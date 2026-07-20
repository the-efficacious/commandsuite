/**
 * Codex Adapter — orchestrates a single `csuite codex` session.
 *
 * Responsibilities:
 *
 *   1. Locate the `codex` binary.
 *   2. Set up the ephemeral `CODEX_HOME` (auth symlink + config.toml
 *      with our `[mcp_servers.csuite]` block).
 *   3. Spawn `codex app-server` (stdio JSON-RPC default transport).
 *   4. `initialize` handshake.
 *   5. Subscribe to thread/turn/item notifications and wire them into
 *      runner state: presence, status cache, active turn id, optional
 *      diagnostic logging.
 *   6. Auto-respond to any approval/elicitation server-requests with a
 *      deny (defense in depth — we configure approvalPolicy=never and
 *      mcp default_tools_approval_mode=never, so these shouldn't fire).
 *   7. `thread/start` — or `thread/resume` for a persisted thread —
 *      carrying the briefing as developerInstructions.
 *   8. Hold the process alive until codex exits (we treat codex exit
 *      as the runner's signal to stop).
 *   9. On shutdown: flush the channel sink, `turn/interrupt` if a turn
 *      is active, `close` the JSON-RPC client, kill codex if still
 *      alive, remove the ephemeral CODEX_HOME.
 *
 * The adapter is deliberately the only file that knows about codex
 * subprocess concerns. Everything beyond it (broker, tools dispatch,
 * MCP bridge, trace host) is shared with claude-code via the runner.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { BriefingResponse } from 'csuite-sdk/types';
import { CLI_VERSION } from '../../../version.js';
import type { Presence } from '../../presence.js';
import type { BusySignal } from '../../trace/busy.js';
import type { CaptureHost } from '../../trace/host.js';
import { type ActivityPrinter, attachCodexActivityPrinter } from './activity-printer.js';
import { attachBundleReader, type BundleReader } from './bundle-reader.js';
import { attachCodexBusySniff, type CodexBusySniff } from './busy-sniff.js';
import type { CodexChannelSink } from './channel-sink.js';
import { createCodexChannelSink } from './channel-sink.js';
import { setupCodexHome } from './codex-home.js';
import { createJsonRpcClient, type JsonRpcClient } from './json-rpc.js';
import {
  type ItemCompletedNotification,
  type ItemStartedNotification,
  METHODS,
  NOTIFICATIONS,
  SERVER_REQUEST_METHODS,
  type ThreadResumeResponse,
  type ThreadStartedNotification,
  type ThreadStartResponse,
  type ThreadStatus,
  type ThreadStatusChangedNotification,
  type TurnStartedNotification,
} from './protocol.js';
import { attachRolloutReader, type RolloutReader } from './rollout-reader.js';

export class CodexAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAdapterError';
  }
}

/** Locate the `codex` binary. Mirrors `findClaudeBinary`. */
export function findCodexBinary(): string {
  const fromEnv = process.env.CODEX_PATH;
  if (fromEnv && fromEnv.length > 0) {
    if (!existsSync(fromEnv)) {
      throw new CodexAdapterError(`CODEX_PATH points at ${fromEnv} but no file exists there`);
    }
    return fromEnv;
  }
  try {
    const out = execFileSync('which', ['codex'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out.length === 0) {
      throw new CodexAdapterError('which found no codex binary');
    }
    return out;
  } catch (err) {
    throw new CodexAdapterError(
      `failed to locate codex binary: ${err instanceof Error ? err.message : String(err)}\n` +
        '  Install OpenAI Codex CLI (npm i -g @openai/codex) and make sure it is on PATH, ' +
        'or set CODEX_PATH explicitly.',
    );
  }
}

export interface CodexSpawnOptions {
  briefing: BriefingResponse;
  /**
   * Path to the runner's IPC socket. Used both for the bridge subprocess
   * (via CODEX_HOME's config.toml env block) and is otherwise unused
   * by codex itself.
   */
  runnerSocketPath: string;
  /**
   * The `command` + `args` to write into `[mcp_servers.csuite]`. Must match
   * the same auto-detection the claude-code adapter does — point at this
   * cli's own dist so the bridge subprocess is reachable.
   */
  bridgeCommand: string;
  bridgeArgs: string[];
  /**
   * Capture host or null when --no-trace. Phase B's native codex
   * adapter will normalize the app-server item stream into
   * `ActivityEvent`s and push them through `captureHost.enqueue`. For
   * now it's threaded through but only its `busy` signal is consumed
   * (via the separate `busy` option below). There is no proxy/CA env
   * translation anymore — codex gets its own native capture in Phase B.
   */
  captureHost: CaptureHost | null;
  /**
   * Broker-held secrets to inject into codex's environment
   * (`RunnerHandle.secretsEnv`). Merged before the runner-managed
   * vars so CODEX_HOME / trace roots always win. Optional: absent
   * means no secrets.
   */
  secretsEnv?: Readonly<Record<string, string>>;
  /** Codex binary path, from `findCodexBinary()`. */
  codexBinary: string;
  /** Working directory for codex. Defaults to process.cwd. */
  cwd?: string;
  /** Optional model override (`--model`). */
  model?: string;
  /**
   * Extra args forwarded verbatim to `codex app-server` after the
   * subcommand. The operator is responsible for the codex version
   * accepting these; csuite passes them through unchanged.
   * Use codex's own `-c key=value` syntax to override config.toml entries,
   * e.g. `-c 'model_provider="qwen"'`.
   */
  codexArgs?: string[];
  /**
   * Resume a persisted thread instead of starting a fresh one. A string
   * is a codex thread id (from a previous run's banner/log) handed to
   * `thread/resume`; `true` means "the most recent thread this member
   * ran on this machine", resolved by scanning the durable sessions
   * dir. Requires the sessions of the run being resumed to have been
   * persisted (they are, by default, since sessions went durable).
   */
  resume?: string | true;
  /**
   * Durable per-member sessions dir override (tests). Default:
   * `$XDG_DATA_HOME/commandsuite/codex/sessions/<member>` (or the
   * `~/.local/share` equivalent). The ephemeral CODEX_HOME's `sessions/`
   * is symlinked here so thread rollouts survive teardown/crashes and
   * `thread/resume` works across runs.
   */
  sessionsDir?: string;
  /** Presence signal — flipped by status notifications. */
  presence: Presence;
  /**
   * Print human-readable activity lines (turn boundaries, tool calls,
   * streamed assistant prose) to stderr. Default `true`. Tests pass
   * `false` to keep their captured output clean; production always
   * leaves it on since the operator running `csuite codex` would
   * otherwise see no progress until the agent exits.
   */
  printActivity?: boolean;
  /**
   * Busy signal — bumped on each tool-execution `item/started` and
   * decremented on the matching `item/completed`. Optional: when
   * absent (e.g. `--no-trace`), tool-lifecycle events still get
   * logged but don't drive the indicator. Pass the same signal the
   * trace host uses so LLM-call and tool-execution bumps share one
   * 0↔busy transition contract.
   */
  busy?: BusySignal;
  /** Logger, structured JSON to stderr by default. */
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface CodexSpawnResult {
  /** Resolves with the exit code of codex when it terminates. */
  exitCode: Promise<number>;
  /** Pluggable sink the runner forwarder writes channel events into. */
  channelSink: CodexChannelSink;
  /**
   * The codex thread id this session runs on — what a later
   * `csuite codex --resume <id>` takes. Set once the thread/start (or
   * thread/resume) handshake completes, i.e. by the time `spawnCodex`
   * resolves.
   */
  getThreadId(): string | null;
  /** Best-effort graceful shutdown. Idempotent. */
  shutdown(reason?: string): Promise<void>;
}

/** Trailing codex thread uuid in a rollout filename. */
const ROLLOUT_THREAD_ID_RE =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Default durable sessions dir for a member. Data (not cache) — the
 * rollouts are the resume history, and a cache sweep must not eat them.
 */
export function defaultSessionsDir(memberName: string): string {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  // Member names come from the broker roster; sanitize anyway so a
  // hostile/odd name can't escape the directory.
  const safe = memberName.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(dataHome, 'commandsuite', 'codex', 'sessions', safe);
}

/**
 * `--resume` with no id: the most recent thread in the member's durable
 * sessions dir. Rollout filenames embed a sortable timestamp
 * (`rollout-<ISO>-<uuid>.jsonl`) under zero-padded `YYYY/MM/DD` dirs, so
 * the lexicographically greatest relative path is the newest thread.
 */
export function findLatestThreadId(sessionsDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir, { recursive: true }) as string[];
  } catch {
    return null;
  }
  const rollouts = entries.filter((rel) => ROLLOUT_THREAD_ID_RE.test(basename(rel))).sort();
  const newest = rollouts[rollouts.length - 1];
  if (newest === undefined) return null;
  const m = ROLLOUT_THREAD_ID_RE.exec(basename(newest));
  return m?.[1] ?? null;
}

