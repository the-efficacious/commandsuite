/**
 * `csuite claude-code` — wrap a Claude Code session in a csuite runner.
 *
 * The runner is the parent process that owns all the heavyweight
 * state: the broker connection, the cached briefing, the SSE forwarder,
 * the objectives tracker, and the IPC socket that the MCP bridge
 * (spawned by claude-code as an MCP server via `.mcp.json`) connects
 * back to.
 *
 * Flow:
 *
 *   1. Validate args + locate the `claude` binary
 *   2. `startRunner()` — fetches briefing, binds the IPC socket, starts
 *      the forwarder. The socket path is passed into the .mcp.json
 *      bridge entry via the `CSUITE_RUNNER_SOCKET` env var.
 *   3. Set up the `csuite` MCP server entry (pointed at this runner's
 *      socket). Default: `writeMcpConfigFile()` writes a csuite-owned
 *      ephemeral config and injects `--mcp-config <file>` — the project
 *      `.mcp.json` is never touched. Fallback (`mcpMode: 'inject'`):
 *      `prepareMcpConfig()` backs up and rewrites `.mcp.json`.
 *   4. Spawn `claude <forwarded args>` with inherited stdio so the
 *      operator interacts with it directly in this terminal.
 *   5. On any exit path (normal, signal, claude crash, ENOENT), run
 *      the teardown: clean up the ephemeral config (or restore
 *      `.mcp.json` in the fallback), shut down the runner, unlink the
 *      socket. Every teardown hook is idempotent so double-firing on
 *      SIGINT → process.exit() is safe.
 *
 * The runner never writes to stdout — stdout belongs to claude. All
 * runner diagnostics go to stderr as structured JSON, which interleaves
 * cleanly with claude's own stderr output.
 *
 * This verb is the entry point for Milestone A. Phase 5 adds
 * `--no-trace` / `--trace` flags and wires tracing into the spawn env;
 * for now the only knobs are `--url` / `--token` (with env fallback)
 * and the passthrough args after `--`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PORT, ENV } from 'csuite-sdk/protocol';
import {
  ClaudeCodeAdapterError,
  type ClaudeSettingsHandle,
  findClaudeBinary,
  prepareClaudeSettings,
  prepareMcpConfig,
  writeMcpConfigFile,
} from '../runtime/agents/claude-code.js';
import { HUD_HEIGHT, startHud } from '../runtime/hud.js';
import { createPresence } from '../runtime/presence.js';
import { type RunnerHandle, RunnerStartupError, startRunner } from '../runtime/runner.js';
import { createSessionLog } from '../runtime/session-log.js';
import { UsageError } from './errors.js';

export { UsageError };

export interface ClaudeCodeCommandInput {
  url?: string;
  token?: string;
  /**
   * Claude args to forward. Everything after `--` on the command line
   * lands here verbatim, plus any positional args we don't recognize.
   */
  claudeArgs: string[];
  /**
   * Directory the runner runs in — this is also where the adapter
   * reads/writes `.mcp.json`. Defaults to `process.cwd()`. Tests
   * override this to isolate from the real repo.
   */
  cwd?: string;
  /** Optional logger override; defaults to stderr JSON lines. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /**
   * Override the `command` + `args` written into `.mcp.json` for the
   * `csuite` MCP server entry. Defaults to `csuite mcp-bridge`, which
   * assumes the `csuite` CLI is on PATH in whatever environment claude
   * runs. Tests override this to point at the built dist so they
   * don't depend on a global install.
   */
  bridgeCommand?: string;
  bridgeArgs?: string[];
  /**
   * How to hand claude our MCP server entry:
   *   - `'flag'` (default) — write a csuite-owned ephemeral config file
   *     and pass `--mcp-config <file>`. Never touches the project
   *     `.mcp.json`; isolates cleanly across concurrent runs.
   *   - `'inject'` — back up and rewrite the project `.mcp.json`
   *     (the legacy behavior). Retained as a fallback.
   * Overridable via `CSUITE_CLAUDE_MCP_MODE=flag|inject`; the explicit
   * input wins over the env var.
   */
  mcpMode?: 'flag' | 'inject';
  /**
   * Disable activity capture. When true, the runner skips starting the
   * capture host (activity uploader, busy signal, hook server) and
   * leaves the agent's environment untouched — no OpenTelemetry export.
   * `csuite claude-code --no-trace` sets this.
   */
  noTrace?: boolean;
  /**
   * Skip resolving/injecting broker-held secrets into the agent's
   * environment. `csuite claude-code --no-secrets` sets this.
   */
  noSecrets?: boolean;
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
 * Run a Claude Code session wrapped in a csuite runner. Resolves with the
 * exit code of the claude subprocess (so the CLI entry can propagate
 * it via `process.exit`). Teardown is synchronous-best-effort so even
 * a crashing claude leaves the operator's `.mcp.json` in its original
 * state.
 */
