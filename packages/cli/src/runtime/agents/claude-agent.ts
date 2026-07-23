/**
 * Claude Code AgentAdapter — the `csuite claude` runner expressed
 * through the shared adapter contract (`adapter.ts`).
 *
 * Framework-specific knowledge lives here and ONLY here:
 *
 *   - locating the `claude` binary (`findClaudeBinary`)
 *   - handing claude our MCP bridge entry (`--mcp-config` ephemeral
 *     file by default, `.mcp.json` backup+rewrite fallback)
 *   - `.claude/settings.json` hook wiring for the busy signal
 *   - the auto-injected posture flags (`--dangerously-skip-permissions`,
 *     `--dangerously-load-development-channels`, `--append-system-prompt`)
 *   - the node-pty relay + HUD strip for interactive terminals, with a
 *     `stdio: 'inherit'` fallback for non-TTY contexts
 *
 * Lifecycle (signals, teardown ordering, run summary) is inherited
 * from `runAgentSession` — this file never installs process signal
 * handlers or emits session events itself.
 *
 * Claude Code owns the terminal (interactive TUI), so the adapter
 * declares `signals: 'forward'`: SIGINT/SIGTERM go to claude, and the
 * session ends when claude exits.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HUD_HEIGHT, startHud } from '../hud.js';
import type { Presence } from '../presence.js';
import type {
  AgentAdapter,
  AgentAdapterMeta,
  AgentLog,
  AgentPrepared,
  AgentProcess,
  AgentSessionContext,
} from './adapter.js';
import {
  type ClaudeSettingsHandle,
  findClaudeBinary,
  prepareClaudeSettings,
  prepareMcpConfig,
  writeMcpConfigFile,
} from './claude.js';

export const CLAUDE_META: AgentAdapterMeta = {
  id: 'claude',
  displayName: 'Claude Code',
  // Tier 3: transcript-primary content capture + operational OTEL +
  // FILE-mode raw API bodies into the gen_ai layer. See
  // docs/runners/conformance.mdx for the tier definitions.
  captureTier: 3,
  signals: 'forward',
  // No declared range yet — the doctor reports the detected version
  // without judging it. Declare {min, max} here once a range is pinned
  // by CI against real claude releases.
  testedVersions: null,
  versionArgs: ['--version'],
};

export interface ClaudeAdapterOptions {
  /** Args forwarded verbatim to claude (after our injected flags). */
  claudeArgs: string[];
  /**
   * How to hand claude our MCP server entry:
   *   - `'flag'` (default) — csuite-owned ephemeral config file via
   *     `--mcp-config`; the project `.mcp.json` is never touched.
   *   - `'inject'` — back up and rewrite the project `.mcp.json`
   *     (legacy fallback).
   * Overridable via `CSUITE_CLAUDE_MCP_MODE=flag|inject`; the explicit
   * option wins over the env var.
   */
  mcpMode?: 'flag' | 'inject';
}

/**
 * Decide which flags to auto-inject into the claude invocation, given
 * the user's forwarded args and the briefing prose to pin into the
 * system prompt. Three flags are candidates:
 *
 *   --dangerously-skip-permissions
 *   --dangerously-load-development-channels server:csuite
 *   --append-system-prompt <briefing>
 *
 * Each is injected unless the user already passed it (or, for the
 * append-system-prompt case, the briefing is empty — which the runner
 * treats as "nothing to pin"). The user's args are kept verbatim and
 * placed AFTER our injected flags so the user-supplied tail wins on
 * any surface that resolves last-flag-wins.
 *
 * `summary` is the human-readable banner we print to stderr; it
 * shortens the briefing prose to a char-count so a 1–8K paragraph
 * doesn't drown the welcome banner.
 */
export function computeInjectedClaudeArgs(
  userArgs: readonly string[],
  briefingInstructions: string,
): { injected: string[]; summary: string[]; final: string[] } {
  const injected: string[] = [];
  const summary: string[] = [];
  const userPassedSkipPerms = userArgs.includes('--dangerously-skip-permissions');
  const userPassedDevChannels = userArgs.includes('--dangerously-load-development-channels');
  const userPassedAppendSysPrompt = userArgs.includes('--append-system-prompt');
  if (!userPassedSkipPerms) {
    injected.push('--dangerously-skip-permissions');
    summary.push('--dangerously-skip-permissions');
  }
  if (!userPassedDevChannels) {
    injected.push('--dangerously-load-development-channels', 'server:csuite');
    summary.push('--dangerously-load-development-channels server:csuite');
  }
  if (!userPassedAppendSysPrompt && briefingInstructions.length > 0) {
    injected.push('--append-system-prompt', briefingInstructions);
    summary.push(`--append-system-prompt <csuite briefing, ${briefingInstructions.length} chars>`);
  }
  return { injected, summary, final: [...injected, ...userArgs] };
}