export async function spawnCodex(opts: CodexSpawnOptions): Promise<CodexSpawnResult> {
  const cwd = opts.cwd ?? process.cwd();

  // 0. Durable sessions + resume resolution. Sessions persist per
  //    member so threads survive the ephemeral home; resolve `--resume`
  //    (bare form = newest rollout on disk) BEFORE touching anything so
  //    "nothing to resume" fails fast with no cleanup owed.
  const sessionsDir = opts.sessionsDir ?? defaultSessionsDir(opts.briefing.name);
  let resumeThreadId: string | null = null;
  if (opts.resume === true) {
    resumeThreadId = findLatestThreadId(sessionsDir);
    if (resumeThreadId === null) {
      throw new CodexAdapterError(
        `--resume: no previous codex session found for ${opts.briefing.name} ` +
          `(looked in ${sessionsDir}) — start one without --resume first`,
      );
    }
  } else if (typeof opts.resume === 'string') {
    resumeThreadId = opts.resume;
  }

  // 1. Set up ephemeral CODEX_HOME with our config.toml. When tracing is
  //    on (capture host present), include an [otel] block so codex ships
  //    its operational telemetry to the broker's OTLP logs endpoint.
  const codexHome = setupCodexHome({
    bridgeCommand: opts.bridgeCommand,
    bridgeArgs: opts.bridgeArgs,
    runnerSocketPath: opts.runnerSocketPath,
    otel: opts.captureHost ? opts.captureHost.otelLogsTarget() : undefined,
    sessionsDir,
  });
  if (resumeThreadId !== null && !codexHome.sessionsLinked) {
    // Without the durable link the fresh home's sessions/ is empty, so
    // codex cannot find the thread — fail now with the real cause
    // rather than surfacing codex's opaque "thread not found".
    codexHome.remove();
    throw new CodexAdapterError(
      '--resume: the durable sessions dir could not be linked into CODEX_HOME ' +
        '(see warning above), so the previous thread is not visible to codex',
    );
  }
  if (!codexHome.authLinked) {
    process.stderr.write(
      'csuite codex: no codex auth.json found in ~/.codex — run `codex login` first ' +
        'so the spawned codex can talk to OpenAI.\n',
    );
  }

  // 2. Build the codex subprocess env. CODEX_HOME points at our
  //    ephemeral dir. There is no proxy/CA translation anymore — the
  //    MITM is gone. Codex's native capture (a subscriber on the
  //    app-server item stream feeding `captureHost.enqueue`) lands in
  //    Phase B; until then codex runs with an untouched network env and
  //    only its busy signal is observed (via the `busy` option and the
  //    app-server notification sniff below).
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (opts.secretsEnv) {
    // Broker-held secrets first, runner-managed vars after — the
    // runner always wins on a (theoretical) name collision.
    for (const [k, v] of Object.entries(opts.secretsEnv)) {
      childEnv[k] = v;
    }
    const envNames = Object.keys(opts.secretsEnv);
    if (envNames.length > 0) {
      opts.log('codex: broker secrets injected into agent env', { envNames });
    }
  }
  childEnv.CODEX_HOME = codexHome.path;

  // Rollout-trace bundle root — the gen_ai + raw-body fidelity layer.
  // When tracing is on, point codex at a dir INSIDE the ephemeral
  // CODEX_HOME (so it's cleaned up with the home) where it writes each
  // inference's full Responses request/response payloads. The bundle
  // reader tails it and uploads to the broker's gen_ai ingest.
  let traceRoot: string | null = null;
  if (opts.captureHost) {
    traceRoot = join(codexHome.path, 'trace-root');
    mkdirSync(traceRoot, { recursive: true });
    childEnv.CODEX_ROLLOUT_TRACE_ROOT = traceRoot;
  }

  // 3. Spawn codex app-server. Default --listen=stdio:// — we own the
  //    child's stdin/stdout. csuite-injected flags are kept to zero so
  //    the same code path works across every codex version that ships
  //    `app-server` (older builds reject unknown flags). User-supplied
  //    `codexArgs` are appended verbatim — the operator has chosen
  //    their codex version and accepts responsibility for compatibility.
  opts.log('codex: spawning', {
    binary: opts.codexBinary,
    codexHome: codexHome.path,
    codexArgs: opts.codexArgs ?? [],
  });
  const child = spawn(opts.codexBinary, ['app-server', ...(opts.codexArgs ?? [])], {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let resolveExit: (code: number) => void = () => {};
  const exitCode = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  child.on('exit', (code, signal) => {
    const resolved = code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 0);
    opts.log('codex: child exited', { code: resolved, signal });
    resolveExit(resolved);
  });
  child.on('error', (err) => {
    opts.log('codex: spawn error', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  if (!child.stdin || !child.stdout) {
    codexHome.remove();
    throw new CodexAdapterError('codex spawned without stdin/stdout pipes');
  }

  // 4. Wire the JSON-RPC client.
  const rpc: JsonRpcClient = createJsonRpcClient(child.stdout, child.stdin, {
    log: opts.log,
  });

  // Auto-deny any approval/elicitation server-request that fires.
  // With our thread settings these shouldn't happen; the handlers
  // exist so a misconfigured run hangs visibly (with a log) rather
  // than silently waiting for a UI that doesn't exist.
  for (const method of Object.values(SERVER_REQUEST_METHODS)) {
    rpc.onRequest(method, async (params) => {
      opts.log('codex: auto-denying server request', { method, params });
      // Codex's response shape varies by method; an empty object
      // generally maps to "deny / cancel" semantics (the client
      // didn't pick a decision). For elicitations specifically we
      // return a `cancel` action. This is best-effort — if codex
      // demands a stricter shape, the request will surface as a
      // JSON deserialization error in codex's logs and we'll know
      // to refine the response.
      return { decision: 'deny', action: 'cancel' };
    });
  }

  // 5. State the channel sink reads via getters.
  let threadId: string | null = null;
  let lastStatus: ThreadStatus = { type: 'notLoaded' };
  let activeTurnId: string | null = null;

  // 6. Channel sink for the runner forwarder. Constructed BEFORE the
  //    notification handlers below because some of them call
  //    `channelSink.flushNow()`, and codex can fire notifications the
  //    instant we register the handlers (the channel is already open
  //    by the time `initialize` completes).
  const channelSink = createCodexChannelSink({
    rpc,
    getThreadId: () => threadId,
    getStatus: () => lastStatus,
    getActiveTurnId: () => activeTurnId,
    log: opts.log,
  });

  rpc.onNotification(NOTIFICATIONS.threadStarted, (params) => {
    const p = params as ThreadStartedNotification;
    if (p?.thread?.id) {
      threadId = p.thread.id;
      opts.log('codex: thread started', { threadId, status: p.thread.status?.type });
      if (p.thread.status) {
        applyStatus(p.thread.status);
      }
    }
  });
  /**
   * Centralised status updater. Called from three sources, all of which
   * carry the same `ThreadStatus` shape:
   *   - `thread/start` RPC response (initial)
   *   - `thread/started` notification (initial, redundant safety net)
   *   - `thread/status/changed` notification (transitions)
   * Without the first two, codex's habit of only emitting status-changed
   * on transitions would leave us stuck at `notLoaded` indefinitely on a
   * fresh idle thread, and the channel sink would buffer every inbound
   * director message forever.
   */
  function applyStatus(status: ThreadStatus): void {
    lastStatus = status;
    opts.log('codex: status changed', { status: status.type });
    switch (status.type) {
      case 'idle':
      case 'active':
        opts.presence.setOnline();
        break;
      case 'notLoaded':
        opts.presence.setConnecting();
        break;
      case 'systemError':
        opts.presence.setOffline();
        break;
    }
    if (status.type !== 'notLoaded') {
      void channelSink.flushNow().catch((err) => {
        opts.log('codex: status-driven flush failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  rpc.onNotification(NOTIFICATIONS.threadStatusChanged, (params) => {
    const p = params as ThreadStatusChangedNotification;
    if (!p?.status) return;
    applyStatus(p.status);
  });
  // Whole-turn `working` handles for the activity signal, keyed by
  // turnId. turn/started opens one; turn/completed (and teardown) close
  // them. This is the codex analogue of Claude Code's
  // UserPromptSubmit→Stop bracket, feeding the SAME `turn_active` source
  // so the WHOLE turn — model generation and tools — reads as `working`,
  // not just the tool windows the busy-sniff already covers. Codex leaves
  // `blocked` unset: approval/elicitation requests are auto-denied and
  // transient, so there's no human-blocking state to surface yet.
  const turnActiveHandles = new Map<string, { finish: () => void }>();
  const drainTurnActive = (): void => {
    if (turnActiveHandles.size === 0) return;
    for (const h of turnActiveHandles.values()) h.finish();
    turnActiveHandles.clear();
  };
  rpc.onNotification(NOTIFICATIONS.turnStarted, (params) => {
    const p = params as TurnStartedNotification;
    if (p?.turn?.id) {
      activeTurnId = p.turn.id;
      // Duplicate turn/started for the same id is a no-op.
      if (opts.busy && !turnActiveHandles.has(p.turn.id)) {
        turnActiveHandles.set(p.turn.id, opts.busy.start('turn_active'));
      }
    }
  });
  rpc.onNotification(NOTIFICATIONS.turnCompleted, () => {
    activeTurnId = null;
    // Codex runs one turn at a time, so a turn/completed ends whatever
    // turn_active handle is open — drain all rather than depend on the
    // completion payload carrying the id.
    drainTurnActive();
  });
  rpc.onNotification(NOTIFICATIONS.itemStarted, (params) => {
    const p = params as ItemStartedNotification;
    if (p?.item?.type) {
      opts.log('codex: item started', { type: p.item.type, turnId: p.turnId });
    }
  });
  rpc.onNotification(NOTIFICATIONS.itemCompleted, (params) => {
    const p = params as ItemCompletedNotification;
    if (p?.item?.type) {
      opts.log('codex: item completed', { type: p.item.type, turnId: p.turnId });
    }
  });
  // Tool-execution busy sniff (only when a busy signal is provided —
  // i.e., tracing is enabled). Subscribes to the same notifications
  // above; logging stays here, busy-counter ownership lives in the
  // shared helper so tests can exercise the same code path.
  const busySniff: CodexBusySniff | null = opts.busy
    ? attachCodexBusySniff({ rpc, busy: opts.busy, log: opts.log })
    : null;
  // Rollout-primary content capture — tails codex's own durable rollout
  // JSONL under the ephemeral CODEX_HOME and feeds normalized
  // `llm_exchange` / `tool_action` / `user_prompt` events to the capture
  // host's uploader. This is the SOLE content source; the app-server
  // stream stays presence/busy/printer-only, mirroring how the Claude
  // runner went transcript-primary with its hooks presence-only. Absent
  // under `--no-trace` (no capture host). Objective open/close markers
  // are emitted by the runner around this session, not here.
  const rolloutReader: RolloutReader | null = opts.captureHost
    ? attachRolloutReader({
        sessionsDir: join(codexHome.path, 'sessions'),
        getSessionId: () => threadId,
        enqueue: (event) => opts.captureHost?.enqueue(event),
        log: opts.log,
        // Sessions are durable now: files present at attach are prior
        // runs' history (already captured then). Only the resumed
        // thread's file is tailed — from EOF, so just this run's turns
        // flow. Falls back to legacy track-everything when the durable
        // link failed and the dir is genuinely per-run.
        preexisting: codexHome.sessionsLinked ? 'ignore' : 'track',
        ...(resumeThreadId !== null ? { resumeThreadId } : {}),
      })
    : null;
  // Rollout-trace bundle reader — the gen_ai + raw-body fidelity layer.
  // Tails the bundle codex writes under CODEX_ROLLOUT_TRACE_ROOT and
  // uploads each completed inference's verbatim payloads to the broker.
  const bundleReader: BundleReader | null =
    opts.captureHost && traceRoot
      ? attachBundleReader({
          traceRoot,
          upload: (inferences) => opts.captureHost?.uploadGenai(inferences) ?? Promise.resolve(),
          log: opts.log,
        })
      : null;
  // Activity printer — turn / item / delta notifications → readable
  // stderr lines for the operator. Subscribes alongside busy-sniff so
  // both observers see the same wire stream without ordering coupling.
  const activityPrinter: ActivityPrinter | null =
    opts.printActivity === false ? null : attachCodexActivityPrinter({ rpc, log: opts.log });
  rpc.onNotification(NOTIFICATIONS.error, (params) => {
    opts.log('codex: error notification', params as Record<string, unknown>);
  });

  // ─── Shutdown wiring ──────────────────────────────────────────
  // Hoisted ABOVE the initialize/thread-start blocks because their
  // catch handlers call `teardown()`. Function declarations are
  // hoisted, but `let teardownReason` is in TDZ until reached, so a
  // failed initialize would have crashed with "Cannot access
  // 'teardownReason' before initialization" — a real bug surfaced
  // the first time codex rejected one of our requests.
  let teardownReason: string | null = null;
  async function teardown(reason: string): Promise<void> {
    if (teardownReason !== null) return;
    teardownReason = reason;
    opts.log('codex: tearing down', { reason });
    try {
      await channelSink.flushNow();
    } catch (err) {
      opts.log('codex: final flush failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (threadId !== null && activeTurnId !== null) {
      try {
        await rpc.request(METHODS.turnInterrupt, {
          threadId,
          turnId: activeTurnId,
        });
      } catch {
        /* best-effort */
      }
    }
    // Drain any in-flight tool handles before we tear down the rpc
    // client — codex won't be sending matching `item/completed` once
    // we close, so anything left here would wedge the busy signal.
    busySniff?.drain();
    // Same for the whole-turn `turn_active` handle: a turn interrupted
    // at shutdown won't get its `turn/completed`, so close it here so
    // the activity signal returns to idle rather than waiting on the
    // watchdog.
    drainTurnActive();
    // Close the activity printer before rpc.close() so it can flush
    // any half-painted streaming assistant line with a final newline.
    activityPrinter?.close();
    rpc.close(reason);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    // Final drain + flush of the rollout reader BEFORE deleting the
    // ephemeral CODEX_HOME. The reader tails codex's rollout file off
    // disk, so the last turn's content must be captured before the rm
    // destroys it — the codex analogue of the raw-bodies-dir "capture
    // then remove" discipline.
    if (rolloutReader) {
      try {
        await rolloutReader.close();
      } catch (err) {
        opts.log('codex: rollout reader close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Same for the gen_ai bundle reader — final drain + upload before the
    // trace root (inside CODEX_HOME) is destroyed by the rm.
    if (bundleReader) {
      try {
        await bundleReader.close();
      } catch (err) {
        opts.log('codex: bundle reader close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    codexHome.remove();
  }

  // 7. Initialize handshake. Codex requires this before any other
  //    method will succeed.
  try {
    await rpc.request(METHODS.initialize, {
      clientInfo: { name: 'commandsuite-cli', version: CLI_VERSION },
    });
  } catch (err) {
    await teardown('initialize-failed');
    throw new CodexAdapterError(
      `codex initialize failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  opts.log('codex: initialize ok');

  // 8. Open the thread — `thread/start` fresh, or `thread/resume` when
  //    the caller named (or asked for the latest) persisted thread.
  //    Both carry the briefing as developerInstructions and lock down
  //    `approvalPolicy: never` so headless runs never elicit a UI
  //    prompt. On resume the overrides re-assert our posture on the
  //    reloaded thread; absent fields would keep whatever the persisted
  //    thread had, and a resumed agent must not come back more (or
  //    less) restricted than a fresh one.
  const developerInstructions =
    opts.briefing.instructions.length > 0 ? opts.briefing.instructions : undefined;
  // Match claude-code's posture: `--dangerously-skip-permissions` on the
  // claude side disables prompting but doesn't sandbox the filesystem or
  // network (claude has no built-in sandbox). `danger-full-access` is the
  // codex equivalent — same trust boundary, just expressed through codex's
  // explicit sandbox enum. Tighter modes (`workspace-write`, `read-only`)
  // are useful for review/CI scenarios; we'll surface them as a flag later.
  const threadPosture = {
    cwd,
    developerInstructions,
    model: opts.model,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  } as const;
  try {
    const resp =
      resumeThreadId !== null
        ? await rpc.request<ThreadResumeResponse>(METHODS.threadResume, {
            threadId: resumeThreadId,
            ...threadPosture,
          })
        : await rpc.request<ThreadStartResponse>(METHODS.threadStart, threadPosture);
    if (resp?.thread?.id) {
      threadId = resp.thread.id;
      opts.log(resumeThreadId !== null ? 'codex: thread/resume ok' : 'codex: thread/start ok', {
        threadId,
        status: resp.thread.status?.type,
      });
      if (resp.thread.status) {
        applyStatus(resp.thread.status);
      }
    }
  } catch (err) {
    const method = resumeThreadId !== null ? 'thread/resume' : 'thread/start';
    await teardown(`${method.replace('/', '-')}-failed`);
    const hint =
      resumeThreadId !== null
        ? ` (thread ${resumeThreadId} — was it started by csuite codex as ${opts.briefing.name} on this machine?)`
        : '';
    throw new CodexAdapterError(
      `codex ${method} failed: ${err instanceof Error ? err.message : String(err)}${hint}`,
    );
  }

  return {
    exitCode,
    channelSink,
    getThreadId: () => threadId,
    shutdown: teardown,
  };
}

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
