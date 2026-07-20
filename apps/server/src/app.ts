/**
 * Hono application factory for the csuite broker.
 *
 * Routes:
 *   GET  /healthz         — unauthed, liveness probe
 *   POST /session/totp    — unauthed, exchange TOTP code for a session cookie
 *   POST /session/logout  — session-auth, clear the session
 *   GET  /session         — session-auth, return current session info
 *   GET  /briefing        — dual-auth, team-context packet for the user
 *   GET  /roster          — dual-auth, full teammate list + live connection state
 *   POST /push            — dual-auth, deliver a message to one teammate or broadcast
 *   GET  /subscribe       — dual-auth, WebSocket of live messages for a name
 *   GET  /history         — dual-auth, prior messages filtered by viewer scope
 *
 * Dual-auth = either `Authorization: Bearer <token>` (machine plane,
 * MCP link) or `Cookie: csuite_session=<id>` (human plane, web SPA).
 * Both resolve to the same `LoadedMember`, which downstream handlers
 * use to stamp authoritative `from` on pushes and to gate identity
 * checks on subscribe. All routes must carry `X-CSUITE-Protocol: 1` if
 * the header is present.
 */

import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import {
  type Broker,
  clampQueryLimit,
  openaiResponsesToGenAi,
  registerSecretValues,
} from 'csuite-core';
import { PATHS, PROTOCOL_HEADER, PROTOCOL_VERSION } from 'csuite-sdk/protocol';
import {
  ActivityKindSchema,
  ActivityReportSchema,
  AddChannelMemberRequestSchema,
  ApproveEnrollmentRequestSchema,
  BindSecretRequestSchema,
  BindToolSourceRequestSchema,
  CancelObjectiveRequestSchema,
  CompleteObjectiveRequestSchema,
  CreateChannelRequestSchema,
  CreateMemberRequestSchema,
  CreateNotificationEndpointRequestSchema,
  CreateNotificationProfileRequestSchema,
  CreateObjectiveRequestSchema,
  CreateSecretRequestSchema,
  CreateToolSourceRequestSchema,
  DeviceAuthorizationRequestSchema,
  DeviceTokenRequestSchema,
  DiscussObjectiveRequestSchema,
  FsMkdirRequestSchema,
  FsMoveRequestSchema,
  FsPathSchema,
  FsWriteCollisionSchema,
  InvokeToolRequestSchema,
  ListObjectivesQuerySchema,
  LogLevelSchema,
  NameSchema,
  PushPayloadSchema,
  PushSubscriptionPayloadSchema,
  ReassignObjectiveRequestSchema,
  RejectEnrollmentRequestSchema,
  RenameChannelRequestSchema,
  SetCustomToolRequestSchema,
  SetNotificationSecretRequestSchema,
  SetSecretValueRequestSchema,
  SetToolCredentialRequestSchema,
  TotpLoginRequestSchema,
  UpdateMemberRequestSchema,
  UpdateNotificationEndpointRequestSchema,
  UpdateNotificationProfileRequestSchema,
  UpdateObjectiveRequestSchema,
  UpdateSecretRequestSchema,
  UpdateToolSourceRequestSchema,
  UpdateWatchersRequestSchema,
  UploadActivityRequestSchema,
} from 'csuite-sdk/schemas';
import type {
  ActivityEvent,
  ActivityKind,
  Attachment,
  ChannelSummary,
  Message,
  NotificationEndpoint,
  NotificationEndpointSummary,
  NotificationOverrides,
  NotificationTarget,
  Objective,
  ObjectiveEvent,
  ObjectiveEventKind,
  Permission,
  Role,
  Secret,
  SecretSummary,
  Teammate,
  ToolSource,
  ToolSourceSummary,
} from 'csuite-sdk/types';
import { hasPermission } from 'csuite-sdk/types';
import { type Context, Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { type ActivityTracker, createActivityTracker } from './activity-tracker.js';
import { type AuthBindings, createAuthMiddleware } from './auth.js';
import { composeBriefing } from './briefing.js';
import { type ChannelStore, ChannelsError, GENERAL_CHANNEL_ID, validateSlug } from './channels.js';
import { type EnrollmentStore, formatUserCode, normalizeUserCode } from './enrollments.js';
import {
  basenameOf,
  type FilesystemStore,
  FsError,
  objectiveNamespacePath,
  type ViewerContext,
} from './files/index.js';
import {
  createGenAiCorrelator,
  type GenAiCorrelator,
  isGenAiLogRecord,
} from './genai-correlator.js';
import type { GenAiStore } from './genai-store.js';
import type { JwtVerifier } from './jwt.js';
import type { Logger } from './logger.js';
import type { ActivityStore } from './member-activity.js';
import {
  type LoadedMember,
  MemberLoadError,
  type MemberStore,
  resolvePermissions,
  teammatesFromMembers,
  type UpdateMemberPatch,
} from './members.js';
import {
  createNotificationDispatcher,
  HOOK_BODY_MAX,
  type NotificationDispatcher,
  NotificationsError,
  type NotificationsStore,
  toWireDelivery,
} from './notifications/index.js';
import { ObjectivesError, type ObjectivesStore } from './objectives.js';
import { parseOtlpLogs, parseOtlpMetrics } from './otlp-parse.js';
import type { PushSubscriptionStore } from './push/store.js';
import type { RawBodyStore } from './raw-body-store.js';
import { SecretsError, type SecretsStore } from './secrets.js';
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, type SessionStore } from './sessions.js';
import type { TeamStore } from './team-store.js';
import type { TelemetryStore } from './telemetry-store.js';
import { generateBearerToken, type TokenStore } from './tokens.js';
import {
  executeCustomTool,
  type McpToolManager,
  McpUnavailableError,
  type ToolSourceStore,
  ToolSourcesError,
} from './tool-sources/index.js';
import { generateSecret, otpauthUri, verifyCode as verifyTotpCode } from './totp.js';

export interface AppOptions {
  broker: Broker;
  members: MemberStore;
  /**
   * Multi-token bearer-credential store. Authoritative for live
   * authentication after the bootstrap migration in `runServer`.
   * Required: every authenticated bearer-token request resolves
   * here, and admin endpoints (rotate, list-tokens, revoke,
   * device-code approve) all write here.
   */
  tokens: TokenStore;
  /**
   * Device-code enrollment store. The `/enroll*` endpoints register
   * iff this is provided. Tests that aren't exercising the
   * onboarding flow can omit it; production always wires it up via
   * `runServer`.
   */
  enrollments?: EnrollmentStore;
  sessions: SessionStore;
  /**
   * DB-backed team config + permission preset store. Replaces the
   * static `team: Team` snapshot — handlers that need fresh team data
   * (briefing, role/preset resolution, permission-preset CRUD) call
   * `teamStore.getTeam()` so a `PATCH /team` from another caller is
   * reflected on the next read.
   */
  teamStore: TeamStore;
  /**
   * Objectives store — the server's authoritative task state. The
   * `/objectives*` endpoints are registered iff this is provided,
   * which lets tests opt out of the whole objectives surface when
   * they're only exercising chat paths.
   */
  objectives?: ObjectivesStore;
  /**
   * Channels store — named-thread metadata + membership. The
   * `/channels*` endpoints are registered iff this is provided. When
   * omitted, the server has no channel concept and team chat collapses
   * to the legacy single-broadcast thread.
   */
  channels?: ChannelStore;
  /**
   * Per-member activity store — append-only timeline of LLM
   * exchanges, tool actions, and objective lifecycle markers the
   * runner ships up via the streaming uploader. The
   * `/members/:name/activity*` endpoints are registered iff this is
   * provided, same opt-out pattern as `objectives`.
   */
  activityStore?: ActivityStore;
  /**
   * Tool-source registry — platform-defined external tools (custom
   * HTTP bindings + proxied remote MCP servers). The `/tool-sources*`
   * endpoints are registered iff this is provided, and the briefing
   * gains per-member resolved tools. Same opt-out pattern as
   * `objectives`.
   */
  toolSources?: ToolSourceStore;
  /**
   * MCP client manager for `kind=mcp` tool sources. Optional even
   * when `toolSources` is wired — without it, mcp-source invoke and
   * refresh return 503 (custom sources are unaffected).
   */
  mcpManager?: McpToolManager;
  /**
   * Secrets registry — broker-held environment secrets the runner
   * injects on the agent child at spawn. The `/secrets*` endpoints
   * are registered iff this is provided. Same opt-out pattern as
   * `objectives`.
   */
  secrets?: SecretsStore;
  /**
   * External Notifications registry — inbound webhook/API endpoints
   * routed to members and channels as ambient input. The
   * `/notifications*` admin endpoints and the `/hooks/:slug` ingress
   * are registered iff this is provided; `createApp` owns the
   * dispatcher (debounce buffers, wake/idle queue flushes, sweep
   * interval) because the delivery policy needs the in-process
   * activity tracker. Same opt-out pattern as `objectives`.
   */
  notifications?: NotificationsStore;
  /**
   * Lossless OTLP telemetry sink. When provided, the `/otlp/v1/logs`
   * and `/otlp/v1/metrics` endpoints are registered and every exported
   * log record / metric data point is persisted verbatim (name-agnostic
   * — no allowlist). Omit for deployments that don't ingest Claude Code
   * operational telemetry.
   */
  telemetryStore?: TelemetryStore;
  /**
   * Full-fidelity GenAI inference store. When provided, the
   * `/otlp/v1/logs` endpoint additionally routes Claude's raw api-body
   * log records (api_request_body / api_request / api_response_body /
   * api_error) through a per-member correlator that resolves the on-disk
   * request/response bodies and appends one `GenAiInference` record per
   * completed call. Additive to `telemetryStore` — the two stores are
   * independent, and either, both, or neither may be wired.
   */
  genaiStore?: GenAiStore;
  /**
   * Content-addressed raw-body store. When provided alongside
   * `genaiStore`, the per-member correlators capture every resolved
   * request/response body VERBATIM (sha256 + gzip) BEFORE parsing, link
   * the derived gen_ai rows to the raw bytes by hash, and unlink the
   * consumed body_ref spill files. Omit to skip raw capture (bodies are
   * then only parsed into the derived view, and spill files are left on
   * disk).
   */
  rawBodyStore?: RawBodyStore;
  version: string;
  logger: Logger;
  /**
   * Whether the server is listening over HTTPS. Controls the `Secure`
   * attribute on the session cookie — we MUST NOT set Secure on a
   * plain-HTTP listener (browsers drop the cookie on the next request),
   * and we MUST set it on HTTPS (sending a session cookie in cleartext
   * is a leak).
   */
  secureCookies?: boolean;
  /**
   * Triggered when the server is shutting down. Open WebSocket
   * connections listen for this so they can close cleanly and let
   * `http.Server.close()` complete.
   */
  shutdownSignal?: AbortSignal;
  /**
   * Absolute path to the directory containing the built `csuite-web-host`
   * bundle (index.html + assets/). When set, the server serves the
   * SPA at `/` plus SPA fallback for any non-API GET request. When
   * omitted or missing on disk, no SPA routes are registered — useful
   * for tests and for the machine-only auth plane where the web UI
   * isn't built.
   */
  publicRoot?: string;
  /**
   * Web Push subscription store + VAPID public key. When both are
   * present, the `/push/vapid-public-key` and `/push/subscriptions`
   * endpoints are registered and the `onPushed` hook fires push
   * dispatch for every message. Omit for tests or machine-only
   * deployments that don't need browser notifications.
   */
  pushStore?: PushSubscriptionStore;
  vapidPublicKey?: string;
  /**
   * Fired once per successful `/push` (or broker-level push) with the
   * stamped message. Runs in the background — do not await it in the
   * request path. The broker-fanout integration lives here so the
   * push-dispatch side effect stays out of the HTTP handler.
   */
  onPushed?: (message: Message) => void;
  /**
   * Virtual filesystem backing file attachments. The `/fs/*` endpoints
   * are registered iff this is provided, and `/push` gains attachment
   * validation + per-recipient grant materialization. Omit for
   * machine-only or chat-only deployments.
   */
  files?: FilesystemStore;
  /**
   * Per-file upload cap in bytes. Defaults to 25 MB. The broker caps
   * this at 1 GB regardless of config — tune upward with intent, not
   * by accident.
   */
  maxFileSize?: number;
  /**
   * Called after every successful member-store mutation (create /
   * update / delete / rotate-token / enroll-totp) with no arguments.
   * The runtime passes a closure that rewrites the on-disk team
   * config atomically; tests can pass a no-op when they don't care
   * about persistence. When omitted, member-mutation endpoints 501
   * rather than mutating in-memory without a durable backing.
   */
  persistMembers?: () => void;
  /**
   * Optional JWKS-backed JWT verifier. When provided, bearer tokens
   * that match JWT structure are verified against it; the `member`
   * claim resolves to a LoadedMember by name. Omit when the
   * deployment isn't federating with an external issuer.
   */
  jwt?: JwtVerifier;
  /**
   * Clock injection for tests — rate-limit book-keeping uses `now()`
   * so tests don't have to wall-clock-wait to see a lockout expire.
   */
  now?: () => number;
}

type AppBindings = AuthBindings;

/**
 * Rate-limit bucket for TOTP login attempts. Keyed by user name —
 * an attacker hammering one user can't accidentally lock a different
 * one out. In-memory, per-process; a restart clears the bucket, which
 * is acceptable at our scale (no distributed deployment yet).
 *
 * Sliding window: we count failures within `TOTP_LOCKOUT_WINDOW_MS`.
 * Lockout is implicit — when `failures >= TOTP_MAX_FAILURES` and the
 * window hasn't elapsed yet, any further attempt is rejected. Once
 * the window elapses the bucket is cleared and the user can try again.
 */
interface TotpLockout {
  failures: number;
  firstFailureAt: number;
}

// Per-user lockout — applies when the caller sent an explicit `user`
// hint (CLI / targeted login). Same 5/15min sliding window as before.
const TOTP_MAX_FAILURES = 5;
const TOTP_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

// Global codeless lockout — applies to the SPA's "just type a code"
// login path where the server iterates members to find a match. With N
// enrolled members each guess has N× the per-user hit chance, so we
// compensate with a tighter global cap in the same 15min window.
// 10 failures / 15min × 6-digit code space × ~10 enrolled members works
// out to a multi-year expected-crack time, comparable to the old
// per-user flow.
const TOTP_CODELESS_MAX_FAILURES = 10;
const CODELESS_LOCKOUT_KEY = '__codeless__';

/**
 * The set of request paths we treat as "API." Any GET outside this
 * set falls through to the SPA fallback when `publicRoot` is set, so
 * client-side routes like `/login` or `/dm/build-bot` resolve to
 * `index.html` instead of 404. Keep in sync with `PATHS` + the
 * session endpoints.
 */
const API_PATH_PREFIXES = [
  PATHS.health,
  PATHS.briefing,
  PATHS.roster,
  PATHS.push,
  PATHS.subscribe,
  PATHS.history,
  PATHS.sessionTotp,
  PATHS.sessionLogout,
  PATHS.session,
  PATHS.pushVapidPublicKey,
  PATHS.pushSubscriptions,
  PATHS.objectives,
  // Note: PATHS.enroll (`/enroll`) is intentionally NOT here. The
  // SPA serves the verification page at the same path; only the
  // POST verb is API-routed. The four sub-endpoints below ARE
  // API-only — they should 404 when accessed via GET, not return
  // the SPA's index.html.
  PATHS.enrollPoll,
  PATHS.enrollPending,
  PATHS.enrollApprove,
  PATHS.enrollReject,
  PATHS.presenceActivity,
  '/notifications',
  PATHS.hooks,
  '/agents',
  '/fs',
  '/otlp',
] as const;

const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024;
const HARD_CAP_MAX_FILE_SIZE = 1024 * 1024 * 1024;

function isApiPath(pathname: string): boolean {
  for (const p of API_PATH_PREFIXES) {
    if (pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(p)) {
      return true;
    }
  }
  return false;
}

export interface CreatedApp {
  /** The Hono application. Use `app.request(...)` in tests, or `app.fetch` as the server handler. */
  app: Hono<AppBindings>;
  /**
   * Wire WebSocket upgrade handling into the underlying Node HTTP
   * server so `/subscribe` and `/members/:name/activity/stream` can
   * upgrade. Call after `serve(...)` returns the server instance.
   */
  injectWebSocket: ReturnType<typeof createNodeWebSocket>['injectWebSocket'];
  /**
   * External Notifications dispatcher, present iff
   * `options.notifications` was wired. Exposed so tests can drive
   * wake/idle/sweep transitions directly without a live WebSocket.
   */
  notificationDispatcher?: NotificationDispatcher;
}

