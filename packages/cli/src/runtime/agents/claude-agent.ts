/**
 * Claude AgentAdapter — the `csuite claude` runner expressed through
 * the shared adapter contract (`adapter.ts`), running Claude Code
 * headlessly via the Claude Agent SDK.
 *
 * Framework-specific knowledge lives here and ONLY here:
 *
 *   - resolving the Claude Code executable the SDK drives
 *     (`resolveClaudeExecutable`: `CLAUDE_PATH` override or the SDK's
 *     bundled per-platform CLI)
 *   - composing the SDK `Options`: the csuite MCP bridge entry, the
 *     briefing pinned into the Claude Code system-prompt preset, the
 *     `bypassPermissions` posture, model/resume knobs, and the child
 *     env (broker secrets + the capture host's OTEL delta)
 *   - the channel sink (broker events → SDK streaming input) and the
 *     in-process hook forwarders that keep the capture host's busy
 *     signal, transcript discovery, and re-brief triggers fed
 *   - the headless operator chrome: activity printer + HUD strip +
 *     session-id banner
 *
 * Nothing is written to the member's working tree: the MCP config
 * travels inline on the CLI invocation the SDK composes, hooks are
 * in-process callbacks, and the briefing rides an SDK option — so
 * `prepare()` has no cleanup to speak of. The member's own Claude
 * config (`~/.claude`, project `.claude/`, CLAUDE.md) still loads
 * exactly as it would under a plain `claude` invocation; csuite adds
 * its surface on top rather than displacing it.
 *
 * Lifecycle (signals, teardown ordering, run summary) is inherited
 * from `runAgentSession`. The agent is headless — the runner owns the
 * terminal — so the adapter declares `signals: 'teardown'`: Ctrl-C
 * ends the session gracefully rather than being forwarded.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  type HookCallback,
  type HookCallbackMatcher,
  type HookEvent,
  type Query,
  query,
  type Options as SdkOptions,
  type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { composeFixedContext } from '../fixed-context.js';
import { type HudHandle, startHud } from '../hud.js';
import type {
  AgentAdapter,
  AgentAdapterMeta,
  AgentDoctorCheck,
  AgentLog,
  AgentPrepared,
  AgentProcess,
  AgentSessionContext,
} from './adapter.js';
import { type ClaudeExecutable, resolveClaudeExecutable } from './claude.js';
import { createClaudeActivityPrinter } from './claude-activity-printer.js';
import {
  type ClaudeChannelSink,
  ClaudeMessageQueue,
  createClaudeChannelSink,
} from './claude-sink.js';

export const CLAUDE_META: AgentAdapterMeta = {
  id: 'claude',
  displayName: 'Claude Code',
  // Tier 3: transcript-primary content capture + operational OTEL +
  // FILE-mode raw API bodies into the gen_ai layer — all unchanged from
  // the CLI-wrapper era, since the SDK runs the same Claude Code
  // underneath. See docs/runners/conformance.mdx for the tier
  // definitions.
  captureTier: 3,
  signals: 'teardown',
  // No declared range yet — the doctor reports the detected version
  // without judging it. Declare {min, max} here once a range is pinned
  // by CI against real SDK releases.
  testedVersions: null,
  versionArgs: ['--version'],
};

export interface ClaudeAdapterOptions {
  /** Model override forwarded as the SDK `model` option. */
  model?: string;
  /**
   * Resume a previous Claude Code session instead of starting fresh.
   * A string is a session id; `true` continues this member's most
   * recent session in the cwd (the SDK `continue` option).
   */
  resume?: string | true;
}

/**
 * The eight hook events the capture host's hook server routes on —
 * the same set the CLI wrapper used to register in the member's
 * `.claude/settings.json`. Now they're in-process SDK callbacks that
 * forward each payload to the hook server's loopback endpoint, keeping
 * the tested busy/transcript/re-brief routing byte-identical.
 */
const FORWARDED_HOOK_EVENTS: readonly HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'Notification',
  'SessionStart',
];

/**
 * Build the SDK hook config: every forwarded event POSTs its payload
 * to the capture host's hook endpoint. POSTs are serialized through
 * one promise chain so Pre/Post pairs can't reorder on the wire, and
 * the callback returns immediately — the agent loop never waits on
 * loopback I/O.
 */
