/**
 * The csuite runner — the parent process that owns a csuite session.
 *
 * The runner holds all the heavyweight state for a single agent run:
 *
 *   - the broker `Client` (authenticated to the csuite server)
 *   - the cached `BriefingResponse` (name, role, permissions, team
 *     directive/context, initial open objectives)
 *   - the live SSE forwarder (chat + objective events from the broker)
 *   - the objectives tracker (keeps the "open objectives" snapshot
 *     fresh — it seeds the context re-brief pushed at session attach
 *     and after context compaction)
 *   - the IPC server that the MCP bridge (a stdio MCP server spawned
 *     by the agent) connects to over a Unix domain socket
 *
 * The runner speaks the IPC protocol defined in `ipc.ts`. When a
 * bridge connects, the runner waits for `mcp_request` frames and
 * dispatches them to the existing tool handlers (`handleToolCall` +
 * `defineTools`), then replies with `mcp_response` frames. Inbound
 * SSE events from the broker are pushed out to the connected bridge
 * as `mcp_notification` frames; the runner's own `context_refresh`
 * re-briefs ride the same path (or the per-runner notification sink
 * for codex).
 *
 * Runners are single-bridge. If a second bridge connects while one
 * is already attached, the newer connection wins and the older one
 * is dropped with a `shutdown` frame. This matches the "one agent
 * per runner" constraint for v1 — multiple agents = multiple runner
 * processes.
 *
 * Lifecycle:
 *   startRunner()      → fetches briefing, binds the IPC socket,
 *                        starts the forwarder, returns a handle
 *   handle.waitClosed  → resolves when the runner has fully torn down
 *   handle.shutdown()  → graceful shutdown (abort forwarder, drop
 *                        bridge connection, close the IPC server,
 *                        unlink the socket)
 *
 * This module is deliberately transport-agnostic about MCP: we do
 * NOT import `StdioServerTransport` or construct an MCP `Server`
 * here. That lives in `bridge.ts`. The runner just dispatches tool
 * requests and forwards channel events — the actual JSON-RPC envelope
 * handling happens at the bridge process.
 */

import { unlinkSync } from 'node:fs';
import type { Socket } from 'node:net';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { createInterface } from 'node:readline';
import { registerSecretValues } from 'csuite-core';
import { Client as BrokerClient, ClientError } from 'csuite-sdk/client';
import { MCP_CHANNEL_NOTIFICATION } from 'csuite-sdk/protocol';
import { isReservedEnvName } from 'csuite-sdk/schemas';
import type { BriefingResponse, Objective, ResolvedToolSource } from 'csuite-sdk/types';
import { CLI_VERSION } from '../version.js';
import { startActivityReporter } from './busy-reporter.js';
import type { ForwarderNotificationSink } from './forwarder.js';
import { runForwarder } from './forwarder.js';
import {
  defaultSocketPath,
  encodeFrame,
  type IpcFrame,
  type IpcMcpNotification,
  type IpcMcpResponse,
  parseFrame,
} from './ipc.js';
import { createObjectivesTracker } from './objectives-tracker.js';
import { createPresence, type Presence } from './presence.js';
import { defineTools, formatAgentTimestamp, handleToolCall } from './tools.js';
import { type CaptureHost, startCaptureHost } from './trace/host.js';

export class RunnerStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerStartupError';
  }
}

