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
 *     instructions pinned into the Claude Code system-prompt preset, the
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
 * in-process callbacks, and the instructions rides an SDK option — so
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
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  Query,
  SDKMessage,
  Options as SdkOptions,
  SpawnedProcess,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { logger as defaultLogger } from 'csuite-core';
import type { CompactAttempt } from '../context-control.js';
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
  RespawnPosture,
} from './adapter.js';
import {
  type ClaudeExecutable,
  ClaudeSdkAbsentError,
  hasClaudeSessionFor,
  isSdkAbsentImportError,
  resolveClaudeExecutable,
} from './claude.js';

/**
 * The Agent SDK is an optional dependency, loaded only here and only at
 * session start: every broker-side verb must keep working on an install
 * without it. `locate()` reports absence first with the operator-facing
 * message; this guard covers the SDK vanishing between locate and spawn.
 * Only the package itself being absent maps to the advisory error — a
 * present-but-broken SDK (missing sub-dependency, corrupt module) is a
 * real failure and propagates as one.
 */
let loadedQuery: typeof sdkQuery | null = null;
async function loadSdkQuery(): Promise<typeof sdkQuery> {
  if (loadedQuery === null) {
    try {
      ({ query: loadedQuery } = await import('@anthropic-ai/claude-agent-sdk'));
    } catch (err) {
      if (isSdkAbsentImportError(err)) throw new ClaudeSdkAbsentError();
      throw err;
    }
  }
  return loadedQuery;
}

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
          log.warn('hook forward failed (busy signal degraded)', {
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

/**
 * uid-0 posture. Claude refuses `--dangerously-skip-permissions` as
 * root, so a root session is a hard preflight FAIL — unless the
 * environment DECLARES a root container via IS_SANDBOX, which the
 * vendor reads for presence (not truth): the refusal is skipped, the
 * session runs, and nothing constrains what it writes — the whole
 * filesystem is root-writable. That earns a WARN, not silence.
 */
function claudeRootCheck(): AgentDoctorCheck {
  const name = 'not running as root';
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) {
    return {
      name,
      status: 'WARN',
      detail:
        'no effective uid on this platform — cannot verify the session user; a ' +
        'root session would surface at spawn instead',
    };
  }
  if (uid !== 0) {
    return { name, status: 'PASS', detail: `uid ${uid}` };
  }
  const sudoUser = process.env.SUDO_USER;
  const sudoPart =
    sudoUser !== undefined && sudoUser !== '' && sudoUser !== 'root'
      ? ` Drop the sudo to run as ${sudoUser}.`
      : '';
  const sandbox = process.env.IS_SANDBOX;
  if (sandbox !== undefined && sandbox !== '') {
    return {
      name,
      status: 'WARN',
      detail:
        'uid 0 with IS_SANDBOX set — claude skips its root refusal in declared ' +
        'containers, so the session runs; nothing constrains what it writes, and ' +
        `the whole filesystem is root-writable.${sudoPart}`,
    };
  }
  return {
    name,
    status: 'FAIL',
    detail:
      'uid 0 — claude refuses --dangerously-skip-permissions as root, and the ' +
      'runner depends on that flag. Run csuite claude from an ordinary user ' +
      `account.${sudoPart}`,
  };
}

export function createClaudeAdapter(options: ClaudeAdapterOptions): AgentAdapter {
  let executable: ClaudeExecutable | null = null;
  // Populated by prepare(), consumed by spawn(); the mutable parts
  // (systemPrompt, env, resume/sessionId) are refreshed by respawn().
  let sdkOptions: SdkOptions = {};

  // Streaming-input queue + channel sink, live from construction: the
  // runner needs a sink before the agent spawns, and events arriving
  // during the SDK subprocess's cold start simply wait in the stream.
  // A REF, not a const queue: the sink reads it at flush time, so a
  // restart re-points it at a fresh queue (detachForRestart) and the
  // swap window buffers for the successor instead of dropping.
  const queueRef = { current: new ClaudeMessageQueue() };
  let sink: ClaudeChannelSink | null = null;

  // What resume posture the NEXT spawn uses. Starts as the operator's
  // choice; respawn() overrides it with the predecessor's session id
  // so the successor continues the same conversation under the new
  // system prompt.
  let effectiveResume: string | true | undefined = options.resume;
  // The initial resume plan, computed ONCE from the ORIGINAL ask
  // (options.resume) and the on-disk facts — immune to prepare()'s
  // later mutation of effectiveResume, so the session_start stamp and
  // the spawn behavior always tell the same story.
  let cachedInitialPlan: { resumed: boolean; reason?: string } | null = null;
  const computeInitialPlan = (cwd: string): { resumed: boolean; reason?: string } => {
    if (cachedInitialPlan === null) {
      if (options.resume === undefined) cachedInitialPlan = { resumed: false };
      else if (typeof options.resume === 'string') cachedInitialPlan = { resumed: true };
      else
        cachedInitialPlan = hasClaudeSessionFor(cwd)
          ? { resumed: true }
          : { resumed: false, reason: 'no previous session in this directory' };
    }
    return cachedInitialPlan;
  };

  const composeChildEnv = (ctx: AgentSessionContext): Record<string, string | undefined> => {
    const { runner, log } = ctx;
    // The SDK `env` option replaces the subprocess environment. Compose
    // this for every generation: secrets and capture-host credentials are
    // mutable runner state, just like instructions and resume posture.
    const env: Record<string, string | undefined> = { ...process.env };
    const secretNames = Object.keys(runner.secretsEnv);
    if (secretNames.length > 0) {
      for (const [k, v] of Object.entries(runner.secretsEnv)) env[k] = v;
      log.info('broker secrets injected into agent env', { envNames: secretNames });
    }
    if (runner.captureHost !== null) {
      for (const [k, v] of Object.entries(runner.captureHost.envVars())) env[k] = v;
      log.info('capture host armed (transcript capture)', {
        hookUrl: runner.captureHost.hookEndpointUrl,
      });
    }
    return env;
  };

  // ── Compaction request/ack correlation ───────────────────────────
  //
  // `/compact` goes in as ordinary streaming user input — the exact
  // path a channel event takes — because the Agent SDK's `Query`
  // exposes no compaction control method. What makes that honest
  // rather than fire-and-forget is that the CLI ANSWERS: a
  // `system/status` message carries `compact_result: 'success' |
  // 'failed'` (with `compact_error` on failure), and a successful
  // compaction is followed by a `compact_boundary` carrying the
  // measured `pre_tokens` / `post_tokens`.
  //
  // So the outcome the broker acks is the framework's own report, not
  // an assumption that the message was delivered.
  interface PendingCompact {
    settle(attempt: CompactAttempt): void;
    /** Set once `compact_result: 'success'` lands, awaiting tokens. */
    succeeded: boolean;
    timer: NodeJS.Timeout | null;
  }
  let pendingCompact: PendingCompact | null = null;

  /**
   * How long to wait for the `compact_boundary` after a success is
   * reported. The boundary carries the token deltas and follows the
   * status message closely; if it does not arrive we still ack
   * `applied` without the measurement, because a compaction that
   * happened is not made un-happened by a missing statistic.
   */
  const COMPACT_BOUNDARY_GRACE_MS = 3_000;
  /**
   * Upper bound on the whole request. Summarising a large conversation
   * is genuinely slow (21s measured on a 26k-token context), so this is
   * generous — but it must exist, or an agent that died mid-compaction
   * leaves the broker's request outstanding forever.
   */
  const COMPACT_TIMEOUT_MS = 180_000;

  const finishCompact = (attempt: CompactAttempt): void => {
    const pending = pendingCompact;
    if (pending === null) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pendingCompact = null;
    pending.settle(attempt);
  };

  /**
   * Route a framework message into a waiting compaction request.
   * Called for every SDK message so the correlation lives in one place
   * rather than being scattered through the consume loop.
   */
  const observeCompactionMessage = (message: SDKMessage): void => {
    const pending = pendingCompact;
    if (pending === null) return;
    if (message.type === 'system' && message.subtype === 'status') {
      if (message.compact_result === 'failed') {
        // A refusal, not an error — "Not enough messages to compact."
        // is the framework declining, and the reason is what makes the
        // decline actionable rather than mysterious.
        finishCompact({
          supported: true,
          applied: false,
          detail: message.compact_error ?? 'the agent reported the compaction failed',
        });
        return;
      }
      if (message.compact_result === 'success') {
        // Hold briefly for the boundary's token measurement.
        pending.succeeded = true;
        if (pending.timer !== null) clearTimeout(pending.timer);
        const t = setTimeout(() => {
          finishCompact({ supported: true, applied: true });
        }, COMPACT_BOUNDARY_GRACE_MS);
        t.unref?.();
        pending.timer = t;
      }
      return;
    }
    if (message.type === 'system' && message.subtype === 'compact_boundary' && pending.succeeded) {
      const meta = message.compact_metadata;
      finishCompact({
        supported: true,
        applied: true,
        ...(typeof meta?.pre_tokens === 'number' && typeof meta?.post_tokens === 'number'
          ? { tokensBefore: meta.pre_tokens, tokensAfter: meta.post_tokens }
          : {}),
      });
    }
  };

  const adapter: AgentAdapter = {
    meta: CLAUDE_META,

    locate(): void {
      executable = resolveClaudeExecutable();
    },

    binaryPath(): string | null {
      return executable?.path ?? null;
    },

    runnerOptions() {
      sink = createClaudeChannelSink({
        getQueue: () => queueRef.current,
        // The session log isn't created yet when runnerOptions() is
        // called, so this goes to the shared default sink rather than
        // the session file. Once spawn() runs the sink is quiet anyway
        // except for per-event debug lines.
        log: defaultLogger.child('claude-sink'),
      });
      return { channelSink: sink, requireRawBodyAck: true };
    },

    prepare(ctx: AgentSessionContext): AgentPrepared {
      const { runner, cwd, log } = ctx;
      const bannerLines: string[] = [];
      if (effectiveResume === true && computeInitialPlan(cwd).reason !== undefined) {
        // Bare --resume is resume-or-start: the SDK's `continue` errors
        // on an empty project dir, and under Restart=always that's an
        // infinite loop. Loud instead: this line, the banner, and
        // resumed:false with a reason on session_start (stamped from
        // the same cached plan, whatever the call order).
        effectiveResume = undefined;
        log.info('resume: no previous claude session found — starting fresh', { cwd });
        bannerLines.push('csuite claude: no previous session here — starting fresh (--resume)');
      }
      const resolved = executable;
      if (resolved === null) {
        // locate() runs first on every driver path; belt and braces.
        throw new Error('claude adapter: prepare() called before locate()');
      }

      const instructions = composeFixedContext(runner.instructions);
      sdkOptions = {
        cwd,
        env: composeChildEnv(ctx),
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
        // instructions pinned on top — the SDK-native form of the old
        // `--append-system-prompt` injection.
        systemPrompt:
          instructions.length > 0
            ? { type: 'preset', preset: 'claude_code', append: instructions }
            : { type: 'preset', preset: 'claude_code' },
        // Team authority is the access control; the agent runs
        // unleashed, same posture as the CLI wrapper injected via
        // `--dangerously-skip-permissions`.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(typeof effectiveResume === 'string'
          ? { resume: effectiveResume }
          : effectiveResume === true
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
      if (instructions.length > 0) {
        bannerLines.push(
          `csuite claude: instructions pinned to system prompt (${instructions.length} chars)`,
        );
      }
      if (typeof effectiveResume === 'string') {
        bannerLines.push(`csuite claude: resuming session ${effectiveResume}`);
      } else if (effectiveResume === true) {
        bannerLines.push('csuite claude: continuing most recent session in this directory');
      }

      // Nothing was written anywhere — there is nothing to restore.
      return { bannerLines, cleanup: (): void => {} };
    },

    async spawn(ctx: AgentSessionContext): Promise<AgentProcess> {
      const { runner, log } = ctx;
      // Captured per spawn: a respawn re-points `queueRef` first, so
      // this generation's stream, depth checks, and shutdown all act
      // on ITS queue while the successor's fills behind it.
      const queue = queueRef.current;

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
          if (text.length > 0) log.debug('cli stderr', { data: text.slice(0, 2000) });
        });
        proc.on('exit', (code, signal) => {
          settleExit(code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 0));
        });
        proc.on('error', (err) => {
          log.error('failed to spawn claude', {
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
      if (effectiveResume === undefined) {
        sessionId = randomUUID();
        sdkOptions.sessionId = sessionId;
      }

      log.info('starting agent sdk session', {
        executable: executable?.path,
        model: options.model ?? null,
        resume: effectiveResume ?? null,
        sessionId,
        cwd: ctx.cwd,
      });

      const q: Query = (await loadSdkQuery())({ prompt: queue.stream(), options: sdkOptions });

      let announcedSessionId = sessionId;
      const printer = createClaudeActivityPrinter();
      const consumed = (async (): Promise<void> => {
        try {
          for await (const message of q) {
            if (message.type === 'system' && message.subtype === 'init') {
              // `init` re-fires on /clear- or compact-style restarts
              // and may rotate the id — the latest one wins.
              sessionId = message.session_id;
              log.info('session initialized', {
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
            observeCompactionMessage(message);
            printer.handle(message);
          }
          log.info('message stream ended');
        } catch (err) {
          // The stream ends with an error when the subprocess dies or
          // is torn down mid-iteration; the child's exit handler owns
          // the exit code, this is diagnostics only.
          log.error('message stream error', {
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
          `    csuite push --agent ${runner.instructions.name} --body "your instructions"\n\n`,
      );

      // HUD strip — same chrome as `csuite codex`: a 2-row footer
      // showing `csuite · ● <state>` + agent name. `reserveBottomSpace`
      // because our banners scrolled the cursor to the bottom row (see
      // the codex adapter for the full story), and one explicit
      // `redraw()` because there is no PTY relay driving repaints.
      const hud: HudHandle = startHud({
        presence: ctx.presence,
        label: `csuite claude · ${runner.instructions.name}`,
        reserveBottomSpace: true,
        logger: log,
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
            // replay on the next session's subscribe.
            log.warn('dropping queued channel events at shutdown', { queued: queue.depth });
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
              log.warn('force-killing agent subprocess', { reason });
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

    detachForRestart(): void {
      // Ambient input re-points to the successor's queue. The old
      // queue keeps whatever the dying generation has not consumed;
      // its shutdown logs and drops those (the broker replays unread
      // messages on the next subscribe anyway).
      queueRef.current = new ClaudeMessageQueue();
    },

    async respawn(ctx: AgentSessionContext, prior: RespawnPosture): Promise<AgentProcess> {
      const fresh = composeFixedContext(ctx.runner.instructions);
      // The four mutable spawn inputs, recomputed: system prompt and
      // child environment from the runner's CURRENT packet, resume
      // posture from the predecessor, and no minted session id (the SDK
      // forbids combining `sessionId` with resume/continue).
      sdkOptions.env = composeChildEnv(ctx);
      sdkOptions.systemPrompt =
        fresh.length > 0
          ? { type: 'preset', preset: 'claude_code', append: fresh }
          : { type: 'preset', preset: 'claude_code' };
      delete sdkOptions.sessionId;
      delete sdkOptions.continue;
      if (!prior.resume) {
        // A `clear`. Drop BOTH resume levers — leaving `continue` set
        // would silently reattach the conversation this exists to
        // discard, which is the failure the RespawnPosture union was
        // introduced to make unrepresentable. spawn() mints a fresh
        // session id when `effectiveResume` is undefined, so the
        // successor is identifiable from t0.
        effectiveResume = undefined;
        delete sdkOptions.resume;
        ctx.log.info('respawning cold — conversation dropped by context clear', {
          instructionChars: fresh.length,
        });
        return adapter.spawn(ctx);
      }
      if (prior.sessionId !== null) {
        effectiveResume = prior.sessionId;
        sdkOptions.resume = prior.sessionId;
      } else {
        // Predecessor never revealed an id (it may never have run a
        // turn). Continue the most recent session in this cwd rather
        // than starting cold.
        effectiveResume = true;
        delete sdkOptions.resume;
        sdkOptions.continue = true;
      }
      ctx.log.info('respawning with refreshed instructions', {
        instructionChars: fresh.length,
        resume: effectiveResume,
      });
      return adapter.spawn(ctx);
    },

    async compactContext(reason: string | undefined): Promise<CompactAttempt> {
      if (pendingCompact !== null) {
        return {
          supported: true,
          applied: false,
          detail: 'a compaction request is already in flight for this agent',
        };
      }
      // The slash command goes in as ordinary user input. Claude
      // Code's own input queue handles the turn mechanics: arriving
      // mid-turn it is queued and runs at the boundary, so the runner
      // does not need to drain first the way `clear` does.
      const body = reason !== undefined ? `/compact ${reason}` : '/compact';
      const accepted = queueRef.current.push({
        type: 'user',
        message: { role: 'user', content: body },
        parent_tool_use_id: null,
      });
      if (!accepted) {
        return {
          supported: true,
          applied: false,
          detail: 'the agent input stream is closed — the session is shutting down',
        };
      }
      return new Promise<CompactAttempt>((resolve) => {
        const timer = setTimeout(() => {
          pendingCompact = null;
          resolve({
            supported: true,
            applied: false,
            detail: `the agent did not report a compaction outcome within ${Math.round(COMPACT_TIMEOUT_MS / 1000)}s`,
          });
        }, COMPACT_TIMEOUT_MS);
        timer.unref?.();
        pendingCompact = { settle: resolve, succeeded: false, timer };
      });
    },

    async doctor(): Promise<AgentDoctorCheck[]> {
      // Binary/SDK facts are the shared `<id> binary` host check and
      // the prepare() banner; the adapter's own preflight is the one
      // property only this framework cares about this hard: claude
      // refuses `--dangerously-skip-permissions` as root, and the
      // runner depends on that flag.
      return [claudeRootCheck()];
    },

    initialResumePlan(ctx: AgentSessionContext): { resumed: boolean; reason?: string } | null {
      return computeInitialPlan(ctx.cwd);
    },
  };
  return adapter;
}
