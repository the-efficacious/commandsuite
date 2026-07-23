/**
 * The shared agent-session driver — one lifecycle for every runner.
 *
 * `csuite claude` and `csuite codex` (and any future runner) are
 * thin wrappers that construct an `AgentAdapter` and hand it to
 * `runAgentSession`. The driver owns everything an adapter must never
 * re-implement, because getting it wrong corrupts operator state or
 * loses trace data:
 *
 *   1. Session log routing (TTY-safe structured logs)
 *   2. Auth resolution (`--token` / `$CSUITE_TOKEN`) → UsageError
 *   3. Fail-fast binary location BEFORE any side effects
 *   4. `startRunner` (briefing, IPC socket, forwarder, capture host,
 *      secrets) with the adapter's sink + bridge policy
 *   5. `prepare` → `spawn` ordering, with runner shutdown on failure
 *      at either step
 *   6. Signal handling per the adapter's declared mode (`forward` to
 *      the agent vs `teardown` of the session)
 *   7. Idempotent teardown on EVERY exit path — agent flush first,
 *      then user-file restoration, then runner drain — including a
 *      last-ditch `cleanup()` on uncaughtException
 *   8. The run bracket + summary: a `session_start` activity event
 *      before the agent runs, a `session_end` event (the
 *      machine-readable run summary) at teardown, a structured
 *      `run summary` log line, and a human-readable closing line
 *
 * Teardown ordering is load-bearing: the agent process is shut down
 * first so its capture readers flush their tail into the uploader;
 * user files are restored next; `session_end` is enqueued; and only
 * then does the runner shut down and drain the uploader — so the
 * terminal event ships with everything before it.
 */

import { resolve } from 'node:path';
import { DEFAULT_PORT, ENV } from 'csuite-sdk/protocol';
import { UsageError } from '../commands/errors.js';
import { CLI_VERSION } from '../version.js';
import type {
  AgentAdapter,
  AgentLog,
  AgentPrepared,
  AgentProcess,
  AgentSessionContext,
} from './agents/adapter.js';
import { AgentAdapterError } from './agents/adapter.js';
import { createPresence } from './presence.js';
import { type RunnerHandle, RunnerStartupError, startRunner } from './runner.js';
import { createSessionLog } from './session-log.js';

/** Inputs common to every runner verb. Runner-specific knobs (claude
 * args, codex --resume, ...) live on the adapter, not here. */
export interface AgentSessionInput {
  url?: string;
  token?: string;
  /** Working directory for the agent. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Logger override. When absent the driver owns a session log. */
  log?: AgentLog;
  /** Disable the capture subsystem (no uploader, hooks, or OTEL env). */
  noTrace?: boolean;
  /** Skip resolving/injecting broker-held secrets. */
  noSecrets?: boolean;
  /** Override the `csuite mcp-bridge` command (tests). */
  bridgeCommand?: string;
  /** Override the bridge args (tests). */
  bridgeArgs?: string[];
}

/**
 * Machine-readable account of one runner session, emitted on every
 * exit path as the final structured log line (`msg: "run summary"`).
 * The same facts ship to the broker as the `session_end` activity
 * event, so both the local log and the server tell the same story.
 */
export interface RunSummary {
  runner: string;
  member: string;
  reason: string;
  exitCode: number | null;
  durationMs: number;
  agentSessionId: string | null;
  capture: { enqueued: number; uploaded: number; dropped: number } | null;
}

/**
 * Run one agent session under a csuite runner. Resolves with the exit
 * code to propagate. Throws `UsageError` for operator-fixable
 * failures (missing token, missing binary, unreachable broker).
 */