export interface RunnerOptions {
  url: string;
  token: string;
  /**
   * Where the runner binds its IPC socket. Defaults to a pid-scoped
   * path under `$TMPDIR`. Override for tests that want a predictable
   * location or for running multiple runners with deterministic paths.
   */
  socketPath?: string;
  /**
   * Optional logger override. Defaults to structured JSON lines on
   * stderr. The runner does NOT write to stdout — stdout is reserved
   * for the bridge process to speak MCP cleanly.
   */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /**
   * Controls how the runner behaves when a second bridge connects
   * while one is already attached.
   *
   *   `displace-old` (default) — drop the older bridge and attach the
   *     newer. Right for agents that keep a single MCP client and only
   *     ever open a second bridge to *replace* a crashed one (claude
   *     code): the reconnect should win.
   *   `reject-new` — keep the attached bridge and refuse the newcomer.
   *     Right for codex, which spawns a fresh bridge per thread — every
   *     dispatched subagent opens one. Displacing on each would tear the
   *     root thread's bridge out from under it (the "Transport closed"
   *     bug). Rejecting pins the root's bridge and leaves subagents off
   *     the net (no csuite tools, no inbound notifications, no gaggle).
   *
   * The root's own reconnect still works under `reject-new`: a dead
   * bridge fires `onClose` (activeBridge → null) before its replacement
   * spawns and connects, so the newcomer is accepted, not rejected.
   */
  onSecondBridge?: 'displace-old' | 'reject-new';
  /**
   * Disable the capture host entirely — no activity uploader, no busy
   * signal, no hook server. The returned `RunnerHandle.captureHost`
   * will be `null`, and the agent child's environment is left untouched
   * (no OTEL export). Default: capture enabled. `csuite claude-code
   * --no-trace` sets this to `true`.
   */
  noTrace?: boolean;
  /**
   * Skip resolving broker-held secrets. The returned
   * `RunnerHandle.secretsEnv` will be empty and the agent child's
   * environment gets no injected secrets. Default: secrets enabled.
   * `csuite claude-code --no-secrets` sets this to `true`.
   */
  noSecrets?: boolean;
  /**
   * Optional presence signal the forwarder will flip between
   * `connecting` / `online` / `offline`. Callers that want to render
   * a status indicator (e.g. the claude-code HUD strip) pass one
   * in; the runner also exposes it back on its handle for anyone
   * else who wants to subscribe.
   */
  presence?: Presence;
  /**
   * Override the notification sink the forwarder writes broker SSE
   * events into. Default: a bridge-IPC shim that wraps each event as
   * an `mcp_notification` frame and pushes it to the connected MCP
   * bridge — this is what claude-code uses (the bridge re-emits the
   * notification to claude over its stdio MCP transport).
   *
   * The codex runner overrides this with a sink that converts each
   * event into a `turn/start` or `turn/steer` JSON-RPC dispatch
   * against the `codex app-server`. Keeps the forwarder + tools
   * dispatch identical across runners — only the outbound notification
   * transport differs per agent framework.
   */
  notificationSink?: ForwarderNotificationSink;
}

export interface RunnerHandle {
  /** The path the IPC socket is bound at. */
  readonly socketPath: string;
  /** The briefing fetched at startup. Frozen. */
  readonly briefing: BriefingResponse;
  /**
   * The live capture host owning the activity uploader, the busy
   * signal, and the Claude Code hook server. `null` when the runner
   * was started with `noTrace: true`. `csuite claude-code` reads this
   * to know whether to bake the OTEL export env into the agent child's
   * environment; the codex adapter reads its `enqueue` / `busy`.
   */
  readonly captureHost: CaptureHost | null;
  /**
   * Broker-held secrets resolved for this member at startup, keyed by
   * env var name. Each runner command merges this into the agent
   * child's environment before the capture host's delta (runner-managed
   * vars always win). Values exist only here and in the child env —
   * never in briefing prose, prompts, or MCP traffic — and are
   * registered with the core redactor so an echoed value is scrubbed
   * from captured traces. Empty when `noSecrets` is set, the broker
   * predates `/secrets/resolve`, or resolution failed (non-fatal).
   */
  readonly secretsEnv: Readonly<Record<string, string>>;
  /** Presence signal driven by the forwarder. */
  readonly presence: Presence;
  /**
   * Graceful shutdown. Aborts the SSE forwarder, closes the active
   * bridge connection (if any), closes the IPC server, and unlinks
   * the socket. Idempotent — calling twice is safe. Awaiting on
   * `waitClosed` after this resolves when teardown is done.
   */
  shutdown(reason?: string): Promise<void>;
  /** Resolves when the runner has fully torn down. */
  readonly waitClosed: Promise<void>;
}