/**
 * Decide whether this invocation should run inside a node-pty relay
 * with the HUD strip at the bottom, or fall back to the older
 * `stdio: 'inherit'` spawn. We need a TTY on both ends (stdin and
 * stdout) to own the user's terminal; otherwise (tests, CI, piped
 * input) we keep the old behavior so automation stays deterministic.
 *
 * Also returns `false` when `node-pty` isn't loadable — the package
 * is listed in `optionalDependencies` so it may be absent on hosts
 * that couldn't build the native binding (CI runners without
 * build-essential, uncommon platforms, etc.). In those environments
 * we transparently fall back to `stdio: 'inherit'` and skip the HUD.
 */
async function shouldUsePty(): Promise<boolean> {
  if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) return false;
  try {
    await import('node-pty');
    return true;
  } catch {
    return false;
  }
}

export function createClaudeAdapter(options: ClaudeAdapterOptions): AgentAdapter {
  let claudeBinary = '';
  // Populated by prepare(), consumed by spawn().
  let childEnv: NodeJS.ProcessEnv = {};
  let finalClaudeArgs: string[] = [];
  let injectedArgs: string[] = [];

  return {
    meta: CLAUDE_META,

    locate(): void {
      claudeBinary = findClaudeBinary();
    },

    binaryPath(): string | null {
      return claudeBinary.length > 0 ? claudeBinary : null;
    },

    prepare(ctx: AgentSessionContext): AgentPrepared {
      const { runner, cwd, log } = ctx;
      const bannerLines: string[] = [];

      // 1. Install our `csuite` MCP server entry. Two strategies,
      //    selected by `mcpMode`; both collapse to a common shape:
      //    flag args to prepend and an idempotent teardown.
      const mcpMode: 'flag' | 'inject' =
        options.mcpMode ?? (process.env.CSUITE_CLAUDE_MCP_MODE === 'inject' ? 'inject' : 'flag');
      let mcpFlagArgs: string[] = [];
      let mcpTeardown: () => void = () => {};
      if (mcpMode === 'flag') {
        const mcpFileHandle = writeMcpConfigFile({
          runnerSocketPath: runner.socketPath,
          bridgeCommand: ctx.bridgeCommand,
          bridgeArgs: [...ctx.bridgeArgs],
        });
        mcpFlagArgs = [...mcpFileHandle.flagArgs];
        mcpTeardown = mcpFileHandle.cleanup;
        bannerLines.push(
          `csuite claude: MCP config = ${mcpFileHandle.path} (via --mcp-config; project .mcp.json untouched)`,
        );
        log('claude: mcp config file written', { path: mcpFileHandle.path });
      } else {
        const mcpTargetPath = resolve(cwd, '.mcp.json');
        const mcpExistedPriorToRun = existsSync(mcpTargetPath);
        const mcpHandle = prepareMcpConfig({
          cwd,
          runnerSocketPath: runner.socketPath,
          bridgeCommand: ctx.bridgeCommand,
          bridgeArgs: [...ctx.bridgeArgs],
        });
        mcpTeardown = mcpHandle.restore;
        bannerLines.push(
          `csuite claude: .mcp.json = ${mcpTargetPath}${
            mcpExistedPriorToRun ? ' (found — backed up and merged csuite entry)' : ' (created)'
          }`,
        );
        log('claude: .mcp.json prepared', { path: mcpHandle.path });
      }

      // 2. If capture is enabled, write the `.claude/settings.json`
      //    hook config so lifecycle events drive the busy signal and
      //    surface the transcript path. Failures are non-fatal — they
      //    only degrade busy-signal accuracy, not the agent itself.
      let settingsHandle: ClaudeSettingsHandle | null = null;
      if (runner.captureHost) {
        try {
          settingsHandle = prepareClaudeSettings({
            cwd,
            hookUrl: runner.captureHost.hookEndpointUrl,
          });
          log('claude: .claude/settings.json prepared', { path: settingsHandle.path });
        } catch (err) {
          log('claude: .claude/settings.json prepare failed (busy hooks disabled)', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 3. Child environment: broker-held secrets first, capture
      //    host's OTEL delta after — runner-managed vars always win on
      //    a (theoretical) name collision.
      childEnv = { ...process.env };
      const secretNames = Object.keys(runner.secretsEnv);
      if (secretNames.length > 0) {
        for (const [k, v] of Object.entries(runner.secretsEnv)) {
          childEnv[k] = v;
        }
        log('claude: broker secrets injected into agent env', { envNames: secretNames });
      }
      if (runner.captureHost !== null) {
        for (const [k, v] of Object.entries(runner.captureHost.envVars())) {
          childEnv[k] = v;
        }
        log('claude: capture host armed (transcript capture)', {
          hookUrl: runner.captureHost.hookEndpointUrl,
        });
      }

      // 4. Compose the final claude invocation: `--mcp-config` first,
      //    then the auto-injected posture flags, then the user's args
      //    (verbatim, last, so they win on last-flag-wins surfaces).
      const computed = computeInjectedClaudeArgs(options.claudeArgs, runner.briefing.instructions);
      injectedArgs = computed.injected;
      finalClaudeArgs = [...mcpFlagArgs, ...computed.final];
      if (computed.summary.length > 0) {
        bannerLines.push(
          '',
          'csuite: auto-injected into claude invocation (team authority is the access control):',
          ...computed.summary.map((f) => `    ${f}`),
          '      (pass either flag yourself to suppress this line)',
          '',
        );
      }

      let cleaned = false;
      return {
        bannerLines,
        cleanup: (): void => {
          if (cleaned) return;
          cleaned = true;
          try {
            mcpTeardown();
          } catch (err) {
            log('claude: mcp teardown threw', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          try {
            settingsHandle?.restore();
          } catch (err) {
            log('claude: settings.json restore threw', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      };
    },

    async spawn(ctx: AgentSessionContext): Promise<AgentProcess> {
      const usePty = await shouldUsePty();
      // Heads-up to the user: claude's ink fork blocks its first
      // render on a terminal-capability probe (kitty-keyboard + DA1)
      // whose reply never materializes under a pty relay, so nothing
      // paints until it reads a byte from stdin. Any keypress works —
      // Enter is just the least surprising. Only shown on the pty
      // path — the stdio:'inherit' fallback doesn't have this quirk.
      if (usePty) {
        process.stderr.write('csuite: press Enter to render the Claude Code TUI.\n\n');
      }
      ctx.log('claude: spawning claude', {
        binary: claudeBinary,
        args: finalClaudeArgs,
        injected: injectedArgs,
        cwd: ctx.cwd,
        transport: usePty ? 'pty' : 'inherit',
      });
      if (usePty) {
        return startPtyProcess({
          claudeBinary,
          args: finalClaudeArgs,
          cwd: ctx.cwd,
          env: childEnv,
          presence: ctx.presence,
          label: ctx.runner.briefing.name,
          log: ctx.log,
        });
      }
      return startInheritProcess({
        claudeBinary,
        args: finalClaudeArgs,
        cwd: ctx.cwd,
        env: childEnv,
        log: ctx.log,
      });
    },
  };
}

/**
 * Map a signal name to its conventional exit-code offset. Claude
 * dying by SIGTERM should surface as `143` (128 + 15), not `0`.
 * Keeps the offsets small and correct for the signals we actually
 * forward; unknown signals fall back to `null` and we treat the
 * exit as a plain `0` rather than guessing.
 */
function signalNumber(signal: NodeJS.Signals): number | null {
  switch (signal) {
    case 'SIGINT':
      return 2;
    case 'SIGTERM':
      return 15;
    case 'SIGHUP':
      return 1;
    case 'SIGQUIT':
      return 3;
    default:
      return null;
  }
}

interface InheritSpawnOptions {
  claudeBinary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: AgentLog;
}

/** Fallback transport: `stdio: 'inherit'`. Used for tests and non-TTY
 * contexts so automation stays byte-for-byte compatible. */
function startInheritProcess(opts: InheritSpawnOptions): AgentProcess {
  const child: ChildProcess = spawn(opts.claudeBinary, opts.args, {
    cwd: opts.cwd,
    stdio: 'inherit',
    env: opts.env,
  });

  const exitCode = new Promise<number>((resolvePromise) => {
    child.on('exit', (code, signal) => {
      resolvePromise(code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 0));
    });
    child.on('error', (err) => {
      opts.log('claude: failed to spawn claude', {
        error: err instanceof Error ? err.message : String(err),
      });
      resolvePromise(1);
    });
  });

  const alive = (): boolean => child.exitCode === null && child.signalCode === null;

  return {
    exitCode,
    sessionId: () => null,
    signal(sig) {
      if (alive()) {
        try {
          child.kill(sig);
        } catch {
          /* ignore */
        }
      }
    },
    async shutdown() {
      // Forward-mode teardown runs after claude exits, so this is a
      // defensive kill for abnormal paths only.
      if (alive()) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    },
  };
}

interface PtySpawnOptions {
  claudeBinary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  presence: Presence;
  label: string;
  log: AgentLog;
}

/**
 * Spawn claude via node-pty, relaying stdin/stdout and reserving the
 * bottom `HUD_HEIGHT` rows for the csuite status strip.
 *
 * Key mechanics:
 *
 *   - The pty we give claude reports `rows - HUD_HEIGHT` via
 *     TIOCGWINSZ, so claude's ink renderer never paints into our
 *     panel rows. We still redraw the HUD after every chunk because
 *     claude's initial alt-screen entry issues `CSI 2J` which wipes
 *     the entire screen buffer, including our strip.
 *
 *   - SIGWINCH on the parent recalculates size and issues
 *     `pty.resize(cols, rows - HUD_HEIGHT)`. Claude picks up the new
 *     dims on its next render tick.
 *
 *   - We import `node-pty` lazily so the rest of the CLI (push,
 *     roster, setup, etc.) can run on systems where the native
 *     prebuild didn't install cleanly. Only this verb needs it.
 *
 * The returned handle's `exitCode` resolves only after terminal state
 * is restored (raw mode off, resize listener removed, HUD closed) so
 * the driver's teardown never races the restore.
 */
async function startPtyProcess(opts: PtySpawnOptions): Promise<AgentProcess> {
  const pty = await import('node-pty');

  const getSize = (): { rows: number; cols: number } => ({
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  });

  const { rows: realRows, cols: realCols } = getSize();
  const ptyRows = Math.max(4, realRows - HUD_HEIGHT);
  const ptyCols = realCols;

  const term = pty.spawn(opts.claudeBinary, opts.args, {
    name: opts.env.TERM ?? 'xterm-256color',
    cwd: opts.cwd,
    env: opts.env as { [key: string]: string },
    cols: ptyCols,
    rows: ptyRows,
  });

  const hud = startHud({
    presence: opts.presence,
    label: opts.label,
  });

  // Forward pty output → stdout, re-painting the HUD after every
  // chunk so `CSI 2J` / repaints from claude don't leave the panel
  // stale.
  term.onData((data) => {
    process.stdout.write(data);
    hud.redraw();
  });

  // Raw mode on stdin so individual keystrokes (arrow keys, Ctrl-C,
  // etc.) reach claude without the parent's line discipline eating
  // them. Restore cooked mode on exit. We attach the 'data' listener
  // BEFORE calling resume(): if the terminal sends a response to a
  // capability query claude fired during mount (DSR, DA, etc.),
  // attaching late risks the response being emitted into a void
  // and claude hanging on its own handshake.
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  const forwardInput = (data: Buffer | string): void => {
    try {
      term.write(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      /* term may have exited */
    }
  };
  stdin.on('data', forwardInput);
  if (stdin.isTTY) {
    try {
      stdin.setRawMode(true);
    } catch {
      /* some TTYs (e.g. some CI runners) don't support raw mode */
    }
  }
  stdin.resume();

  const onResize = (): void => {
    const { rows, cols } = getSize();
    try {
      term.resize(cols, Math.max(4, rows - HUD_HEIGHT));
    } catch {
      /* ignore race with pty exit */
    }
    hud.redraw();
  };
  process.stdout.on('resize', onResize);

  let exited = false;
  let restored = false;
  const restoreTerminal = (): void => {
    if (restored) return;
    restored = true;
    // Stop forwarding stdin and restore cooked mode so the user's
    // shell doesn't inherit raw-mode terminal state after we exit.
    stdin.off('data', forwardInput);
    if (stdin.isTTY) {
      try {
        stdin.setRawMode(wasRaw ?? false);
      } catch {
        /* ignore */
      }
    }
    stdin.pause();
    process.stdout.off('resize', onResize);
    hud.close();
  };

  const exitCode = new Promise<number>((resolvePromise) => {
    term.onExit(({ exitCode: code, signal }) => {
      exited = true;
      restoreTerminal();
      resolvePromise(code ?? (signal ? 128 + signal : 0));
    });
  });

  return {
    exitCode,
    sessionId: () => null,
    signal(sig) {
      try {
        term.kill(sig);
      } catch {
        /* ignore */
      }
    },
    async shutdown() {
      restoreTerminal();
      if (!exited) {
        try {
          term.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    },
  };
}
