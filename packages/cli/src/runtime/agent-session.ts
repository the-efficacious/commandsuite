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
 *   4. `startRunner` (instructions, IPC socket, forwarder, capture host,
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
import type { Logger } from 'csuite-core';
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
import {
  type ContextControlCoordinator,
  createContextControlCoordinator,
} from './context-control.js';
import type { ContextControlEvent } from './forwarder.js';
import { createPresence } from './presence.js';
import { createRestartCoordinator, type RestartCoordinator } from './restart.js';
import { type RunnerHandle, RunnerStartupError, startRunner } from './runner.js';
import { createSessionLog } from './session-log.js';
import type { ActivityUploaderStats } from './trace/activity-uploader.js';

/** Inputs common to every runner verb. Runner-specific knobs (claude
 * args, codex --resume, ...) live on the adapter, not here. */
export interface AgentSessionInput {
  url?: string;
  token?: string;
  resolveReplacementToken?: () => string | null;
  /** Working directory for the agent. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Logger override. When absent the driver owns a session log. */
  logger?: Logger;
  /** Disable the capture subsystem (no uploader, hooks, or OTEL env). */
  noTrace?: boolean;
  /** Skip resolving/injecting broker-held secrets. */
  noSecrets?: boolean;
  /** Do not restart automatically when the broker reports an environment change. */
  noEnvReload?: boolean;
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
  capture: ActivityUploaderStats | null;
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
  const ownedSessionLog = input.logger ? null : createSessionLog({ component: meta.id });
  const log = input.logger ?? (ownedSessionLog as NonNullable<typeof ownedSessionLog>).logger;

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
  // The restart coordinator exists only once an agent process does;
  // an instruction event in the startup window is remembered and
  // replayed to it (rare, but an edit can land between the packet
  // fetch and the first spawn).
  let coordinator: RestartCoordinator | null = null;
  let instructionsEventBeforeSpawn = false;
  let environmentEventBeforeSpawn = false;
  // Same story for context controls: the coordinator needs a live agent
  // process, so a control landing in the startup window is held and
  // replayed once one exists. Held rather than dropped because the
  // broker is waiting on an outcome event for it either way.
  let contextControl: ContextControlCoordinator | null = null;
  const contextControlsBeforeSpawn: ContextControlEvent[] = [];

  /**
   * The agent-lifecycle lock. Both the restart coordinator and a
   * `clear` stop and respawn the SAME process, so they are serialized
   * against each other here rather than each holding a private guard —
   * two private guards is how you get a clear swapping a process a
   * restart is midway through replacing.
   */
  let lifecycleLock: Promise<unknown> = Promise.resolve();
  const withLifecycleLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lifecycleLock.then(fn, fn);
    // The chain must not inherit this call's rejection, or one failed
    // swap would poison every later one.
    lifecycleLock = run.catch(() => undefined);
    return run;
  };
  let runner: RunnerHandle;
  try {
    runner = await startRunner({
      url,
      token,
      resolveReplacementToken: input.resolveReplacementToken,
      logger: log.child('runner'),
      presence,
      noTrace: input.noTrace,
      noSecrets: input.noSecrets,
      onInstructionsEvent: () => {
        if (coordinator !== null) coordinator.request();
        else instructionsEventBeforeSpawn = true;
      },
      onEnvironmentEvent: () => {
        if (input.noEnvReload) return;
        if (coordinator !== null) coordinator.request();
        else environmentEventBeforeSpawn = true;
      },
      onContextControlEvent: (control) => {
        if (contextControl !== null) void contextControl.handle(control);
        else contextControlsBeforeSpawn.push(control);
      },
      ...runnerOptions,
    });
  } catch (err) {
    ownedSessionLog?.close();
    if (err instanceof RunnerStartupError) throw new UsageError(err.message);
    throw err;
  }
  log.info('runner started', {
    socketPath: runner.socketPath,
    name: runner.instructions.name,
    role: runner.instructions.role.title,
    team: runner.instructions.team.name,
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
      log.warn('runner shutdown failed during prepare cleanup', {
        error: shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr),
      });
    });
    closeLogAndThrow(err);
  }

  // 5. Standard operator banner — identical header across runners, then
  //    whatever the adapter wants to disclose (config paths, posture).
  const bannerLines = [
    `csuite ${meta.id}: runner cwd = ${resolve(cwd)}`,
    `csuite ${meta.id}: agent = ${runner.instructions.name} (${runner.instructions.role.title}) on team ${runner.instructions.team.name}`,
    ...(ctx.sessionLogPath ? [`csuite ${meta.id}: session log = ${ctx.sessionLogPath}`] : []),
    ...(prepared.bannerLines ?? []),
  ];
  process.stderr.write(`${bannerLines.join('\n')}\n`);

  // Last-ditch restore if the node process itself is dying — the
  // operator's config files must be restored even on an unhandled crash.
  const onUncaught = (err: unknown): void => {
    log.error('uncaught exception', {
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
  // The initial generation's resume posture comes from the adapter's
  // plan (same facts spawn() will use); a resume-or-start fallback is
  // typed here so a wiped state dir shows in the trace, not only in a
  // runner log line.
  const initialPlan = adapter.initialResumePlan?.(ctx) ?? null;
  runner.captureHost?.enqueue({
    kind: 'session_start',
    ts: startedAt,
    runner: meta.id,
    runnerVersion: CLI_VERSION,
    captureTier: meta.captureTier,
    ...(initialPlan !== null
      ? {
          resumed: initialPlan.resumed,
          ...(initialPlan.reason !== undefined ? { resumeReason: initialPlan.reason } : {}),
        }
      : {}),
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
      log.warn('runner shutdown failed after spawn failure', {
        error: shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr),
      });
    });
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUncaught);
    closeLogAndThrow(err);
  }

  // The live agent process. A restart swaps it for a successor; every
  // consumer below (teardown, signal handlers, exit watching) reads
  // the CURRENT one rather than closing over the first.
  let currentProc: AgentProcess = proc;
  // Which process the restart coordinator is deliberately stopping —
  // its exit is a phase of the swap, not the end of the session.
  let expectedRestartExit: AgentProcess | null = null;
  // Re-arms exit watching for each successor; assigned inside the
  // wait loop below where the settle function lives.
  let attachGenerationWatch: (p: AgentProcess) => void = () => {};
  // Per-generation start time, so each session_end reports its own
  // generation's duration.
  let generationStartedAt = startedAt;

  // 7. Idempotent teardown. Ordering: restart coordinator quiesced →
  //    agent flush → file restore → session_end → runner drain →
  //    summary. Double-calls await the first invocation.
  let teardownPromise: Promise<number> | null = null;
  const teardown = (reason: string): Promise<number> => {
    if (teardownPromise !== null) return teardownPromise;
    teardownPromise = (async (): Promise<number> => {
      log.info('tearing down', { reason });
      // A restart cycle past its drain point finishes before teardown
      // proceeds — a half-swapped agent is worse than a completed
      // swap, and settled() bounds the wait to the cycle in flight.
      coordinator?.close();
      await coordinator?.settled();
      // Same reasoning for a control in flight: a clear past its stop
      // has an agent down and a successor to bring up, and tearing
      // down through that leaves the run summary describing a process
      // nobody is watching. `close()` also makes any control arriving
      // from here on ack `failed` rather than vanish.
      contextControl?.close();
      await contextControl?.settled();
      try {
        await currentProc.shutdown(reason);
      } catch (err) {
        log.error('agent shutdown failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      let exitCode: number;
      try {
        exitCode = await currentProc.exitCode;
      } catch {
        exitCode = 1;
      }
      try {
        prepared.cleanup();
      } catch (err) {
        log.error('prepared cleanup threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const summary = finishRun({
        meta,
        runner,
        log,
        reason,
        exitCode,
        startedAt: generationStartedAt,
        agentSessionId: currentProc.sessionId(),
      });
      await runner.shutdown(reason).catch((err) => {
        log.error('runner shutdown threw', {
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
      // (session log closes after the summary lands in it)
      ownedSessionLog?.close();
      return exitCode;
    })();
    return teardownPromise;
  };

  // 8a. Restart support — only where the adapter can respawn and the
  //     runner owns the terminal. An instruction edit drains the agent
  //     at its next idle boundary, stops it gracefully, refetches the
  //     packet, and respawns resuming the same conversation under the
  //     new system prompt. Adapters without respawn stay on the old
  //     contract: edits apply at the next manual start, and the broker
  //     keeps listing the member restart-pending.
  if (meta.signals === 'teardown' && adapter.respawn !== undefined) {
    const respawn = adapter.respawn.bind(adapter);
    coordinator = createRestartCoordinator(
      {
        activity: () => runner.captureHost?.busy ?? null,
        detach: () => adapter.detachForRestart?.(),
        stopCurrent: async (reason) => {
          const prior = currentProc;
          expectedRestartExit = prior;
          await prior.shutdown(reason);
          const code = await prior.exitCode.catch(() => 1);
          finishRun({
            meta,
            runner,
            log,
            reason,
            exitCode: code,
            startedAt: generationStartedAt,
            agentSessionId: prior.sessionId(),
          });
          return { sessionId: prior.sessionId() };
        },
        refreshInstructions: () => runner.refreshInstructions(),
        refreshSecrets: () => runner.refreshSecrets(),
        respawn: async (prior) => {
          generationStartedAt = Date.now();
          runner.captureHost?.enqueue({
            kind: 'session_start',
            ts: generationStartedAt,
            runner: meta.id,
            runnerVersion: CLI_VERSION,
            captureTier: meta.captureTier,
            // An instruction/environment restart always resumes the
            // live conversation — that is its contract.
            resumed: true,
          });
          const next = await respawn(ctx, prior);
          currentProc = next;
          attachGenerationWatch(next);
          process.stderr.write(
            `csuite ${meta.id}: agent restarted to apply updated instructions\n`,
          );
        },
        gate: withLifecycleLock,
        log,
      },
      {
        onFailure: (err) => {
          log.error('restart failed — ending session', {
            error: err instanceof Error ? err.message : String(err),
          });
          void teardown('restart-failed');
        },
      },
    );
    if (instructionsEventBeforeSpawn || environmentEventBeforeSpawn) {
      if (environmentEventBeforeSpawn) {
        log.info('environment changed before agent spawn — scheduling one refresh cycle');
      }
      coordinator.request();
    }
  } else if (instructionsEventBeforeSpawn) {
    log.info('instructions changed before spawn — packet already current');
  }

  // 8a-bis. Context control — the broker's compact/clear verbs.
  //
  //   `clear` needs the same machinery a restart does (drain, detach,
  //     stop, refetch, respawn) and differs in exactly one input: the
  //     successor does NOT resume. It is gated on `respawn` for that
  //     reason.
  //   `compact` needs no swap at all — it asks the running agent and
  //     waits for the framework's verdict — so an adapter without
  //     `compactContext` still answers, with `unsupported`.
  //
  // Registered even when the adapter can do NEITHER, because the
  // broker is owed an outcome for every request it pushes. Silence is
  // the one answer this feature must never give.
  if (meta.signals === 'teardown') {
    const respawnForClear = adapter.respawn?.bind(adapter) ?? null;
    const compactForAdapter = adapter.compactContext?.bind(adapter) ?? null;
    contextControl = createContextControlCoordinator({
      activity: () => runner.captureHost?.busy ?? null,
      gate: withLifecycleLock,
      compact: async (reason) => {
        if (compactForAdapter === null) {
          return {
            supported: false,
            detail: `the ${meta.id} runner has no compaction operation`,
          };
        }
        return compactForAdapter(reason);
      },
      clear: async (reason) => {
        if (respawnForClear === null) {
          throw new Error(`the ${meta.id} runner cannot restart its agent in place`);
        }
        adapter.detachForRestart?.();
        const prior = currentProc;
        expectedRestartExit = prior;
        await prior.shutdown(reason);
        const code = await prior.exitCode.catch(() => 1);
        finishRun({
          meta,
          runner,
          log,
          reason,
          exitCode: code,
          startedAt: generationStartedAt,
          agentSessionId: prior.sessionId(),
        });
        // Refetch on the way through. A clear re-delivers instruction
        // blocks by definition, and delivering the STALE ones would
        // make a clear the one operation that can move a member
        // backwards. A failure here is not fatal — the cached packet
        // still beats a dead session, and the broker keeps listing the
        // member restart-pending if an edit was outstanding.
        try {
          await runner.refreshInstructions();
        } catch (err) {
          log.warn('instructions refetch failed during clear — using cached packet', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        generationStartedAt = Date.now();
        runner.captureHost?.enqueue({
          kind: 'session_start',
          ts: generationStartedAt,
          runner: meta.id,
          runnerVersion: CLI_VERSION,
          captureTier: meta.captureTier,
          resumed: false,
          resumeReason: 'context cleared',
        });
        const next = await respawnForClear(ctx, { resume: false });
        currentProc = next;
        attachGenerationWatch(next);
        process.stderr.write(`csuite ${meta.id}: context cleared — agent restarted cold\n`);
      },
      reload: async (reason) => {
        if (respawnForClear === null) {
          throw new Error(`the ${meta.id} runner cannot restart its agent in place`);
        }
        adapter.detachForRestart?.();
        const prior = currentProc;
        expectedRestartExit = prior;
        await prior.shutdown(reason);
        const code = await prior.exitCode.catch(() => 1);
        finishRun({
          meta,
          runner,
          log,
          reason,
          exitCode: code,
          startedAt: generationStartedAt,
          agentSessionId: prior.sessionId(),
        });
        try {
          await runner.refreshInstructions();
        } catch (err) {
          log.warn('instructions refetch failed during reload — using cached packet', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        try {
          await runner.refreshSecrets();
        } catch (err) {
          log.warn('environment refetch failed during reload — using cached environment', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        generationStartedAt = Date.now();
        runner.captureHost?.enqueue({
          kind: 'session_start',
          ts: generationStartedAt,
          runner: meta.id,
          runnerVersion: CLI_VERSION,
          captureTier: meta.captureTier,
          // A reload resumes the same conversation by definition.
          resumed: true,
        });
        const next = await respawnForClear(ctx, {
          resume: true,
          sessionId: prior.sessionId(),
        });
        currentProc = next;
        attachGenerationWatch(next);
        process.stderr.write(`csuite ${meta.id}: environment reloaded — agent resumed\n`);
      },
      report: (event) => {
        // The ack rides the activity plane, so it lands in the member's
        // trace next to the session_start a clear just produced and is
        // readable through `listActivity` and the web UI without a
        // second transport.
        runner.captureHost?.enqueue(event);
      },
      logger: log,
    });
    for (const pending of contextControlsBeforeSpawn) void contextControl.handle(pending);
    contextControlsBeforeSpawn.length = 0;
  }

  // 8b. Wait for the session to end, per the adapter's signal mode.
  let exitCode: number;
  if (meta.signals === 'forward') {
    // The agent owns the terminal: forward signals, session ends when
    // the agent exits. (No restart support here — the agent's TTY
    // ownership makes a silent respawn wrong anyway.)
    const onSigint = (): void => currentProc.signal?.('SIGINT');
    const onSigterm = (): void => currentProc.signal?.('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    exitCode = await currentProc.exitCode;
    await teardown(`agent-exited-${exitCode}`);
    removeProcessHandlers({ sigint: onSigint, sigterm: onSigterm });
  } else {
    // The runner owns the terminal: a signal ends the session; so does
    // the agent exiting on its own (its code propagates). Exits the
    // restart coordinator caused are a phase of the swap, not the end
    // of the session — the successor re-arms the watch.
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
      const watchExit = (p: AgentProcess): void => {
        void p.exitCode.then((code) => {
          if (expectedRestartExit === p) return;
          if (currentProc !== p) return; // superseded generation
          finish(`agent-exited-${code}`);
        });
      };
      attachGenerationWatch = watchExit;
      watchExit(currentProc);
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
    member: args.runner.instructions.name,
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
  log.info('run summary', { ...summary });
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