function defaultLog(msg: string, ctx: Record<string, unknown> = {}): void {
  const record = { ts: new Date().toISOString(), component: 'runner', msg, ...ctx };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

/**
 * Start the runner: fetch briefing, bind the IPC socket, start the
 * SSE forwarder. Returns a handle the caller can use to wait for
 * completion or trigger a graceful shutdown. Throws
 * `RunnerStartupError` if required inputs are missing or the broker
 * briefing call fails.
 */
export async function startRunner(options: RunnerOptions): Promise<RunnerHandle> {
  const log = options.log ?? defaultLog;
  if (!options.url || options.url.length === 0) {
    throw new RunnerStartupError('url is required');
  }
  if (!options.token || options.token.length === 0) {
    throw new RunnerStartupError('token is required');
  }

  const brokerClient = new BrokerClient({ url: options.url, token: options.token });

  let briefing: BriefingResponse;
  try {
    briefing = await brokerClient.briefing();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // When the failure looks like a connection problem (broker unreachable)
    // we surface a plain-English hint pointing at the most common cause —
    // `csuite serve` isn't running, or `--url` is pointing somewhere else.
    // Token/auth failures surface a different shape (4xx from the HTTP
    // layer) and fall through to the original message so we don't
    // mislead the member with a "start your broker" hint when the
    // broker is actually up and rejecting them.
    const looksLikeConnectFailure =
      /ECONNREFUSED|fetch failed|socket hang up|ENOTFOUND|getaddrinfo|ETIMEDOUT/i.test(errMsg);
    const hint = looksLikeConnectFailure
      ? `\n  hint: is \`csuite serve\` running at ${options.url}? ` +
        `(start it, or pass --url to point elsewhere)`
      : '';
    throw new RunnerStartupError(`briefing failed against ${options.url}: ${errMsg}${hint}`);
  }

  // Live open-objectives snapshot — mutated as the objectives tracker
  // refreshes from SSE events. Tool descriptions deliberately do NOT
  // read it (static descriptions keep the model's prompt-prefix cache
  // intact); it seeds the context re-brief pushed as message traffic.
  let openObjectives: Objective[] = briefing.openObjectives;

  // Live external-tools snapshot from the broker's tool-source
  // registry. Unlike objective STATE, this is a CAPABILITY surface:
  // when it changes (a `tool_source` channel event), the runner
  // refetches the briefing, swaps the snapshot, and emits a genuine
  // `tools/list_changed` — the one event class that earns a
  // prompt-prefix cache break.
  let externalTools: ResolvedToolSource[] = briefing.toolSources;

  // ── Context re-brief ─────────────────────────────────────────────
  // Static surfaces (system prompt, tool descriptions) are frozen per
  // session, so live state reaches the agent as message traffic. This
  // is the re-assertion path: a `context_refresh` channel push
  // composed from the live open-objectives snapshot, sent when a
  // fresh MCP session attaches (first `tools/list` on a new bridge
  // connection) and when the agent's context falls off (SessionStart
  // hook with source=compact|clear). Empty plates are skipped — an
  // empty re-brief is noise. The real implementation is assigned once
  // the notification sink exists below; the cooldown guards against
  // double-fire when an attach and a compaction land together.
  const REBRIEF_COOLDOWN_MS = 10_000;
  let lastRebriefMs = 0;
  let sendRebrief: (reason: 'session-start' | 'context-compaction') => void = () => {};

  // At most one active bridge connection at a time. When a second
  // bridge connects, the older one gets dropped (`displace-old`,
  // default — claude code's reconnect model) or the newcomer is
  // refused (`reject-new` — codex, whose per-thread subagent bridges
  // must not displace the root's; see `onSecondBridge`).
  let activeBridge: BridgeConnection | null = null;
  const secondBridgePolicy = options.onSecondBridge ?? 'displace-old';

  const abortController = new AbortController();
  const socketPath = options.socketPath ?? defaultSocketPath();
  const presence = options.presence ?? createPresence();

  // ── Secrets ──────────────────────────────────────────────────────
  // Broker-held environment secrets bound to this member, resolved
  // once per runner start; the runner command merges them into the
  // agent child's env at spawn. Resolved BEFORE the capture host
  // starts so the values are registered with the core redactor by
  // the time anything can be captured — an agent that echoes a
  // secret leaks `[REDACTED]` into the uploaded trace, not the value.
  // Failures are non-fatal: a broker that predates `/secrets/resolve`
  // (404) or a broker-side KEK problem degrades to "no secrets" with
  // a warning — the agent still runs, it just won't find the vars.
  const secretsEnv: Record<string, string> = {};
  if (!options.noSecrets) {
    try {
      const resolved = await brokerClient.resolveSecrets();
      for (const [name, value] of Object.entries(resolved.env)) {
        // Defensive re-check of the server-side guard — never inject
        // a reserved or malformed name even if a (mis)configured
        // broker sends one.
        if (!/^[A-Z][A-Z0-9_]*$/.test(name) || isReservedEnvName(name)) {
          log('runner: dropping secret with reserved/invalid env name', { name });
          continue;
        }
        secretsEnv[name] = value;
      }
      registerSecretValues(Object.values(secretsEnv));
      if (Object.keys(secretsEnv).length > 0) {
        // Names only — the values must never reach the log stream.
        log('runner: secrets resolved', { envNames: Object.keys(secretsEnv) });
      }
    } catch (err) {
      if (err instanceof ClientError && err.status === 404) {
        log('runner: broker has no /secrets/resolve endpoint — skipping secrets');
      } else {
        log('runner: secrets resolve failed — continuing without secrets', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Optional capture host: activity uploader + busy signal + Claude
  // Code hook server. No network interception — each agent's native
  // instrumentation feeds it (OTEL for claude, the app-server stream
  // for codex). Skipped entirely when `noTrace` is set — tests and CI
  // use this to avoid binding an ephemeral hook port.
  let captureHost: CaptureHost | null = null;
  if (!options.noTrace) {
    try {
      captureHost = await startCaptureHost({
        brokerClient,
        name: briefing.name,
        brokerUrl: options.url,
        token: options.token,
        log,
        onSessionStart: (source) => {
          // `compact` = post-compaction restart, `clear` = /clear —
          // both mean the prior conversation context is gone and the
          // agent needs its plate re-asserted. `startup` / `resume`
          // are already covered by the tools/list attach trigger.
          if (source === 'compact' || source === 'clear') {
            sendRebrief('context-compaction');
          }
        },
      });
    } catch (err) {
      log('runner: capture host failed to start — continuing without capture', {
        error: err instanceof Error ? err.message : String(err),
      });
      captureHost = null;
    }
  }

  // Pre-emptively remove any stale socket from a previous crashed
  // runner at the same path. Unix domain sockets are files; a stale
  // one at the bind target causes EADDRINUSE on listen().
  try {
    unlinkSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('runner: stale socket cleanup failed', {
        socketPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const ipcServer: NetServer = createNetServer((socket) => {
    log('runner: bridge connecting');

    if (activeBridge !== null) {
      if (secondBridgePolicy === 'reject-new') {
        log('runner: rejecting second bridge (policy: reject-new)', {
          note: 'root bridge stays pinned; extra bridge (e.g. a codex subagent thread) gets no csuite tools',
        });
        socket.write(
          encodeFrame({
            kind: 'error',
            message: 'runner already attached to a bridge (reject-new policy)',
          }),
        );
        socket.end();
        return;
      }
      log('runner: displacing previous bridge (policy: displace-old)');
      activeBridge.close('displaced-by-new-bridge');
    }

    let rebriefedThisConnection = false;
    const conn = createBridgeConnection(socket, {
      handleRequest: async (frame) => {
        const response = await handleMcpRequest(frame, briefing, brokerClient, externalTools);
        // First `tools/list` on a fresh bridge connection = the
        // agent's MCP session just came up (new session, or an agent
        // restart against a live runner). Re-assert the open plate as
        // message traffic once the response is on the wire —
        // setImmediate lets the response frame flush first.
        if (frame.method === 'tools/list' && !rebriefedThisConnection) {
          rebriefedThisConnection = true;
          setImmediate(() => sendRebrief('session-start'));
        }
        return response;
      },
      onClose: () => {
        if (activeBridge === conn) activeBridge = null;
        log('runner: bridge disconnected');
      },
      log,
    });
    activeBridge = conn;
    log('runner: bridge attached');
  });

  const listening = new Promise<void>((resolve, reject) => {
    ipcServer.once('listening', () => resolve());
    ipcServer.once('error', (err) => reject(err));
  });
  ipcServer.listen(socketPath);
  try {
    await listening;
  } catch (err) {
    throw new RunnerStartupError(
      `runner: failed to bind IPC socket at ${socketPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  log('runner: IPC socket bound', {
    socketPath,
    name: briefing.name,
    role: briefing.role.title,
    openObjectives: briefing.openObjectives.length,
    version: CLI_VERSION,
  });

  // Objectives tracker: refresh the open set when SSE objective
  // events arrive. On every diff, emit objective_open/close
  // events into the agent's activity stream so the server can
  // slice traces by time range later. The refreshed snapshot also
  // seeds the context re-brief (session attach / compaction) —
  // tool descriptions themselves stay static so the prompt-prefix
  // cache survives; state freshness is message traffic.
  const tracker = createObjectivesTracker({
    brokerClient,
    name: briefing.name,
    log,
    onRefresh: (next) => {
      if (captureHost !== null) {
        const prevIds = new Set(openObjectives.map((o) => o.id));
        const nextIds = new Set(next.map((o) => o.id));
        for (const id of nextIds) {
          if (!prevIds.has(id)) {
            captureHost.noteObjectiveOpen(id);
            log('runner: objective open recorded', { objectiveId: id });
          }
        }
        for (const id of prevIds) {
          if (!nextIds.has(id)) {
            // We can't tell done vs cancelled vs reassigned from
            // the tracker alone — the objective is just "no longer
            // open." The server has the terminal state in its
            // audit log, so consumers that care can join on
            // objective id. Stamp `done` as the default — it's
            // the most common outcome and it's a hint, not a
            // source of truth.
            captureHost.noteObjectiveClose(id, 'done');
            log('runner: objective close recorded', { objectiveId: id });
          }
        }
      }
      openObjectives = next;
    },
  });

  // Record open markers for whatever the slot already had at
  // startup, so in-flight objectives get bracketed in the activity
  // stream from the first uploaded event.
  if (captureHost !== null) {
    for (const obj of briefing.openObjectives) {
      captureHost.noteObjectiveOpen(obj.id);
    }
    // Activity reporter — subscribes to the capture host's activity
    // signal and POSTs `/presence/activity` on state transitions
    // (idle↔working↔blocked), plus a heartbeat while non-idle so the
    // server TTL stays fresh. Skipped when capture is off (the activity
    // signal is driven by the native instrumentation the capture host
    // owns — Claude Code hooks and the codex adapter).
    startActivityReporter({
      brokerClient,
      activity: captureHost.busy,
      signal: abortController.signal,
      log,
    });
  }

  // SSE forwarder: subscribe to the broker for this slot's name,
  // wrap inbound messages as `notifications/claude/channel`
  // notifications, and send them to the bridge over IPC. This is the
  // substitute for the MCP `Server.notification()` call that used to
  // live inside the link — the bridge side converts incoming
  // notification frames into real MCP notifications on the agent's
  // stdio transport.
  const sink: ForwarderNotificationSink =
    options.notificationSink ??
    forwarderShim((method, params) => {
      if (activeBridge === null) {
        // No bridge attached — drop. Messages still land in server
        // history; agent reads them via `recent` when it reconnects.
        return;
      }
      activeBridge.sendNotification({ kind: 'mcp_notification', method, params });
    });

  // Real re-brief implementation, now that the sink exists. Rides the
  // same notification path as broker events, so it renders identically
  // for both agents (a `<channel>` block for claude, a turn dispatch
  // for codex).
  sendRebrief = (reason) => {
    if (openObjectives.length === 0) return;
    const now = Date.now();
    if (now - lastRebriefMs < REBRIEF_COOLDOWN_MS) return;
    lastRebriefMs = now;
    log('runner: sending context re-brief', {
      reason,
      openObjectives: openObjectives.length,
    });
    void sink
      .notification({
        method: MCP_CHANNEL_NOTIFICATION,
        params: {
          content: composeRebrief(openObjectives),
          meta: {
            kind: 'context_refresh',
            from: 'csuite',
            reason,
            level: 'info',
            ts: formatAgentTimestamp(now),
            ts_ms: String(now),
          },
        },
      })
      .catch((err: unknown) => {
        log('runner: context re-brief send failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };

  // External-tools refresher: a `tool_source` channel event means the
  // registry changed for this member. Debounced refetch of the
  // briefing (the resolved-tools source of truth), then — only when
  // the snapshot actually differs — swap it and push a genuine
  // `tools/list_changed` to the bridge so the agent re-lists.
  const TOOLS_REFRESH_DEBOUNCE_MS = 150;
  let toolsRefreshTimer: NodeJS.Timeout | null = null;
  let toolsRefreshInflight = false;
  const refreshExternalTools = async (): Promise<void> => {
    if (toolsRefreshInflight) return;
    toolsRefreshInflight = true;
    try {
      const fresh = await brokerClient.briefing();
      const next = fresh.toolSources;
      if (JSON.stringify(next) === JSON.stringify(externalTools)) return;
      externalTools = next;
      log('runner: external tools changed', {
        sources: next.length,
        tools: next.reduce((n, s) => n + s.tools.length, 0),
      });
      activeBridge?.sendNotification({
        kind: 'mcp_notification',
        method: 'notifications/tools/list_changed',
        params: {},
      });
    } catch (err) {
      log('runner: external tools refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      toolsRefreshInflight = false;
    }
  };
  const scheduleExternalToolsRefresh = (): void => {
    if (toolsRefreshTimer) clearTimeout(toolsRefreshTimer);
    toolsRefreshTimer = setTimeout(() => {
      toolsRefreshTimer = null;
      void refreshExternalTools();
    }, TOOLS_REFRESH_DEBOUNCE_MS);
    toolsRefreshTimer.unref?.();
  };

  const forwarderPromise = runForwarder({
    server: sink,
    brokerClient,
    name: briefing.name,
    signal: abortController.signal,
    log,
    presence,
    onObjectiveEvent: (message) => {
      tracker.refresh(message);
    },
    onToolSourceEvent: () => {
      scheduleExternalToolsRefresh();
    },
  });
  // Forwarder never throws outward — it catches its own errors and
  // just logs them. Attach a tail-catch anyway in case a refactor
  // breaks that invariant.
  forwarderPromise.catch((err) => {
    log('runner: forwarder loop crashed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  let closed = false;
  let resolveClosed: () => void = () => {};
  const waitClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const shutdown = async (reason?: string): Promise<void> => {
    if (closed) return;
    closed = true;
    log('runner: shutdown requested', reason ? { reason } : {});
    abortController.abort();
    if (activeBridge !== null) {
      activeBridge.close(reason ?? 'runner-shutdown');
      activeBridge = null;
    }
    await new Promise<void>((resolve) => {
      ipcServer.close(() => resolve());
    });
    try {
      unlinkSync(socketPath);
    } catch {
      /* already gone */
    }
    // Let the forwarder finish its wind-down (abort already fired).
    await forwarderPromise.catch((err) => {
      log('runner: forwarder wind-down failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    if (captureHost !== null) {
      await captureHost.close().catch((err) => {
        log('runner: capture host close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    resolveClosed();
  };

  return {
    socketPath,
    briefing,
    captureHost,
    secretsEnv,
    presence,
    shutdown,
    waitClosed,
  };
}

/**
 * Compose the `context_refresh` re-brief body from the live open
 * objectives. Plain prose — it arrives as an ordinary channel push, so
 * it appends to the agent's context instead of invalidating any cached
 * prefix the way a tool-description mutation would.
 */
function composeRebrief(open: Objective[]): string {
  const lines = open.map((o) => {
    const block = o.status === 'blocked' && o.blockReason ? ` (blocked: ${o.blockReason})` : '';
    return `- ${o.id} [${o.status}] ${o.title}${block}\n    outcome: ${o.outcome}`;
  });
  return (
    `Context refresh — your open objectives (${open.length}):\n` +
    `${lines.join('\n')}\n` +
    'Use `objectives_view <id>` for full detail and `objectives_list` to re-check at any time.'
  );
}

/**
 * Dispatch a single `mcp_request` frame to the tool handlers. Returns
 * the response frame the runner should send back.
 *
 * We support two MCP methods here, mirroring what the old link
 * handled: `tools/list` and `tools/call`. Any other method comes
 * back as an error frame. The MCP SDK's type system is irrelevant
 * on this side of the IPC — we're looking at raw JSON.
 */
async function handleMcpRequest(
  frame: { id: number; method: string; params: Record<string, unknown> | undefined },
  briefing: BriefingResponse,
  brokerClient: BrokerClient,
  externalTools: ResolvedToolSource[],
): Promise<IpcMcpResponse> {
  try {
    if (frame.method === 'tools/list') {
      const tools = defineTools(briefing, externalTools);
      return { kind: 'mcp_response', id: frame.id, result: { tools } };
    }
    if (frame.method === 'tools/call') {
      const params = frame.params as { name?: unknown; arguments?: unknown } | undefined;
      const name = typeof params?.name === 'string' ? params.name : '';
      const args =
        params?.arguments && typeof params.arguments === 'object'
          ? (params.arguments as Record<string, unknown>)
          : undefined;
      const result = await handleToolCall(name, args, brokerClient, briefing, externalTools);
      return { kind: 'mcp_response', id: frame.id, result };
    }
    return {
      kind: 'mcp_response',
      id: frame.id,
      error: { code: -32601, message: `method not found: ${frame.method}` },
    };
  } catch (err) {
    return {
      kind: 'mcp_response',
      id: frame.id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── Bridge connection wrapper ─────────────────────────────────────

interface BridgeConnection {
  sendNotification(frame: IpcMcpNotification): void;
  close(reason?: string): void;
}

interface BridgeConnectionDeps {
  handleRequest: (frame: {
    id: number;
    method: string;
    params: Record<string, unknown> | undefined;
  }) => Promise<IpcMcpResponse>;
  onClose: () => void;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * Wrap a raw IPC socket into the runner's bridge-facing API. Handles
 * line-delimited framing on the receive side, serializes outbound
 * frames on the send side, and routes inbound `mcp_request` frames to
 * `deps.handleRequest`.
 */
function createBridgeConnection(socket: Socket, deps: BridgeConnectionDeps): BridgeConnection {
  let closed = false;
  const rl = createInterface({ input: socket, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const frame = parseFrame(line);
    if (frame === null) {
      deps.log('runner: dropped malformed IPC frame', { lineLength: line.length });
      return;
    }
    if (frame.kind === 'mcp_request') {
      void deps
        .handleRequest({
          id: frame.id,
          method: frame.method,
          params: frame.params,
        })
        .then((response) => {
          send(response);
        })
        .catch((err) => {
          deps.log('runner: handler rejected', {
            error: err instanceof Error ? err.message : String(err),
          });
          send({
            kind: 'mcp_response',
            id: frame.id,
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : String(err),
            },
          });
        });
      return;
    }
    if (frame.kind === 'shutdown') {
      deps.log('runner: bridge sent shutdown', { reason: frame.reason });
      cleanup();
      return;
    }
    if (frame.kind === 'error') {
      deps.log('runner: bridge reported error', { message: frame.message });
      return;
    }
    // Responses and notifications from the bridge side aren't
    // expected on the runner side of the protocol for v1.
    deps.log('runner: unexpected frame kind from bridge', { kind: frame.kind });
  });

  const send = (frame: IpcFrame): void => {
    if (closed) return;
    try {
      socket.write(encodeFrame(frame));
    } catch (err) {
      deps.log('runner: write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      cleanup();
    }
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    try {
      rl.close();
    } catch {
      /* ignore */
    }
    try {
      socket.end();
      socket.destroy();
    } catch {
      /* ignore */
    }
    deps.onClose();
  };

  socket.on('close', cleanup);
  socket.on('error', (err) => {
    deps.log('runner: socket error', {
      error: err instanceof Error ? err.message : String(err),
    });
    cleanup();
  });

  return {
    sendNotification(frame) {
      send(frame);
    },
    close(reason) {
      if (closed) return;
      send({ kind: 'shutdown', reason });
      cleanup();
    },
  };
}

// ─── Forwarder shim ─────────────────────────────────────────────────

/**
 * The existing `runForwarder` (in `forwarder.ts`) expects an MCP
 * `Server` with a `notification(args)` method. When the runner
 * doesn't own a real MCP server (it delegates that to the bridge),
 * we stub one out: a plain object whose `notification` implementation
 * translates the MCP-style call into an IPC `mcp_notification` frame
 * via a callback.
 *
 * We keep the forwarder's interface unchanged so Phase 5 (trace
 * capture) can reuse it verbatim — the trace layer wraps the forwarder
 * and doesn't care whether its server is real MCP or a runner shim.
 */
function forwarderShim(
  send: (method: string, params: Record<string, unknown>) => void,
): ForwarderNotificationSink {
  return {
    notification: async (args) => {
      send(args.method, args.params);
    },
  };
}