export function buildHookForwarders(
  hookUrl: string,
  log: AgentLog,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  let chain: Promise<void> = Promise.resolve();
  let failuresLogged = 0;
  const post = (body: Record<string, unknown>): void => {
    chain = chain.then(async () => {
      try {
        const res = await fetch(hookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        await res.arrayBuffer();
      } catch (err) {
        // Presence-only signal — degrade quietly rather than spam the
        // session log once per tool call.
        if (failuresLogged < 5) {
          failuresLogged++;
          log('claude: hook forward failed (busy signal degraded)', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
  };
  const forward: HookCallback = async (input, toolUseID) => {
    const body = input as unknown as Record<string, unknown>;
    // The tool_use_id arrives as a separate callback argument; the hook
    // server matches Pre/Post pairs on it, so merge it into the body.
    post(
      toolUseID !== undefined && body.tool_use_id === undefined
        ? { ...body, tool_use_id: toolUseID }
        : body,
    );
    return { continue: true };
  };
  const matchers: HookCallbackMatcher[] = [{ hooks: [forward] }];
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const event of FORWARDED_HOOK_EVENTS) hooks[event] = matchers;
  return hooks;
}

/**
 * Map a signal name to its conventional exit-code offset, so an agent
 * dying by SIGTERM surfaces as `143` (128 + 15), not `0`.
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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function createClaudeAdapter(options: ClaudeAdapterOptions): AgentAdapter {
  let executable: ClaudeExecutable | null = null;
  // Populated by prepare(), consumed by spawn().
  let sdkOptions: SdkOptions = {};

  // Streaming-input queue + channel sink, live from construction: the
  // runner needs a sink before the agent spawns, and events arriving
  // during the SDK subprocess's cold start simply wait in the stream.
  const queue = new ClaudeMessageQueue();
  let sink: ClaudeChannelSink | null = null;

  return {
    meta: CLAUDE_META,

    locate(): void {
      executable = resolveClaudeExecutable();
    },

    binaryPath(): string | null {
      return executable?.path ?? null;
    },

    runnerOptions() {
      sink = createClaudeChannelSink({
        queue,
        log: (msg, ctx) => {
          // The session log isn't created yet when runnerOptions() is
          // called; route through stderr-JSON like other pre-session
          // components. Once spawn() runs, the sink is quiet anyway
          // except for per-event debug lines.
          const record = { ts: new Date().toISOString(), component: 'claude-sink', msg, ...ctx };
          process.stderr.write(`${JSON.stringify(record)}\n`);
        },
      });
      return { channelSink: sink, requireRawBodyAck: true };
    },

    prepare(ctx: AgentSessionContext): AgentPrepared {
      const { runner, cwd, log } = ctx;
      const bannerLines: string[] = [];
      const resolved = executable;
      if (resolved === null) {
        // locate() runs first on every driver path; belt and braces.
        throw new Error('claude adapter: prepare() called before locate()');
      }

      // Child environment: broker-held secrets first, capture host's
      // OTEL delta after — runner-managed vars always win on a
      // (theoretical) name collision. The SDK `env` option REPLACES the
      // subprocess environment, so start from process.env.
      const env: Record<string, string | undefined> = { ...process.env };
      const secretNames = Object.keys(runner.secretsEnv);
      if (secretNames.length > 0) {
        for (const [k, v] of Object.entries(runner.secretsEnv)) env[k] = v;
        log('claude: broker secrets injected into agent env', { envNames: secretNames });
      }
      if (runner.captureHost !== null) {
        for (const [k, v] of Object.entries(runner.captureHost.envVars())) env[k] = v;
        log('claude: capture host armed (transcript capture)', {
          hookUrl: runner.captureHost.hookEndpointUrl,
        });
      }

      // The briefing is more than its `instructions` string: process
      // rules ride in their own field because that string's cap would
      // stop the runner starting. One composer so a future block does
      // not have to be added to each adapter separately.
      const briefing = composeFixedContext(runner.briefing);
      sdkOptions = {
        cwd,
        env,
        pathToClaudeCodeExecutable: resolved.path,
        // The csuite MCP bridge — delivered inline on the invocation
        // the SDK composes (`--mcp-config <json>`); the member's own
        // `.mcp.json` and settings-file servers still load normally.
        mcpServers: {
          csuite: {
            type: 'stdio',
            command: ctx.bridgeCommand,
            args: [...ctx.bridgeArgs],
            env: { CSUITE_RUNNER_SOCKET: runner.socketPath },
          },
        },
        // Claude Code's own system prompt with the composed team
        // briefing pinned on top — the SDK-native form of the old
        // `--append-system-prompt` injection.
        systemPrompt:
          briefing.length > 0
            ? { type: 'preset', preset: 'claude_code', append: briefing }
            : { type: 'preset', preset: 'claude_code' },
        // Team authority is the access control; the agent runs
        // unleashed, same posture as the CLI wrapper injected via
        // `--dangerously-skip-permissions`.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(typeof options.resume === 'string'
          ? { resume: options.resume }
          : options.resume === true
            ? { continue: true }
            : {}),
        ...(runner.captureHost !== null
          ? { hooks: buildHookForwarders(runner.captureHost.hookEndpointUrl, log) }
          : {}),
      };

      bannerLines.push(
        `csuite claude: Agent SDK ${resolved.sdkVersion ?? '?'}${
          resolved.source === 'env'
            ? ` · claude = ${resolved.path} (CLAUDE_PATH)`
            : ` · bundled Claude Code ${resolved.bundledCliVersion ?? '?'}`
        }`,
        'csuite claude: posture = bypassPermissions (team authority is the access control)',
      );
      if (briefing.length > 0) {
        bannerLines.push(
          `csuite claude: briefing pinned to system prompt (${briefing.length} chars)`,
        );
      }
      if (typeof options.resume === 'string') {
        bannerLines.push(`csuite claude: resuming session ${options.resume}`);
      } else if (options.resume === true) {
        bannerLines.push('csuite claude: continuing most recent session in this directory');
      }

      // Nothing was written anywhere — there is nothing to restore.
      return { bannerLines, cleanup: (): void => {} };
    },

    async spawn(ctx: AgentSessionContext): Promise<AgentProcess> {
      const { runner, log } = ctx;

      let child: ChildProcess | null = null;
      let resolveExit!: (code: number) => void;
      let exitSettled = false;
      const exitCode = new Promise<number>((resolvePromise) => {
        resolveExit = resolvePromise;
      });
      const settleExit = (code: number): void => {
        if (exitSettled) return;
        exitSettled = true;
        resolveExit(code);
      };

      // The adapter owns the subprocess spawn so the driver's run
      // summary carries the agent's REAL exit code (and signal deaths
      // map to 128+n), not the SDK's interpretation of them.
      sdkOptions.spawnClaudeCodeProcess = (spawnOpts) => {
        const proc = spawn(spawnOpts.command, spawnOpts.args, {
          cwd: spawnOpts.cwd ?? ctx.cwd,
          env: spawnOpts.env as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          // The SDK's forwarded signal aborts only after its graceful
          // stdin-EOF + grace window, so hanging Node's kill on it is
          // the documented force-kill backstop.
          signal: spawnOpts.signal,
        });
        child = proc;
        proc.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8').trim();
          if (text.length > 0) log('claude: cli stderr', { data: text.slice(0, 2000) });
        });
        proc.on('exit', (code, signal) => {
          settleExit(code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 0));
        });
        proc.on('error', (err) => {
          log('claude: failed to spawn claude', {
            error: err instanceof Error ? err.message : String(err),
          });
          settleExit(1);
        });
        return proc as unknown as SpawnedProcess;
      };

      // Fresh sessions get a csuite-minted session id so the identity
      // is known from t0 — an idle session that never runs a turn never
      // emits its `init` message, and the run summary should still name
      // the session. Resume/continue sessions take their id from `init`
      // instead (the SDK forbids combining `sessionId` with them).
      let sessionId: string | null = null;
      if (options.resume === undefined) {
        sessionId = randomUUID();
        sdkOptions.sessionId = sessionId;
      }

      log('claude: starting agent sdk session', {
        executable: executable?.path,
        model: options.model ?? null,
        resume: options.resume ?? null,
        sessionId,
        cwd: ctx.cwd,
      });

      const q: Query = query({ prompt: queue.stream(), options: sdkOptions });

      let announcedSessionId = sessionId;
      const printer = createClaudeActivityPrinter();
      const consumed = (async (): Promise<void> => {
        try {
          for await (const message of q) {
            if (message.type === 'system' && message.subtype === 'init') {
              // `init` re-fires on /clear- or compact-style restarts
              // and may rotate the id — the latest one wins.
              sessionId = message.session_id;
              log('claude: session initialized', {
                sessionId,
                model: message.model,
                apiKeySource: message.apiKeySource,
                claudeCodeVersion: message.claude_code_version,
              });
              if (announcedSessionId !== sessionId) {
                announcedSessionId = sessionId;
                process.stderr.write(
                  `csuite claude: session ${sessionId} — pick it up later with: csuite claude --resume ${sessionId}\n`,
                );
              }
            }
            printer.handle(message);
          }
          log('claude: message stream ended');
        } catch (err) {
          // The stream ends with an error when the subprocess dies or
          // is torn down mid-iteration; the child's exit handler owns
          // the exit code, this is diagnostics only.
          log('claude: message stream error', {
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          printer.close();
        }
      })();

      // If the SDK fails before ever spawning the subprocess (bad
      // executable, option validation), no child exit will settle the
      // promise — resolve it from the stream's end instead.
      void consumed.finally(() => {
        if (child === null) settleExit(1);
      });

      process.stderr.write(
        (sessionId !== null
          ? `csuite claude: session ${sessionId} — pick it up later with: csuite claude --resume ${sessionId}\n`
          : '') +
          `csuite claude: agent running headless — Ctrl-C to stop. Direct it via the broker:\n` +
          `    csuite push --agent ${runner.briefing.name} --body "your instructions"\n\n`,
      );

      // HUD strip — same chrome as `csuite codex`: a 2-row footer
      // showing `csuite · ● <state>` + agent name. `reserveBottomSpace`
      // because our banners scrolled the cursor to the bottom row (see
      // the codex adapter for the full story), and one explicit
      // `redraw()` because there is no PTY relay driving repaints.
      const hud: HudHandle = startHud({
        presence: ctx.presence,
        label: `csuite claude · ${runner.briefing.name}`,
        reserveBottomSpace: true,
        log,
      });
      hud.redraw();

      let shutdownDone = false;
      return {
        exitCode,
        sessionId: () => sessionId,
        async shutdown(reason: string): Promise<void> {
          if (shutdownDone) return;
          shutdownDone = true;
          // Close the HUD first so its scroll-region is released before
          // teardown chatter scrolls.
          hud.close();
          if (queue.depth > 0) {
            // Deliberately NOT flushed: delivering queued broker events
            // now would start a fresh turn in a session that is being
            // torn down. The broker still holds the messages; they
            // replay on the next session's SSE subscribe.
            log('claude: dropping queued channel events at shutdown', { queued: queue.depth });
          }
          queue.close();
          try {
            await withTimeout(q.interrupt(), 2_000);
          } catch {
            // No active turn / already gone — either way we proceed.
          }
          q.close();
          const settled = await withTimeout(exitCode, 5_000).catch(() => null);
          if (settled === null) {
            const proc = child;
            if (proc !== null && proc.exitCode === null && proc.signalCode === null) {
              log('claude: force-killing agent subprocess', { reason });
              try {
                proc.kill('SIGKILL');
              } catch {
                /* already gone */
              }
            }
          }
          await consumed.catch(() => {});
        },
      };
    },

    async doctor(): Promise<AgentDoctorCheck[]> {
      const resolved = executable ?? resolveClaudeExecutable();
      const checks: AgentDoctorCheck[] = [
        {
          name: 'claude agent sdk',
          status: 'PASS',
          detail: `@anthropic-ai/claude-agent-sdk ${resolved.sdkVersion ?? 'unknown version'}`,
        },
      ];
      if (resolved.source === 'env') {
        checks.push({
          name: 'claude executable',
          status: 'WARN',
          detail: `CLAUDE_PATH override in effect: ${resolved.path} (the SDK's bundled Claude Code is bypassed)`,
        });
      } else {
        checks.push({
          name: 'claude executable',
          status: 'PASS',
          detail: `bundled Claude Code ${resolved.bundledCliVersion ?? 'unknown version'} at ${resolved.path}`,
        });
      }
      return checks;
    },
  };
}