export function createApp(options: AppOptions): CreatedApp {
  const {
    broker,
    members,
    tokens,
    enrollments,
    sessions,
    teamStore,
    objectives,
    channels,
    activityStore,
    toolSources,
    mcpManager,
    secrets,
    notifications,
    telemetryStore,
    genaiStore,
    rawBodyStore,
    version,
    logger,
    shutdownSignal,
    secureCookies = false,
    publicRoot,
    pushStore,
    vapidPublicKey,
    onPushed,
  } = options;
  const { files, persistMembers, jwt } = options;
  const maxFileSize = Math.min(
    options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
    HARD_CAP_MAX_FILE_SIZE,
  );
  const now = options.now ?? Date.now;
  // Per-member ACTIVITY tracker (idle/working/blocked). Filled by
  // `POST /presence/activity`, read on roster GETs, and decayed via TTL
  // so a runner that crashes mid-turn doesn't leave the member stuck
  // "working"/"blocked" forever — stale state resolves back to idle.
  // Orthogonal to connection presence (which the broker's SSE registry
  // owns). Local helper, not exposed externally — it's behavioral state
  // of the running broker, not config or persisted truth.
  const activityTracker: ActivityTracker = createActivityTracker(now);

  // External Notifications dispatcher — owned here (not by run.ts)
  // because the delivery policy reads the in-process activity
  // tracker. The sweep interval expires stale offline-queue rows,
  // force-delivers starved busy-waits, and backstops debounce
  // timers; `recover()` re-dispatches deliveries a restart stranded
  // mid-debounce.
  let notificationDispatcher: NotificationDispatcher | undefined;
  if (notifications !== undefined) {
    notificationDispatcher = createNotificationDispatcher({
      store: notifications,
      broker,
      members,
      ...(channels !== undefined ? { channels } : {}),
      activity: activityTracker,
      logger,
      now,
    });
    const dispatcher = notificationDispatcher;
    void dispatcher.recover().catch((err) => {
      logger.warn('notification recovery failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    const sweepInterval = setInterval(() => {
      void dispatcher.sweep().catch((err) => {
        logger.warn('notification sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 5_000);
    sweepInterval.unref?.();
    shutdownSignal?.addEventListener(
      'abort',
      () => {
        clearInterval(sweepInterval);
        dispatcher.stop();
      },
      { once: true },
    );
  }

  // Per-member GenAI inference correlators. The api-body OTEL records for
  // one call routinely span multiple export POSTs, so correlation is
  // stateful and MUST persist across requests — one correlator per member,
  // lazily created on first api-body record. Only used when `genaiStore`
  // is wired; otherwise the map stays empty.
  const genaiCorrelators = new Map<string, GenAiCorrelator>();
  const getGenAiCorrelator = (memberName: string): GenAiCorrelator => {
    let corr = genaiCorrelators.get(memberName);
    if (!corr) {
      corr = createGenAiCorrelator({
        log: (msg, ctx) => logger.warn(msg, ctx),
        // Raw capture-before-parse: when the raw-body store is wired,
        // the correlator content-addresses every body verbatim before
        // parsing and unlinks the consumed spill file (its default).
        ...(rawBodyStore !== undefined ? { rawStore: rawBodyStore, memberName } : {}),
      });
      genaiCorrelators.set(memberName, corr);
    }
    return corr;
  };

  const app = new Hono<AppBindings>();
  // WebSocket upgrade helper, bound to this app. Used by `/subscribe`
  // and `/members/:name/activity/stream`. The returned
  // `injectWebSocket` gets called by the server after `serve()` so
  // Node's HTTP server routes upgrade events to Hono.
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const auth = createAuthMiddleware({
    members,
    tokens,
    sessions,
    logger,
    ...(jwt !== undefined ? { jwt } : {}),
  });

  // Unified lockout map — per-user buckets keyed on name plus a
  // global "codeless" bucket keyed on a fixed sentinel. Both obey
  // the same sliding-window shape; they differ only in their
  // max-failures threshold (per-user = 5, codeless = 10).
  const totpLockouts = new Map<string, TotpLockout>();

  function maxFailuresFor(key: string): number {
    return key === CODELESS_LOCKOUT_KEY ? TOTP_CODELESS_MAX_FAILURES : TOTP_MAX_FAILURES;
  }

  function checkTotpLockout(key: string): { locked: boolean; retryAfter?: number } {
    const entry = totpLockouts.get(key);
    if (!entry) return { locked: false };
    const t = now();
    const elapsed = t - entry.firstFailureAt;
    if (elapsed >= TOTP_LOCKOUT_WINDOW_MS) {
      totpLockouts.delete(key);
      return { locked: false };
    }
    if (entry.failures >= maxFailuresFor(key)) {
      return {
        locked: true,
        retryAfter: Math.ceil((TOTP_LOCKOUT_WINDOW_MS - elapsed) / 1000),
      };
    }
    return { locked: false };
  }

  function recordTotpFailure(key: string): void {
    const t = now();
    const entry = totpLockouts.get(key);
    if (!entry || t - entry.firstFailureAt >= TOTP_LOCKOUT_WINDOW_MS) {
      totpLockouts.set(key, { failures: 1, firstFailureAt: t });
      return;
    }
    entry.failures += 1;
  }

  function clearTotpLockout(key: string): void {
    totpLockouts.delete(key);
  }

  // Enforce protocol version if the client sent the header. Missing header
  // is allowed for relaxed clients; wrong version is a 400.
  app.use('*', async (c, next) => {
    const header = c.req.header(PROTOCOL_HEADER);
    if (header && Number(header) !== PROTOCOL_VERSION) {
      return c.json(
        {
          error: `unsupported protocol version`,
          got: header,
          expected: PROTOCOL_VERSION,
        },
        400,
      );
    }
    await next();
  });

  app.get(PATHS.health, (c) => {
    return c.json({ status: 'ok' as const, version });
  });

  // ─── Platform pairing-code handshake ──────────────────────────────
  //
  // Bridges a csuite deployment into a hosted control plane (the
  // platform) without the platform ever asserting who you are. The
  // platform mints a short code + shows it to the user; the user
  // confirms on THIS server while signed in as a real member; the
  // platform's status endpoint calls back to /platform-connect/lookup
  // to retrieve the server-attested memberName.
  //
  // State is process-local: a Map of code → {memberName, expiresAt}
  // with opportunistic sweep on access. 10-min TTL + single-use
  // semantics on lookup keep the surface tight. No persistence —
  // a restart mid-handshake just requires the user to restart the
  // flow on the platform side, which takes seconds.
  //
  // `/platform-connect/bind` needs an authenticated session (the
  // member is read from the `LoadedMember` on `c.var`).
  // `/platform-connect/lookup` is intentionally unauthenticated: the
  // platform calls it over HTTPS, the code is a one-time secret, and
  // a successful lookup drops the binding so replays fail.
  const PLATFORM_CONNECT_CODE_TTL_MS = 10 * 60 * 1000;
  interface PlatformConnectBinding {
    memberName: string;
    expiresAt: number;
  }
  const platformConnectBindings = new Map<string, PlatformConnectBinding>();

  function sweepPlatformConnectBindings(): void {
    const t = now();
    for (const [code, binding] of platformConnectBindings) {
      if (binding.expiresAt < t) platformConnectBindings.delete(code);
    }
  }

  // Confirmation page the user lands on from the platform connect
  // flow. Renders standalone HTML (no SPA dependencies) so it works
  // even when the csuite web bundle isn't served from the same host, and
  // so we don't have to push another route into the shared
  // csuite-web-ui package (which would leak into the
  // platform-embedded shell).
  //
  // Flow:
  //   1. Page loads, reads ?code from URL.
  //   2. Client-side fetches /session to check whether the user is
  //      signed in on this csuite. If not, renders "sign in first".
  //   3. If signed in, shows "the platform wants to bind this server
  //      as <member>" with a big confirm button.
  //   4. Confirm → POST /platform-connect/bind with the code; cookies
  //      carry the session, so `auth` on the bind endpoint resolves
  //      the member identity from the server's own roster.
  app.get('/setup/connect-platform', (c) => {
    const code = c.req.query('code') ?? '';
    // `mode=iframe` switches the page into iframe-embed mode: after a
    // successful bind, it postMessages the parent instead of trying
    // to close its own window (which usually fails silently when the
    // window wasn't opened via window.open). `parentOrigin` is the
    // only origin the page will postMessage to — required in iframe
    // mode so a malicious embedding page can't intercept the message.
    const mode = c.req.query('mode') === 'iframe' ? 'iframe' : 'tab';
    const parentOrigin = c.req.query('parentOrigin') ?? '';
    return c.html(renderConnectPlatformPage(code, { mode, parentOrigin }));
  });

  app.post('/platform-connect/bind', auth, async (c) => {
    const body = await c.req.json().catch(() => null);
    const code =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { code?: unknown }).code === 'string'
        ? (body as { code: string }).code
        : null;
    if (code === null || code.length === 0 || code.length > 32) {
      return c.json({ error: 'missing or invalid code' }, 400);
    }
    const member = c.get('member');
    sweepPlatformConnectBindings();
    platformConnectBindings.set(code, {
      memberName: member.name,
      expiresAt: now() + PLATFORM_CONNECT_CODE_TTL_MS,
    });
    logger.info('platform-connect: bind', { code, memberName: member.name });
    return c.json({ ok: true, memberName: member.name });
  });

  app.get('/platform-connect/lookup', (c) => {
    const code = c.req.query('code');
    if (!code || code.length === 0) {
      return c.json({ error: 'missing code query param' }, 400);
    }
    sweepPlatformConnectBindings();
    const binding = platformConnectBindings.get(code);
    if (!binding) {
      return c.json({ error: 'unknown or expired code' }, 404);
    }
    // Single-use: consume on read so a replay (or a stale platform
    // retry after it already completed the handshake) can't re-bind.
    platformConnectBindings.delete(code);
    return c.json({ memberName: binding.memberName });
  });

  // ─── Session endpoints ────────────────────────────────────────────

  app.post(PATHS.sessionTotp, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = TotpLoginRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid login payload', details: parsed.error.issues }, 400);
    }
    const { member: providedName, code } = parsed.data;

    // Two paths:
    //   1. `member` was provided → targeted login (CLI, scripts that
    //      know their name). Uses the per-member rate-limit bucket.
    //   2. `member` was omitted → codeless login (SPA). Server
    //      iterates TOTP-enrolled members to find a match. Uses the
    //      tighter global `__codeless__` rate-limit bucket to
    //      compensate for the multi-member effective attack surface.
    const lockoutKey = providedName ?? CODELESS_LOCKOUT_KEY;
    const lockout = checkTotpLockout(lockoutKey);
    if (lockout.locked) {
      return c.json(
        { error: 'too many attempts; try again later', retryAfter: lockout.retryAfter },
        429,
      );
    }

    // Resolve which member we're about to verify against.
    let matched: LoadedMember | null = null;
    let matchedCounter = 0;

    if (providedName !== undefined) {
      const m = members.findByName(providedName);
      if (m?.totpSecret) {
        const verify = verifyTotpCode(m.totpSecret, code, m.totpLastCounter ?? 0, now());
        if (verify.ok) {
          matched = m;
          matchedCounter = verify.counter;
        }
      }
    } else {
      // Codeless: iterate every enrolled member. First ok-verify wins.
      for (const m of members.members()) {
        if (!m.totpSecret) continue;
        const verify = verifyTotpCode(m.totpSecret, code, m.totpLastCounter ?? 0, now());
        if (verify.ok) {
          matched = m;
          matchedCounter = verify.counter;
          break;
        }
      }
    }

    if (!matched) {
      recordTotpFailure(lockoutKey);
      logger.warn('totp login rejected', {
        path: providedName ? 'targeted' : 'codeless',
        ...(providedName ? { name: providedName } : {}),
      });
      return c.json({ error: 'invalid code' }, 401);
    }

    const matchedName = matched.name;

    members.recordTotpAccept(matchedName, matchedCounter);
    clearTotpLockout(lockoutKey);
    if (providedName === undefined) {
      clearTotpLockout(matchedName);
    }

    const userAgent = c.req.header('User-Agent') ?? null;
    const session = sessions.create(matchedName, userAgent);

    setCookie(c, SESSION_COOKIE_NAME, session.id, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'Strict',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });

    logger.info('session created', {
      name: matchedName,
      path: providedName ? 'targeted' : 'codeless',
      expiresAt: session.expiresAt,
    });
    return c.json({
      member: matchedName,
      role: matched.role,
      permissions: matched.permissions,
      expiresAt: session.expiresAt,
    });
  });

  app.post(PATHS.sessionLogout, auth, (c) => {
    const sessionId = c.get('sessionId');
    if (sessionId) {
      sessions.delete(sessionId);
    }
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
    return c.body(null, 204);
  });

  app.get(PATHS.session, auth, (c) => {
    const member = c.get('member');
    const sessionId = c.get('sessionId');
    // Cookie-auth requests have a sessionId so we can return expiresAt;
    // bearer-auth requests (machine plane) do not, and we report the
    // far future so clients don't infer a misleading expiry.
    const expiresAt = sessionId
      ? (sessions.get(sessionId)?.expiresAt ?? now() + SESSION_TTL_MS)
      : Number.MAX_SAFE_INTEGER;
    return c.json({
      member: member.name,
      role: member.role,
      permissions: member.permissions,
      expiresAt,
    });
  });

  // ─── Team endpoints (dual-auth) ────────────────────────────────

  app.get(PATHS.briefing, auth, (c) => {
    const member = c.get('member');
    // Live open objectives for this member — included in the briefing
    // so the runner can seed its open-plate snapshot (the source for
    // `context_refresh` re-briefs) and the web UI can render the plate.
    // Active + blocked are both "on the plate"; done/cancelled drop off.
    const openObjectives: Objective[] = objectives
      ? [
          ...objectives.list({ assignee: member.name, status: 'active' }),
          ...objectives.list({ assignee: member.name, status: 'blocked' }),
        ]
      : [];
    // External-notification doctrine: when any enabled endpoint can
    // reach this member (direct DM target, or a channel target on a
    // channel they belong to), the briefing prose gains the standing
    // contract for `<external_content>` blocks — defined once in the
    // system prompt so each delivery's wrapper stays compact.
    const externalNotificationEndpoints: string[] = [];
    if (notifications !== undefined) {
      for (const endpoint of notifications.list()) {
        if (!endpoint.enabled) continue;
        const reaches = endpoint.targets.some((t) => {
          if (t.member !== undefined) return t.member === member.name;
          if (t.channel !== undefined && channels) {
            return t.channel === GENERAL_CHANNEL_ID || channels.isMember(t.channel, member.name);
          }
          return false;
        });
        if (reaches) externalNotificationEndpoints.push(endpoint.slug);
      }
    }
    const briefing = composeBriefing({
      self: member,
      team: teamStore.getTeam(),
      teammates: teammatesFromMembers(members),
      openObjectives,
      // Structured field only — never rendered into the prose (same
      // staleness rule as openObjectives).
      toolSources: toolSources ? toolSources.resolveFor(member.name) : [],
      externalNotificationEndpoints,
    });
    return c.json(briefing);
  });

  app.get(PATHS.roster, auth, (c) => {
    // Decorate the live presence list with each member's ACTIVITY state
    // (idle/working/blocked). Both `activity` and the back-compat `busy`
    // mirror default to absent for members the tracker resolves as idle
    // (never reported, reported idle, or lapsed past the TTL) — older
    // clients ignore the fields and see the same shape they always have.
    // For non-idle members we surface `activity` plus `busy = activity
    // === 'working'`, so `blocked` reads as not-busy (an operator should
    // look) while still exposing the distinct state to new UIs.
    const presences = broker.listPresences().map((p) => {
      const activity = activityTracker.getActivity(p.name);
      if (activity === 'idle') return p;
      return { ...p, activity, busy: activity === 'working' };
    });
    return c.json({
      teammates: teammatesFromMembers(members),
      connected: presences,
    });
  });

  /**
   * Runner-driven presence report: records the authenticated member's
   * live ACTIVITY transition (idle/working/blocked). Bearer-only —
   * humans on the web UI never report this; the runner is the only
   * thing that knows.
   *
   * Body: `{ state: ActivityState, busy?: bool }`. `state` is
   * authoritative; the optional `busy` mirror is ignored server-side
   * (the roster derives `busy = state === 'working'`). Response is 204.
   *
   * The tracker is internally TTL'd so a runner that drops mid-turn
   * still gets reset to idle after ACTIVITY_TTL_MS. Runners are expected
   * to heartbeat (re-post the current non-idle state) every ~10s while
   * still working/blocked so the TTL stays fresh; on transition to idle
   * they post `state: 'idle'` once and drop the entry.
   */
  app.post(PATHS.presenceActivity, auth, async (c) => {
    const tokenId = c.get('tokenId');
    if (tokenId === null) {
      // Cookie + JWT subscribers don't have a runner context to report.
      return c.json({ error: 'presence/activity is runner-only (bearer auth required)' }, 403);
    }
    const member = c.get('member');
    const raw = await c.req.json().catch(() => null);
    const parsed = ActivityReportSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid activity report', details: parsed.error.issues }, 400);
    }
    activityTracker.report(member.name, parsed.data.state);
    // A transition out of `working` is the `if_busy: wait` flush
    // signal — deliver any external notifications held for this
    // member. Fire-and-forget; the report response never blocks on
    // message fanout.
    if (notificationDispatcher && parsed.data.state !== 'working') {
      const dispatcher = notificationDispatcher;
      queueMicrotask(() => {
        void dispatcher.onActivityReport(member.name, parsed.data.state).catch((err) => {
          logger.warn('notification busy-flush failed', {
            member: member.name,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
    }
    return c.body(null, 204);
  });

  app.post(PATHS.push, auth, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = PushPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid push payload', details: parsed.error.issues }, 400);
    }
    if (parsed.data.to && !broker.hasMember(parsed.data.to)) {
      return c.json({ error: `no such agent: ${parsed.data.to}` }, 404);
    }
    const member = c.get('member');

    // Attachment validation: every path must resolve, must be a file,
    // and the sender must have read access. The wire `size` / `mime`
    // / `name` fields are re-derived from the stored entry so the
    // sender can't lie about what they're attaching.
    const pushAttachmentsResult = canonicalizeAttachments(
      parsed.data.attachments,
      toViewer(member),
      files,
    );
    if (!pushAttachmentsResult.ok) {
      return c.json({ error: pushAttachmentsResult.error }, pushAttachmentsResult.status);
    }
    const canonicalAttachments = pushAttachmentsResult.canonical;

    const payload = canonicalAttachments
      ? { ...parsed.data, attachments: canonicalAttachments }
      : parsed.data;

    // Channel-scoped routing: if the payload tags itself for a
    // channel via `data.thread = 'chan:<id>'`, resolve the channel,
    // verify the sender is a member, and pass an explicit recipient
    // list down to the broker so the message fans out only to
    // channel members instead of broadcasting team-wide.
    //
    // The general channel (`chan:general`) deliberately falls through
    // to default broadcast routing — its membership is implicit.
    let pushContext: { from: string; recipients?: string[] } = { from: member.name };
    if (channels) {
      const threadTag = parsed.data.data?.thread;
      if (typeof threadTag === 'string' && threadTag.startsWith('chan:')) {
        const channelId = threadTag.slice('chan:'.length);
        if (channelId !== GENERAL_CHANNEL_ID) {
          const ch = channels.get(channelId);
          if (!ch) {
            return c.json({ error: `no such channel: ${channelId}` }, 404);
          }
          if (ch.archivedAt !== null) {
            return c.json({ error: 'channel is archived' }, 410);
          }
          if (!channels.isMember(channelId, member.name)) {
            return c.json({ error: 'not a member of this channel' }, 403);
          }
          const explicit = channels.recipientNames(channelId);
          if (explicit !== null) {
            pushContext = { from: member.name, recipients: explicit };
          }
        }
      }
    }

    const result = await broker.push(payload, pushContext);

    // Grant fanout — for every recipient that isn't the owner, record
    // a read grant keyed on the message id. The recipient set is the
    // push's audience: targeted = {target, sender}, broadcast = all
    // members. Owner self-grants are dropped by `files.grant` so we
    // don't need to filter here.
    if (files && canonicalAttachments.length > 0) {
      const recipients = new Set<string>();
      if (result.message.to) {
        recipients.add(result.message.to);
        if (member.name !== result.message.to) recipients.add(member.name);
      } else {
        for (const s of members.members()) recipients.add(s.name);
      }
      grantAttachmentsTo(files, canonicalAttachments, recipients, result.message.id, logger);
    }

    logger.info('push delivered', {
      messageId: result.message.id,
      from: member.name,
      targetAgent: parsed.data.to ?? '*broadcast*',
      attachments: canonicalAttachments.length,
      live: result.delivery.live,
      targets: result.delivery.targets,
    });
    // Fire-and-forget the push notification fanout. We don't await —
    // notification delivery shouldn't block the HTTP response, and
    // onPushed is responsible for its own error handling.
    if (onPushed) {
      queueMicrotask(() => {
        onPushed(result.message);
      });
    }
    return c.json(result);
  });

  // ─── Channels ─────────────────────────────────────────────────────
  //
  // Slack-style named team threads. Anyone can create; the creator
  // becomes admin. Admins manage rename/archive/membership; members
  // can self-leave (last-admin guard prevents orphaning a non-empty
  // channel). The synthetic `general` channel is everyone's default
  // and can't be modified — its membership is implicit.

  if (channels !== undefined) {
    const mapChannelsError = (
      // biome-ignore lint/suspicious/noExplicitAny: Hono's Context type is invariant; helper is only ever called inside a route handler
      ctx: Context<any, string, Record<string, unknown>>,
      err: unknown,
    ): Response => {
      if (err instanceof ChannelsError) {
        const status =
          err.code === 'not_found'
            ? 404
            : err.code === 'forbidden'
              ? 403
              : err.code === 'slug_taken'
                ? 409
                : err.code === 'archived'
                  ? 410
                  : err.code === 'reserved'
                    ? 403
                    : err.code === 'already_member' || err.code === 'not_member'
                      ? 409
                      : 400;
        return ctx.json({ error: err.message, code: err.code }, status);
      }
      return ctx.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    };
    // Use validateSlug at module-eval time so a startup typo in the
    // import doesn't slip past — it's the same validator the create
    // path uses. Keeps it from being flagged as unused.
    void validateSlug;

    const summarize = (slug: string, viewer: string): ChannelSummary | null => {
      const ch = channels.getBySlug(slug);
      if (!ch) return null;
      const members = channels.listMembers(ch.id);
      // General reports the team count; broker doesn't expose a
      // member-store-size primitive so we use the actively-known
      // member set (live presences) as the closest available proxy.
      const memberCount =
        ch.id === GENERAL_CHANNEL_ID ? broker.listPresences().length : members.length;
      const myRole = channels.roleOf(ch.id, viewer);
      return {
        ...ch,
        joined: ch.id === GENERAL_CHANNEL_ID ? true : myRole !== null,
        myRole: ch.id === GENERAL_CHANNEL_ID ? 'member' : myRole,
        memberCount,
      };
    };

    app.get(PATHS.channels, auth, (c) => {
      const member = c.get('member');
      const all = channels.listAll();
      const summaries: ChannelSummary[] = [];
      for (const ch of all) {
        const members = channels.listMembers(ch.id);
        const memberCount =
          ch.id === GENERAL_CHANNEL_ID ? broker.listPresences().length : members.length;
        const myRole = channels.roleOf(ch.id, member.name);
        summaries.push({
          ...ch,
          joined: ch.id === GENERAL_CHANNEL_ID ? true : myRole !== null,
          myRole: ch.id === GENERAL_CHANNEL_ID ? 'member' : myRole,
          memberCount,
        });
      }
      return c.json({ channels: summaries });
    });

    app.post(PATHS.channels, auth, async (c) => {
      const raw = await c.req.json().catch(() => null);
      const parsed = CreateChannelRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid channel input', details: parsed.error.issues }, 400);
      }
      const member = c.get('member');
      try {
        const ch = channels.create({ slug: parsed.data.slug, creator: member.name });
        return c.json(ch, 201);
      } catch (err) {
        return mapChannelsError(c, err);
      }
    });

    app.get(`${PATHS.channels}/:slug`, auth, (c) => {
      const slug = c.req.param('slug');
      const member = c.get('member');
      const summary = summarize(slug, member.name);
      if (!summary) return c.json({ error: `no such channel: ${slug}` }, 404);
      const members = channels.listMembers(summary.id);
      return c.json({ channel: summary, members });
    });

    app.patch(`${PATHS.channels}/:slug`, auth, async (c) => {
      const slug = c.req.param('slug');
      const raw = await c.req.json().catch(() => null);
      const parsed = RenameChannelRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid rename input', details: parsed.error.issues }, 400);
      }
      const ch = channels.getBySlug(slug);
      if (!ch) return c.json({ error: `no such channel: ${slug}` }, 404);
      const member = c.get('member');
      try {
        const renamed = channels.rename(ch.id, parsed.data.slug, member.name);
        return c.json(renamed);
      } catch (err) {
        return mapChannelsError(c, err);
      }
    });

    app.delete(`${PATHS.channels}/:slug`, auth, (c) => {
      const slug = c.req.param('slug');
      const ch = channels.getBySlug(slug);
      if (!ch) return c.json({ error: `no such channel: ${slug}` }, 404);
      const member = c.get('member');
      try {
        const archived = channels.archive(ch.id, member.name);
        return c.json(archived);
      } catch (err) {
        return mapChannelsError(c, err);
      }
    });

    // Add a member. Body may be empty for self-join (caller adds self
    // as `member`); else admins may add any team member at either role.
    app.post(`${PATHS.channels}/:slug/members`, auth, async (c) => {
      const slug = c.req.param('slug');
      const ch = channels.getBySlug(slug);
      if (!ch) return c.json({ error: `no such channel: ${slug}` }, 404);
      const caller = c.get('member');
      const raw = await c.req.json().catch(() => null);
      let target: string;
      let role: 'admin' | 'member' = 'member';
      if (raw === null) {
        // Empty body — self-join.
        target = caller.name;
      } else {
        const parsed = AddChannelMemberRequestSchema.safeParse(raw);
        if (!parsed.success) {
          return c.json({ error: 'invalid member input', details: parsed.error.issues }, 400);
        }
        target = parsed.data.member;
        role = parsed.data.role;
      }
      // Self-join is always allowed (this is a public-channel model).
      // Admin-add gates on the caller being an admin AND the target
      // being a real team member.
      const isSelf = target === caller.name;
      if (!isSelf) {
        const callerRole = channels.roleOf(ch.id, caller.name);
        if (callerRole !== 'admin') {
          return c.json({ error: 'only admins can add other members' }, 403);
        }
        if (members.findByName(target) === null) {
          return c.json({ error: `no such team member: ${target}` }, 404);
        }
      }
      try {
        channels.addMember({ channelId: ch.id, memberName: target, role });
      } catch (err) {
        return mapChannelsError(c, err);
      }
      const summary = summarize(slug, caller.name);
      const memberRows = channels.listMembers(ch.id);
      return c.json({ channel: summary, members: memberRows });
    });

    app.delete(`${PATHS.channels}/:slug/members/:name`, auth, (c) => {
      const slug = c.req.param('slug');
      const name = c.req.param('name');
      const ch = channels.getBySlug(slug);
      if (!ch) return c.json({ error: `no such channel: ${slug}` }, 404);
      const caller = c.get('member');
      const isSelf = name === caller.name;
      if (!isSelf) {
        const callerRole = channels.roleOf(ch.id, caller.name);
        if (callerRole !== 'admin') {
          return c.json({ error: 'only admins can remove other members' }, 403);
        }
      }
      try {
        channels.removeMember(ch.id, name);
      } catch (err) {
        return mapChannelsError(c, err);
      }
      const summary = summarize(slug, caller.name);
      const memberRows = channels.listMembers(ch.id);
      return c.json({ channel: summary, members: memberRows });
    });
  }

  // ─── Web Push endpoints ───────────────────────────────────────────

  if (vapidPublicKey !== undefined) {
    app.get(PATHS.pushVapidPublicKey, (c) => {
      return c.json({ publicKey: vapidPublicKey });
    });
  }

  if (pushStore !== undefined) {
    app.post(PATHS.pushSubscriptions, auth, async (c) => {
      const raw = await c.req.json().catch(() => null);
      const parsed = PushSubscriptionPayloadSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid push subscription', details: parsed.error.issues }, 400);
      }
      const member = c.get('member');
      const userAgent = c.req.header('User-Agent') ?? null;
      const row = pushStore.upsert({
        memberName: member.name,
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        userAgent,
      });
      logger.info('push subscription registered', {
        name: member.name,
        id: row.id,
      });
      return c.json({ id: row.id, endpoint: row.endpoint, createdAt: row.createdAt });
    });

    app.delete(`${PATHS.pushSubscriptions}/:id`, auth, (c) => {
      const idParam = c.req.param('id');
      const id = Number.parseInt(idParam, 10);
      if (!Number.isFinite(id) || id < 1) {
        return c.json({ error: 'invalid subscription id' }, 400);
      }
      const member = c.get('member');
      pushStore.deleteForMember(id, member.name);
      return c.body(null, 204);
    });
  }

  // ─── OTLP telemetry sink ──────────────────────────────────────────
  //
  // Claude Code exports OpenTelemetry logs + metrics to the broker via
  // OTLP/HTTP-JSON. We persist EVERY record losslessly (known or
  // unknown event/metric name — no allowlist) so dashboards + analytics
  // are pure downstream queries. Auth is the standard bearer plane; the
  // OTEL exporter's `Bearer%20` header form is normalized in auth.ts.
  //
  // The response is always `200 { partialSuccess: {} }` — the OTLP
  // success shape. Parsing never throws and storage failures are logged
  // rather than surfaced, because an OTEL exporter that gets a non-2xx
  // will retry the batch indefinitely; we'd rather drop a malformed
  // batch than wedge the exporter.
  if (telemetryStore !== undefined || genaiStore !== undefined) {
    app.post('/otlp/v1/logs', auth, async (c) => {
      const member = c.get('member');
      const raw = await c.req.json().catch(() => null);
      const records = parseOtlpLogs(raw);

      // Split the batch. The gen_ai correlator consumes the four api-body
      // records (api_request_body / api_request / api_response_body /
      // api_error). But only the two RAW BODY records are gen_ai-exclusive
      // (they're large and get parsed into full-context inference records);
      // `api_request` and `api_error` carry operational accounting
      // (cost/tokens/duration/error) that must ALSO stay in the telemetry
      // sink — the correlator only uses them for request_id bridging and
      // eviction. So those two go to BOTH sinks.
      const genaiRecords = [];
      const telemetryRecords = [];
      for (const rec of records) {
        const toGenai = genaiStore !== undefined && isGenAiLogRecord(rec.name);
        if (toGenai) genaiRecords.push(rec);
        const isRawBody = rec.name === 'api_request_body' || rec.name === 'api_response_body';
        if (!(toGenai && isRawBody)) telemetryRecords.push(rec);
      }

      if (telemetryStore !== undefined && telemetryRecords.length > 0) {
        try {
          telemetryStore.append(member.name, telemetryRecords);
        } catch (err) {
          logger.warn('otlp logs store failed', {
            member: member.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (genaiStore !== undefined && genaiRecords.length > 0) {
        try {
          const inferences = getGenAiCorrelator(member.name).ingest(genaiRecords);
          for (const inf of inferences) {
            genaiStore.append(member.name, inf);
          }
        } catch (err) {
          logger.warn('otlp genai ingest failed', {
            member: member.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return c.json({ partialSuccess: {} }, 200);
    });
  }

  if (telemetryStore !== undefined) {
    app.post('/otlp/v1/metrics', auth, async (c) => {
      const member = c.get('member');
      const raw = await c.req.json().catch(() => null);
      try {
        telemetryStore.append(member.name, parseOtlpMetrics(raw));
      } catch (err) {
        logger.warn('otlp metrics store failed', {
          member: member.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return c.json({ partialSuccess: {} }, 200);
    });
  }

  // GenAI inference read path — the full-fidelity request layer
  // (system instructions + complete input context) behind the trace
  // viewer's enrichment join. Same visibility rule as the activity
  // stream: self OR `activity.read`. Rows come back oldest-first
  // within the `ts` bounds; coverage is best-effort (only calls whose
  // bodies the agent's instrumentation exported), which is why the
  // trace viewer joins these onto `llm_exchange` markers rather than
  // reading this endpoint alone.
  if (genaiStore !== undefined) {
    const gStore = genaiStore;
    app.get('/members/:name/genai', auth, (c) => {
      const member = c.get('member');
      const parsedName = NameSchema.safeParse(c.req.param('name'));
      if (!parsedName.success) return c.json({ error: 'invalid name' }, 400);
      const name = parsedName.data;
      const isSelf = name === member.name;
      const canReadAny = hasPermission(member.permissions, 'activity.read');
      if (!isSelf && !canReadAny) {
        return c.json(
          { error: 'reading gen_ai inferences requires activity.read permission, or self' },
          403,
        );
      }
      const fromRaw = c.req.query('from');
      const toRaw = c.req.query('to');
      const limitRaw = c.req.query('limit');
      const from = fromRaw !== undefined ? Number(fromRaw) : undefined;
      const to = toRaw !== undefined ? Number(toRaw) : undefined;
      const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
      if (from !== undefined && !Number.isFinite(from)) {
        return c.json({ error: 'invalid `from` parameter' }, 400);
      }
      if (to !== undefined && !Number.isFinite(to)) {
        return c.json({ error: 'invalid `to` parameter' }, 400);
      }
      if (limit !== undefined && !Number.isFinite(limit)) {
        return c.json({ error: 'invalid `limit` parameter' }, 400);
      }
      const rows = gStore.list({
        memberName: name,
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      // `view=summary` serves the light call-ledger projection (no
      // content arrays) — cheap enough for the timeline to hydrate a
      // whole feed window and join onto its llm_exchange markers.
      if (c.req.query('view') === 'summary') {
        const inferences = rows.map((r) => ({
          id: r.id,
          memberName: r.memberName,
          operationName: r.operationName,
          provider: r.provider,
          model: r.model,
          responseId: r.responseId,
          finishReasons: r.finishReasons,
          usage: r.usage,
          querySource: r.querySource,
          agentName: r.agentName,
          ts: r.ts,
          receivedAt: r.receivedAt,
        }));
        return c.json({ inferences });
      }
      // Wire projection: drop the server-internal raw-body pointers
      // (`requestBodyRef` and the sha256 columns stay server-side).
      const inferences = rows.map((r) => ({
        id: r.id,
        memberName: r.memberName,
        operationName: r.operationName,
        provider: r.provider,
        model: r.model,
        responseId: r.responseId,
        finishReasons: r.finishReasons,
        usage: r.usage,
        systemInstructions: r.systemInstructions,
        inputMessages: r.inputMessages,
        outputMessages: r.outputMessages,
        querySource: r.querySource,
        agentName: r.agentName,
        ts: r.ts,
        receivedAt: r.receivedAt,
      }));
      return c.json({ inferences });
    });

    // Single full record by id — the heavy-body counterpart of a
    // summary row. Same visibility rule as the list; a cross-member id
    // is a 404 (indistinguishable from absent) rather than a 403 so
    // ids don't leak which member owns them.
    app.get('/members/:name/genai/:id', auth, (c) => {
      const member = c.get('member');
      const parsedName = NameSchema.safeParse(c.req.param('name'));
      if (!parsedName.success) return c.json({ error: 'invalid name' }, 400);
      const name = parsedName.data;
      const isSelf = name === member.name;
      const canReadAny = hasPermission(member.permissions, 'activity.read');
      if (!isSelf && !canReadAny) {
        return c.json(
          { error: 'reading gen_ai inferences requires activity.read permission, or self' },
          403,
        );
      }
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id < 0) {
        return c.json({ error: 'invalid `id` parameter' }, 400);
      }
      const row = gStore.getById(id);
      if (row === null || row.memberName !== name) {
        return c.json({ error: 'inference not found' }, 404);
      }
      return c.json({
        inference: {
          id: row.id,
          memberName: row.memberName,
          operationName: row.operationName,
          provider: row.provider,
          model: row.model,
          responseId: row.responseId,
          finishReasons: row.finishReasons,
          usage: row.usage,
          systemInstructions: row.systemInstructions,
          inputMessages: row.inputMessages,
          outputMessages: row.outputMessages,
          querySource: row.querySource,
          agentName: row.agentName,
          ts: row.ts,
          receivedAt: row.receivedAt,
        },
      });
    });
  }

  // Codex gen_ai ingest — the codex analogue of Claude's OTLP body_ref →
  // correlator path. Codex has no OTLP body channel; its runner tails the
  // rollout-TRACE bundle and uploads each completed inference's VERBATIM
  // request+response payload bytes here. The bundle already pairs request
  // and response per call, so there's no correlation to do: we
  // content-address the raw bytes FIRST (before any reshape), then map a
  // parsed copy into a GenAiInference via the pure core mapper. Self-only,
  // and defensive — a malformed entry is skipped, its raw bytes still land.
  if (genaiStore !== undefined && rawBodyStore !== undefined) {
    const gStore = genaiStore;
    const rStore = rawBodyStore;
    const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    const numOrNull = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    app.post('/members/:name/genai', auth, async (c) => {
      const member = c.get('member');
      const parsedName = NameSchema.safeParse(c.req.param('name'));
      if (!parsedName.success) return c.json({ error: 'invalid name' }, 400);
      const name = parsedName.data;
      if (name !== member.name) {
        return c.json({ error: `user '${member.name}' cannot upload gen_ai for '${name}'` }, 403);
      }
      const raw = await c.req.json().catch(() => null);
      const inferences =
        raw &&
        typeof raw === 'object' &&
        Array.isArray((raw as { inferences?: unknown }).inferences)
          ? ((raw as { inferences: unknown[] }).inferences as unknown[])
          : [];
      let accepted = 0;
      for (const item of inferences) {
        try {
          const inf = item as Record<string, unknown>;
          const reqB64 = strOrNull(inf?.requestBase64);
          const respB64 = strOrNull(inf?.responseBase64);
          if (reqB64 === null || respB64 === null) continue;
          const reqBytes = Buffer.from(reqB64, 'base64');
          const respBytes = Buffer.from(respB64, 'base64');
          const envelope = {
            requestId: strOrNull(inf.upstreamRequestId),
            sessionId: strOrNull(inf.threadId),
            querySource: strOrNull(inf.querySource),
            agentName: strOrNull(inf.agentName),
            model: strOrNull(inf.model),
            eventTs: numOrNull(inf.ts),
          };
          // Verbatim bytes first — content-addressed before any parse.
          const { hash: requestSha256 } = rStore.appendBody({
            memberName: name,
            kind: 'request',
            bytes: reqBytes,
            envelope,
          });
          const { hash: responseSha256 } = rStore.appendBody({
            memberName: name,
            kind: 'response',
            bytes: respBytes,
            envelope,
          });
          // Derived view — parse a COPY; a malformed body maps to a
          // model-only record rather than vanishing (raw already captured).
          let requestBody: unknown = null;
          let responseBody: unknown = null;
          try {
            requestBody = JSON.parse(reqBytes.toString('utf8'));
          } catch {
            /* keep null */
          }
          try {
            responseBody = JSON.parse(respBytes.toString('utf8'));
          } catch {
            /* keep null */
          }
          const rec = openaiResponsesToGenAi({
            requestBody,
            responseBody,
            model: envelope.model,
            responseId: strOrNull(inf.responseId),
            querySource: envelope.querySource,
            agentName: envelope.agentName,
            ts: envelope.eventTs ?? undefined,
          });
          gStore.append(name, { ...rec, requestSha256, responseSha256 });
          accepted++;
        } catch (err) {
          logger.warn('codex genai ingest entry failed', {
            member: name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return c.json({ accepted }, 200);
    });
  }

  // ─── Tool sources ─────────────────────────────────────────────────
  // Platform-defined external tools: `custom` (HTTP bindings the
  // broker executes with stored credentials) and `mcp` (remote MCP
  // servers the broker proxies). Registry mutations gate on
  // `tools.manage`; invoke gates on the caller being bound (or the
  // source being open to all members). Credentials are write-only.
  // Registered iff a ToolSourceStore is provided.

  if (toolSources !== undefined) {
    const mapToolSourcesError = (
      // biome-ignore lint/suspicious/noExplicitAny: Hono's Context type is invariant; helper is only ever called inside a route handler
      ctx: Context<any, string, Record<string, unknown>>,
      err: unknown,
    ): Response => {
      if (err instanceof ToolSourcesError) {
        const status =
          err.code === 'not_found'
            ? 404
            : err.code === 'slug_taken'
              ? 409
              : err.code === 'no_kek'
                ? 503
                : 400;
        return ctx.json({ error: err.message, code: err.code }, status);
      }
      return ctx.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    };

    const summarizeSource = (source: ToolSource, viewer: string): ToolSourceSummary => ({
      ...source,
      hasCredential: toolSources.hasCredential(source.id),
      toolCount: toolSources.toolCount(source.id, source.kind),
      bound: source.allMembers || toolSources.isBound(source.id, viewer),
    });

    /**
     * Recipients for a tool-source change event: the source's visible
     * set (whole team when allMembers, else bound members) plus every
     * `tools.manage` holder (admins observe registry changes the way
     * `members.manage` holders observe objectives).
     */
    const toolSourceRecipients = (source: ToolSource, extraMember?: string): Set<string> => {
      const names = new Set<string>();
      if (source.allMembers) {
        for (const m of members.members()) names.add(m.name);
      } else {
        for (const name of toolSources.listBindings(source.id)) names.add(name);
      }
      for (const m of members.members()) {
        if (m.permissions.includes('tools.manage')) names.add(m.name);
      }
      if (extraMember) names.add(extraMember);
      return names;
    };

    const publishToolSourceEvent = async (
      source: ToolSource,
      event: string,
      actor: string,
      opts: { body: string; recipients?: Set<string>; extra?: Record<string, unknown> },
    ): Promise<void> => {
      const recipients = opts.recipients ?? toolSourceRecipients(source);
      // One multi-recipient push, not a per-target loop — same
      // rationale as publishObjectiveEvent. Never include credential
      // material or header names in body or data.
      try {
        await broker.push(
          {
            body: opts.body,
            level: 'info',
            data: {
              kind: 'tool_source',
              event,
              source_slug: source.slug,
              source_kind: source.kind,
              thread: `tool:${source.slug}`,
              actor,
              ...(opts.extra ?? {}),
            },
          },
          { from: actor, recipients: [...recipients] },
        );
      } catch (err) {
        logger.warn('failed to fanout tool-source event', {
          source: source.slug,
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const requireToolsManage = (
      // biome-ignore lint/suspicious/noExplicitAny: helper is only ever called inside a route handler
      ctx: Context<any, string, Record<string, unknown>>,
    ): Response | null => {
      const member = ctx.get('member');
      if (!hasPermission(member.permissions, 'tools.manage')) {
        return ctx.json({ error: 'requires tools.manage' }, 403);
      }
      return null;
    };

    // GET /tool-sources — list, per-viewer summaries. Dual-auth.
    app.get(PATHS.toolSources, auth, (c) => {
      const member = c.get('member');
      const sources = toolSources.list().map((s) => summarizeSource(s, member.name));
      return c.json({ sources });
    });

    // POST /tool-sources — create (tools.manage).
    app.post(PATHS.toolSources, auth, async (c) => {
      const denied = requireToolsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const raw = await c.req.json().catch(() => null);
      const parsed = CreateToolSourceRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid tool source payload', details: parsed.error.issues }, 400);
      }
      try {
        const source = toolSources.create({
          slug: parsed.data.slug,
          kind: parsed.data.kind,
          ...(parsed.data.displayName !== undefined
            ? { displayName: parsed.data.displayName }
            : {}),
          ...(parsed.data.config !== undefined ? { config: parsed.data.config } : {}),
          ...(parsed.data.allMembers !== undefined ? { allMembers: parsed.data.allMembers } : {}),
          ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
          creator: member.name,
        });
        queueMicrotask(() => {
          void publishToolSourceEvent(source, 'created', member.name, {
            body: `Tool source '${source.slug}' (${source.kind}) was registered by ${member.name}.`,
          });
        });
        return c.json(source, 201);
      } catch (err) {
        return mapToolSourcesError(c, err);
      }
    });

    // GET /tool-sources/:slug — detail. Bound members + admins see
    // tool defs; only tools.manage sees the binding list.
    app.get(`${PATHS.toolSources}/:slug`, auth, (c) => {
      const member = c.get('member');
      const source = toolSources.getBySlug(c.req.param('slug'));
      if (!source) return c.json({ error: 'no such tool source' }, 404);
      const isAdmin = hasPermission(member.permissions, 'tools.manage');
      const tools =
        source.kind === 'custom'
          ? toolSources.listCustomTools(source.id)
          : toolSources.listMcpToolsCache(source.id).map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            }));
      return c.json({
        source: summarizeSource(source, member.name),
        tools,
        ...(isAdmin ? { boundMembers: toolSources.listBindings(source.id) } : {}),
      });
    });

    // PATCH /tool-sources/:slug — update mutable fields (tools.manage).
    app.patch(`${PATHS.toolSources}/:slug`, auth, async (c) => {
      const denied = requireToolsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const source = toolSources.getBySlug(c.req.param('slug'));
      if (!source) return c.json({ error: 'no such tool source' }, 404);
      const raw = await c.req.json().catch(() => null);
      const parsed = UpdateToolSourceRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid tool source payload', details: parsed.error.issues }, 400);
      }
      // Capture the pre-mutation visible set: a `disabled` event must
      // reach the members who are LOSING the tools.
      const preRecipients = toolSourceRecipients(source);
      try {
        const updated = toolSources.update(source.id, {
          ...(parsed.data.displayName !== undefined
            ? { displayName: parsed.data.displayName }
            : {}),
          ...(parsed.data.config !== undefined ? { config: parsed.data.config } : {}),
          ...(parsed.data.allMembers !== undefined ? { allMembers: parsed.data.allMembers } : {}),
          ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
        });
        // Config/enable changes invalidate any live upstream client.
        mcpManager?.invalidate(source.id);
        const event =
          parsed.data.enabled === undefined
            ? 'updated'
            : parsed.data.enabled
              ? 'enabled'
              : 'disabled';
        queueMicrotask(() => {
          void publishToolSourceEvent(updated, event, member.name, {
            body: `Tool source '${updated.slug}' was ${event} by ${member.name}.`,
            recipients: event === 'disabled' ? preRecipients : toolSourceRecipients(updated),
          });
        });
        return c.json(updated);
      } catch (err) {
        return mapToolSourcesError(c, err);
      }
    });

    // DELETE /tool-sources/:slug — delete + cascade (tools.manage).
    app.delete(`${PATHS.toolSources}/:slug`, auth, (c) => {
      const denied = requireToolsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const source = toolSources.getBySlug(c.req.param('slug'));
      if (!source) return c.json({ error: 'no such tool source' }, 404);
      const preRecipients = toolSourceRecipients(source);
      try {
        toolSources.delete(source.id);
        mcpManager?.invalidate(source.id);
        queueMicrotask(() => {
          void publishToolSourceEvent(source, 'deleted', member.name, {
            body: `Tool source '${source.slug}' was deleted by ${member.name}.`,
            recipients: preRecipients,
          });
        });
        return c.json({ ok: true });
      } catch (err) {
        return mapToolSourcesError(c, err);
      }
    });

    // PUT /tool-sources/:slug/credential — set static credential
    // (tools.manage). Write-only; the secret never leaves the server.
    app.put(`${PATHS.toolSources}/:slug/credential`, auth, async (c) => {
      const denied = requireToolsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const source = toolSources.getBySlug(c.req.param('slug'));
      if (!source) return c.json({ error: 'no such tool source' }, 404);
      const raw = await c.req.json().catch(() => null);
      const parsed = SetToolCredentialRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid credential payload', details: parsed.error.issues }, 400);
      }
      // A header credential must not collide with a header any
      // existing tool binding templates — the executor's injection
      // would silently overwrite it.
      if (parsed.data.kind === 'header' && parsed.data.headerName) {
        const headerLower = parsed.data.headerName.toLowerCase();
        for (const tool of toolSources.listCustomTools(source.id)) {
          const names = Object.keys(tool.binding.headers ?? {}).map((h) => h.toLowerCase());
          if (names.includes(headerLower)) {
            return c.json(
              {
                error: `credential header collides with a templated header on tool '${tool.name}'`,
              },
              409,
            );
          }
        }
      }
      try {
        toolSources.setCredential(source.id, {
          kind: parsed.data.kind,
          ...(parsed.data.headerName !== undefined ? { headerName: parsed.data.headerName } : {}),
          secret: parsed.data.secret,
        });
        mcpManager?.invalidate(source.id);
        queueMicrotask(() => {
          void publishToolSourceEvent(source, 'credential_set', member.name, {
            body: `Credentials for tool source '${source.slug}' were updated by ${member.name}.`,
          });
        });
        return c.json({ ok: true });
      } catch (err) {
        return mapToolSourcesError(c, err);
      }
    });

    // DELETE /tool-sources/:slug/credential (tools.manage).
    app.delete(`${PATHS.toolSources}/:slug/credential`, auth, (c) => {
      const denied = requireToolsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const source = toolSources.getBySlug(c.req.param('slug'));
      if (!source) return c.json({ error: 'no such tool source' }, 404);
      toolSources.deleteCredential(source.id);
      mcpManager?.invalidate(source.id);
      queueMicrotask(() => {
        void publishToolSourceEvent(source, 'credential_deleted', member.name, {
          body: `Credentials for tool source '${source.slug}' were removed by ${member.name}.`,
        });
      });
      return c.json({ ok: true });
    });

    // POST /tool-sources/:slug/bindings — bind a member (tools.manage).
    app.post(`${PATHS.toolSources}/:slug/bindings`, auth, async (c) => {
      const denied = requireToolsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const source = toolSources.getBySlug(c.req.param('slug'));
      if (!source) return c.json({ error: 'no such tool source' }, 404);
      const raw = await c.req.json().catch(() => null);
      const parsed = BindToolSourceRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid binding payload', details: parsed.error.issues }, 400);
      }
      if (members.findByName(parsed.data.member) === null) {
        return c.json({ error: `no such member: ${parsed.data.member}` }, 400);
      }
      toolSources.bind(source.id, parsed.data.member);
      queueMicrotask(() => {
        void publishToolSourceEvent(source, 'bound', member.name, {
          body: `${parsed.data.member} was given access to tool source '${source.slug}' by ${member.name}.`,
          extra: { member: parsed.data.member },
        });
      });
      return c.json({ ok: true, boundMembers: toolSources.listBindings(source.id) });
    });

    // DELETE /tool-sources/:slug/bindings/:name — unbind (tools.manage).
    app.delete(`${PATHS.toolSources}/:slug/bindings/:name`, auth, (c) => {
      const denied = requireToolsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const source = toolSources.getBySlug(c.req.param('slug'));
      if (!source) return c.json({ error: 'no such tool source' }, 404);
      const name = c.req.param('name');
      toolSources.unbind(source.id, name);
      queueMicrotask(() => {
        void publishToolSourceEvent(source, 'unbound', member.name, {
          // The removed member gets the event too so their runner
          // drops the tools.
          body: `${name}'s access to tool source '${source.slug}' was removed by ${member.name}.`,
          recipients: toolSourceRecipients(source, name),
          extra: { member: name },
        });
      });
      return c.json({ ok: true, boundMembers: toolSources.listBindings(source.id) });
    });

    // PUT /tool-sources/:slug/tools/:name — set/replace a custom tool
    // definition (tools.manage, kind=custom).
    app.put(`${PATHS.toolSources}/:slug/tools/:name`, auth, async (c) => {
      const denied = requireToolsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const source = toolSources.getBySlug(c.req.param('slug'));
      if (!source) return c.json({ error: 'no such tool source' }, 404);
      const raw = await c.req.json().catch(() => null);
      const parsed = SetCustomToolRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid tool payload', details: parsed.error.issues }, 400);
      }
      const name = c.req.param('name');
      try {
        toolSources.upsertCustomTool(source.id, {
          name,
          description: parsed.data.description,
          inputSchema: parsed.data.inputSchema,
          binding: parsed.data.binding,
        });
        queueMicrotask(() => {
          void publishToolSourceEvent(source, 'tool_upserted', member.name, {
            body: `Tool '${source.slug}__${name}' was defined by ${member.name}.`,
            extra: { tool: name },
          });
        });
        return c.json({ ok: true });
      } catch (err) {
        return mapToolSourcesError(c, err);
      }
    });

    // DELETE /tool-sources/:slug/tools/:name (tools.manage, kind=custom).
    app.delete(`${PATHS.toolSources}/:slug/tools/:name`, auth, (c) => {
      const denied = requireToolsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const source = toolSources.getBySlug(c.req.param('slug'));
      if (!source) return c.json({ error: 'no such tool source' }, 404);
      const name = c.req.param('name');
      toolSources.deleteCustomTool(source.id, name);
      queueMicrotask(() => {
        void publishToolSourceEvent(source, 'tool_deleted', member.name, {
          body: `Tool '${source.slug}__${name}' was removed by ${member.name}.`,
          extra: { tool: name },
        });
      });
      return c.json({ ok: true });
    });

    // POST /tool-sources/:slug/refresh — re-discover upstream MCP
    // tools (tools.manage, kind=mcp). Synchronous: the admin wants
    // the tool list back; 502 when the upstream is unreachable.
    app.post(`${PATHS.toolSources}/:slug/refresh`, auth, async (c) => {
      const denied = requireToolsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const source = toolSources.getBySlug(c.req.param('slug'));
      if (!source) return c.json({ error: 'no such tool source' }, 404);
      if (source.kind !== 'mcp') {
        return c.json({ error: 'refresh only applies to mcp sources' }, 400);
      }
      if (mcpManager === undefined) {
        return c.json({ error: 'mcp support is not enabled on this broker' }, 503);
      }
      try {
        const { tools, changed } = await mcpManager.refresh(source);
        if (changed) {
          queueMicrotask(() => {
            void publishToolSourceEvent(source, 'tools_changed', member.name, {
              body: `Tool source '${source.slug}' was refreshed: ${tools.length} tool(s) available.`,
            });
          });
        }
        return c.json({
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
          changed,
        });
      } catch (err) {
        if (err instanceof McpUnavailableError) {
          return c.json({ error: `upstream MCP server unreachable: ${err.message}` }, 502);
        }
        return mapToolSourcesError(c, err);
      }
    });

    // POST /tool-sources/:slug/tools/:name/invoke — the execution
    // path. Caller must be bound (no tools.manage bypass — admins
    // bind themselves). Tool-level failures are 200 + isError per MCP
    // convention; authz/registry problems are HTTP errors. Checked in
    // an order that leaks nothing to unbound probers: 404 slug → 403
    // unbound → 409 disabled → 400 payload → 404 tool.
    app.post(`${PATHS.toolSources}/:slug/tools/:name/invoke`, auth, async (c) => {
      const member = c.get('member');
      const source = toolSources.getBySlug(c.req.param('slug'));
      if (!source) return c.json({ error: 'no such tool source' }, 404);
      const bound = source.allMembers || toolSources.isBound(source.id, member.name);
      if (!bound) return c.json({ error: 'not bound to this tool source' }, 403);
      if (!source.enabled) return c.json({ error: 'tool source is disabled' }, 409);

      const contentLength = Number(c.req.header('content-length') ?? '0');
      if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) {
        return c.json({ error: 'invoke payload too large (max 1 MiB)' }, 413);
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = InvokeToolRequestSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        return c.json({ error: 'invalid invoke payload', details: parsed.error.issues }, 400);
      }
      const args = parsed.data.args ?? {};
      const toolName = c.req.param('name');
      const startedAt = now();

      let result: Awaited<ReturnType<typeof executeCustomTool>>;
      try {
        if (source.kind === 'custom') {
          const tool = toolSources.getCustomTool(source.id, toolName);
          if (!tool) return c.json({ error: `no such tool: ${toolName}` }, 404);
          result = await executeCustomTool({
            binding: tool.binding,
            credential: toolSources.getCredential(source.id),
            args,
          });
        } else {
          if (mcpManager === undefined) {
            return c.json({ error: 'mcp support is not enabled on this broker' }, 503);
          }
          const cached = toolSources.getMcpCachedTool(source.id, toolName);
          if (!cached) {
            return c.json(
              {
                error: `no such tool: ${toolName} (if recently added upstream, ask an operator to refresh the source)`,
              },
              404,
            );
          }
          result = await mcpManager.invoke(source, toolName, args);
        }
      } catch (err) {
        if (err instanceof McpUnavailableError) {
          return c.json({ error: `upstream MCP server unreachable: ${err.message}` }, 502);
        }
        if (err instanceof ToolSourcesError && err.code === 'no_kek') {
          logger.error('tool invoke failed: no KEK for credential decrypt', {
            source: source.slug,
          });
          return c.json({ error: 'credential unavailable' }, 500);
        }
        logger.error('tool invoke crashed', {
          source: source.slug,
          tool: toolName,
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: 'internal error' }, 500);
      }

      // Broker-side audit — authoritative record of the invocation.
      // Guarded: the activity store is optional, and an audit failure
      // must never fail a successful invoke. The full result payload
      // already flows to the runner; record meta only.
      if (activityStore) {
        try {
          const inputJson = JSON.stringify(args);
          activityStore.append(member.name, [
            {
              kind: 'tool_action',
              ts: startedAt,
              durationMs: now() - startedAt,
              agent: 'broker',
              source: 'tool_source',
              toolName: `${source.slug}__${toolName}`,
              input: inputJson.length > 8_192 ? { truncated: true } : args,
              result: {
                isError: result.isError === true,
                contentBlocks: result.content.length,
              },
              isError: result.isError === true,
            },
          ]);
        } catch (err) {
          logger.warn('tool invoke audit append failed', {
            source: source.slug,
            tool: toolName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return c.json(result, 200);
    });
  }

  // ─── Secret endpoints ─────────────────────────────────────────────
  // Broker-held environment secrets the runner injects on the agent
  // child at spawn. Values are write-only (KEK-encrypted at rest,
  // never returned); `/secrets/resolve` is the single read path and
  // returns only the calling member's own resolved env delta.
  // Registry mutations gate on `secrets.manage`. Registered iff a
  // SecretsStore is provided.

  if (secrets !== undefined) {
    const mapSecretsError = (
      // biome-ignore lint/suspicious/noExplicitAny: Hono's Context type is invariant; helper is only ever called inside a route handler
      ctx: Context<any, string, Record<string, unknown>>,
      err: unknown,
    ): Response => {
      if (err instanceof SecretsError) {
        const status =
          err.code === 'not_found'
            ? 404
            : err.code === 'slug_taken' || err.code === 'env_taken'
              ? 409
              : err.code === 'no_kek'
                ? 503
                : 400;
        return ctx.json({ error: err.message, code: err.code }, status);
      }
      return ctx.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    };

    const summarizeSecret = (secret: Secret, viewer: string): SecretSummary => ({
      ...secret,
      hasValue: secrets.hasValue(secret.id),
      bound: secret.allMembers || secrets.isBound(secret.id, viewer),
    });

    /**
     * Recipients for a secret change event: the delivery set (whole
     * team when allMembers, else bound members) plus every
     * `secrets.manage` holder. Same shape as tool-source events; the
     * body doubles as the "restart your runner to pick this up"
     * signal since the agent env is frozen at spawn.
     */
    const secretRecipients = (secret: Secret, extraMember?: string): Set<string> => {
      const names = new Set<string>();
      if (secret.allMembers) {
        for (const m of members.members()) names.add(m.name);
      } else {
        for (const name of secrets.listBindings(secret.id)) names.add(name);
      }
      for (const m of members.members()) {
        if (m.permissions.includes('secrets.manage')) names.add(m.name);
      }
      if (extraMember) names.add(extraMember);
      return names;
    };

    const publishSecretEvent = async (
      secret: Secret,
      event: string,
      actor: string,
      opts: { body: string; recipients?: Set<string>; extra?: Record<string, unknown> },
    ): Promise<void> => {
      const recipients = opts.recipients ?? secretRecipients(secret);
      // Never include the value — envName and slug only.
      try {
        await broker.push(
          {
            body: opts.body,
            level: 'info',
            data: {
              kind: 'secret',
              event,
              secret_slug: secret.slug,
              env_name: secret.envName,
              thread: `secret:${secret.slug}`,
              actor,
              ...(opts.extra ?? {}),
            },
          },
          { from: actor, recipients: [...recipients] },
        );
      } catch (err) {
        logger.warn('failed to fanout secret event', {
          secret: secret.slug,
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const requireSecretsManage = (
      // biome-ignore lint/suspicious/noExplicitAny: helper is only ever called inside a route handler
      ctx: Context<any, string, Record<string, unknown>>,
    ): Response | null => {
      const member = ctx.get('member');
      if (!hasPermission(member.permissions, 'secrets.manage')) {
        return ctx.json({ error: 'requires secrets.manage' }, 403);
      }
      return null;
    };

    // GET /secrets/resolve — the runner's read path. Registered
    // before `/:slug` so the literal segment wins. Returns the
    // decrypted env delta for the CALLING member only; there is no
    // way to resolve another member's secrets.
    app.get(PATHS.secretsResolve, auth, (c) => {
      const member = c.get('member');
      try {
        const env = secrets.resolveFor(member.name);
        // Delivery audit: names only, never values.
        logger.info('secrets resolved', {
          member: member.name,
          envNames: Object.keys(env),
        });
        return c.json({ env });
      } catch (err) {
        return mapSecretsError(c, err);
      }
    });

    // GET /secrets — list, per-viewer summaries. Dual-auth.
    app.get(PATHS.secrets, auth, (c) => {
      const member = c.get('member');
      const list = secrets.list().map((s) => summarizeSecret(s, member.name));
      return c.json({ secrets: list });
    });

    // POST /secrets — create (secrets.manage). The value is set
    // separately via PUT /secrets/:slug/value.
    app.post(PATHS.secrets, auth, async (c) => {
      const denied = requireSecretsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const raw = await c.req.json().catch(() => null);
      const parsed = CreateSecretRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid secret payload', details: parsed.error.issues }, 400);
      }
      try {
        const secret = secrets.create({
          slug: parsed.data.slug,
          envName: parsed.data.envName,
          ...(parsed.data.description !== undefined
            ? { description: parsed.data.description }
            : {}),
          ...(parsed.data.allMembers !== undefined ? { allMembers: parsed.data.allMembers } : {}),
          ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
          creator: member.name,
        });
        queueMicrotask(() => {
          void publishSecretEvent(secret, 'created', member.name, {
            body: `Secret '${secret.slug}' (${secret.envName}) was registered by ${member.name}.`,
          });
        });
        return c.json(secret, 201);
      } catch (err) {
        return mapSecretsError(c, err);
      }
    });

    // GET /secrets/:slug — detail. Only secrets.manage sees bindings.
    app.get(`${PATHS.secrets}/:slug`, auth, (c) => {
      const member = c.get('member');
      const secret = secrets.getBySlug(c.req.param('slug'));
      if (!secret) return c.json({ error: 'no such secret' }, 404);
      const isAdmin = hasPermission(member.permissions, 'secrets.manage');
      return c.json({
        secret: summarizeSecret(secret, member.name),
        ...(isAdmin ? { boundMembers: secrets.listBindings(secret.id) } : {}),
      });
    });

    // PATCH /secrets/:slug — update mutable fields (secrets.manage).
    app.patch(`${PATHS.secrets}/:slug`, auth, async (c) => {
      const denied = requireSecretsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const secret = secrets.getBySlug(c.req.param('slug'));
      if (!secret) return c.json({ error: 'no such secret' }, 404);
      const raw = await c.req.json().catch(() => null);
      const parsed = UpdateSecretRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid secret payload', details: parsed.error.issues }, 400);
      }
      // A `disabled` event must reach the members who are LOSING the
      // secret — capture the pre-mutation delivery set.
      const preRecipients = secretRecipients(secret);
      try {
        const updated = secrets.update(secret.id, {
          ...(parsed.data.envName !== undefined ? { envName: parsed.data.envName } : {}),
          ...(parsed.data.description !== undefined
            ? { description: parsed.data.description }
            : {}),
          ...(parsed.data.allMembers !== undefined ? { allMembers: parsed.data.allMembers } : {}),
          ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
        });
        const event =
          parsed.data.enabled === undefined
            ? 'updated'
            : parsed.data.enabled
              ? 'enabled'
              : 'disabled';
        queueMicrotask(() => {
          void publishSecretEvent(updated, event, member.name, {
            body: `Secret '${updated.slug}' was ${event} by ${member.name}. Running agents pick this up on their next runner start.`,
            recipients: event === 'disabled' ? preRecipients : secretRecipients(updated),
          });
        });
        return c.json(updated);
      } catch (err) {
        return mapSecretsError(c, err);
      }
    });

    // DELETE /secrets/:slug — delete + cascade (secrets.manage).
    app.delete(`${PATHS.secrets}/:slug`, auth, (c) => {
      const denied = requireSecretsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const secret = secrets.getBySlug(c.req.param('slug'));
      if (!secret) return c.json({ error: 'no such secret' }, 404);
      const preRecipients = secretRecipients(secret);
      try {
        secrets.delete(secret.id);
        queueMicrotask(() => {
          void publishSecretEvent(secret, 'deleted', member.name, {
            body: `Secret '${secret.slug}' was deleted by ${member.name}.`,
            recipients: preRecipients,
          });
        });
        return c.json({ ok: true });
      } catch (err) {
        return mapSecretsError(c, err);
      }
    });

    // PUT /secrets/:slug/value — set the value (secrets.manage).
    // Write-only; the value never leaves the server except via
    // /secrets/resolve to a bound member's runner.
    app.put(`${PATHS.secrets}/:slug/value`, auth, async (c) => {
      const denied = requireSecretsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const secret = secrets.getBySlug(c.req.param('slug'));
      if (!secret) return c.json({ error: 'no such secret' }, 404);
      const raw = await c.req.json().catch(() => null);
      const parsed = SetSecretValueRequestSchema.safeParse(raw);
      if (!parsed.success) {
        // Schema issues would echo the (invalid) value back — return
        // a generic message instead of zod issue details.
        return c.json({ error: 'invalid value payload' }, 400);
      }
      try {
        secrets.setValue(secret.id, parsed.data.value);
        // Broker-side ingest (OTLP bodies, genai bundles) redacts in
        // this process — teach the redactor the new value immediately.
        registerSecretValues([parsed.data.value]);
        queueMicrotask(() => {
          void publishSecretEvent(secret, 'value_set', member.name, {
            body: `The value of secret '${secret.slug}' was updated by ${member.name}. Running agents pick this up on their next runner start.`,
          });
        });
        return c.json({ ok: true });
      } catch (err) {
        return mapSecretsError(c, err);
      }
    });

    // DELETE /secrets/:slug/value (secrets.manage).
    app.delete(`${PATHS.secrets}/:slug/value`, auth, (c) => {
      const denied = requireSecretsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const secret = secrets.getBySlug(c.req.param('slug'));
      if (!secret) return c.json({ error: 'no such secret' }, 404);
      secrets.deleteValue(secret.id);
      queueMicrotask(() => {
        void publishSecretEvent(secret, 'value_deleted', member.name, {
          body: `The value of secret '${secret.slug}' was removed by ${member.name}.`,
        });
      });
      return c.json({ ok: true });
    });

    // POST /secrets/:slug/bindings — bind a member (secrets.manage).
    app.post(`${PATHS.secrets}/:slug/bindings`, auth, async (c) => {
      const denied = requireSecretsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const secret = secrets.getBySlug(c.req.param('slug'));
      if (!secret) return c.json({ error: 'no such secret' }, 404);
      const raw = await c.req.json().catch(() => null);
      const parsed = BindSecretRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid binding payload', details: parsed.error.issues }, 400);
      }
      if (members.findByName(parsed.data.member) === null) {
        return c.json({ error: `no such member: ${parsed.data.member}` }, 400);
      }
      secrets.bind(secret.id, parsed.data.member);
      queueMicrotask(() => {
        void publishSecretEvent(secret, 'bound', member.name, {
          body: `${parsed.data.member} was given the secret '${secret.slug}' (${secret.envName}) by ${member.name}. It applies on their next runner start.`,
          extra: { member: parsed.data.member },
        });
      });
      return c.json({ ok: true, boundMembers: secrets.listBindings(secret.id) });
    });

    // DELETE /secrets/:slug/bindings/:name — unbind (secrets.manage).
    app.delete(`${PATHS.secrets}/:slug/bindings/:name`, auth, (c) => {
      const denied = requireSecretsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const secret = secrets.getBySlug(c.req.param('slug'));
      if (!secret) return c.json({ error: 'no such secret' }, 404);
      const name = c.req.param('name');
      secrets.unbind(secret.id, name);
      queueMicrotask(() => {
        void publishSecretEvent(secret, 'unbound', member.name, {
          // The removed member gets the event too so they know the
          // env var disappears on their next runner start.
          body: `${name}'s access to secret '${secret.slug}' was removed by ${member.name}.`,
          recipients: secretRecipients(secret, name),
          extra: { member: name },
        });
      });
      return c.json({ ok: true, boundMembers: secrets.listBindings(secret.id) });
    });
  }

  // ─── External Notifications ───────────────────────────────────────
  //
  // Inbound webhooks / API calls → members and channels, as ambient
  // input. Admin surface gates on `notifications.manage`; the
  // `/hooks/:slug` ingress is unauthenticated at the middleware layer
  // and verified per-endpoint (HMAC / shared-secret header) against
  // the KEK-held signing secret. Every inbound request lands a
  // delivery receipt — verified or rejected, filtered or delivered —
  // and receipts are the replay unit.
  if (notifications !== undefined && notificationDispatcher !== undefined) {
    const dispatcher = notificationDispatcher;

    const mapNotificationsError = (
      // biome-ignore lint/suspicious/noExplicitAny: Hono's Context type is invariant; helper is only ever called inside a route handler
      ctx: Context<any, string, Record<string, unknown>>,
      err: unknown,
    ): Response => {
      if (err instanceof NotificationsError) {
        const status =
          err.code === 'not_found'
            ? 404
            : err.code === 'slug_taken' || err.code === 'profile_in_use'
              ? 409
              : err.code === 'no_kek'
                ? 503
                : 400;
        return ctx.json({ error: err.message, code: err.code }, status);
      }
      return ctx.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    };

    const requireNotificationsManage = (
      // biome-ignore lint/suspicious/noExplicitAny: helper is only ever called inside a route handler
      ctx: Context<any, string, Record<string, unknown>>,
    ): Response | null => {
      const member = ctx.get('member');
      if (!hasPermission(member.permissions, 'notifications.manage')) {
        return ctx.json({ error: 'requires notifications.manage' }, 403);
      }
      return null;
    };

    const summarizeEndpoint = (endpoint: NotificationEndpoint): NotificationEndpointSummary => ({
      ...endpoint,
      hasSecret: notifications.hasSecret(endpoint.id),
    });

    const targetsMember = (endpoint: NotificationEndpoint, name: string): boolean =>
      endpoint.targets.some((t) => t.member === name);

    /**
     * Validate targets and resolve channel references (slug OR id)
     * to stable channel ids so renames never break routing.
     */
    const resolveTargets = (
      targets: NotificationTarget[],
    ): { ok: true; targets: NotificationTarget[] } | { ok: false; error: string } => {
      const resolved: NotificationTarget[] = [];
      for (const t of targets) {
        if (t.member !== undefined) {
          if (members.findByName(t.member) === null) {
            return { ok: false, error: `no such member: ${t.member}` };
          }
          resolved.push({ member: t.member });
          continue;
        }
        if (t.channel === undefined) continue;
        if (t.channel === GENERAL_CHANNEL_ID) {
          resolved.push({ channel: GENERAL_CHANNEL_ID });
          continue;
        }
        if (!channels) {
          return { ok: false, error: 'channel targets are unavailable (no channel store)' };
        }
        const ch = channels.get(t.channel) ?? channels.getBySlug(t.channel);
        if (!ch || ch.archivedAt !== null) {
          return { ok: false, error: `no such channel: ${t.channel}` };
        }
        resolved.push({ channel: ch.id });
      }
      return { ok: true, targets: resolved };
    };

    /**
     * Recipients for a registry change event: direct member targets
     * plus every `notifications.manage` holder — the people whose
     * inbound surface just changed, and the people who administer it.
     */
    const endpointRecipients = (endpoint: NotificationEndpoint): Set<string> => {
      const names = new Set<string>();
      for (const t of endpoint.targets) {
        if (t.member !== undefined) names.add(t.member);
      }
      for (const m of members.members()) {
        if (m.permissions.includes('notifications.manage')) names.add(m.name);
      }
      return names;
    };

    const publishEndpointEvent = async (
      endpoint: NotificationEndpoint,
      event: string,
      actor: string,
      body: string,
      recipients?: Set<string>,
    ): Promise<void> => {
      try {
        await broker.push(
          {
            body,
            level: 'info',
            data: {
              kind: 'notification_endpoint',
              event,
              endpoint_slug: endpoint.slug,
              thread: `hook:${endpoint.slug}`,
              actor,
            },
          },
          { from: actor, recipients: [...(recipients ?? endpointRecipients(endpoint))] },
        );
      } catch (err) {
        logger.warn('failed to fanout notification-endpoint event', {
          endpoint: endpoint.slug,
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // GET /notifications/endpoints — manage sees all; other members
    // see the endpoints that target them directly (their inbound
    // surface is their business; the rest of the registry isn't).
    app.get(PATHS.notificationEndpoints, auth, (c) => {
      const member = c.get('member');
      const isAdmin = hasPermission(member.permissions, 'notifications.manage');
      const list = notifications
        .list()
        .filter((e) => isAdmin || targetsMember(e, member.name))
        .map(summarizeEndpoint);
      return c.json({ endpoints: list });
    });

    // POST /notifications/endpoints — create (notifications.manage).
    // The signing secret is set separately via PUT .../secret.
    app.post(PATHS.notificationEndpoints, auth, async (c) => {
      const denied = requireNotificationsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const raw = await c.req.json().catch(() => null);
      const parsed = CreateNotificationEndpointRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid endpoint payload', details: parsed.error.issues }, 400);
      }
      const targets = resolveTargets(parsed.data.targets);
      if (!targets.ok) return c.json({ error: targets.error }, 400);
      try {
        const endpoint = notifications.create({
          slug: parsed.data.slug,
          targets: targets.targets,
          ...(parsed.data.displayName !== undefined
            ? { displayName: parsed.data.displayName }
            : {}),
          ...(parsed.data.description !== undefined
            ? { description: parsed.data.description }
            : {}),
          ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
          ...(parsed.data.auth !== undefined ? { auth: parsed.data.auth } : {}),
          ...(parsed.data.authProfile !== undefined
            ? { authProfile: parsed.data.authProfile }
            : {}),
          ...(parsed.data.level !== undefined ? { level: parsed.data.level } : {}),
          ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
          ...(parsed.data.template !== undefined ? { template: parsed.data.template } : {}),
          ...(parsed.data.filters !== undefined ? { filters: parsed.data.filters } : {}),
          ...(parsed.data.policy !== undefined ? { policy: parsed.data.policy } : {}),
          ...(parsed.data.dedupeHeader !== undefined
            ? { dedupeHeader: parsed.data.dedupeHeader }
            : {}),
          creator: member.name,
        });
        queueMicrotask(() => {
          void publishEndpointEvent(
            endpoint,
            'created',
            member.name,
            `External notification endpoint '${endpoint.slug}' was registered by ${member.name}. Inbound events on it will reach: ${describeTargets(endpoint.targets)}.`,
          );
        });
        return c.json(endpoint, 201);
      } catch (err) {
        return mapNotificationsError(c, err);
      }
    });

    // GET /notifications/endpoints/:slug — detail (manage OR targeted).
    app.get(`${PATHS.notificationEndpoints}/:slug`, auth, (c) => {
      const member = c.get('member');
      const endpoint = notifications.getBySlug(c.req.param('slug'));
      if (!endpoint) return c.json({ error: 'no such endpoint' }, 404);
      const isAdmin = hasPermission(member.permissions, 'notifications.manage');
      if (!isAdmin && !targetsMember(endpoint, member.name)) {
        return c.json({ error: 'requires notifications.manage' }, 403);
      }
      return c.json({ endpoint: summarizeEndpoint(endpoint) });
    });

    // PATCH /notifications/endpoints/:slug — update (notifications.manage).
    app.patch(`${PATHS.notificationEndpoints}/:slug`, auth, async (c) => {
      const denied = requireNotificationsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const endpoint = notifications.getBySlug(c.req.param('slug'));
      if (!endpoint) return c.json({ error: 'no such endpoint' }, 404);
      const raw = await c.req.json().catch(() => null);
      const parsed = UpdateNotificationEndpointRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid endpoint payload', details: parsed.error.issues }, 400);
      }
      let resolvedTargets: NotificationTarget[] | undefined;
      if (parsed.data.targets !== undefined) {
        const targets = resolveTargets(parsed.data.targets);
        if (!targets.ok) return c.json({ error: targets.error }, 400);
        resolvedTargets = targets.targets;
      }
      // A `disabled` / retargeting event must reach members who are
      // LOSING the endpoint — capture the pre-mutation recipient set.
      const preRecipients = endpointRecipients(endpoint);
      try {
        const updated = notifications.update(endpoint.id, {
          ...(parsed.data.displayName !== undefined
            ? { displayName: parsed.data.displayName }
            : {}),
          ...(parsed.data.description !== undefined
            ? { description: parsed.data.description }
            : {}),
          ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
          ...(parsed.data.auth !== undefined ? { auth: parsed.data.auth } : {}),
          ...(parsed.data.authProfile !== undefined
            ? { authProfile: parsed.data.authProfile }
            : {}),
          ...(resolvedTargets !== undefined ? { targets: resolvedTargets } : {}),
          ...(parsed.data.level !== undefined ? { level: parsed.data.level } : {}),
          ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
          ...(parsed.data.template !== undefined ? { template: parsed.data.template } : {}),
          ...(parsed.data.filters !== undefined ? { filters: parsed.data.filters } : {}),
          ...(parsed.data.policy !== undefined ? { policy: parsed.data.policy } : {}),
          ...(parsed.data.dedupeHeader !== undefined
            ? { dedupeHeader: parsed.data.dedupeHeader }
            : {}),
        });
        const event =
          parsed.data.enabled === undefined
            ? 'updated'
            : parsed.data.enabled
              ? 'enabled'
              : 'disabled';
        queueMicrotask(() => {
          const merged = new Set([...preRecipients, ...endpointRecipients(updated)]);
          void publishEndpointEvent(
            updated,
            event,
            member.name,
            `External notification endpoint '${updated.slug}' was ${event} by ${member.name}. Targets: ${describeTargets(updated.targets)}.`,
            merged,
          );
        });
        return c.json(updated);
      } catch (err) {
        return mapNotificationsError(c, err);
      }
    });

    // DELETE /notifications/endpoints/:slug — delete + cascade
    // receipts and pending rows (notifications.manage).
    app.delete(`${PATHS.notificationEndpoints}/:slug`, auth, (c) => {
      const denied = requireNotificationsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const endpoint = notifications.getBySlug(c.req.param('slug'));
      if (!endpoint) return c.json({ error: 'no such endpoint' }, 404);
      const preRecipients = endpointRecipients(endpoint);
      try {
        notifications.delete(endpoint.id);
        queueMicrotask(() => {
          void publishEndpointEvent(
            endpoint,
            'deleted',
            member.name,
            `External notification endpoint '${endpoint.slug}' was deleted by ${member.name}.`,
            preRecipients,
          );
        });
        return c.json({ ok: true });
      } catch (err) {
        return mapNotificationsError(c, err);
      }
    });

    // PUT /notifications/endpoints/:slug/secret — set the inline
    // signing secret (notifications.manage). Write-only; the value
    // never leaves the server (verification reads it internally).
    app.put(`${PATHS.notificationEndpoints}/:slug/secret`, auth, async (c) => {
      const denied = requireNotificationsManage(c);
      if (denied) return denied;
      const endpoint = notifications.getBySlug(c.req.param('slug'));
      if (!endpoint) return c.json({ error: 'no such endpoint' }, 404);
      const raw = await c.req.json().catch(() => null);
      const parsed = SetNotificationSecretRequestSchema.safeParse(raw);
      if (!parsed.success) {
        // Schema issues would echo the (invalid) secret back — return
        // a generic message instead of zod issue details.
        return c.json({ error: 'invalid secret payload' }, 400);
      }
      try {
        notifications.setSecret(endpoint.id, parsed.data.secret);
        return c.json({ ok: true });
      } catch (err) {
        return mapNotificationsError(c, err);
      }
    });

    // DELETE /notifications/endpoints/:slug/secret (notifications.manage).
    app.delete(`${PATHS.notificationEndpoints}/:slug/secret`, auth, (c) => {
      const denied = requireNotificationsManage(c);
      if (denied) return denied;
      const endpoint = notifications.getBySlug(c.req.param('slug'));
      if (!endpoint) return c.json({ error: 'no such endpoint' }, 404);
      try {
        notifications.deleteSecret(endpoint.id);
        return c.json({ ok: true });
      } catch (err) {
        return mapNotificationsError(c, err);
      }
    });

    // GET /notifications/endpoints/:slug/deliveries — receipts,
    // newest first (notifications.manage). `limit` ≤ 500, `before`
    // is an epoch-ms cursor.
    app.get(`${PATHS.notificationEndpoints}/:slug/deliveries`, auth, (c) => {
      const denied = requireNotificationsManage(c);
      if (denied) return denied;
      const endpoint = notifications.getBySlug(c.req.param('slug'));
      if (!endpoint) return c.json({ error: 'no such endpoint' }, 404);
      const limitRaw = c.req.query('limit');
      const beforeRaw = c.req.query('before');
      const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
      const before = beforeRaw !== undefined ? Number(beforeRaw) : undefined;
      if (
        (limit !== undefined && !Number.isFinite(limit)) ||
        (before !== undefined && !Number.isFinite(before))
      ) {
        return c.json({ error: 'limit/before must be numbers' }, 400);
      }
      return c.json({
        deliveries: notifications.listDeliveries(endpoint.id, {
          ...(limit !== undefined ? { limit } : {}),
          ...(before !== undefined ? { before } : {}),
        }),
      });
    });

    // POST /notifications/deliveries/:id/replay — re-run a stored
    // delivery through the pipeline (notifications.manage). Verify /
    // dedupe / rate limit are skipped; filters, template, and policy
    // apply — replay is for debugging exactly those.
    app.post(`${PATHS.notificationDeliveries}/:id/replay`, auth, async (c) => {
      const denied = requireNotificationsManage(c);
      if (denied) return denied;
      try {
        const record = await dispatcher.replay(c.req.param('id'));
        return c.json({ delivery: toWireDelivery(record) });
      } catch (err) {
        return mapNotificationsError(c, err);
      }
    });

    // ── Auth profiles ──

    // GET /notifications/profiles (notifications.manage).
    app.get(PATHS.notificationProfiles, auth, (c) => {
      const denied = requireNotificationsManage(c);
      if (denied) return denied;
      const profiles = notifications.listProfiles().map((p) => ({
        ...p,
        hasSecret: notifications.hasProfileSecret(p.id),
        endpointCount: notifications.endpointCountForProfile(p.id),
      }));
      return c.json({ profiles });
    });

    // POST /notifications/profiles (notifications.manage).
    app.post(PATHS.notificationProfiles, auth, async (c) => {
      const denied = requireNotificationsManage(c);
      if (denied) return denied;
      const member = c.get('member');
      const raw = await c.req.json().catch(() => null);
      const parsed = CreateNotificationProfileRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid profile payload', details: parsed.error.issues }, 400);
      }
      try {
        const profile = notifications.createProfile({
          slug: parsed.data.slug,
          auth: parsed.data.auth,
          ...(parsed.data.description !== undefined
            ? { description: parsed.data.description }
            : {}),
          creator: member.name,
        });
        return c.json(profile, 201);
      } catch (err) {
        return mapNotificationsError(c, err);
      }
    });

    // PATCH /notifications/profiles/:slug (notifications.manage).
    app.patch(`${PATHS.notificationProfiles}/:slug`, auth, async (c) => {
      const denied = requireNotificationsManage(c);
      if (denied) return denied;
      const profile = notifications.getProfileBySlug(c.req.param('slug'));
      if (!profile) return c.json({ error: 'no such profile' }, 404);
      const raw = await c.req.json().catch(() => null);
      const parsed = UpdateNotificationProfileRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid profile payload', details: parsed.error.issues }, 400);
      }
      try {
        const updated = notifications.updateProfile(profile.id, {
          ...(parsed.data.description !== undefined
            ? { description: parsed.data.description }
            : {}),
          ...(parsed.data.auth !== undefined ? { auth: parsed.data.auth } : {}),
        });
        return c.json(updated);
      } catch (err) {
        return mapNotificationsError(c, err);
      }
    });

    // DELETE /notifications/profiles/:slug — 409 while referenced;
    // an endpoint silently losing its verifier is an outage.
    app.delete(`${PATHS.notificationProfiles}/:slug`, auth, (c) => {
      const denied = requireNotificationsManage(c);
      if (denied) return denied;
      const profile = notifications.getProfileBySlug(c.req.param('slug'));
      if (!profile) return c.json({ error: 'no such profile' }, 404);
      try {
        notifications.deleteProfile(profile.id);
        return c.json({ ok: true });
      } catch (err) {
        return mapNotificationsError(c, err);
      }
    });

    // PUT /notifications/profiles/:slug/secret — the shared-secret
    // rotation point: one write re-keys every referencing endpoint.
    app.put(`${PATHS.notificationProfiles}/:slug/secret`, auth, async (c) => {
      const denied = requireNotificationsManage(c);
      if (denied) return denied;
      const profile = notifications.getProfileBySlug(c.req.param('slug'));
      if (!profile) return c.json({ error: 'no such profile' }, 404);
      const raw = await c.req.json().catch(() => null);
      const parsed = SetNotificationSecretRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid secret payload' }, 400);
      }
      try {
        notifications.setProfileSecret(profile.id, parsed.data.secret);
        return c.json({ ok: true });
      } catch (err) {
        return mapNotificationsError(c, err);
      }
    });

    // DELETE /notifications/profiles/:slug/secret (notifications.manage).
    app.delete(`${PATHS.notificationProfiles}/:slug/secret`, auth, (c) => {
      const denied = requireNotificationsManage(c);
      if (denied) return denied;
      const profile = notifications.getProfileBySlug(c.req.param('slug'));
      if (!profile) return c.json({ error: 'no such profile' }, 404);
      try {
        notifications.deleteProfileSecret(profile.id);
        return c.json({ ok: true });
      } catch (err) {
        return mapNotificationsError(c, err);
      }
    });

    // ── Ingress ──
    //
    // POST /hooks/:slug — NO auth middleware; this is the outside
    // world's door. Transport checks here (existence, enabled, size,
    // override grammar), then the dispatcher owns verify → dedupe →
    // filter → render → policy. Responses are deliberately terse:
    // verification failures are a bare 401 with no detail, and the
    // accept path returns 202 before any fanout completes.
    app.post(`${PATHS.hooks}/:slug`, async (c) => {
      const endpoint = notifications.getBySlug(c.req.param('slug'));
      if (!endpoint) return c.json({ error: 'not_found' }, 404);
      if (!endpoint.enabled) return c.json({ error: 'disabled' }, 409);

      const declared = c.req.header('content-length');
      if (declared !== undefined && Number(declared) > HOOK_BODY_MAX) {
        return c.json({ error: 'payload too large' }, 413);
      }
      const rawBody = Buffer.from(await c.req.arrayBuffer());
      if (rawBody.length > HOOK_BODY_MAX) {
        return c.json({ error: 'payload too large' }, 413);
      }

      // Per-delivery overrides ride the query string — the only knob
      // a sender controls when the caller is a webhook provider whose
      // URL you configure once.
      const overrides: NotificationOverrides = {};
      const ifOffline = c.req.query('if_offline');
      if (ifOffline !== undefined) {
        if (ifOffline !== 'drop' && ifOffline !== 'queue') {
          return c.json({ error: 'if_offline must be drop|queue' }, 400);
        }
        overrides.ifOffline = ifOffline;
      }
      const ifBusy = c.req.query('if_busy');
      if (ifBusy !== undefined) {
        if (ifBusy !== 'now' && ifBusy !== 'wait') {
          return c.json({ error: 'if_busy must be now|wait' }, 400);
        }
        overrides.ifBusy = ifBusy;
      }
      const level = c.req.query('level');
      if (level !== undefined) {
        const parsedLevel = LogLevelSchema.safeParse(level);
        if (!parsedLevel.success) {
          return c.json({ error: 'level must be a valid log level' }, 400);
        }
        overrides.level = parsedLevel.data;
      }

      const result = await dispatcher.ingest({
        endpoint,
        rawBody,
        contentType: c.req.header('content-type') ?? null,
        getHeader: (name) => c.req.header(name),
        overrides: Object.keys(overrides).length > 0 ? overrides : null,
      });

      if (result.status === 'rate_limited') {
        c.header('Retry-After', '60');
        return c.json({ error: 'rate_limited' }, 429);
      }
      if (result.httpStatus === 401) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      return c.json({ id: result.id, status: result.status }, 202);
    });
  }

  // ─── Objective endpoints ──────────────────────────────────────────
  // Registered iff an ObjectivesStore is provided — keeps chat-only
  // tests clean. Permission guards enforce the following access matrix:
  //   agent                 — see/update/complete objectives assigned to self
  //   operator / lead-agent — agent + create + cancel own-originated + see team
  //   admin                 — any mutation, see everything
  //
  // All mutations publish an `ObjectiveEvent` through the broker on
  // thread key `obj:<id>` so web clients + the link can react in
  // real time. The publish is fire-and-forget so an SSE failure
  // never blocks the HTTP response.
  if (objectives !== undefined) {
    /**
     * The set of names that belong to an objective's thread.
     * Originator + assignee + explicit watchers + every admin
     * ("admins see everything in their team"). For a `reassigned`
     * event, also include the previous assignee so they know the
     * objective left their plate. For a `watcher_removed` event,
     * also include the removed watcher so they get the exit
     * notification before the next event skips them entirely.
     *
     * This function is reused by the lifecycle-event publisher, the
     * `/discuss` endpoint, and the `/watchers` endpoint so every
     * surface that fans out a push uses the same membership rule.
     */
    const objectiveThreadMembers = (
      objective: Objective,
      extraEvent?: ObjectiveEvent,
    ): Set<string> => {
      const names = new Set<string>([objective.assignee, objective.originator]);
      for (const w of objective.watchers) names.add(w);
      // Members with `members.manage` are implicit thread participants
      // on every objective (observable-by-default for admins).
      for (const m of members.members()) {
        if (m.permissions.includes('members.manage')) names.add(m.name);
      }
      if (extraEvent?.kind === 'reassigned') {
        const fromCs = extraEvent.payload.from;
        if (typeof fromCs === 'string') names.add(fromCs);
      }
      if (extraEvent?.kind === 'watcher_removed') {
        const cs = extraEvent.payload.name;
        if (typeof cs === 'string') names.add(cs);
      }
      return names;
    };

    const publishObjectiveEvent = async (
      objective: Objective,
      event: ObjectiveEvent,
      actor: string,
    ): Promise<void> => {
      const threadKey = `obj:${objective.id}`;
      const primaryTargets = objectiveThreadMembers(objective, event);
      const body = systemMessageForEvent(objective, event.kind, event);
      // One multi-recipient push, not a per-target loop — see the
      // /discuss endpoint for the rationale: a loop mints a distinct
      // message id per recipient, so a connected web client renders
      // the event once per other connected thread member.
      try {
        await broker.push(
          {
            body,
            level: 'info',
            // Minimal machine meta: classification + ids for filtering.
            // The full objective state used to be serialized here as
            // `data.objective = JSON.stringify(...)`, but that landed
            // in the agent's channel-event envelope as a noisy XML
            // attribute. Agents read the human-readable `body` above
            // and call `objectives_view` for full state when they
            // need it — one extra tool call on the rare path, clean
            // events on the common path.
            data: {
              kind: 'objective',
              event: event.kind,
              objective_id: objective.id,
              objective_status: objective.status,
              thread: threadKey,
              actor,
            },
          },
          { from: actor, recipients: [...primaryTargets] },
        );
      } catch (err) {
        logger.warn('failed to fanout objective event', {
          objectiveId: objective.id,
          event: event.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    function mapObjectivesError(err: unknown): { status: number; body: { error: string } } {
      if (err instanceof ObjectivesError) {
        const status =
          err.code === 'not_found'
            ? 404
            : err.code === 'terminal' || err.code === 'invalid_transition'
              ? 409
              : 400;
        return { status, body: { error: err.message } };
      }
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }

    // GET /objectives?assignee=&status=
    //
    // Agents see objectives they have any relationship with:
    // assigned, originated, or watching. Admins / operators /
    // lead-agents see team-wide. When an agent passes an explicit
    // `assignee` filter, it must match their own name — they can't
    // fish for other agents' plates. The watching filter has no
    // equivalent explicit param today; watched objectives appear in
    // the default list.
    app.get(PATHS.objectives, auth, (c) => {
      const member = c.get('member');
      const raw = {
        assignee: c.req.query('assignee'),
        status: c.req.query('status'),
      };
      const parsed = ListObjectivesQuerySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid query', details: parsed.error.issues }, 400);
      }
      const filter = parsed.data;

      const canListAny = hasPermission(member.permissions, 'objectives.create');
      if (!canListAny) {
        if (filter.assignee && filter.assignee !== member.name) {
          return c.json(
            { error: 'members without objectives.create may only list their own objectives' },
            403,
          );
        }
        // Default scope for a plain member: assigned OR originated OR watching.
        const all = objectives.list(filter.status ? { status: filter.status } : {});
        const scoped = all.filter(
          (o) =>
            o.assignee === member.name ||
            o.originator === member.name ||
            o.watchers.includes(member.name),
        );
        return c.json({ objectives: scoped });
      }
      return c.json({ objectives: objectives.list(filter) });
    });

    // GET /objectives/:id
    //
    // A thread participant (assignee, originator, watcher) can always
    // view. Anyone with `objectives.create` can view any.
    app.get(`${PATHS.objectives}/:id`, auth, (c) => {
      const member = c.get('member');
      const id = c.req.param('id');
      const obj = objectives.get(id);
      if (!obj) return c.json({ error: `no such objective: ${id}` }, 404);
      const isParticipant =
        obj.assignee === member.name ||
        obj.originator === member.name ||
        obj.watchers.includes(member.name);
      if (!isParticipant && !hasPermission(member.permissions, 'objectives.create')) {
        return c.json(
          { error: 'not a thread participant; viewing requires objectives.create' },
          403,
        );
      }
      return c.json({ objective: obj, events: objectives.events(id) });
    });

    // POST /objectives — requires `objectives.create`.
    app.post(PATHS.objectives, auth, async (c) => {
      const member = c.get('member');
      if (!hasPermission(member.permissions, 'objectives.create')) {
        return c.json(
          { error: 'creating objectives requires the objectives.create permission' },
          403,
        );
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = CreateObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid objective payload', details: parsed.error.issues }, 400);
      }
      // Assignee must be a known user on the team.
      if (!members.findByName(parsed.data.assignee)) {
        return c.json({ error: `unknown assignee: ${parsed.data.assignee}` }, 400);
      }
      // Every initial watcher must also resolve — catch typos at
      // creation time, not on the first fanout attempt.
      if (Array.isArray(parsed.data.watchers)) {
        for (const w of parsed.data.watchers) {
          if (!members.findByName(w)) {
            return c.json({ error: `unknown watcher: ${w}` }, 400);
          }
        }
      }
      const createAttachmentsResult = canonicalizeAttachments(
        parsed.data.attachments,
        toViewer(member),
        files,
      );
      if (!createAttachmentsResult.ok) {
        return c.json({ error: createAttachmentsResult.error }, createAttachmentsResult.status);
      }
      const inputWithCanonical =
        createAttachmentsResult.canonical.length > 0
          ? { ...parsed.data, attachments: createAttachmentsResult.canonical }
          : parsed.data;
      try {
        const { objective: created, events } = objectives.create(inputWithCanonical, member.name);
        logger.info('objective created', {
          id: created.id,
          originator: member.name,
          assignee: created.assignee,
          attachments: created.attachments.length,
        });

        // Mirror each attachment into the objective's own namespace
        // (`/objectives/<id>/...`) so the file's home is the
        // objective, not whichever member uploaded it. The originator's
        // home copy stays put — `copyByBlobRef` shares a single
        // underlying blob, so bytes aren't duplicated, but each entry
        // is independently deletable.
        //
        // No fallback: if any copy fails, the whole create surfaces
        // the error. A half-mirrored objective with mixed
        // namespace/pointer paths is harder to reason about than a
        // clean retry, and there's no legacy data to coexist with.
        let finalObjective = created;
        if (files && created.attachments.length > 0) {
          const viewer = toViewer(member);
          const namespacePaths: Attachment[] = created.attachments.map((att) => {
            const dst = objectiveNamespacePath(created.id, basenameOf(att.path));
            const copied = files.copyByBlobRef({
              src: att.path,
              dst,
              mimeType: att.mimeType,
              collision: 'suffix',
              viewer,
            });
            return {
              path: copied.path,
              name: copied.name,
              size: copied.size ?? att.size,
              mimeType: copied.mimeType ?? att.mimeType,
            };
          });
          finalObjective = objectives.setAttachments(created.id, namespacePaths);
        }
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(finalObjective, ev, member.name);
          }
        });
        return c.json(finalObjective);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // PATCH /objectives/:id — assignee, or a member with `objectives.cancel`.
    app.patch(`${PATHS.objectives}/:id`, auth, async (c) => {
      const member = c.get('member');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);
      if (
        current.assignee !== member.name &&
        !hasPermission(member.permissions, 'objectives.cancel')
      ) {
        return c.json(
          {
            error: 'only the assignee or a member with objectives.cancel may update this objective',
          },
          403,
        );
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = UpdateObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid update payload', details: parsed.error.issues }, 400);
      }
      try {
        const { objective: updated, events } = objectives.update(id, parsed.data, member.name);
        // `events` can have 0-2 entries: 0 for a no-op (status=current,
        // no note), 1 for a single status transition or a note-only
        // update, 2 for a status transition + note in the same call.
        // Publish each one individually so each landing push carries
        // its own structured body — the note's note, the block's
        // block reason, etc.
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, member.name);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/complete (assignee only)
    app.post(`${PATHS.objectives}/:id/complete`, auth, async (c) => {
      const member = c.get('member');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);
      if (current.assignee !== member.name) {
        return c.json({ error: 'only the assignee may complete this objective' }, 403);
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = CompleteObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid complete payload', details: parsed.error.issues }, 400);
      }
      try {
        const { objective: updated, events } = objectives.complete(id, parsed.data, member.name);
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, member.name);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/cancel — originator, or any member with `objectives.cancel`.
    app.post(`${PATHS.objectives}/:id/cancel`, auth, async (c) => {
      const member = c.get('member');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);
      const isOriginator = current.originator === member.name;
      if (!(isOriginator || hasPermission(member.permissions, 'objectives.cancel'))) {
        return c.json({ error: 'cancel requires originator or objectives.cancel permission' }, 403);
      }
      const raw = await c.req.json().catch(() => ({}));
      const parsed = CancelObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid cancel payload', details: parsed.error.issues }, 400);
      }
      try {
        const { objective: updated, events } = objectives.cancel(id, parsed.data, member.name);
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, member.name);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/reassign — requires `objectives.reassign`.
    app.post(`${PATHS.objectives}/:id/reassign`, auth, async (c) => {
      const member = c.get('member');
      if (!hasPermission(member.permissions, 'objectives.reassign')) {
        return c.json({ error: 'reassign requires the objectives.reassign permission' }, 403);
      }
      const id = c.req.param('id');
      const raw = await c.req.json().catch(() => null);
      const parsed = ReassignObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid reassign payload', details: parsed.error.issues }, 400);
      }
      if (!members.findByName(parsed.data.to)) {
        return c.json({ error: `unknown assignee: ${parsed.data.to}` }, 400);
      }
      try {
        const { objective: updated, events } = objectives.reassign(id, parsed.data, member.name);
        // Attachment access for the new assignee comes "for free" from
        // the objective-namespace ACL — they're now a thread member,
        // so `canRead('/objectives/<id>/...')` returns true via
        // `isObjectiveMember`. No grant backfill needed.
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, member.name);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/watchers
    //
    // Add and/or remove watchers on an objective. Permitted to:
    //   - any admin (team-wide)
    //   - the originating operator / lead-agent (they own the
    //     objective they made)
    // Every name in both `add` and `remove` must resolve to a known
    // user. Watcher mutations produce `watcher_added` and
    // `watcher_removed` audit events that fan out to the full
    // post-change thread membership (plus removed parties so they
    // get the exit notification).
    app.post(`${PATHS.objectives}/:id/watchers`, auth, async (c) => {
      const member = c.get('member');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);

      const isOriginator = current.originator === member.name;
      if (!(isOriginator || hasPermission(member.permissions, 'objectives.watch'))) {
        return c.json(
          { error: 'watcher changes require originator or objectives.watch permission' },
          403,
        );
      }

      const raw = await c.req.json().catch(() => null);
      const parsed = UpdateWatchersRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid watchers payload', details: parsed.error.issues }, 400);
      }

      // Validate every name in both lists.
      for (const cs of parsed.data.add ?? []) {
        if (!members.findByName(cs)) {
          return c.json({ error: `unknown watcher: ${cs}` }, 400);
        }
      }
      for (const cs of parsed.data.remove ?? []) {
        if (!members.findByName(cs)) {
          return c.json({ error: `unknown watcher: ${cs}` }, 400);
        }
      }

      try {
        const { objective: updated, events } = objectives.updateWatchers(
          id,
          parsed.data,
          member.name,
        );
        // Watcher membership changes have no FS-side bookkeeping to do:
        // attachment access flows from `isObjectiveMember` in the
        // namespace ACL, so adding a watcher grants access at the
        // moment the membership lands and removing one revokes it the
        // moment they're gone. No grant rows to backfill or sweep.
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, member.name);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/discuss (thread members only)
    //
    // Discussion posts are real team messages with thread key
    // `obj:<id>`. The post is ONE message delivered to every thread
    // member via the broker's multi-recipient `recipients` path — the
    // same path channel posts use. The message lands in the event log
    // alongside chat, visible in the web UI's inline thread and in
    // `recent`/`history` for anyone filtering by thread.
    //
    // Earlier this looped `broker.push({ to: member })` once per
    // thread member. Each push minted its own message id, so a
    // connected member's web client received the post once per *other*
    // connected member and rendered it that many times (a single
    // multi-recipient push has one id, which `appendMessages` dedupes).
    //
    // The caller itself also receives its own message back — the
    // `recipients` path always includes the sender. The link's
    // self-echo suppression DOES apply (agents won't see their own
    // objective-discussion posts on the live stream — same as
    // `broadcast`/`send`); the web client still renders its own posts
    // because the web SSE handler does NOT suppress self-echoes.
    app.post(`${PATHS.objectives}/:id/discuss`, auth, async (c) => {
      const member = c.get('member');
      const id = c.req.param('id');
      const objective = objectives.get(id);
      if (!objective) return c.json({ error: `no such objective: ${id}` }, 404);

      const members = objectiveThreadMembers(objective);
      if (!members.has(member.name)) {
        return c.json(
          { error: `user '${member.name}' is not a member of objective ${id}'s thread` },
          403,
        );
      }

      const raw = await c.req.json().catch(() => null);
      const parsed = DiscussObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid discuss payload', details: parsed.error.issues }, 400);
      }

      const discussAttachmentsResult = canonicalizeAttachments(
        parsed.data.attachments,
        toViewer(member),
        files,
      );
      if (!discussAttachmentsResult.ok) {
        return c.json({ error: discussAttachmentsResult.error }, discussAttachmentsResult.status);
      }
      const discussAttachments = discussAttachmentsResult.canonical;

      const threadKey = `obj:${id}`;
      let canonical: Message | null = null;
      try {
        // Single multi-recipient push: one message id, one event-log
        // row, delivered live to every connected thread member (and the
        // sender). Offline members are dropped silently by the broker,
        // exactly as the old per-target `hasMember` skip did.
        const result = await broker.push(
          {
            body: parsed.data.body,
            title: parsed.data.title ?? null,
            level: 'info',
            data: {
              kind: 'objective_discuss',
              objective_id: id,
              thread: threadKey,
            },
            ...(discussAttachments.length > 0 ? { attachments: discussAttachments } : {}),
          },
          { from: member.name, recipients: [...members] },
        );
        canonical = result.message;
      } catch (err) {
        logger.warn('failed to fanout objective discuss', {
          objectiveId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Materialize grants for every thread member (minus the owner,
      // filtered inside files.grant). Use the message id so agents and
      // the Files panel can trace the grant back to a specific post.
      if (files && discussAttachments.length > 0 && canonical) {
        grantAttachmentsTo(files, discussAttachments, members, canonical.id, logger);
      }

      if (!canonical) {
        // Shouldn't happen — the caller is at least a member, and
        // `broker.hasMember` should be true for any active name.
        // Return 202 semantics as 200 with an empty-ish body rather
        // than faking a Message shape.
        return c.json({ error: 'no thread members are currently registered with the broker' }, 503);
      }
      return c.json(canonical);
    });
  }

  // `/subscribe` is a WebSocket endpoint — the browser / SDK open a
  // WS for their own member, and the server pipes every broker push
  // targeting them over `ws.send` as a JSON text frame. The pre-check
  // middleware below runs BEFORE the upgrade so a bad `name` or
  // identity mismatch returns a proper 400/403 HTTP response rather
  // than a half-upgraded socket.
  app.get(
    PATHS.subscribe,
    auth,
    async (c, next) => {
      const targetName = c.req.query('name');
      if (!targetName) {
        return c.json({ error: 'name query parameter is required' }, 400);
      }
      const member = c.get('member');
      if (targetName !== member.name) {
        logger.warn('subscribe rejected: identity mismatch', {
          targetName,
          name: member.name,
        });
        return c.json(
          {
            error:
              `user '${member.name}' cannot subscribe to '${targetName}'; ` +
              "the name query parameter must equal the caller's authenticated name",
          },
          403,
        );
      }
      await next();
    },
    upgradeWebSocket((c) => {
      // Pre-check middleware guaranteed a valid `name` and identity match.
      const targetName = c.req.query('name') as string;
      const member = c.get('member');
      let unsubscribe: (() => void) | null = null;
      let onShutdown: (() => void) | null = null;

      return {
        onOpen: (_evt, ws) => {
          unsubscribe = broker.subscribe(
            targetName,
            (message) => {
              try {
                ws.send(JSON.stringify(message));
              } catch (err) {
                logger.warn('ws send failed', {
                  targetName,
                  messageId: message.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            },
            { role: member.role, name: member.name },
          );

          // Shutdown fan-out: server.close() needs every live socket
          // to close before it returns. Without this, SIGTERM would
          // hang indefinitely on idle connections.
          onShutdown = () => {
            try {
              ws.close(1001, 'server shutting down');
            } catch {
              /* already closed */
            }
          };
          shutdownSignal?.addEventListener('abort', onShutdown, { once: true });

          logger.info('ws subscribe opened', { targetName, by: member.name });

          // Session-online notice — pushed only to runner-authenticated
          // subscribers so the agent's first turn carries enough
          // context to decide whether to resume something or stand by.
          // Excluded from web UI sessions (they get presence + the
          // dashboard, no channel push needed) and from JWT-auth
          // subscribers (federated; the runner-context-restoration use
          // case doesn't apply). The auth plane is the only signal we
          // have that a subscriber is the runner — `tokenId !== null`
          // means opaque-bearer auth, which is the runner's auth path.
          //
          // The message used to be titled "comms check," which agents
          // read as "respond to verify you're alive" and dutifully
          // started messaging teammates. The reframed version is
          // explicit that it's a system notice, not a ping.
          const tokenId = c.get('tokenId');
          if (objectives && tokenId !== null) {
            const active = [
              ...objectives.list({ assignee: member.name, status: 'active' }),
              ...objectives.list({ assignee: member.name, status: 'blocked' }),
            ];
            const notice = composeSessionOnlineMessage(member.name, active.length);
            void broker.push(
              { to: member.name, body: notice.body, title: notice.title, level: 'info' },
              { from: 'csuite' },
            );
          }
          // Runner attach is the `if_offline: queue` wake signal —
          // flush external notifications queued while this member
          // was offline (and any busy-waits; a fresh attach is idle).
          if (notificationDispatcher && tokenId !== null) {
            const dispatcher = notificationDispatcher;
            void dispatcher.onWake(member.name).catch((err) => {
              logger.warn('notification wake-flush failed', {
                member: member.name,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        },
        onClose: () => {
          unsubscribe?.();
          if (onShutdown) {
            shutdownSignal?.removeEventListener('abort', onShutdown);
          }
          logger.info('ws subscribe closed', { targetName, by: member.name });
        },
        onError: (evt) => {
          logger.warn('ws subscribe error', {
            targetName,
            error: evt instanceof Error ? evt.message : 'ws error',
          });
        },
      };
    }),
  );

  app.get(PATHS.history, auth, async (c) => {
    const member = c.get('member');

    const withRaw = c.req.query('with');
    let withOther: string | undefined;
    if (withRaw !== undefined && withRaw.length > 0) {
      const parsed = NameSchema.safeParse(withRaw);
      if (!parsed.success) {
        return c.json({ error: '`with` must be a valid name', details: parsed.error.issues }, 400);
      }
      withOther = parsed.data;
    }

    const channelRaw = c.req.query('channel');
    let channelId: string | undefined;
    if (channelRaw !== undefined && channelRaw.length > 0) {
      if (withOther !== undefined) {
        return c.json({ error: '`with` and `channel` are mutually exclusive' }, 400);
      }
      // Resolve slug → id when channels are wired up. Allow the
      // sentinel "general" through unconditionally so callers don't
      // need to special-case it client-side.
      if (channelRaw === GENERAL_CHANNEL_ID) {
        channelId = GENERAL_CHANNEL_ID;
      } else if (channels) {
        const ch = channels.getBySlug(channelRaw) ?? channels.get(channelRaw);
        if (!ch) return c.json({ error: `no such channel: ${channelRaw}` }, 404);
        if (!channels.isMember(ch.id, member.name)) {
          return c.json({ error: 'not a member of this channel' }, 403);
        }
        channelId = ch.id;
      } else {
        return c.json({ error: 'channels are not enabled on this server' }, 404);
      }
    }

    const limitQuery = c.req.query('limit');
    const limit = clampQueryLimit(limitQuery === undefined ? undefined : Number(limitQuery));
    const beforeRaw = c.req.query('before');
    const before = beforeRaw ? Number(beforeRaw) : undefined;
    if (before !== undefined && !Number.isFinite(before)) {
      return c.json({ error: 'invalid `before` parameter' }, 400);
    }

    const eventLog = broker.getEventLog();
    const messages = await eventLog.query({
      viewer: member.name,
      ...(withOther !== undefined ? { with: withOther } : {}),
      ...(channelId !== undefined ? { channel: channelId } : {}),
      limit,
      ...(before !== undefined ? { before } : {}),
    });
    return c.json({ messages });
  });

  // ─── Agent activity stream (registered iff `activityStore` is set) ──
  //
  // The runner streams decoded HTTP exchanges + objective lifecycle
  // markers here as they happen. Three endpoints:
  //
  //   POST /members/:name/activity          — self upload only
  //   GET  /members/:name/activity          — self OR admin
  //   GET  /members/:name/activity/stream   — WebSocket live tail, self OR admin
  //
  // The POST-self gate is strict: a user can only append its OWN
  // activity, regardless of permissions. Admins read via GET; they
  // don't write on behalf of other users. The GET gate allows
  // self (so the user can introspect its own history) OR admin
  // (for team-wide observability).
  if (activityStore) {
    // Note: `AGENT_PATHS.activity` URL-encodes its argument (for
    // SDK client use), so we can't call it with `:name` here
    // — Hono would see `%3Aname` and never bind a param. Use
    // the literal path for server-side route registration.
    app.post('/members/:name/activity', auth, async (c) => {
      const member = c.get('member');
      const nameRaw = c.req.param('name');
      const parsedName = NameSchema.safeParse(nameRaw);
      if (!parsedName.success) {
        return c.json({ error: 'invalid name' }, 400);
      }
      const name = parsedName.data;
      if (name !== member.name) {
        return c.json(
          {
            error: `user '${member.name}' cannot upload activity for '${name}'`,
          },
          403,
        );
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = UploadActivityRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid activity payload', details: parsed.error.issues }, 400);
      }
      try {
        const rows = activityStore.append(name, parsed.data.events);

        // Objective context watchdog: after appending, check whether
        // any llm_exchange events are missing active objective IDs
        // from their context. If so, push a reminder so the agent
        // picks the objective back up.
        if (objectives) {
          checkObjectiveContext(parsed.data.events, name, objectives, broker, logger);
        }

        return c.json({ accepted: rows.length }, 201);
      } catch (err) {
        logger.warn('agent activity append failed', {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: 'failed to append activity' }, 500);
      }
    });

    app.get('/members/:name/activity', auth, (c) => {
      const member = c.get('member');
      const nameRaw = c.req.param('name');
      const parsedName = NameSchema.safeParse(nameRaw);
      if (!parsedName.success) {
        return c.json({ error: 'invalid name' }, 400);
      }
      const name = parsedName.data;
      const isSelf = name === member.name;
      const canReadAny = hasPermission(member.permissions, 'activity.read');
      if (!isSelf && !canReadAny) {
        return c.json(
          { error: 'reading activity requires activity.read permission, or self' },
          403,
        );
      }
      const fromRaw = c.req.query('from');
      const toRaw = c.req.query('to');
      const limitRaw = c.req.query('limit');
      const kindRaw = c.req.queries('kind');

      const from = fromRaw !== undefined ? Number(fromRaw) : undefined;
      const to = toRaw !== undefined ? Number(toRaw) : undefined;
      const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
      if (from !== undefined && !Number.isFinite(from)) {
        return c.json({ error: 'invalid `from` parameter' }, 400);
      }
      if (to !== undefined && !Number.isFinite(to)) {
        return c.json({ error: 'invalid `to` parameter' }, 400);
      }
      if (limit !== undefined && !Number.isFinite(limit)) {
        return c.json({ error: 'invalid `limit` parameter' }, 400);
      }
      // Validate each kind discriminator. Multiple ?kind= params
      // are AND-combined at query time, OR-combined at the store
      // level (row.kind IN (...)).
      const kinds: ActivityKind[] = [];
      if (kindRaw) {
        for (const k of kindRaw) {
          const parsedKind = ActivityKindSchema.safeParse(k);
          if (!parsedKind.success) {
            return c.json({ error: `invalid kind: ${k}` }, 400);
          }
          kinds.push(parsedKind.data);
        }
      }
      const activity = activityStore.list({
        memberName: name,
        from,
        to,
        kinds: kinds.length > 0 ? kinds : undefined,
        limit,
      });
      return c.json({ activity });
    });

    // Activity tail — WebSocket. Every new row appended to the per-
    // member activity store is forwarded as a JSON text frame. The
    // pre-check middleware validates the name and permission so
    // rejection returns a proper HTTP error rather than a failed
    // upgrade handshake.
    const activity = activityStore;
    app.get(
      '/members/:name/activity/stream',
      auth,
      async (c, next) => {
        const member = c.get('member');
        const nameRaw = c.req.param('name');
        const parsedName = NameSchema.safeParse(nameRaw);
        if (!parsedName.success) {
          return c.json({ error: 'invalid name' }, 400);
        }
        const name = parsedName.data;
        const isSelf = name === member.name;
        const canReadAny = hasPermission(member.permissions, 'activity.read');
        if (!isSelf && !canReadAny) {
          return c.json(
            { error: 'streaming activity requires activity.read permission, or self' },
            403,
          );
        }
        await next();
      },
      upgradeWebSocket((c) => {
        const member = c.get('member');
        const name = NameSchema.parse(c.req.param('name'));
        let unsubscribe: (() => void) | null = null;
        let onShutdown: (() => void) | null = null;

        return {
          onOpen: (_evt, ws) => {
            unsubscribe = activity.subscribe(name, (row) => {
              try {
                ws.send(JSON.stringify(row));
              } catch (err) {
                logger.warn('activity ws send failed', {
                  name,
                  id: row.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            });
            onShutdown = () => {
              try {
                ws.close(1001, 'server shutting down');
              } catch {
                /* already closed */
              }
            };
            shutdownSignal?.addEventListener('abort', onShutdown, { once: true });
            logger.info('activity ws opened', { name, by: member.name });
          },
          onClose: () => {
            unsubscribe?.();
            if (onShutdown) {
              shutdownSignal?.removeEventListener('abort', onShutdown);
            }
            logger.info('activity ws closed', { name, by: member.name });
          },
          onError: (evt) => {
            logger.warn('activity ws error', {
              name,
              error: evt instanceof Error ? evt.message : 'ws error',
            });
          },
        };
      }),
    );
  }

  // ─── User management endpoints ───────────────────────────────
  //
  // `GET /users` is dual-auth — every teammate can see who's on the
  // team. Mutating verbs are admin-only and require `persistMembers`
  // to be wired; without it, mutations would drift in-memory and lose
  // on restart so we 501 instead.
  //
  // The server generates the bearer token on create and rotate; the
  // plaintext is returned exactly once in the HTTP response. After
  // that only the hash lives on disk.
  //
  // Self-mutation exceptions: any authenticated member can rotate
  // their own token or (re-)enroll their own TOTP; members with
  // `members.manage` can do it on behalf of anyone else.

  app.get(PATHS.members, auth, (c) => {
    const member = c.get('member');
    // Full member records (with instructions) require members.manage;
    // otherwise return the public `Teammate` projection.
    if (hasPermission(member.permissions, 'members.manage')) {
      return c.json({ members: members.members().map(loadedToMember) });
    }
    return c.json({ members: teammatesFromMembers(members) });
  });

  // ─── Team config endpoints ───────────────────────────────────
  //
  // Read is dual-auth (every authenticated member sees their team).
  // Mutations require `team.manage`. The response always reflects the
  // freshly-read DB state — there is no in-memory snapshot to go
  // stale. Note: changing `directive` / `context` / member `instructions`
  // takes effect on the *next* MCP session for any agent — those
  // strings are baked into the MCP `instructions` field, which is
  // frozen for the lifetime of a session by the protocol. Restart the
  // runner to pick up such changes.

  app.get(PATHS.team, auth, (c) => {
    return c.json({ team: teamStore.getTeam() });
  });

  app.patch(PATHS.team, auth, async (c) => {
    const member = c.get('member');
    if (!hasPermission(member.permissions, 'team.manage')) {
      return c.json({ error: 'updating the team requires the team.manage permission' }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null) return c.json({ error: 'expected a JSON body' }, 400);
    const patch: { name?: string; directive?: string; context?: string } = {};
    if (typeof body.name === 'string') patch.name = body.name;
    if (typeof body.directive === 'string') patch.directive = body.directive;
    if (typeof body.context === 'string') patch.context = body.context;
    if (Object.keys(patch).length === 0) {
      return c.json({ error: 'no fields to update (name, directive, context)' }, 400);
    }
    try {
      const updated = teamStore.updateTeam(patch, member.name);
      logger.info('team updated', { fields: Object.keys(patch), updatedBy: member.name });
      return c.json({ team: updated });
    } catch (err) {
      if (err instanceof MemberLoadError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  // ─── Permission preset CRUD ──────────────────────────────────
  //
  // Presets are referenced by raw_permissions on members. A change
  // here re-resolves all members that reference the preset on the
  // next read — no admin re-resolve sweep required. Deleting a preset
  // that members reference silently removes those leaves on next read;
  // the response includes a `referencedBy` list so the caller can
  // confirm the impact.

  app.get(PATHS.teamPresets, auth, (c) => {
    return c.json({ presets: teamStore.getPresets() });
  });

  app.put(`${PATHS.teamPresets}/:name`, auth, async (c) => {
    const caller = c.get('member');
    if (!hasPermission(caller.permissions, 'team.manage')) {
      return c.json({ error: 'managing presets requires the team.manage permission' }, 403);
    }
    const presetName = c.req.param('name');
    const body = (await c.req.json().catch(() => null)) as { permissions?: unknown } | null;
    if (
      body === null ||
      !Array.isArray(body.permissions) ||
      body.permissions.some((p) => typeof p !== 'string')
    ) {
      return c.json({ error: 'body must be `{ permissions: string[] }`' }, 400);
    }
    try {
      // Validate each entry resolves to a known leaf permission. We
      // run it through resolvePermissions with an empty preset map so
      // preset-of-preset isn't a thing (intentional — keeps the
      // resolution graph flat and free of cycles).
      const leaves = resolvePermissions(body.permissions as string[], {}, `preset '${presetName}'`);
      teamStore.setPreset(presetName, leaves, caller.name);
      logger.info('preset updated', {
        preset: presetName,
        leaves,
        updatedBy: caller.name,
      });
      return c.json({ preset: { name: presetName, permissions: leaves } });
    } catch (err) {
      if (err instanceof MemberLoadError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.delete(`${PATHS.teamPresets}/:name`, auth, (c) => {
    const caller = c.get('member');
    if (!hasPermission(caller.permissions, 'team.manage')) {
      return c.json({ error: 'managing presets requires the team.manage permission' }, 403);
    }
    const presetName = c.req.param('name');
    const referencedBy = teamStore.membersReferencingPreset(presetName, members);
    const removed = teamStore.deletePreset(presetName);
    if (!removed) {
      return c.json({ error: `no such preset: ${presetName}` }, 404);
    }
    logger.info('preset deleted', {
      preset: presetName,
      referencedBy,
      deletedBy: caller.name,
    });
    return c.json({ deleted: presetName, referencedBy });
  });

  app.post(PATHS.members, auth, async (c) => {
    const member = c.get('member');
    if (!hasPermission(member.permissions, 'members.manage')) {
      return c.json({ error: 'creating members requires the members.manage permission' }, 403);
    }
    if (!persistMembers) {
      return c.json(
        { error: 'member creation is not available (server missing persistMembers hook)' },
        501,
      );
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = CreateMemberRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid member payload', details: parsed.error.issues }, 400);
    }
    if (members.findByName(parsed.data.name)) {
      return c.json({ error: `member '${parsed.data.name}' already exists` }, 409);
    }
    let resolvedPerms: Permission[];
    try {
      resolvedPerms = resolvePermissions(
        parsed.data.permissions,
        teamStore.getPresets(),
        `create member '${parsed.data.name}'`,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    const token = generateBearerToken();
    try {
      members.addMember({
        name: parsed.data.name,
        role: parsed.data.role,
        instructions: parsed.data.instructions ?? '',
        rawPermissions: [...parsed.data.permissions],
        permissions: resolvedPerms,
        token,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'failed to add member' }, 409);
    }
    // Mirror the bootstrap token into the SQLite token store so the
    // resolver finds it on the very next request. Without this the
    // newly-minted plaintext would 401 because nothing in `tokens`
    // would match its hash. `origin = 'bootstrap'` matches the JSON-
    // initiated path; the row is labeled 'initial' so directors
    // listing tokens can see this is the one created at member-add.
    tokens.insert({
      memberName: parsed.data.name,
      rawToken: token,
      label: 'initial',
      origin: 'bootstrap',
      createdBy: member.name,
    });
    persistMembers();
    const teammate: Teammate = {
      name: parsed.data.name,
      role: parsed.data.role,
      permissions: resolvedPerms,
    };
    broker.seedMembers([teammate]);
    logger.info('member created', {
      name: teammate.name,
      role: teammate.role,
      permissions: teammate.permissions,
      createdBy: member.name,
    });
    return c.json({ member: teammate, token });
  });

  app.patch(`${PATHS.members}/:name`, auth, async (c) => {
    const member = c.get('member');
    if (!hasPermission(member.permissions, 'members.manage')) {
      return c.json({ error: 'updating members requires the members.manage permission' }, 403);
    }
    if (!persistMembers) {
      return c.json({ error: 'member updates are not available (persistMembers missing)' }, 501);
    }
    const targetRaw = c.req.param('name');
    const parsedName = NameSchema.safeParse(targetRaw);
    if (!parsedName.success) return c.json({ error: 'invalid member name' }, 400);
    const target = members.findByName(parsedName.data);
    if (!target) return c.json({ error: `no such member: ${parsedName.data}` }, 404);

    const raw = await c.req.json().catch(() => null);
    const parsed = UpdateMemberRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid update payload', details: parsed.error.issues }, 400);
    }
    // Guard the last-admin invariant when changing permissions.
    let nextPermissions: Permission[] | undefined;
    let nextRaw: string[] | undefined;
    if (parsed.data.permissions !== undefined) {
      try {
        nextPermissions = resolvePermissions(
          parsed.data.permissions,
          teamStore.getPresets(),
          `update member '${target.name}'`,
        );
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
      nextRaw = [...parsed.data.permissions];
      const losingManage =
        target.permissions.includes('members.manage') &&
        !nextPermissions.includes('members.manage');
      if (losingManage) {
        const adminCount = members
          .members()
          .filter((m) => m.permissions.includes('members.manage')).length;
        if (adminCount <= 1) {
          return c.json(
            {
              error:
                'cannot remove members.manage from the last admin — promote someone else first',
            },
            409,
          );
        }
      }
    }
    const patch: UpdateMemberPatch = {};
    if (parsed.data.role !== undefined) patch.role = parsed.data.role;
    if (parsed.data.instructions !== undefined) patch.instructions = parsed.data.instructions;
    if (nextPermissions !== undefined) {
      patch.permissions = nextPermissions;
      patch.rawPermissions = nextRaw;
    }
    try {
      members.updateMember(parsedName.data, patch);
    } catch (err) {
      if (err instanceof MemberLoadError) return c.json({ error: err.message }, 400);
      throw err;
    }
    persistMembers();
    const updated = members.findByName(parsedName.data);
    if (!updated) {
      return c.json({ error: `member vanished after update: ${parsedName.data}` }, 500);
    }
    logger.info('member updated', { name: updated.name, patch, updatedBy: member.name });
    return c.json(loadedToMember(updated));
  });

  app.delete(`${PATHS.members}/:name`, auth, (c) => {
    const member = c.get('member');
    if (!hasPermission(member.permissions, 'members.manage')) {
      return c.json({ error: 'deleting members requires the members.manage permission' }, 403);
    }
    if (!persistMembers) {
      return c.json({ error: 'member deletion is not available (persistMembers missing)' }, 501);
    }
    const targetRaw = c.req.param('name');
    const parsedName = NameSchema.safeParse(targetRaw);
    if (!parsedName.success) return c.json({ error: 'invalid member name' }, 400);
    const target = members.findByName(parsedName.data);
    if (!target) return c.json({ error: `no such member: ${parsedName.data}` }, 404);
    if (target.permissions.includes('members.manage')) {
      const adminCount = members
        .members()
        .filter((m) => m.permissions.includes('members.manage')).length;
      if (adminCount <= 1) {
        return c.json({ error: 'cannot delete the last admin — promote someone else first' }, 409);
      }
    }
    try {
      members.removeMember(parsedName.data);
    } catch (err) {
      if (err instanceof MemberLoadError) return c.json({ error: err.message }, 404);
      throw err;
    }
    // Nuke every bearer token belonging to the deleted member —
    // otherwise a stale token in someone's clipboard could keep
    // authenticating as a now-orphaned identity. Auth middleware
    // would catch this anyway (member not found → 401), but
    // proactive deletion keeps the table clean.
    const revoked = tokens.revokeAllForMember(parsedName.data);
    activityTracker.forget(parsedName.data);
    persistMembers();
    logger.info('member deleted', {
      name: parsedName.data,
      deletedBy: member.name,
      tokensRevoked: revoked,
    });
    return c.body(null, 204);
  });

  app.post(`${PATHS.members}/:name/rotate-token`, auth, (c) => {
    const member = c.get('member');
    if (!persistMembers) {
      return c.json({ error: 'rotate-token is not available (persistMembers missing)' }, 501);
    }
    const targetRaw = c.req.param('name');
    const parsedName = NameSchema.safeParse(targetRaw);
    if (!parsedName.success) return c.json({ error: 'invalid member name' }, 400);
    const target = members.findByName(parsedName.data);
    if (!target) return c.json({ error: `no such member: ${parsedName.data}` }, 404);
    if (!hasPermission(member.permissions, 'members.manage') && member.name !== target.name) {
      return c.json({ error: 'rotate-token requires members.manage, or self' }, 403);
    }
    // Multi-token rotation: in the legacy single-token world rotate
    // meant "replace the only token." Now it means "issue a fresh
    // token AND invalidate every other active token for this
    // member" — the canonical break-glass posture for "I think a
    // token leaked, restart from a clean slate." Members who want
    // to add a token without nuking peers should use the
    // device-code flow (`csuite connect` → director approve) which
    // calls `tokens.insert` on its own.
    const token = generateBearerToken();
    const before = tokens.listForMember(parsedName.data);
    for (const t of before) {
      tokens.revoke(t.id);
    }
    const newRow = tokens.insert({
      memberName: parsedName.data,
      rawToken: token,
      label: 'rotated',
      origin: 'rotate',
      createdBy: member.name,
    });
    // Token rotation is a tokens-table operation only — the
    // DB-backed MemberStore does not own auth tokens. Persistence is
    // immediate at the `tokens.insert` / `tokens.revoke` calls above.
    logger.info('token rotated', {
      name: parsedName.data,
      rotatedBy: member.name,
      tokenId: newRow.id,
      revokedPeers: before.length,
    });
    // `tokenInfo` strips the hash before going on the wire (the
    // schema's `TokenInfoSchema` doesn't include it).
    const { hash: _hash, ...publicTokenInfo } = newRow;
    return c.json({ token, tokenInfo: publicTokenInfo });
  });

  // ─── Multi-token management ──────────────────────────────────
  //
  // GET  /members/:name/tokens           — list active token rows
  // DELETE /members/:name/tokens/:id     — revoke one row
  //
  // Both gate on `members.manage` OR self. Plaintext is never
  // surfaced — that lives only in the issuance responses (rotate /
  // device-code approve). Listing is what lets a director spot a
  // token they don't recognize before it's used, and revoke a
  // specific device's binding without nuking the rest.

  app.get(`${PATHS.members}/:name/tokens`, auth, (c) => {
    const caller = c.get('member');
    const targetRaw = c.req.param('name');
    const parsedName = NameSchema.safeParse(targetRaw);
    if (!parsedName.success) return c.json({ error: 'invalid member name' }, 400);
    const target = members.findByName(parsedName.data);
    if (!target) return c.json({ error: `no such member: ${parsedName.data}` }, 404);
    if (!hasPermission(caller.permissions, 'members.manage') && caller.name !== target.name) {
      return c.json({ error: 'listing tokens requires members.manage, or self' }, 403);
    }
    const list = tokens.listForMember(parsedName.data);
    return c.json({ tokens: list });
  });

  app.delete(`${PATHS.members}/:name/tokens/:id`, auth, (c) => {
    const caller = c.get('member');
    const targetRaw = c.req.param('name');
    const tokenIdRaw = c.req.param('id');
    const parsedName = NameSchema.safeParse(targetRaw);
    if (!parsedName.success) return c.json({ error: 'invalid member name' }, 400);
    const target = members.findByName(parsedName.data);
    if (!target) return c.json({ error: `no such member: ${parsedName.data}` }, 404);
    if (!hasPermission(caller.permissions, 'members.manage') && caller.name !== target.name) {
      return c.json({ error: 'revoking tokens requires members.manage, or self' }, 403);
    }
    const row = tokens.findById(tokenIdRaw);
    if (!row || row.memberName !== parsedName.data) {
      // Don't leak whether the id exists for a different member; just
      // 404 either way.
      return c.json({ error: 'no such token' }, 404);
    }
    // Last-token guard: if revoking would leave the member with zero
    // active tokens AND the member is the last remaining admin, the
    // team would be lockable. Members with any non-admin role can
    // still revoke their own last token (they'd just rely on TOTP /
    // device-code re-issue afterward). The strict-loss case mirrors
    // the existing last-admin guard on member delete.
    const remaining = tokens.listForMember(parsedName.data).filter((t) => t.id !== row.id);
    if (
      remaining.length === 0 &&
      target.permissions.includes('members.manage') &&
      members.members().filter((m) => m.permissions.includes('members.manage')).length <= 1
    ) {
      return c.json(
        {
          error:
            'cannot revoke the last token of the last admin — promote another member to admin first',
        },
        409,
      );
    }
    tokens.revoke(row.id);
    logger.info('token revoked', {
      name: parsedName.data,
      tokenId: row.id,
      revokedBy: caller.name,
    });
    return c.body(null, 204);
  });

  // ─── Device-code enrollment (RFC 8628-shaped) ─────────────────
  //
  // Five endpoints implement the gh-auth-style "operator types a
  // short code, director approves" flow:
  //
  //   POST   /enroll          — anonymous; mint device_code/user_code
  //   POST   /enroll/poll     — anonymous; CLI polls with device_code
  //   GET    /enroll/pending  — director; list pending requests
  //   POST   /enroll/approve  — director; approve a user_code
  //   POST   /enroll/reject   — director; reject a user_code
  //
  // The director endpoints gate on `members.manage` (same as member
  // CRUD), since approval can mint a new member with arbitrary
  // role/permissions.
  //
  // RFC 8628 §3.5 token-endpoint shape: success returns 200 with the
  // bearer token, the four pending/error states return 400 with
  // `{error: <code>}` so OAuth-aware clients recognize them.
  if (enrollments) {
    const enrollmentsStore = enrollments;

    /**
     * Per-IP rate limit for `POST /enroll`. Anonymous endpoint, so
     * this is the first line of defense against an attacker spamming
     * the server to enumerate user codes (every mint reduces the
     * remaining 32^8 keyspace by one). Same sliding-window pattern
     * the TOTP path uses; in-memory only — restart resets, fine for
     * single-process scale.
     */
    const ENROLL_MINT_MAX = 10;
    const ENROLL_MINT_WINDOW_MS = 60 * 60 * 1000;
    interface MintBucket {
      count: number;
      firstAt: number;
    }
    const mintBuckets = new Map<string, MintBucket>();

    function ipKey(c: Context<AppBindings>): string {
      // Hono doesn't expose remoteAddress directly; pull from the
      // standard headers a reverse proxy sets, falling back to a
      // sentinel. The header chain is `Forwarded` → `X-Forwarded-For`
      // → 'unknown'. Header values are NOT trusted for security,
      // only for rate-limit bucketing — an attacker who can spoof
      // `X-Forwarded-For` is already inside the trust boundary
      // around the broker host.
      const forwarded = c.req.header('Forwarded');
      if (forwarded) {
        const match = forwarded.match(/for=("?\[?[^;",\]]+\]?"?)/i);
        if (match?.[1]) return match[1].replace(/^"|"$/g, '');
      }
      const xff = c.req.header('X-Forwarded-For');
      if (xff) return xff.split(',')[0]?.trim() || 'unknown';
      const real = c.req.header('X-Real-IP');
      if (real) return real;
      return 'unknown';
    }

    function checkMintLimit(key: string): { ok: true } | { ok: false; retryAfter: number } {
      const t = now();
      const bucket = mintBuckets.get(key);
      if (!bucket || t - bucket.firstAt >= ENROLL_MINT_WINDOW_MS) {
        mintBuckets.set(key, { count: 1, firstAt: t });
        return { ok: true };
      }
      bucket.count += 1;
      if (bucket.count > ENROLL_MINT_MAX) {
        return {
          ok: false,
          retryAfter: Math.ceil((ENROLL_MINT_WINDOW_MS - (t - bucket.firstAt)) / 1000),
        };
      }
      return { ok: true };
    }

    /**
     * Compose the verification URI we hand back to the device. The
     * SPA route is `/enroll`; the prefilled deep link adds `?code=`
     * with the formatted user code. Both forms are absolute paths
     * (no scheme/host) so the CLI can join them with whatever
     * broker URL it was configured with — works identically across
     * localhost / LAN / Tailscale Funnel deployments.
     */
    function verificationUriFor(formattedCode: string): {
      uri: string;
      uriComplete: string;
    } {
      const base = PATHS.enrollVerify;
      return {
        uri: base,
        uriComplete: `${base}?code=${encodeURIComponent(formattedCode)}`,
      };
    }

    app.post(PATHS.enroll, async (c) => {
      const ip = ipKey(c);
      const limit = checkMintLimit(ip);
      if (!limit.ok) {
        c.header('Retry-After', String(limit.retryAfter));
        return c.json(
          { error: 'too many enrollment requests; try again later', retryAfter: limit.retryAfter },
          429,
        );
      }
      const raw = await c.req.json().catch(() => ({}));
      const parsed = DeviceAuthorizationRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid enroll payload', details: parsed.error.issues }, 400);
      }
      const sourceIp = ip === 'unknown' ? null : ip;
      const sourceUa = c.req.header('User-Agent') ?? null;
      const minted = enrollmentsStore.mint({
        sourceIp,
        sourceUa,
        ...(parsed.data.labelHint !== undefined ? { labelHint: parsed.data.labelHint } : {}),
      });
      const verify = verificationUriFor(minted.userCodeFormatted);
      logger.info('enrollment minted', {
        userCode: minted.userCodeFormatted,
        sourceIp,
        labelHint: parsed.data.labelHint ?? '',
      });
      return c.json({
        deviceCode: minted.deviceCode,
        userCode: minted.userCodeFormatted,
        verificationUri: verify.uri,
        verificationUriComplete: verify.uriComplete,
        expiresIn: minted.expiresIn,
        interval: minted.interval,
      });
    });

    app.post(PATHS.enrollPoll, async (c) => {
      const raw = await c.req.json().catch(() => null);
      const parsed = DeviceTokenRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid poll payload', details: parsed.error.issues }, 400);
      }
      const outcome = enrollmentsStore.pollByDeviceCode(parsed.data.deviceCode);
      switch (outcome.kind) {
        case 'authorization_pending':
          return c.json({ error: 'authorization_pending' as const }, 400);
        case 'slow_down':
          return c.json({ error: 'slow_down' as const }, 400);
        case 'expired_token':
          return c.json({ error: 'expired_token' as const }, 400);
        case 'access_denied': {
          const body: { error: 'access_denied'; errorDescription?: string } = {
            error: 'access_denied',
          };
          if (outcome.reason !== null) body.errorDescription = outcome.reason;
          return c.json(body, 400);
        }
        case 'approved': {
          const member = members.findByName(outcome.memberName);
          if (!member) {
            // Member was deleted between approval and poll — token
            // would auth-fail at first use anyway. Return expired_token
            // to keep the wire shape deterministic; logs flag the
            // anomaly for forensic review.
            logger.warn('approved enrollment references unknown member', {
              member: outcome.memberName,
              tokenId: outcome.tokenId,
            });
            // Best-effort: revoke the orphan token.
            tokens.revoke(outcome.tokenId);
            return c.json({ error: 'expired_token' as const }, 400);
          }
          logger.info('enrollment poll resolved', {
            member: outcome.memberName,
            tokenId: outcome.tokenId,
          });
          return c.json({
            token: outcome.tokenPlaintext,
            tokenId: outcome.tokenId,
            member: {
              name: member.name,
              role: member.role,
              permissions: member.permissions,
            },
          });
        }
      }
    });

    app.get(PATHS.enrollPending, auth, (c) => {
      const caller = c.get('member');
      if (!hasPermission(caller.permissions, 'members.manage')) {
        return c.json({ error: 'listing enrollments requires members.manage' }, 403);
      }
      const rows = enrollmentsStore.listPending();
      return c.json({
        enrollments: rows.map((r) => ({
          userCode: formatUserCode(r.userCode),
          labelHint: r.labelHint,
          sourceIp: r.sourceIp,
          sourceUa: r.sourceUa,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
        })),
      });
    });

    app.post(PATHS.enrollApprove, auth, async (c) => {
      const caller = c.get('member');
      if (!hasPermission(caller.permissions, 'members.manage')) {
        return c.json({ error: 'approving enrollments requires members.manage' }, 403);
      }
      if (!persistMembers) {
        return c.json(
          { error: 'enrollment approval is not available (persistMembers missing)' },
          501,
        );
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = ApproveEnrollmentRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid approve payload', details: parsed.error.issues }, 400);
      }
      const normalized = normalizeUserCode(parsed.data.userCode);
      if (!normalized) {
        return c.json({ error: 'invalid userCode format' }, 400);
      }
      const lookup = enrollmentsStore.lookupByUserCode(normalized);
      switch (lookup.kind) {
        case 'not_found':
          return c.json({ error: 'no such enrollment' }, 404);
        case 'expired':
          return c.json({ error: 'enrollment expired' }, 410);
        case 'already_approved':
          return c.json({ error: 'enrollment already approved' }, 409);
        case 'already_rejected':
          return c.json({ error: 'enrollment already rejected' }, 409);
      }

      // Branch on bind vs create — `mode === 'create'` produces a
      // brand-new member; `mode === 'bind'` requires the named
      // member to already exist.
      let boundMember: { name: string; role: Role; permissions: Permission[] };
      if (parsed.data.mode === 'create') {
        if (members.findByName(parsed.data.memberName)) {
          return c.json({ error: `member '${parsed.data.memberName}' already exists` }, 409);
        }
        let resolvedPerms: Permission[];
        try {
          resolvedPerms = resolvePermissions(
            parsed.data.permissions,
            teamStore.getPresets(),
            `approve-enrollment ${parsed.data.memberName}`,
          );
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
        try {
          // A throwaway plaintext we'll never expose; the real token
          // for this member's first device is minted below and
          // tracked in the SQLite token store. addMember requires a
          // token, so we synthesize one and immediately replace it.
          const placeholder = generateBearerToken();
          members.addMember({
            name: parsed.data.memberName,
            role: parsed.data.role,
            instructions: parsed.data.instructions,
            rawPermissions: [...parsed.data.permissions],
            permissions: resolvedPerms,
            token: placeholder,
          });
        } catch (err) {
          return c.json(
            { error: err instanceof Error ? err.message : 'failed to create member' },
            409,
          );
        }
        const newTeammate: Teammate = {
          name: parsed.data.memberName,
          role: parsed.data.role,
          permissions: resolvedPerms,
        };
        broker.seedMembers([newTeammate]);
        boundMember = newTeammate;
      } else {
        const target = members.findByName(parsed.data.memberName);
        if (!target) {
          return c.json({ error: `no such member: ${parsed.data.memberName}` }, 404);
        }
        boundMember = {
          name: target.name,
          role: target.role,
          permissions: target.permissions,
        };
      }

      // Mint the actual bearer token for this device, insert into
      // the token store, then attach the plaintext to the pending
      // enrollment row for the device-side poll to consume. The
      // plaintext is KEK-wrapped at rest by the EnrollmentStore.
      const plaintext = generateBearerToken();
      const tokenRow = tokens.insert({
        memberName: boundMember.name,
        rawToken: plaintext,
        label: parsed.data.label ?? lookup.row.labelHint ?? 'connected device',
        origin: 'enroll',
        createdBy: caller.name,
      });
      const ok = enrollmentsStore.approve({
        userCode: normalized,
        approvedBy: caller.name,
        boundMember: boundMember.name,
        approveArgsJson: JSON.stringify({ mode: parsed.data.mode }),
        issuedTokenId: tokenRow.id,
        issuedTokenPlaintext: plaintext,
      });
      if (!ok) {
        // Race: someone else mutated this row between lookup and
        // approve. Roll back the token we just inserted so we don't
        // leave an orphan.
        tokens.revoke(tokenRow.id);
        return c.json({ error: 'enrollment changed state during approval — try again' }, 409);
      }
      // Persist member-store changes only if we mutated it.
      if (parsed.data.mode === 'create') {
        persistMembers();
      }
      logger.info('enrollment approved', {
        userCode: formatUserCode(normalized),
        approvedBy: caller.name,
        bound: boundMember.name,
        mode: parsed.data.mode,
        tokenId: tokenRow.id,
      });
      const { hash: _hash, ...publicTokenInfo } = tokenRow;
      return c.json({
        member: boundMember,
        tokenInfo: publicTokenInfo,
      });
    });

    app.post(PATHS.enrollReject, auth, async (c) => {
      const caller = c.get('member');
      if (!hasPermission(caller.permissions, 'members.manage')) {
        return c.json({ error: 'rejecting enrollments requires members.manage' }, 403);
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = RejectEnrollmentRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid reject payload', details: parsed.error.issues }, 400);
      }
      const normalized = normalizeUserCode(parsed.data.userCode);
      if (!normalized) {
        return c.json({ error: 'invalid userCode format' }, 400);
      }
      const ok = enrollmentsStore.reject({
        userCode: normalized,
        rejectedBy: caller.name,
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
      });
      if (!ok) {
        return c.json({ error: 'no pending enrollment matched that userCode' }, 404);
      }
      logger.info('enrollment rejected', {
        userCode: formatUserCode(normalized),
        rejectedBy: caller.name,
        reason: parsed.data.reason ?? '',
      });
      return c.body(null, 204);
    });
  }

  app.post(`${PATHS.members}/:name/enroll-totp`, auth, (c) => {
    const member = c.get('member');
    if (!persistMembers) {
      return c.json({ error: 'enroll-totp is not available (persistMembers missing)' }, 501);
    }
    const targetRaw = c.req.param('name');
    const parsedName = NameSchema.safeParse(targetRaw);
    if (!parsedName.success) return c.json({ error: 'invalid member name' }, 400);
    const target = members.findByName(parsedName.data);
    if (!target) return c.json({ error: `no such member: ${parsedName.data}` }, 404);
    if (!hasPermission(member.permissions, 'members.manage') && member.name !== target.name) {
      return c.json({ error: 'enroll-totp requires members.manage, or self' }, 403);
    }
    const secret = generateSecret();
    members.setTotpSecret(parsedName.data, secret);
    logger.info('totp enrolled', { name: parsedName.data, enrolledBy: member.name });
    return c.json({
      totpSecret: secret,
      totpUri: otpauthUri({
        secret,
        issuer: `csuite-${teamStore.getTeam().name}`,
        label: target.name,
      }),
    });
  });

  // ─── Filesystem endpoints ─────────────────────────────────────
  //
  // Registered iff an FilesystemStore is provided. Permission checks
  // live in the store; this layer maps `FsError` codes onto HTTP
  // statuses and handles request/response plumbing (multipart vs raw
  // body, streaming downloads, JSON payload parsing).
  if (files) {
    const fsStore = files;

    app.get(PATHS.fsList, auth, (c) => {
      const pathRaw = c.req.query('path') ?? '/';
      const parsedPath = FsPathSchema.safeParse(pathRaw);
      if (!parsedPath.success) {
        return c.json({ error: 'invalid path', details: parsedPath.error.issues }, 400);
      }
      try {
        const entries = fsStore.list(parsedPath.data, toViewer(c.get('member')));
        return c.json({ entries });
      } catch (err) {
        return mapFsError(c, err);
      }
    });

    app.get(PATHS.fsStat, auth, (c) => {
      const pathRaw = c.req.query('path');
      if (!pathRaw) return c.json({ error: '`path` query parameter is required' }, 400);
      const parsedPath = FsPathSchema.safeParse(pathRaw);
      if (!parsedPath.success) {
        return c.json({ error: 'invalid path', details: parsedPath.error.issues }, 400);
      }
      try {
        const entry = fsStore.stat(parsedPath.data, toViewer(c.get('member')));
        if (!entry) return c.json({ error: `no such path: ${parsedPath.data}` }, 404);
        return c.json({ entry });
      } catch (err) {
        return mapFsError(c, err);
      }
    });

    app.get(PATHS.fsShared, auth, (c) => {
      const entries = fsStore.listShared(toViewer(c.get('member')));
      return c.json({ entries });
    });

    // `/fs/all` — admin-only flat enumeration of every file in every
    // home, newest-first. Non-admins use the per-home tree under
    // `/<owner>/...` for their own files and `/fs/shared` for the
    // grants other members have given them.
    app.get(PATHS.fsAll, auth, (c) => {
      try {
        const entries = fsStore.listAllFiles(toViewer(c.get('member')));
        return c.json({ entries });
      } catch (err) {
        return mapFsError(c, err);
      }
    });

    // `/fs/read/*` — catch-all, single URL-decoded segment per path
    // component so `<img src="/fs/read/alice/uploads/foo.png">` just
    // works. The `*` route lives in its own handler so Hono's
    // path-matcher treats it distinctly from /fs/read (no slash).
    app.get('/fs/read/*', auth, async (c) => {
      const rawPath = c.req.path.slice('/fs/read'.length);
      if (rawPath.length === 0 || rawPath === '/') {
        return c.json({ error: '`/fs/read/<path>` requires a file path' }, 400);
      }
      // Hono's URL already URL-decodes the path before we see it;
      // pass through to the store which does its own validation.
      const parsedPath = FsPathSchema.safeParse(rawPath);
      if (!parsedPath.success) {
        return c.json({ error: 'invalid path', details: parsedPath.error.issues }, 400);
      }
      try {
        const { entry, stream } = fsStore.openReadStream(
          parsedPath.data,
          toViewer(c.get('member')),
        );
        const webStream = nodeStreamToWebStream(stream);
        return new Response(webStream, {
          status: 200,
          headers: {
            'Content-Type': entry.mimeType ?? 'application/octet-stream',
            ...(entry.size !== null ? { 'Content-Length': String(entry.size) } : {}),
            'Content-Disposition': `inline; filename="${encodeFilenameForHeader(entry.name)}"`,
          },
        });
      } catch (err) {
        return mapFsError(c, err);
      }
    });

    app.post(PATHS.fsWrite, auth, async (c) => {
      const pathRaw = c.req.query('path');
      const mime = c.req.query('mime');
      const collideRaw = c.req.query('collide') ?? 'error';
      if (!pathRaw) return c.json({ error: '`path` query parameter is required' }, 400);
      if (!mime) return c.json({ error: '`mime` query parameter is required' }, 400);
      const parsedPath = FsPathSchema.safeParse(pathRaw);
      if (!parsedPath.success) {
        return c.json({ error: 'invalid path', details: parsedPath.error.issues }, 400);
      }
      const parsedCollide = FsWriteCollisionSchema.safeParse(collideRaw);
      if (!parsedCollide.success) {
        return c.json({ error: `invalid collide strategy: ${collideRaw}` }, 400);
      }
      const body = c.req.raw.body;
      if (!body) return c.json({ error: 'empty upload body' }, 400);
      const nodeStream = Readable.fromWeb(
        body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
      );
      try {
        const result = await fsStore.writeFile({
          path: parsedPath.data,
          mimeType: mime,
          writer: toViewer(c.get('member')),
          source: nodeStream,
          collision: parsedCollide.data,
          maxSize: maxFileSize,
        });
        return c.json(result);
      } catch (err) {
        return mapFsError(c, err);
      }
    });

    app.post(PATHS.fsMkdir, auth, async (c) => {
      const raw = await c.req.json().catch(() => null);
      const parsed = FsMkdirRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid mkdir payload', details: parsed.error.issues }, 400);
      }
      try {
        const recursive = parsed.data.recursive ?? false;
        const entry = fsStore.mkdir(parsed.data.path, toViewer(c.get('member')), { recursive });
        return c.json({ entry });
      } catch (err) {
        return mapFsError(c, err);
      }
    });

    app.delete(PATHS.fsRm, auth, async (c) => {
      const pathRaw = c.req.query('path');
      const recursiveRaw = c.req.query('recursive');
      if (!pathRaw) return c.json({ error: '`path` query parameter is required' }, 400);
      const parsedPath = FsPathSchema.safeParse(pathRaw);
      if (!parsedPath.success) {
        return c.json({ error: 'invalid path', details: parsedPath.error.issues }, 400);
      }
      const recursive = recursiveRaw === 'true' || recursiveRaw === '1';
      try {
        await fsStore.remove(parsedPath.data, toViewer(c.get('member')), { recursive });
        return c.body(null, 204);
      } catch (err) {
        return mapFsError(c, err);
      }
    });

    app.post(PATHS.fsMv, auth, async (c) => {
      const raw = await c.req.json().catch(() => null);
      const parsed = FsMoveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid move payload', details: parsed.error.issues }, 400);
      }
      try {
        const entry = fsStore.move(parsed.data.from, parsed.data.to, toViewer(c.get('member')));
        return c.json({ entry });
      } catch (err) {
        return mapFsError(c, err);
      }
    });
  }

  // ─── Static SPA serving (registered LAST so API routes match first) ─

  if (publicRoot && existsSync(publicRoot)) {
    // Absolute root works despite serveStatic's docstring — the
    // implementation uses `path.join(root, filename)` which handles
    // absolute `root` correctly. We guard `existsSync` up front so
    // a stale `publicRoot` prints a Hono warning at startup rather
    // than 404ing every request silently.
    //
    // Two-phase serving:
    //   1. Direct file match (assets, manifest, icons, the root index)
    //   2. SPA fallback — for any GET that isn't an API path AND
    //      wasn't a direct file hit, serve index.html so client-side
    //      routing (preact-iso) can take over.
    app.use('*', serveStatic({ root: publicRoot }));
    app.get('*', async (c, next) => {
      if (isApiPath(c.req.path)) return next();
      return serveStatic({ root: publicRoot, path: 'index.html' })(c, next);
    });
  }

  return {
    app,
    injectWebSocket,
    ...(notificationDispatcher !== undefined ? { notificationDispatcher } : {}),
  };
}

/**
 * Objective context watchdog — scans uploaded LLM exchanges for
 * active objective IDs. If an objective is active for this user but
 * its ID doesn't appear anywhere in the exchange's system prompt or
 * messages, the agent has lost context (compaction, long session).
 * Pushes a reminder through the broker so the agent picks it back up.
 *
 * Debounced per user: only fires once per batch of uploads, and
 * only for the most recent exchange (checking every exchange in a
 * batch would spam on fast-uploading agents).
 */
const watchdogLastFired = new Map<string, number>();
const WATCHDOG_COOLDOWN_MS = 5 * 60 * 1000;

function checkObjectiveContext(
  events: ActivityEvent[],
  name: string,
  objectivesStore: ObjectivesStore,
  broker: Broker,
  logger: Logger,
): void {
  // Only inspect the most recent llm_exchange in this batch.
  const llmEvent = events.findLast((e) => e.kind === 'llm_exchange');
  if (!llmEvent || llmEvent.kind !== 'llm_exchange') return;

  const active = [
    ...objectivesStore.list({ assignee: name, status: 'active' }),
    ...objectivesStore.list({ assignee: name, status: 'blocked' }),
  ];
  if (active.length === 0) return;

  // Build a string from the full request context the agent sent to
  // the LLM: system prompt + all text content blocks.
  const entry = llmEvent.entry;
  const parts: string[] = [];
  if (entry.request.system) parts.push(entry.request.system);
  for (const m of entry.request.messages) {
    for (const block of m.content) {
      if ('text' in block && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }
  const contextText = parts.join(' ');

  const now = Date.now();
  const missing = active.filter((o) => {
    if (contextText.includes(o.id)) return false;
    const key = `${name}:${o.id}`;
    const last = watchdogLastFired.get(key) ?? 0;
    return now - last > WATCHDOG_COOLDOWN_MS;
  });
  if (missing.length === 0) return;

  const lines = missing.map((o) => `  ${o.id}: ${o.title}\n    outcome: ${o.outcome}`);
  const body =
    `You have ${missing.length} active objective(s) that are no longer in your context. ` +
    `Here they are — call \`objectives_view\` for full details:\n${lines.join('\n')}`;

  for (const o of missing) watchdogLastFired.set(`${name}:${o.id}`, now);

  void broker.push(
    { to: name, body, title: 'objective context reminder', level: 'notice' },
    { from: 'csuite' },
  );
  logger.info('objective context watchdog fired', {
    name,
    missing: missing.map((o) => o.id),
  });
}

/** Re-export so `LoadedMember` consumers don't have to dig into members.ts. */
export type { LoadedMember };

/**
 * Validate + canonicalize a list of attachment claims. Server
 * re-derives name/size/mime from the stored entry so the caller
 * can't lie. Used by `/push`, `/objectives` create, and
 * `/objectives/:id/discuss` so every attachment-bearing path
 * shares the same resolver.
 *
 *   result.error      — a human-readable explanation; set iff
 *                       result.canonical is undefined
 *   result.status     — HTTP status to return alongside result.error
 *   result.canonical  — an array (possibly empty) of authoritative
 *                       Attachment objects to persist / fan out
 */
type CanonicalizeResult =
  | { ok: true; canonical: Attachment[] }
  | { ok: false; error: string; status: 400 | 403 };

function canonicalizeAttachments(
  claims: Attachment[] | undefined,
  viewer: ViewerContext,
  filesStore: FilesystemStore | undefined,
): CanonicalizeResult {
  if (!claims || claims.length === 0) return { ok: true, canonical: [] };
  if (!filesStore) {
    return {
      ok: false,
      error: 'file attachments are not enabled on this server',
      status: 400,
    };
  }
  const out: Attachment[] = [];
  for (const claim of claims) {
    try {
      const entry = filesStore.stat(claim.path, viewer);
      if (!entry) {
        return { ok: false, error: `attachment not found: ${claim.path}`, status: 400 };
      }
      if (entry.kind !== 'file') {
        return { ok: false, error: `attachment is a directory: ${claim.path}`, status: 400 };
      }
      if (entry.size === null || entry.mimeType === null) {
        return { ok: false, error: `attachment is corrupt: ${claim.path}`, status: 400 };
      }
      out.push({
        path: entry.path,
        name: entry.name,
        size: entry.size,
        mimeType: entry.mimeType,
      });
    } catch (err) {
      if (err instanceof FsError && err.code === 'forbidden') {
        return { ok: false, error: `no access to attachment: ${claim.path}`, status: 403 };
      }
      throw err;
    }
  }
  return { ok: true, canonical: out };
}

/**
 * Materialize read-grants for every (attachment, recipient) pair.
 * Owner self-grants are dropped inside `files.grant`, so callers
 * don't need to filter the recipient set.
 */
function grantAttachmentsTo(
  filesStore: FilesystemStore,
  attachments: Attachment[],
  recipients: Iterable<string>,
  grantKey: string,
  logger: Logger,
): void {
  for (const att of attachments) {
    for (const r of recipients) {
      try {
        filesStore.grant(att.path, r, grantKey);
      } catch (err) {
        logger.warn('failed to grant attachment access', {
          path: att.path,
          viewer: r,
          grantKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * Project a LoadedMember onto the smaller shape the filesystem layer
 * consumes. The store only needs name + permissions for permission
 * checks — keeping the surface lean makes it trivial to unit-test
 * without constructing a full user record.
 */
/** Human-readable target list for endpoint change events. */
function describeTargets(targets: NotificationTarget[]): string {
  if (targets.length === 0) return 'nobody';
  return targets
    .map((t) => (t.member !== undefined ? t.member : `#${t.channel ?? '?'}`))
    .join(', ');
}

function toViewer(member: LoadedMember): ViewerContext {
  return { name: member.name, permissions: member.permissions };
}

/**
 * Compose the "csuite session online" notice the broker pushes to a
 * runner the moment its WS subscribe lands. The agent reads this on
 * its first turn and uses it to decide whether to resume work,
 * acknowledge new direction, or stand by — without treating it as a
 * teammate message that demands a reply.
 *
 * The wording deliberately avoids:
 *   - "comms check" / "ping" / "are you there" — historical title;
 *     agents interpreted it as a probe and started DMing teammates
 *     to "test" the chat surface.
 *   - "you're online" framed as something the AGENT needs to confirm.
 *
 * And explicitly carries:
 *   - "system notice" framing so the agent knows it's machine-emitted.
 *   - "no acknowledgement required" so the agent doesn't generate a
 *     reply turn just to say "got it".
 *   - The current plate count, so the agent has enough context to
 *     decide whether `objectives_list` is worth a tool call right now.
 *
 * Pure: takes the member name and the count of active+blocked
 * objectives, returns body/title. Tested directly.
 */
export function composeSessionOnlineMessage(
  memberName: string,
  activeObjectiveCount: number,
): { title: string; body: string } {
  const plate =
    activeObjectiveCount > 0
      ? `You have ${activeObjectiveCount} active objective(s) on your plate — call \`objectives_list\` to see them.`
      : 'No active objectives are assigned to you right now.';
  const body =
    `Connected to csuite as ${memberName}. ${plate} ` +
    'This is a system notice marking the start of a runtime session — no acknowledgement is required. ' +
    'Resume any in-progress work, address open objectives, or stand by for new direction as appropriate.';
  return {
    title: 'csuite session online',
    body,
  };
}

/** Project a LoadedMember into the public `Member` wire shape. */
function loadedToMember(m: LoadedMember): {
  name: string;
  role: Role;
  permissions: readonly Permission[];
  instructions: string;
} {
  return {
    name: m.name,
    role: m.role,
    permissions: m.permissions,
    instructions: m.instructions,
  };
}

/**
 * Map an `FsError` to a Hono JSON response. Non-FsError throws
 * bubble up as 500s — the store never throws raw errors for
 * permission / shape issues.
 */
function mapFsError(c: Context<AppBindings>, err: unknown): Response {
  if (err instanceof FsError) {
    const status =
      err.code === 'not_found'
        ? 404
        : err.code === 'forbidden'
          ? 403
          : err.code === 'too_large'
            ? 413
            : err.code === 'exists' ||
                err.code === 'not_a_directory' ||
                err.code === 'is_a_directory' ||
                err.code === 'not_empty'
              ? 409
              : 400;
    return c.json({ error: err.message, code: err.code }, status as 400 | 403 | 404 | 409 | 413);
  }
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
}

/**
 * Wrap a Node `Readable` into a web `ReadableStream<Uint8Array>` so
 * we can hand it to `new Response(...)`. `Readable.toWeb` returns a
 * loosely-typed stream; we narrow it at the boundary since every
 * value on the wire is a Uint8Array chunk.
 */
function nodeStreamToWebStream(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

/**
 * RFC-5987 filename* encoding for Content-Disposition. Non-ASCII
 * characters are percent-encoded per UTF-8. Control characters and
 * the characters `"\` are replaced with `_` to keep the header safe.
 */
function encodeFilenameForHeader(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strip control chars from header values
  return name.replace(/[\x00-\x1f"\\]/g, '_');
}

/**
 * Render the human-readable body for a lifecycle event's channel push.
 * This is what the agent actually reads in its channel envelope — it
 * has to carry enough structured context that the agent can act on
 * the event without immediately calling `objectives_view`. Kept out of
 * the store so the store stays free of wire-format concerns.
 *
 * Format: a one-line header identifying the event, followed by a
 * structured block of `key: value` lines for the fields the agent
 * cares about. The lines are plain text (no JSON, no XML) so they
 * flow naturally in the agent's context window alongside chat.
 */
function systemMessageForEvent(
  objective: Objective,
  kind: ObjectiveEventKind,
  event: ObjectiveEvent | undefined,
): string {
  const header = `[objective ${kind}] ${objective.id}`;

  switch (kind) {
    case 'assigned': {
      return [
        header,
        `title:      ${objective.title}`,
        `outcome:    ${objective.outcome}`,
        `assignee:   ${objective.assignee}`,
        `originator: ${objective.originator}`,
        `status:     ${objective.status}`,
        objective.body ? `body:       ${objective.body}` : null,
      ]
        .filter((l): l is string => l !== null)
        .join('\n');
    }
    case 'blocked': {
      const reason =
        typeof event?.payload.reason === 'string' ? event.payload.reason : '(no reason given)';
      return [
        header,
        `title:    ${objective.title}`,
        `assignee: ${objective.assignee}`,
        `reason:   ${reason}`,
      ].join('\n');
    }
    case 'unblocked': {
      return [
        header,
        `title:    ${objective.title}`,
        `assignee: ${objective.assignee}`,
        `status:   active (resumed)`,
      ].join('\n');
    }
    case 'completed': {
      return [
        header,
        `title:    ${objective.title}`,
        `outcome:  ${objective.outcome}`,
        `assignee: ${objective.assignee}`,
        `result:   ${objective.result ?? ''}`,
      ].join('\n');
    }
    case 'cancelled': {
      const reason =
        typeof event?.payload.reason === 'string' ? event.payload.reason : '(no reason given)';
      return [
        header,
        `title:    ${objective.title}`,
        `assignee: ${objective.assignee}`,
        `reason:   ${reason}`,
      ].join('\n');
    }
    case 'reassigned': {
      const from = typeof event?.payload.from === 'string' ? event.payload.from : '(unknown)';
      const to = typeof event?.payload.to === 'string' ? event.payload.to : objective.assignee;
      return [
        header,
        `title:   ${objective.title}`,
        `outcome: ${objective.outcome}`,
        `from:    ${from}`,
        `to:      ${to}`,
      ].join('\n');
    }
    case 'watcher_added': {
      const cs = typeof event?.payload.name === 'string' ? event.payload.name : '(unknown)';
      return [
        header,
        `title:    ${objective.title}`,
        `outcome:  ${objective.outcome}`,
        `watcher:  ${cs}`,
        `status:   ${objective.status}`,
      ].join('\n');
    }
    case 'watcher_removed': {
      const cs = typeof event?.payload.name === 'string' ? event.payload.name : '(unknown)';
      return [header, `title:   ${objective.title}`, `watcher: ${cs}`].join('\n');
    }
  }
}

/**
 * Minimal self-contained HTML for the `/setup/connect-platform`
 * confirmation page. No framework, no bundler — the page runs a
 * 5-line script that probes `/session`, then either shows the
 * confirm button or a "sign in first" fallback.
 *
 * Styled inline to match the csuite theme tokens approximately; the
 * page is ephemeral (post-confirm, user closes the tab) so we don't
 * need a pixel-perfect match.
 */
function renderConnectPlatformPage(
  code: string,
  opts: { mode: 'iframe' | 'tab'; parentOrigin: string } = { mode: 'tab', parentOrigin: '' },
): string {
  // Escape the code for HTML attribute context. Codes are generated
  // from a Crockford base32 alphabet on the platform side so there's
  // nothing dangerous to escape in practice, but doing it anyway
  // means future code-format changes don't open an XSS hole.
  const escapeHtml = (s: string): string =>
    s.replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        default:
          return ch;
      }
    });
  const safeCode = escapeHtml(code);
  // Validate parentOrigin at render time so a malformed value doesn't
  // reach the client-side postMessage call. An invalid URL yields an
  // empty string, which disables postMessage entirely (falls back to
  // tab-mode behavior) rather than using a risky wildcard target.
  let parentOrigin = '';
  if (opts.mode === 'iframe' && opts.parentOrigin) {
    try {
      const parsed = new URL(opts.parentOrigin);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        parentOrigin = parsed.origin;
      }
    } catch {
      // Leave as empty; iframe mode without a trusted parent origin
      // renders but won't postMessage.
    }
  }
  const modeLiteral = opts.mode === 'iframe' && parentOrigin ? 'iframe' : 'tab';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Connect to platform</title>
  <style>
    :root {
      --ink: #0e1c2b;
      --paper: #f6f3ec;
      --rule: rgba(14, 28, 43, 0.14);
      --muted: #4b5560;
      --err: #b04a34;
    }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: var(--paper);
      color: var(--ink);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      max-width: 440px;
      width: 100%;
      background: white;
      border: 1px solid var(--rule);
      border-radius: 12px;
      padding: 28px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    }
    h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
    p { margin: 0 0 12px; color: var(--muted); line-height: 1.5; }
    code { font-family: ui-monospace, "SF Mono", monospace; font-size: 14px; background: #eee; padding: 2px 6px; border-radius: 4px; }
    .row { margin-top: 20px; display: flex; gap: 8px; }
    button, a.btn {
      display: inline-block;
      font: inherit;
      padding: 10px 16px;
      border-radius: 8px;
      border: 1px solid var(--rule);
      background: var(--paper);
      color: var(--ink);
      cursor: pointer;
      text-decoration: none;
    }
    button.primary {
      background: var(--ink);
      color: var(--paper);
      border-color: var(--ink);
    }
    button:disabled { opacity: 0.5; cursor: default; }
    .err { color: var(--err); margin-top: 12px; font-size: 14px; }
    .muted { color: var(--muted); font-size: 13px; }
  </style>
</head>
<body>
  <main class="card" id="root">
    <h1>Loading…</h1>
    <p class="muted">Checking your session on this server.</p>
  </main>
  <script>
    (function () {
      var code = ${JSON.stringify(safeCode)};
      var mode = ${JSON.stringify(modeLiteral)};
      var parentOrigin = ${JSON.stringify(parentOrigin)};
      var root = document.getElementById('root');

      if (!code) {
        renderError("Missing code in the URL. Restart the connect flow from the platform.");
        return;
      }

      fetch('/session', { credentials: 'same-origin' }).then(function (res) {
        if (res.status === 200) {
          return res.json().then(function (body) { renderConfirm(body); });
        }
        renderSignedOut();
      }).catch(function () {
        renderSignedOut();
      });

      function renderConfirm(session) {
        var member = session && session.member && session.member.name ? session.member.name : '(unknown)';
        root.innerHTML =
          '<h1>Authorize the platform</h1>' +
          '<p>The platform wants to bind this server to member <code>' + escapeHtml(member) + '</code>.</p>' +
          '<p class="muted">Confirming links this server to your platform account. The platform will never mint tokens for any other member on this server.</p>' +
          '<div class="row">' +
          '<button id="confirm" class="primary">Authorize</button>' +
          '<button id="cancel">Cancel</button>' +
          '</div>' +
          '<div id="err" class="err" hidden></div>';

        document.getElementById('confirm').addEventListener('click', function () {
          var btn = this;
          var err = document.getElementById('err');
          btn.disabled = true;
          btn.textContent = 'Working…';
          err.hidden = true;
          fetch('/platform-connect/bind', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: code })
          }).then(function (res) {
            if (!res.ok) {
              return res.text().then(function (body) { throw new Error(body || ('HTTP ' + res.status)); });
            }
            // When embedded in the platform via iframe, we postMessage
            // the parent so the platform flow can advance without a
            // tab switch. The explicit parentOrigin was validated
            // server-side and rejects to empty string on any parse
            // issue; in that case we silently stay in "close the
            // tab" mode.
            if (mode === 'iframe' && parentOrigin) {
              try {
                window.parent.postMessage(
                  { type: 'platform-connect-bound', code: code, memberName: member },
                  parentOrigin,
                );
              } catch (_) {
                // Parent may have navigated away; the platform tab can
                // still complete the handshake on its next poll.
              }
            }
            root.innerHTML =
              '<h1>Done.</h1>' +
              '<p>The platform has been authorized as <code>' + escapeHtml(member) + '</code>.</p>' +
              (mode === 'iframe'
                ? '<p class="muted">Your platform tab will continue automatically.</p>'
                : '<p class="muted">You can close this tab and return to the platform.</p>');
          }).catch(function (e) {
            btn.disabled = false;
            btn.textContent = 'Authorize';
            err.hidden = false;
            err.textContent = e && e.message ? e.message : 'Request failed. Try again.';
          });
        });

        document.getElementById('cancel').addEventListener('click', function () {
          window.close();
          root.innerHTML = '<h1>Cancelled.</h1><p class="muted">Nothing was changed. Close this tab.</p>';
        });
      }

      function renderSignedOut() {
        root.innerHTML =
          '<h1>Sign in first</h1>' +
          '<p>Sign into this csuite server as the member you want to bind to the platform.</p>' +
          '<p class="muted">After signing in, return to this page to confirm the binding. The code is already pinned to this tab.</p>' +
          '<div class="row"><a class="btn" href="/">Go to sign-in →</a></div>';
      }

      function renderError(msg) {
        root.innerHTML = '<h1>Cannot continue</h1><p class="err">' + escapeHtml(msg) + '</p>';
      }

      function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (ch) {
          return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
        });
      }
    })();
  </script>
</body>
</html>`;
}