export async function runClaudeCodeCommand(input: ClaudeCodeCommandInput): Promise<number> {
  // When the caller (tests, embedders) provides an explicit log, honor
  // it unchanged. Otherwise auto-route: if stderr is a TTY we'll be
  // running the pty + HUD path and stderr writes would corrupt claude's
  // frame, so structured logs go to ~/.cache/commandsuite/session-<pid>.log
  // instead. `sessionLog.path` is printed on startup so the user
  // can `tail -f` it for live diagnostics.
  const ownedSessionLog = input.log ? null : createSessionLog({ component: 'claude-code' });
  const log = input.log ?? (ownedSessionLog as NonNullable<typeof ownedSessionLog>).log;
  const url = input.url ?? process.env[ENV.url] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  const token = input.token ?? process.env[ENV.token];
  if (!token) {
    throw new UsageError(
      `--token or ${ENV.token} is required — run \`csuite setup\` or pass the user's bearer token explicitly`,
    );
  }
  const cwd = input.cwd ?? process.cwd();

  // 1. Locate claude before we touch anything shared — if it's missing
  //    we want to bail without modifying `.mcp.json` or binding a socket.
  let claudeBinary: string;
  try {
    claudeBinary = findClaudeBinary();
  } catch (err) {
    if (err instanceof ClaudeCodeAdapterError) {
      throw new UsageError(err.message);
    }
    throw err;
  }

  // 2. Start the runner. If this fails we haven't touched `.mcp.json`
  //    yet either, so a failure here just propagates cleanly.
  const presence = createPresence();
  let runner: RunnerHandle;
  try {
    runner = await startRunner({
      url,
      token,
      log,
      presence,
      noTrace: input.noTrace,
      noSecrets: input.noSecrets,
    });
  } catch (err) {
    if (err instanceof RunnerStartupError) {
      ownedSessionLog?.close();
      throw new UsageError(err.message);
    }
    ownedSessionLog?.close();
    throw err;
  }
  log('claude-code: runner started', {
    socketPath: runner.socketPath,
    name: runner.briefing.name,
    role: runner.briefing.role,
    team: runner.briefing.team,
  });

  // 3. Install our `csuite` MCP server entry. Any failure here tears
  //    down the runner before propagating so we don't leave an orphaned
  //    IPC socket. Two strategies, selected by `mcpMode`:
  //      - 'flag'   → write a csuite-owned ephemeral config, inject
  //                   `--mcp-config <file>`; project `.mcp.json` untouched.
  //      - 'inject' → back up + rewrite the project `.mcp.json` (legacy).
  //    Both collapse to a common shape: flag args to prepend and an
  //    idempotent teardown.
  const mcpMode: 'flag' | 'inject' =
    input.mcpMode ?? (process.env.CSUITE_CLAUDE_MCP_MODE === 'inject' ? 'inject' : 'flag');
  let mcpFlagArgs: string[] = [];
  let mcpTeardown: () => void = () => {};
  let settingsHandle: ClaudeSettingsHandle | null = null;
  // Auto-detect the bridge command from the currently-running cli
  // process. `process.execPath` is the node binary; `process.argv[1]`
  // is the absolute path to the cli's entry script (dist/index.js in
  // dev, the globally-installed cli in production). Baking these
  // into the `.mcp.json` entry means claude spawns the SAME cli that
  // spawned it — no PATH assumption, works identically whether the
  // operator ran `csuite claude-code` via a shell alias, a pnpm script,
  // or a global npm install. Callers may still override via
  // `input.bridgeCommand`/`bridgeArgs` for tests that want explicit
  // paths.
  const detectedBridgeCommand = input.bridgeCommand ?? process.execPath;
  const detectedBridgeArgs =
    input.bridgeArgs ?? (process.argv[1] ? [process.argv[1], 'mcp-bridge'] : ['mcp-bridge']);

  // Human-readable disclosure on stderr so the MCP surface is legible on
  // turn 1. Dan's 2026-04-16 audit Part-3 DX item #3 flagged the legacy
  // `.mcp.json` rewrite: operators running from the wrong directory don't
  // notice until their MCP servers "disappear" mid-session. The default
  // 'flag' mode sidesteps that entirely (project file untouched), but we
  // still print where our ephemeral config lives; 'inject' keeps the
  // original found/creating disclosure.
  const shutdownRunnerThenThrow = async (err: unknown): Promise<never> => {
    await runner.shutdown('mcp-config-failed').catch((shutdownErr) => {
      log('claude-code: runner shutdown failed during mcp-config cleanup', {
        error: shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr),
      });
    });
    if (err instanceof ClaudeCodeAdapterError) {
      throw new UsageError(err.message);
    }
    throw err;
  };

  if (mcpMode === 'flag') {
    let mcpFileHandle: ReturnType<typeof writeMcpConfigFile>;
    try {
      mcpFileHandle = writeMcpConfigFile({
        runnerSocketPath: runner.socketPath,
        bridgeCommand: detectedBridgeCommand,
        bridgeArgs: detectedBridgeArgs,
      });
    } catch (err) {
      await shutdownRunnerThenThrow(err);
      throw err; // unreachable — shutdownRunnerThenThrow always throws
    }
    mcpFlagArgs = [...mcpFileHandle.flagArgs];
    mcpTeardown = mcpFileHandle.cleanup;
    process.stderr.write(
      `csuite: runner cwd = ${cwd}\n` +
        `csuite: MCP config = ${mcpFileHandle.path} (via --mcp-config; project .mcp.json untouched)\n` +
        (ownedSessionLog?.path ? `csuite: session log = ${ownedSessionLog.path}\n` : ''),
    );
    log('claude-code: mcp config file written', { path: mcpFileHandle.path });
  } else {
    const mcpTargetPath = resolve(cwd, '.mcp.json');
    const mcpExistedPriorToRun = existsSync(mcpTargetPath);
    process.stderr.write(
      `csuite: runner cwd = ${cwd}\n` +
        `csuite: .mcp.json = ${mcpTargetPath}${
          mcpExistedPriorToRun ? ' (found — backing up and merging csuite entry)' : ' (creating)'
        }\n` +
        (ownedSessionLog?.path ? `csuite: session log = ${ownedSessionLog.path}\n` : ''),
    );
    let mcpHandle: ReturnType<typeof prepareMcpConfig>;
    try {
      mcpHandle = prepareMcpConfig({
        cwd,
        runnerSocketPath: runner.socketPath,
        bridgeCommand: detectedBridgeCommand,
        bridgeArgs: detectedBridgeArgs,
      });
    } catch (err) {
      await shutdownRunnerThenThrow(err);
      throw err; // unreachable
    }
    mcpTeardown = mcpHandle.restore;
    log('claude-code: .mcp.json prepared', { path: mcpHandle.path });
  }

  // 3b. If capture is enabled, write a `.claude/settings.json` hook
  //    config so PreToolUse / PostToolUse events drive the busy signal
  //    AND emit `tool_action` activity. Skipped under `--no-trace`
  //    since there's no hook endpoint to point at. Failures here are
  //    non-fatal — they only degrade busy-signal accuracy and tool
  //    activity during runs, not correctness of the agent itself.
  if (runner.captureHost) {
    try {
      settingsHandle = prepareClaudeSettings({
        cwd,
        hookUrl: runner.captureHost.hookEndpointUrl,
      });
      log('claude-code: .claude/settings.json prepared', { path: settingsHandle.path });
    } catch (err) {
      log('claude-code: .claude/settings.json prepare failed (busy hooks disabled)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. Spawn claude. In interactive sessions we route through a
  //    node-pty relay so we can (a) reserve the bottom `HUD_HEIGHT`
  //    rows for the csuite status strip and (b) own the stream for
  //    later features (e.g. injecting `/compact` on demand). When
  //    stdout/stdin aren't TTYs (tests, piped input) we fall back
  //    to `stdio: 'inherit'` so automation stays byte-for-byte
  //    compatible.
  let teardownDone = false;
  let closeHud: (() => void) | null = null;
  const teardown = async (reason: string): Promise<void> => {
    if (teardownDone) return;
    teardownDone = true;
    log('claude-code: tearing down', { reason });
    try {
      closeHud?.();
    } catch {
      /* ignore */
    }
    try {
      mcpTeardown();
    } catch (err) {
      log('claude-code: mcp teardown threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (settingsHandle) {
      try {
        settingsHandle.restore();
      } catch (err) {
        log('claude-code: settings.json restore threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await runner.shutdown(reason).catch((err) => {
      log('claude-code: runner shutdown threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    ownedSessionLog?.close();
  };

  // Merge the capture host's env delta into the child's environment when
  // capture is on. That delta is the LEAN operational OTEL export
  // (CLAUDE_CODE_ENABLE_TELEMETRY + OTLP endpoint/headers) — metrics and
  // structured events only; content stays transcript-primary. It's a
  // plain delta (no NODE_OPTIONS / proxy vars to reconcile against the
  // existing env), so a flat merge over the inherited env is enough.
  //
  // Merge order matters: broker-held secrets first, capture delta
  // after — runner-managed vars always win on a (theoretical)
  // collision. Secret env names are validated broker-side and
  // re-filtered in startRunner, so in practice the sets are disjoint.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  const secretNames = Object.keys(runner.secretsEnv);
  if (secretNames.length > 0) {
    for (const [k, v] of Object.entries(runner.secretsEnv)) {
      childEnv[k] = v;
    }
    log('claude-code: broker secrets injected into agent env', { envNames: secretNames });
  }
  if (runner.captureHost !== null) {
    const captureEnv = runner.captureHost.envVars();
    for (const [k, v] of Object.entries(captureEnv)) {
      childEnv[k] = v;
    }
    log('claude-code: capture host armed (transcript capture)', {
      hookUrl: runner.captureHost.hookEndpointUrl,
    });
  }

  // Auto-inject the flags that csuite's bridge-based setup fundamentally
  // depends on:
  //
  //   --dangerously-skip-permissions
  //     csuite's MCP tools (broadcast, send, objectives_*, etc.) are
  //     supposed to be callable by the agent without a permission
  //     prompt per-call — the team authority model is the access
  //     control layer, not per-tool yes/no prompts. Skipping
  //     permissions is therefore a structural requirement, not a
  //     convenience.
  //
  //   --dangerously-load-development-channels server:csuite
  //     Enables claude's `claude/channel` experimental capability
  //     against our bridge (keyed `csuite` in the written .mcp.json).
  //     Without this, the bridge declares the capability but claude
  //     ignores it and push events never reach the agent — the
  //     whole "events arrive mid-session" value prop collapses.
  //
  //   --append-system-prompt <briefing>
  //     Pins the composed team briefing (csuite framing + team name /
  //     context, role, personal instructions, teammates,
  //     objectives primer) into claude's system prompt for the whole
  //     session. The same prose is also delivered through the MCP
  //     `instructions` channel, but `--append-system-prompt` keeps it
  //     in EVERY turn's context — survives compaction and beats the
  //     "agent forgot who it is by turn 40" failure mode. Snapshot
  //     at startup: edits to role / personal instructions / team
  //     config require an agent rerun to take effect.
  //
  // We prepend the flags unconditionally. If the caller explicitly
  // passed any of them already, we de-dup so claude doesn't see them
  // twice. User-supplied args still end up on the command line, just
  // after ours.
  const {
    injected: injectedArgs,
    summary: injectedSummary,
    final: computedClaudeArgs,
  } = computeInjectedClaudeArgs(input.claudeArgs, runner.briefing.instructions);
  // Prepend `--mcp-config <file>` (empty in 'inject' mode) ahead of the
  // auto-injected flags and the user's args. It's unconditional in
  // 'flag' mode — the csuite server has to exist — and additive: any
  // `--mcp-config` the user passes coexists (the flag is repeatable and
  // claude merges the sources).
  const finalClaudeArgs = [...mcpFlagArgs, ...computedClaudeArgs];

  // Human-readable posture banner on stderr — stdout belongs to claude.
  // The two auto-injected flags meaningfully relax claude's default
  // per-call permission behavior. Dan's 2026-04-16 audit Part-3 item #5
  // flagged this as a "posture users need to notice on turn 1" — the
  // structured JSON log on its own doesn't make that visible enough,
  // because an operator skimming a fresh session sees the TUI first
  // and structured logs look like plumbing noise.
  //
  // Emitted only when we actually injected something; if the operator
  // passed the flags themselves, no banner fires (they already know).
  if (injectedSummary.length > 0) {
    const banner =
      `\ncsuite: auto-injected into claude invocation (team authority is the access control):\n` +
      injectedSummary.map((f) => `    ${f}\n`).join('') +
      `      (pass either flag yourself to suppress this line)\n\n`;
    process.stderr.write(banner);
  }

  const usePty = await shouldUsePty();
  // Heads-up to the user: claude-code's ink fork blocks its first
  // render on a terminal-capability probe (kitty-keyboard + DA1)
  // whose reply never materializes under a pty relay, so nothing
  // paints until it reads a byte from stdin. Any keypress works —
  // Enter is just the least surprising. We forward the keystroke
  // through to claude's stdin so the same Enter that unblocks the
  // TUI becomes a no-op submit against the welcome prompt. Only
  // shown when we're actually taking the pty path — the
  // stdio:'inherit' fallback doesn't have this quirk.
  if (usePty) {
    process.stderr.write('csuite: press Enter to render the Claude Code TUI.\n\n');
  }

  log('claude-code: spawning claude', {
    binary: claudeBinary,
    args: finalClaudeArgs,
    injected: injectedArgs,
    cwd,
    transport: usePty ? 'pty' : 'inherit',
  });

  // Last-ditch teardown if the node process itself is dying — we'd
  // rather the operator's `.mcp.json` be restored on an unhandled
  // crash than leave it modified.
  const onUncaught = (err: unknown): void => {
    log('claude-code: uncaught exception', {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    try {
      mcpTeardown();
    } catch {
      /* ignore */
    }
    try {
      settingsHandle?.restore();
    } catch {
      /* ignore */
    }
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);

  let onSigint: () => void = () => {};
  let onSigterm: () => void = () => {};

  const exitCode = await new Promise<number>((resolvePromise) => {
    if (usePty) {
      void runPty({
        claudeBinary,
        args: finalClaudeArgs,
        cwd,
        env: childEnv,
        presence,
        label: runner.briefing.name,
        log,
        onSigintRegister: (handler) => {
          onSigint = handler;
          process.on('SIGINT', onSigint);
        },
        onSigtermRegister: (handler) => {
          onSigterm = handler;
          process.on('SIGTERM', onSigterm);
        },
        onHudReady: (close) => {
          closeHud = close;
        },
      })
        .then(resolvePromise)
        .catch((err) => {
          log('claude-code: pty run failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          resolvePromise(1);
        });
      return;
    }

    // Fallback: stdio inherit. Used for tests and non-TTY contexts.
    const child = spawn(claudeBinary, finalClaudeArgs, {
      cwd,
      stdio: 'inherit',
      env: childEnv,
    });

    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal);
        } catch {
          /* ignore */
        }
      }
    };
    onSigint = (): void => forwardSignal('SIGINT');
    onSigterm = (): void => forwardSignal('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    child.on('exit', (code, signal) => {
      const resolved = code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 0);
      resolvePromise(resolved);
    });
    child.on('error', (err) => {
      log('claude-code: failed to spawn claude', {
        error: err instanceof Error ? err.message : String(err),
      });
      resolvePromise(1);
    });
  });

  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  process.off('uncaughtException', onUncaught);
  process.off('unhandledRejection', onUncaught);

  await teardown(`claude-exited-${exitCode}`);
  return exitCode;
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

interface RunPtyOptions {
  claudeBinary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  presence: ReturnType<typeof createPresence>;
  label: string;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
  onSigintRegister: (handler: () => void) => void;
  onSigtermRegister: (handler: () => void) => void;
  onHudReady: (close: () => void) => void;
}

/**
 * Spawn claude via node-pty, relaying stdin/stdout and reserving the
 * bottom `HUD_HEIGHT` rows for the csuite status strip. Resolves with
 * the child's exit code.
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
 */
async function runPty(opts: RunPtyOptions): Promise<number> {
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
  opts.onHudReady(hud.close);

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

  opts.onSigintRegister(() => {
    try {
      term.kill('SIGINT');
    } catch {
      /* ignore */
    }
  });
  opts.onSigtermRegister(() => {
    try {
      term.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  });

  const exitCode = await new Promise<number>((resolvePromise) => {
    term.onExit(({ exitCode: code, signal }) => {
      const resolved = code ?? (signal ? 128 + signal : 0);
      resolvePromise(resolved);
    });
  });

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

  return exitCode;
}