export async function runAgentSession(
  adapter: AgentAdapter,
  input: AgentSessionInput,
): Promise<number> {
  const meta = adapter.meta;
  const ownedSessionLog = input.log ? null : createSessionLog({ component: meta.id });
  const log = input.log ?? (ownedSessionLog as NonNullable<typeof ownedSessionLog>).log;

  // Function declaration (not arrow) so TS control-flow analysis knows
  // calls to it never return — the try/catch blocks below rely on that.
  function closeLogAndThrow(err: unknown): never {
    ownedSessionLog?.close();
    if (err instanceof AgentAdapterError) throw new UsageError(err.message);
    throw err;
  }

  const url = input.url ?? process.env[ENV.url] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  const token = input.token ?? process.env[ENV.token];
  if (!token) {
    ownedSessionLog?.close();
    throw new UsageError(
      `--token or ${ENV.token} is required — run \`csuite connect\` to enroll this device, ` +
        `or pass the member's bearer token explicitly`,
    );
  }
  const cwd = input.cwd ?? process.cwd();

  // 1. Locate the agent binary before touching anything shared — a
  //    missing binary must not leave a socket bound or a file written.
  try {
    await adapter.locate();
  } catch (err) {
    closeLogAndThrow(err);
  }

  // 2. Start the runner with the adapter's framework-specific knobs.
  const presence = createPresence();
  const runnerOptions = adapter.runnerOptions?.() ?? {};
  let runner: RunnerHandle;
  try {
    runner = await startRunner({
      url,
      token,
      log,
      presence,
      noTrace: input.noTrace,
      noSecrets: input.noSecrets,
      ...runnerOptions,
    });
  } catch (err) {
    ownedSessionLog?.close();
    if (err instanceof RunnerStartupError) throw new UsageError(err.message);
    throw err;
  }
  log(`${meta.id}: runner started`, {
    socketPath: runner.socketPath,
    name: runner.briefing.name,
    role: runner.briefing.role.title,
    team: runner.briefing.team.name,
  });

  // 3. Bridge auto-detection: the same node binary + CLI entry script
  //    this process runs under, so the agent spawns the SAME csuite that
  //    spawned it — no PATH assumption. Tests override for explicit paths.
  const bridgeCommand = input.bridgeCommand ?? process.execPath;
  const bridgeArgs =
    input.bridgeArgs ?? (process.argv[1] ? [process.argv[1], 'mcp-bridge'] : ['mcp-bridge']);

  const ctx: AgentSessionContext = {
    runner,
    presence,
    cwd,
    bridgeCommand,
    bridgeArgs,
    log,
    sessionLogPath: ownedSessionLog?.path ?? null,
  };

  // 4. Prepare: agent config, env, args. A failure here aborts cleanly —
  //    nothing spawned yet, and prepare's contract is that a throw means
  //    it undid (or never made) its own writes.
  let prepared: AgentPrepared;
  try {
    prepared = await adapter.prepare(ctx);
  } catch (err) {
    await runner.shutdown('prepare-failed').catch((shutdownErr) => {
      log(`${meta.id}: runner shutdown failed during prepare cleanup`, {
        error: shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr),
      });
    });
    closeLogAndThrow(err);
  }

  // 5. Standard operator banner — identical header across runners, then
  //    whatever the adapter wants to disclose (config paths, posture).
  const bannerLines = [
    `csuite ${meta.id}: runner cwd = ${resolve(cwd)}`,
    `csuite ${meta.id}: agent = ${runner.briefing.name} (${runner.briefing.role.title}) on team ${runner.briefing.team.name}`,
    ...(ctx.sessionLogPath ? [`csuite ${meta.id}: session log = ${ctx.sessionLogPath}`] : []),
    ...(prepared.bannerLines ?? []),
  ];
  process.stderr.write(`${bannerLines.join('\n')}\n`);

  // Last-ditch restore if the node process itself is dying — the
  // operator's config files must be restored even on an unhandled crash.
  const onUncaught = (err: unknown): void => {
    log(`${meta.id}: uncaught exception`, {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    try {
      prepared.cleanup();
    } catch {
      /* ignore */
    }
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);

  const startedAt = Date.now();

  // Open the run bracket. Every runner emits the same pair regardless
  // of agent framework, so the activity stream can be sliced per run.
  runner.captureHost?.enqueue({
    kind: 'session_start',
    ts: startedAt,
    runner: meta.id,
    runnerVersion: CLI_VERSION,
    captureTier: meta.captureTier,
  });

  const removeProcessHandlers = (handlers: { sigint: () => void; sigterm: () => void }): void => {
    process.off('SIGINT', handlers.sigint);
    process.off('SIGTERM', handlers.sigterm);
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUncaught);
  };

  // 6. Spawn. On failure: restore files, close the bracket, shut the
  //    runner down, and surface the error.
  let proc: AgentProcess;
  try {
    proc = await adapter.spawn(ctx);
  } catch (err) {
    try {
      prepared.cleanup();
    } catch {
      /* cleanup is contractually non-throwing; belt and suspenders */
    }
    finishRun({
      meta,
      runner,
      log,
      reason: 'spawn-failed',
      exitCode: null,
      startedAt,
      agentSessionId: null,
    });
    await runner.shutdown('spawn-failed').catch((shutdownErr) => {
      log(`${meta.id}: runner shutdown failed after spawn failure`, {
        error: shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr),
      });
    });
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUncaught);
    closeLogAndThrow(err);
  }

  // 7. Idempotent teardown. Ordering: agent flush → file restore →
  //    session_end → runner drain → summary. Double-calls await the
  //    first invocation.
  let teardownPromise: Promise<number> | null = null;
  const teardown = (reason: string): Promise<number> => {
    if (teardownPromise !== null) return teardownPromise;
    teardownPromise = (async (): Promise<number> => {
      log(`${meta.id}: tearing down`, { reason });
      try {
        await proc.shutdown(reason);
      } catch (err) {
        log(`${meta.id}: agent shutdown failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      let exitCode: number;
      try {
        exitCode = await proc.exitCode;
      } catch {
        exitCode = 1;
      }
      try {
        prepared.cleanup();
      } catch (err) {
        log(`${meta.id}: prepared cleanup threw`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const summary = finishRun({
        meta,
        runner,
        log,
        reason,
        exitCode,
        startedAt,
        agentSessionId: proc.sessionId(),
      });
      await runner.shutdown(reason).catch((err) => {
        log(`${meta.id}: runner shutdown threw`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // Re-read capture stats AFTER the runner drained the uploader so
      // the printed summary counts the final flush (the session_end
      // event itself carries the pre-drain snapshot — it can't count
      // its own upload).
      if (runner.captureHost !== null) {
        summary.capture = runner.captureHost.stats();
      }
      emitSummary(meta.id, summary, log, ctx.sessionLogPath);
      ownedSessionLog?.close();
      return exitCode;
    })();
    return teardownPromise;
  };

  // 8. Wait for the session to end, per the adapter's signal mode.
  let exitCode: number;
  if (meta.signals === 'forward') {
    // The agent owns the terminal: forward signals, session ends when
    // the agent exits.
    const onSigint = (): void => proc.signal?.('SIGINT');
    const onSigterm = (): void => proc.signal?.('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    exitCode = await proc.exitCode;
    await teardown(`agent-exited-${exitCode}`);
    removeProcessHandlers({ sigint: onSigint, sigterm: onSigterm });
  } else {
    // The runner owns the terminal: a signal ends the session; so does
    // the agent exiting on its own (its code propagates).
    let onSigint: () => void = () => {};
    let onSigterm: () => void = () => {};
    exitCode = await new Promise<number>((resolvePromise) => {
      const finish = (reason: string): void => {
        void teardown(reason).then((code) => resolvePromise(code));
      };
      onSigint = () => finish('SIGINT');
      onSigterm = () => finish('SIGTERM');
      process.on('SIGINT', onSigint);
      process.on('SIGTERM', onSigterm);
      void proc.exitCode.then((code) => {
        void teardown(`agent-exited-${code}`).then(() => resolvePromise(code));
      });
    });
    removeProcessHandlers({ sigint: onSigint, sigterm: onSigterm });
  }

  return exitCode;
}

/**
 * Close the run bracket: compute the summary and enqueue the
 * `session_end` activity event (when capture is on). Called BEFORE
 * `runner.shutdown()` so the terminal event rides the final drain.
 */
function finishRun(args: {
  meta: AgentAdapter['meta'];
  runner: RunnerHandle;
  log: AgentLog;
  reason: string;
  exitCode: number | null;
  startedAt: number;
  agentSessionId: string | null;
}): RunSummary {
  const durationMs = Date.now() - args.startedAt;
  const capture = args.runner.captureHost?.stats() ?? null;
  const summary: RunSummary = {
    runner: args.meta.id,
    member: args.runner.briefing.name,
    reason: args.reason,
    exitCode: args.exitCode,
    durationMs,
    agentSessionId: args.agentSessionId,
    capture,
  };
  args.runner.captureHost?.enqueue({
    kind: 'session_end',
    ts: Date.now(),
    runner: args.meta.id,
    reason: args.reason,
    ...(args.exitCode !== null ? { exitCode: args.exitCode } : {}),
    durationMs,
    ...(args.agentSessionId !== null ? { agentSessionId: args.agentSessionId } : {}),
    ...(capture !== null ? { capture } : {}),
  });
  return summary;
}

/** Final structured log line + human-readable closing line. */
function emitSummary(
  id: string,
  summary: RunSummary,
  log: AgentLog,
  sessionLogPath: string | null,
): void {
  log(`${id}: run summary`, { ...summary });
  const capturePart =
    summary.capture === null
      ? 'capture disabled'
      : `captured ${summary.capture.enqueued} events (${summary.capture.uploaded} uploaded, ${summary.capture.dropped} dropped)`;
  const sessionPart = summary.agentSessionId ? ` · session ${summary.agentSessionId}` : '';
  const logPart = sessionLogPath ? ` · session log: ${sessionLogPath}` : '';
  process.stderr.write(
    `csuite ${id}: session ended — exit ${summary.exitCode ?? '?'} (${summary.reason}) ` +
      `after ${formatDuration(summary.durationMs)} · ${capturePart}${sessionPart}${logPart}\n`,
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${(minutes % 60).toString().padStart(2, '0')}m`;
}
