/**
 * `csuite-sdk` runtime client.
 *
 * A thin, typed wrapper over the broker HTTP API. Validates every response
 * against `csuite-sdk/schemas` so callers get either a validated,
 * strongly-typed result or a `ClientError`.
 *
 * Live streams (`subscribe`) run over WebSocket. The default client
 * uses the Node `ws` package; tests and non-Node runtimes can inject
 * a `WebSocket` class via `ClientOptions.WebSocket`.
 */

import { WebSocket as NodeWebSocket } from 'ws';
import packageJson from '../package.json' with { type: 'json' };
import {
  AUTH_HEADER,
  CHANNEL_PATHS,
  CLIENT_IDENTITY_HEADER,
  FS_PATHS,
  MEMBER_PATHS,
  NOTIFICATION_PATHS,
  OBJECTIVE_PATHS,
  PATHS,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  RUNNER_VERSION_HEADER,
  SECRET_PATHS,
  TEAM_PROCESS_PATHS,
  TOOL_SOURCE_PATHS,
  VARIABLE_PATHS,
} from './protocol.js';
import {
  ActivityReportSchema,
  AddChannelMemberRequestSchema,
  ApproveEnrollmentRequestSchema,
  ApproveEnrollmentResponseSchema,
  BindSecretRequestSchema,
  BindToolSourceRequestSchema,
  BindVariableRequestSchema,
  ChannelAuditResponseSchema,
  ChannelSchema,
  ClientIdentitySchema,
  ContextControlResponseSchema,
  CreateChannelRequestSchema,
  CreateMemberResponseSchema,
  CreateNotificationEndpointRequestSchema,
  CreateNotificationProfileRequestSchema,
  CreateSecretRequestSchema,
  CreateToolSourceRequestSchema,
  CreateVariableRequestSchema,
  DeviceAuthorizationRequestSchema,
  DeviceAuthorizationResponseSchema,
  DeviceTokenErrorResponseSchema,
  DeviceTokenResponseSchema,
  EditTeamProcessRequestSchema,
  EnrollTotpResponseSchema,
  FsEntryResponseSchema,
  FsListResponseSchema,
  FsWriteResponseSchema,
  GetChannelResponseSchema,
  GetGenaiInferenceResponseSchema,
  GetNotificationEndpointResponseSchema,
  GetObjectiveResponseSchema,
  GetSecretResponseSchema,
  GetTeamProcessResponseSchema,
  GetToolSourceResponseSchema,
  GetVariableResponseSchema,
  HealthResponseSchema,
  HistoryResponseSchema,
  InstructionsResponseSchema,
  InvokeToolRequestSchema,
  InvokeToolResponseSchema,
  ListActivityResponseSchema,
  ListChannelsResponseSchema,
  ListGenaiResponseSchema,
  ListGenaiSummariesResponseSchema,
  ListMembersResponseSchema,
  ListNotificationDeliveriesResponseSchema,
  ListNotificationEndpointsResponseSchema,
  ListNotificationProfilesResponseSchema,
  ListObjectivesResponseSchema,
  ListPendingEnrollmentsResponseSchema,
  ListSecretsResponseSchema,
  ListTelemetryResponseSchema,
  ListTokensResponseSchema,
  ListToolSourcesResponseSchema,
  ListVariablesResponseSchema,
  MemberSchema,
  MessageDispositionFrameSchema,
  MessageSchema,
  NotificationEndpointSchema,
  NotificationProfileSchema,
  ObjectiveSchema,
  PushPayloadSchema,
  PushResultSchema,
  PushSubscriptionResponseSchema,
  RefreshToolSourceResponseSchema,
  RejectEnrollmentRequestSchema,
  RenameChannelRequestSchema,
  ReplayNotificationDeliveryResponseSchema,
  ResolveSecretsResponseSchema,
  RosterResponseSchema,
  RotateTokenResponseSchema,
  RunnerControlFrameSchema,
  RunnerIdentitySchema,
  SecretSchema,
  SessionResponseSchema,
  SetCustomToolRequestSchema,
  SetNotificationSecretRequestSchema,
  SetSecretValueRequestSchema,
  SetToolCredentialRequestSchema,
  SetVariableValueRequestSchema,
  TeamProcessEditSchema,
  TeamProcessHistoryResponseSchema,
  TeamProcessSchema,
  TeamSchema,
  TeamStatusResponseSchema,
  ToolSourceSchema,
  UpdateChannelRequestSchema,
  UpdateNotificationEndpointRequestSchema,
  UpdateNotificationProfileRequestSchema,
  UpdateSecretRequestSchema,
  UpdateToolSourceRequestSchema,
  UpdateVariableRequestSchema,
  UploadActivityResponseSchema,
  VapidPublicKeyResponseSchema,
} from './schemas.js';
import type {
  ActivityReport,
  ActivityRow,
  AddChannelMemberRequest,
  ApproveEnrollmentRequest,
  ApproveEnrollmentResponse,
  BindSecretRequest,
  BindToolSourceRequest,
  BindVariableRequest,
  CancelObjectiveRequest,
  Channel,
  ChannelSummary,
  ClientIdentity,
  ContextControlRequest,
  ContextControlResponse,
  CreateChannelRequest,
  CreateMemberRequest,
  CreateMemberResponse,
  CreateNotificationEndpointRequest,
  CreateNotificationProfileRequest,
  CreateObjectiveRequest,
  CreateSecretRequest,
  CreateToolSourceRequest,
  CreateVariableRequest,
  DeviceAuthorizationRequest,
  DeviceAuthorizationResponse,
  DeviceTokenErrorCode,
  DeviceTokenResponse,
  DiscussObjectiveRequest,
  EditTeamProcessRequest,
  EnrollTotpResponse,
  FsEntry,
  FsWriteCollisionStrategy,
  FsWriteResponse,
  GenAiInferenceRecord,
  GenAiInferenceSummary,
  GetChannelResponse,
  GetNotificationEndpointResponse,
  GetObjectiveResponse,
  GetSecretResponse,
  GetToolSourceResponse,
  GetVariableResponse,
  HealthResponse,
  HistoryQuery,
  InstructionsResponse,
  InvokeToolResponse,
  ListActivityQuery,
  ListGenaiQuery,
  ListObjectivesQuery,
  ListTelemetryQuery,
  Member,
  Message,
  MessageDispositionFrame,
  NotificationDelivery,
  NotificationEndpoint,
  NotificationEndpointSummary,
  NotificationProfile,
  NotificationProfileSummary,
  Objective,
  PendingEnrollment,
  PushPayload,
  PushResult,
  PushSubscriptionPayload,
  PushSubscriptionResponse,
  RefreshToolSourceResponse,
  RejectEnrollmentRequest,
  RenameChannelRequest,
  ResolveSecretsResponse,
  RosterResponse,
  RotateTokenRequest,
  RotateTokenResponse,
  RunnerControlFrame,
  RunnerIdentity,
  Secret,
  SecretSummary,
  SessionResponse,
  SetCustomToolRequest,
  SetNotificationSecretRequest,
  SetSecretValueRequest,
  SetToolCredentialRequest,
  SetVariableValueRequest,
  Team,
  TeamProcess,
  TeamProcessEdit,
  TeamStatusResponse,
  TelemetryRecordRow,
  TokenInfo,
  ToolSource,
  ToolSourceSummary,
  TotpLoginRequest,
  UpdateChannelRequest,
  UpdateMemberRequest,
  UpdateNotificationEndpointRequest,
  UpdateNotificationProfileRequest,
  UpdateObjectiveRequest,
  UpdateSecretRequest,
  UpdateToolSourceRequest,
  UpdateVariableRequest,
  UploadActivityRequest,
  UploadActivityResponse,
  VapidPublicKeyResponse,
  VariableSummary,
} from './types.js';

// Re-exported from `./types` (canonical home) so `csuite-sdk`
// and its `./client` subpath keep exporting the name unchanged.
export type { FsWriteCollisionStrategy };

export interface FsWriteInput {
  path: string;
  mimeType: string;
  /**
   * The file contents. Accepts anything `fetch` accepts for a body —
   * a `Blob`, `ArrayBuffer`, `Uint8Array`, `File`, `ReadableStream`,
   * or `string`. For large files prefer a streaming source so the
   * request doesn't buffer the entire file in memory.
   */
  source: BodyInit;
  /** Override the default `'error'` collision behavior. */
  collision?: FsWriteCollisionStrategy;
}

export interface ClientOptions {
  /** Broker base URL, e.g. `http://127.0.0.1:8717`. No trailing slash required. */
  url: string;
  /**
   * Shared-secret bearer token. Optional — omit for human/web-UI usage
   * where auth comes from the session cookie (`useCookies: true`).
   * Required for machine/MCP-link usage where no cookie is available.
   */
  token?: string;
  /**
   * Opt into `credentials: 'include'` on every request — for
   * browser-side SPAs that rely on the `csuite_session` cookie instead
   * of a bearer token. Has no effect in Node where fetch doesn't
   * manage cookies automatically.
   */
  useCookies?: boolean;
  /** Custom fetch implementation (for tests or polyfills). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /**
   * Custom WebSocket constructor (for tests or non-Node runtimes).
   * Must match the `ws` package's `WebSocket` surface — construct
   * with `(url, { headers? })` and expose `on('message'|'close'|'error', …)`
   * plus `close()`. Defaults to `WebSocket` from `ws`.
   */
  WebSocket?: typeof NodeWebSocket;
  /** Called when either outbound transport receives an authentication rejection. */
  onUnauthorized?: (source: 'http' | 'websocket') => void;
  /** Identity reported by subscriptions; defaults to this SDK build. */
  clientIdentity?: ClientIdentity;
}

export class ClientError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'ClientError';
    this.status = status;
    this.body = body;
  }
}

/** Ack-capable runner subscription. Dispositions travel on the same authenticated WebSocket. */
export interface ReliableSubscription extends AsyncIterable<Message> {
  disposition(frame: MessageDispositionFrame): void;
  /** Additive liveness-v1 control; old brokers ignore the unknown frame. */
  control(frame: RunnerControlFrame): void;
}

export class Client {
  private readonly baseUrl: URL;
  private token: string | null;
  private readonly useCookies: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl: typeof NodeWebSocket;
  private readonly onUnauthorized: ((source: 'http' | 'websocket') => void) | undefined;
  private readonly clientIdentity: ClientIdentity;
  private readonly activeSubscriptions = new Set<NodeWebSocket>();

  constructor(options: ClientOptions) {
    // Normalize: strip trailing slash so URL composition is predictable.
    this.baseUrl = new URL(`${options.url.replace(/\/+$/, '')}/`);
    this.token = options.token ?? null;
    this.useCookies = options.useCookies ?? false;
    if (!this.token && !this.useCookies) {
      throw new Error(
        'Client: must provide either `token` (bearer) or `useCookies: true` (session)',
      );
    }
    const fetchRef = options.fetch ?? globalThis.fetch;
    if (!fetchRef) {
      throw new Error('Client: no fetch implementation available');
    }
    // Bind to avoid "Illegal invocation" on some runtimes.
    this.fetchImpl = fetchRef.bind(globalThis);
    this.WebSocketImpl = options.WebSocket ?? NodeWebSocket;
    this.onUnauthorized = options.onUnauthorized;
    this.clientIdentity = ClientIdentitySchema.parse(
      options.clientIdentity ?? { kind: 'sdk', clientVersion: packageJson.version },
    );
  }

  /**
   * Replace the bearer credential used by future requests. Never returns or logs the token.
   * A token supplied to a runner through its environment cannot be replaced in place;
   * restart that runner with the new environment value instead.
   */
  replaceToken(token: string): void {
    if (this.useCookies) throw new Error('Client.replaceToken is unavailable for cookie clients');
    if (token.length === 0) throw new Error('Client.replaceToken requires a non-empty token');
    this.token = token;
    for (const socket of this.activeSubscriptions) socket.close(4001, 'credential replaced');
  }

  /** Make a request with the protocol header and credentials. */
  private async request(
    path: string,
    init: RequestInit & { skipAuth?: boolean } = {},
  ): Promise<Response> {
    const url = new URL(path.replace(/^\//, ''), this.baseUrl);
    const headers = new Headers(init.headers);
    headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    if (!init.skipAuth && this.token) {
      headers.set(AUTH_HEADER, `Bearer ${this.token}`);
    }
    const { skipAuth: _skipAuth, ...rest } = init;
    const requestInit: RequestInit = { ...rest, headers };
    if (this.useCookies) {
      requestInit.credentials = 'include';
    }
    const response = await this.fetchImpl(url, requestInit);
    if (!init.skipAuth && response.status === 401) this.onUnauthorized?.('http');
    return response;
  }

  private async json<T>(resp: Response): Promise<T> {
    const text = await resp.text();
    if (!resp.ok) {
      throw new ClientError(`${resp.status} ${resp.statusText}`, resp.status, text);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ClientError(`invalid JSON from ${resp.url}`, resp.status, text);
    }
  }

  async health(): Promise<HealthResponse> {
    const resp = await this.request(PATHS.health, { method: 'GET', skipAuth: true });
    return HealthResponseSchema.parse(await this.json(resp));
  }

  /**
   * Exchange a TOTP code for a session. Succeeds → server sets the
   * `csuite_session` cookie and returns the authenticated member info.
   * Failure modes: wrong/stale code → 401, malformed → 400,
   * too-many-attempts → 429.
   */
  async loginWithTotp(payload: TotpLoginRequest): Promise<SessionResponse> {
    const resp = await this.request(PATHS.sessionTotp, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      skipAuth: true,
    });
    return SessionResponseSchema.parse(await this.json(resp));
  }

  /**
   * Drop the server-side session and clear the cookie. Safe to call
   * even if already logged out — returns 200 either way.
   */
  async logout(): Promise<void> {
    const resp = await this.request(PATHS.sessionLogout, {
      method: 'POST',
      skipAuth: true,
    });
    // Any 2xx is success; no body to validate.
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new ClientError(`logout failed: ${resp.status} ${resp.statusText}`, resp.status, body);
    }
  }

  /**
   * Fetch the current session's member/role/expiry. Used by the SPA on
   * mount to rehydrate its session signal before showing any UI.
   * Returns null on 401 (no / expired session) so callers can treat
   * "not signed in" as a first-class state without catching errors.
   */
  async currentSession(): Promise<SessionResponse | null> {
    const resp = await this.request(PATHS.session, {
      method: 'GET',
      skipAuth: true,
    });
    if (resp.status === 401) return null;
    return SessionResponseSchema.parse(await this.json(resp));
  }

  /**
   * Fetch the server's VAPID public key. Anonymous — no auth needed.
   * Used by the SPA's push-subscription flow to pass into
   * `pushManager.subscribe({applicationServerKey})`.
   */
  async vapidPublicKey(): Promise<VapidPublicKeyResponse> {
    const resp = await this.request(PATHS.pushVapidPublicKey, {
      method: 'GET',
      skipAuth: true,
    });
    return VapidPublicKeyResponseSchema.parse(await this.json(resp));
  }

  /**
   * Register (or refresh) a push subscription for the current
   * authenticated member. Subsequent calls with the same endpoint
   * replace the existing row.
   */
  async registerPushSubscription(
    payload: PushSubscriptionPayload,
  ): Promise<PushSubscriptionResponse> {
    const resp = await this.request(PATHS.pushSubscriptions, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return PushSubscriptionResponseSchema.parse(await this.json(resp));
  }

  /**
   * Remove a push subscription by its database id. Scoped to the
   * authenticated member server-side.
   */
  async deletePushSubscription(id: number): Promise<void> {
    const resp = await this.request(`${PATHS.pushSubscriptions}/${id}`, {
      method: 'DELETE',
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new ClientError(
        `deletePushSubscription failed: ${resp.status} ${resp.statusText}`,
        resp.status,
        body,
      );
    }
  }

  /**
   * Fetch the composed instruction packet for the authenticated
   * member.
   *
   * Returns the caller's name, role, permissions, team
   * (name/context/presets), list of teammates, open objectives
   * currently on the caller's plate, the member's personal
   * `instructions` string ready for `new Server({instructions})` in
   * the MCP link, and — from brokers with the instruction-block model
   * — the named `blocks` descriptors plus the `composedSha256`
   * instruction-version identifier.
   *
   * Requires a broker serving `GET /instructions` (protocol v2).
   */
  async instructions(options: { runnerVersion?: string } = {}): Promise<InstructionsResponse> {
    const headers = new Headers();
    if (options.runnerVersion !== undefined) {
      headers.set(RUNNER_VERSION_HEADER, options.runnerVersion);
    }
    const resp = await this.request(PATHS.instructions, { method: 'GET', headers });
    return InstructionsResponseSchema.parse(await this.json(resp));
  }

  /**
   * List all members defined on the team (including any not currently
   * connected) plus the runtime connection state of each one. Use
   * this for the team roster view in the web UI and for the `roster`
   * MCP tool exposed by the runner.
   */
  async roster(): Promise<RosterResponse> {
    const resp = await this.request(PATHS.roster, { method: 'GET' });
    return RosterResponseSchema.parse(await this.json(resp));
  }

  /** Read the broker-composed team operability report. Requires members.manage. */
  async teamStatus(options: { stalledMs?: number } = {}): Promise<TeamStatusResponse> {
    const params = new URLSearchParams();
    if (options.stalledMs !== undefined) params.set('stalledMs', String(options.stalledMs));
    const suffix = params.size > 0 ? `?${params}` : '';
    const resp = await this.request(`${PATHS.teamStatus}${suffix}`, { method: 'GET' });
    return TeamStatusResponseSchema.parse(await this.json(resp));
  }

  // ─────────────────────── Objectives ───────────────────────

  /**
   * List objectives. Members without `objectives.create` see only
   * their own; members with that permission can filter by any
   * `assignee` name. Pass `status` to scope to a single lifecycle
   * state; omit to see all.
   *
   * Pass `related` for the union a member actually has a stake in —
   * assigned OR originated OR watching. `assignee` alone answers a
   * narrower question and omits work you originated or watch, which is
   * the whole plate for a coordinating member.
   */
  async listObjectives(query: ListObjectivesQuery = {}): Promise<Objective[]> {
    const params = new URLSearchParams();
    if (query.assignee) params.set('assignee', query.assignee);
    if (query.related) params.set('related', query.related);
    if (query.status) params.set('status', query.status);
    const qs = params.toString();
    const path = qs ? `${PATHS.objectives}?${qs}` : PATHS.objectives;
    const resp = await this.request(path, { method: 'GET' });
    return ListObjectivesResponseSchema.parse(await this.json(resp)).objectives;
  }

  /** Fetch a single objective plus its full event history. */
  async getObjective(id: string): Promise<GetObjectiveResponse> {
    const resp = await this.request(OBJECTIVE_PATHS.one(id), { method: 'GET' });
    return GetObjectiveResponseSchema.parse(await this.json(resp));
  }

  /**
   * Create (and atomically assign) an objective. Requires the caller
   * to hold the `objectives.create` permission.
   */
  async createObjective(payload: CreateObjectiveRequest): Promise<Objective> {
    const resp = await this.request(PATHS.objectives, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return ObjectiveSchema.parse(await this.json(resp));
  }

  /**
   * Update an objective's status (active ↔ blocked), post a note to
   * its thread, or both. Cannot transition to `done` — use
   * `completeObjective` for that.
   */
  async updateObjective(id: string, payload: UpdateObjectiveRequest): Promise<Objective> {
    const resp = await this.request(OBJECTIVE_PATHS.one(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return ObjectiveSchema.parse(await this.json(resp));
  }

  /**
   * Mark an objective done with a required result summary. Only the
   * objective's current assignee can call this.
   */
  async completeObjective(id: string, result: string): Promise<Objective> {
    const resp = await this.request(OBJECTIVE_PATHS.complete(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result }),
    });
    return ObjectiveSchema.parse(await this.json(resp));
  }

  /**
   * Terminally cancel an objective. Originator, or any member with
   * `objectives.cancel`.
   */
  async cancelObjective(id: string, payload: CancelObjectiveRequest = {}): Promise<Objective> {
    const resp = await this.request(OBJECTIVE_PATHS.cancel(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return ObjectiveSchema.parse(await this.json(resp));
  }

  // ─── Team team process ──────────────────────────────────────
  // The document reaches a member by injection on the instruction packet. These
  // are for what injection deliberately does not carry: the edit
  // history, and the write path.

  /**
   * The team process, or `null` when none has been set.
   * Readable by every member — what binds you is not privileged.
   *
   * `null` is a real state, not a missing resource: a team that has
   * never written one is a team with no team process, and the
   * runner renders that explicitly rather than showing nothing.
   */
  async getTeamProcess(): Promise<TeamProcess | null> {
    const resp = await this.request(PATHS.teamProcess);
    return GetTeamProcessResponseSchema.parse(await this.json(resp)).document;
  }

  /**
   * The edit history, oldest first. RETRIEVED, never resident — this
   * is what keeps the injected size a function of the document rather
   * than of how often it has changed.
   *
   * The diff the outcome asks for is derived from `previous.text` and
   * the current text. It is deliberately not stored: a cached diff is
   * a second copy that can drift from the text it describes.
   */
  async teamProcessHistory(): Promise<TeamProcessEdit[]> {
    const resp = await this.request(TEAM_PROCESS_PATHS.history);
    return TeamProcessHistoryResponseSchema.parse(await this.json(resp)).edits;
  }

  /**
   * Create or edit the team process. Requires `team_process.manage`.
   *
   * One method for both, because there is one endpoint for both: the
   * first authorised write produces version 1 with a real author and
   * reason, and every later write records the prior text. A separate
   * creation path would need its own validation and would not be
   * exercised by the edit tests.
   */
  async writeTeamProcess(
    payload: EditTeamProcessRequest,
  ): Promise<{ document: TeamProcess; edit: TeamProcessEdit }> {
    const validated = EditTeamProcessRequestSchema.parse(payload);
    const resp = await this.request(PATHS.teamProcess, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    const body = (await this.json(resp)) as { document: unknown; edit: unknown };
    return {
      document: TeamProcessSchema.parse(body.document),
      edit: TeamProcessEditSchema.parse(body.edit),
    };
  }

  /**
   * Post a discussion message into an objective's thread. Fans out to
   * every member of the thread (originator + assignee + explicit
   * watchers) via their live streams, scoped to thread key `obj:<id>`.
   * Caller must already be a thread member server-side.
   */
  async discussObjective(id: string, payload: DiscussObjectiveRequest): Promise<Message> {
    const resp = await this.request(OBJECTIVE_PATHS.discuss(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return MessageSchema.parse(await this.json(resp));
  }

  /**
   * Append activity events for `name`. Only the member itself may
   * POST its own activity (server returns 403 for any other caller).
   * Used by the runner's streaming uploader to ship decoded HTTP
   * exchanges + objective lifecycle markers to the broker in real time.
   */
  async uploadActivity(
    name: string,
    payload: UploadActivityRequest,
  ): Promise<UploadActivityResponse> {
    const resp = await this.request(MEMBER_PATHS.activity(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return UploadActivityResponseSchema.parse(await this.json(resp));
  }

  /**
   * Upload codex gen_ai inferences (the full-context layer). Each entry
   * carries the VERBATIM request + response payload bytes (base64) from a
   * rollout-trace bundle; the broker content-addresses them and maps a
   * parsed copy into a `GenAiInference`. Self-only (403 for any other
   * caller). Returns how many entries the broker accepted.
   */
  async uploadGenaiInference(
    name: string,
    payload: { inferences: CodexGenaiInferenceUpload[] },
  ): Promise<{ accepted: number }> {
    const resp = await this.request(MEMBER_PATHS.genai(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await this.json(resp)) as { accepted?: unknown };
    return { accepted: typeof body.accepted === 'number' ? body.accepted : 0 };
  }

  /**
   * List activity events for `name`. Readable by the member itself OR
   * by any member with `activity.read` (other callers get 403).
   * Supports range filtering by `from`/`to` timestamps and by kind.
   * Returns newest-first up to `limit` rows.
   *
   * Objective traces are a view over this endpoint: query with
   * `from=objective.openedAt`, `to=objective.closedAt`, and
   * `kind=llm_exchange` to pull the LLM calls made during an
   * objective's lifetime.
   */
  async listActivity(name: string, query: ListActivityQuery = {}): Promise<ActivityRow[]> {
    const params = new URLSearchParams();
    if (query.from !== undefined) params.set('from', String(query.from));
    if (query.to !== undefined) params.set('to', String(query.to));
    if (query.cursor !== undefined) {
      params.set('cursor_ts', String(query.cursor.ts));
      params.set('cursor_id', String(query.cursor.id));
    }
    if (query.kind !== undefined) {
      const kinds = Array.isArray(query.kind) ? query.kind : [query.kind];
      for (const k of kinds) params.append('kind', k);
    }
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const qs = params.toString();
    const path = qs ? `${MEMBER_PATHS.activity(name)}?${qs}` : MEMBER_PATHS.activity(name);
    const resp = await this.request(path, { method: 'GET' });
    return ListActivityResponseSchema.parse(await this.json(resp)).activity;
  }

  /**
   * List stored GenAI inference records for `name` — the
   * full-fidelity request layer (system instructions + complete
   * input context). Same visibility rule as the activity stream:
   * self OR `activity.read`. Oldest-first within the `from`/`to`
   * bounds (which apply to capture time `ts`).
   *
   * Coverage is best-effort (rows exist only where the agent's
   * instrumentation exported request/response bodies) — join these
   * onto `llm_exchange` activity rows by `responseId`, falling back
   * to timestamp/model proximity, rather than treating them as the
   * call ledger.
   */
  async listGenaiInferences(
    name: string,
    query: ListGenaiQuery = {},
  ): Promise<GenAiInferenceRecord[]> {
    const params = new URLSearchParams();
    if (query.from !== undefined) params.set('from', String(query.from));
    if (query.to !== undefined) params.set('to', String(query.to));
    if (query.cursor !== undefined) {
      params.set('cursor_ts', String(query.cursor.ts));
      params.set('cursor_id', String(query.cursor.id));
    }
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const qs = params.toString();
    const path = qs ? `${MEMBER_PATHS.genai(name)}?${qs}` : MEMBER_PATHS.genai(name);
    const resp = await this.request(path, { method: 'GET' });
    // GenAiPartSchema is deliberately more permissive than the TS
    // union (unknown block shapes survive as generic parts), so the
    // inferred parse type is wider than GenAiPart — narrow explicitly.
    const parsed = ListGenaiResponseSchema.parse(await this.json(resp));
    return parsed.inferences as unknown as GenAiInferenceRecord[];
  }

  /**
   * List GenAI inference SUMMARIES for `name` — the same ledger as
   * `listGenaiInferences` but without the heavy content fields
   * (system instructions, input/output messages), cheap enough to
   * hydrate for a whole feed window. The turn-spine timeline joins
   * these onto `llm_exchange` markers (exact `responseId`, else
   * interval overlap) and lazy-loads full bodies per call via
   * `getGenaiInference`.
   */
  async listGenaiSummaries(
    name: string,
    query: ListGenaiQuery = {},
  ): Promise<GenAiInferenceSummary[]> {
    const params = new URLSearchParams();
    params.set('view', 'summary');
    if (query.from !== undefined) params.set('from', String(query.from));
    if (query.to !== undefined) params.set('to', String(query.to));
    if (query.cursor !== undefined) {
      params.set('cursor_ts', String(query.cursor.ts));
      params.set('cursor_id', String(query.cursor.id));
    }
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const path = `${MEMBER_PATHS.genai(name)}?${params.toString()}`;
    const resp = await this.request(path, { method: 'GET' });
    return ListGenaiSummariesResponseSchema.parse(await this.json(resp)).inferences;
  }

  /**
   * Fetch ONE full inference record by its server-assigned id — the
   * heavy-body counterpart of a summary row. 404 when the id doesn't
   * exist or belongs to a different member than `name`.
   */
  async getGenaiInference(name: string, id: number): Promise<GenAiInferenceRecord> {
    const resp = await this.request(`${MEMBER_PATHS.genai(name)}/${id}`, { method: 'GET' });
    const parsed = GetGenaiInferenceResponseSchema.parse(await this.json(resp));
    // Same permissive-schema narrowing as `listGenaiInferences`.
    return parsed.inference as unknown as GenAiInferenceRecord;
  }

  /**
   * Read this member's operational telemetry — the cost, token and
   * lifecycle records their agent exported over OTLP. Oldest-first
   * within the window; page with `cursor`.
   *
   * Separate from `listGenaiInferences` because the two answer
   * different questions: this is the accounting, that is the content.
   */
  async listTelemetry(name: string, query: ListTelemetryQuery = {}): Promise<TelemetryRecordRow[]> {
    const params = new URLSearchParams();
    if (query.signal !== undefined) params.set('signal', query.signal);
    if (query.event !== undefined) params.set('event', query.event);
    if (query.from !== undefined) params.set('from', String(query.from));
    if (query.to !== undefined) params.set('to', String(query.to));
    if (query.cursor !== undefined) {
      params.set('cursor_ts', String(query.cursor.ts));
      params.set('cursor_id', String(query.cursor.id));
    }
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const qs = params.toString();
    const path = qs === '' ? MEMBER_PATHS.telemetry(name) : `${MEMBER_PATHS.telemetry(name)}?${qs}`;
    const resp = await this.request(path, { method: 'GET' });
    return ListTelemetryResponseSchema.parse(await this.json(resp)).telemetry;
  }

  /**
   * Fetch the verbatim bytes behind one inference — the source the
   * parsed record was mapped from, byte-exact with respect to what was
   * stored after redaction.
   *
   * Addressed through the inference rather than by content hash: the
   * blob store is deduped and global, so a hash-addressed read would
   * cross member boundaries. 404 when the inference is absent or that
   * side was never captured; 410 when the record outlived its bytes
   * (retention collects a blob once nothing references it).
   */
  async getGenaiRawBody(
    name: string,
    id: number,
    kind: 'request' | 'response' = 'request',
  ): Promise<Uint8Array> {
    const resp = await this.request(`${MEMBER_PATHS.genai(name)}/${id}/raw?kind=${kind}`, {
      method: 'GET',
    });
    return new Uint8Array(await resp.arrayBuffer());
  }

  // ─────────────────────── Members ──────────────────────────────

  /**
   * List all members on the team — name, role, permissions,
   * instructions. Requires `members.manage`; callers without it
   * should use `roster()` for the public subset.
   */
  async listMembers(): Promise<Member[]> {
    const resp = await this.request(PATHS.members, { method: 'GET' });
    return ListMembersResponseSchema.parse(await this.json(resp)).members;
  }

  /**
   * Read the current team config (name and context).
   * Authenticated; available to every member.
   */
  async getTeam(): Promise<Team> {
    const resp = await this.request(PATHS.team, { method: 'GET' });
    const body = (await this.json(resp)) as { team: unknown };
    return TeamSchema.parse(body.team);
  }

  /**
   * Update one or more team-level fields (name, context).
   * Requires `team.manage`.
   */
  async updateTeam(patch: Partial<Pick<Team, 'name' | 'context'>>): Promise<Team> {
    const resp = await this.request(PATHS.team, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const body = (await this.json(resp)) as { team: unknown };
    return TeamSchema.parse(body.team);
  }

  /**
   * Create a new member. Requires `members.manage`. Prefer
   * `credentialMode: 'pending'`: no credential is minted or returned;
   * the member enrolls through the device-code flow. Omitting the mode
   * preserves the 0.8 bootstrap-token response during migration.
   */
  async createMember(payload: CreateMemberRequest): Promise<CreateMemberResponse> {
    const resp = await this.request(PATHS.members, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return CreateMemberResponseSchema.parse(await this.json(resp));
  }

  /**
   * Update an existing member's role, instructions, or permissions.
   * Requires `members.manage`. Enforces the "at least one member with
   * `members.manage` must remain" invariant on permission changes.
   */
  async updateMember(name: string, payload: UpdateMemberRequest): Promise<Member> {
    const resp = await this.request(MEMBER_PATHS.one(name), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return MemberSchema.parse(await this.json(resp));
  }

  /** Delete a member. Requires `members.manage`. Preserves at least one holder. */
  async deleteMember(name: string): Promise<void> {
    const resp = await this.request(MEMBER_PATHS.one(name), { method: 'DELETE' });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new ClientError(
        `deleteMember failed: ${resp.status} ${resp.statusText}`,
        resp.status,
        body,
      );
    }
  }

  /**
   * Rotate a member's bearer token. Requires `members.manage` OR self.
   * Explicit scope can replace one device credential or every credential.
   * An omitted request retains the legacy revoke-all contract temporarily.
   */
  async rotateToken(name: string, request?: RotateTokenRequest): Promise<RotateTokenResponse> {
    const resp = await this.request(MEMBER_PATHS.rotateToken(name), {
      method: 'POST',
      ...(request
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
          }
        : {}),
    });
    return RotateTokenResponseSchema.parse(await this.json(resp));
  }

  /**
   * (Re-)enroll a member in TOTP. Requires `members.manage` OR self.
   * Any member may enroll — TOTP is no longer gated by type. Returns
   * a fresh secret + otpauth URI; any prior enrollment is replaced.
   */
  async enrollTotp(name: string): Promise<EnrollTotpResponse> {
    const resp = await this.request(MEMBER_PATHS.enrollTotp(name), { method: 'POST' });
    return EnrollTotpResponseSchema.parse(await this.json(resp));
  }

  /**
   * Ask `name`'s runner to compact or clear its agent context.
   * Requires `members.context` when `name` is someone else; always
   * permitted on yourself.
   *
   * RESOLVES ON PUSH, NOT ON EFFECT. The returned `delivered` says
   * whether a live runner was subscribed to receive it — nothing more.
   * Whether the agent actually compacted arrives afterwards on the
   * target's activity stream as a `context_control` row carrying the
   * same `requestId`. Callers that need the outcome must read for it;
   * a caller that treats this response as success has asserted
   * something the broker did not observe.
   */
  async controlContext(
    name: string,
    payload: ContextControlRequest,
  ): Promise<ContextControlResponse> {
    const resp = await this.request(MEMBER_PATHS.context(name), {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return ContextControlResponseSchema.parse(await this.json(resp));
  }

  // ─────────────────────── Tokens (multi-token) ──────────────────

  /**
   * List `name`'s active bearer tokens. Returns metadata only — never
   * plaintext. Requires `members.manage` (admin) or matches the
   * authenticated member (self).
   *
   * Useful for: spotting tokens you don't recognize (potential leak),
   * inventorying which devices a member has bound, deciding which
   * token to revoke without nuking the rest.
   */
  async listTokens(name: string): Promise<TokenInfo[]> {
    const resp = await this.request(MEMBER_PATHS.tokens(name), { method: 'GET' });
    return ListTokensResponseSchema.parse(await this.json(resp)).tokens;
  }

  /**
   * Revoke a specific token row by id. Requires `members.manage` or
   * self. Revoking the token currently authenticating the request is
   * permitted — the caller is signing off this device.
   *
   * Token rows are deleted, not soft-flagged, so a future request
   * with the same plaintext gets a clean 401.
   */
  async revokeToken(name: string, tokenId: string): Promise<void> {
    const resp = await this.request(MEMBER_PATHS.token(name, tokenId), { method: 'DELETE' });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new ClientError(
        `revokeToken failed: ${resp.status} ${resp.statusText}`,
        resp.status,
        body,
      );
    }
  }

  // ─────────────────── Device-code enrollment ───────────────────

  /**
   * Begin a device-code enrollment from this device. Anonymous —
   * intentionally requires no auth so a fresh VM with no token can
   * still kick off the flow. The server mints `(deviceCode,
   * userCode)`, persists a pending row, and returns both plus a
   * verification URI for the operator to visit.
   *
   * The device caller MUST keep `deviceCode` secret; only present
   * `userCode` to humans. The CLI saves `deviceCode` in memory and
   * polls `pollDeviceToken` until the row resolves.
   */
  async beginDeviceAuthorization(
    payload: DeviceAuthorizationRequest = {},
  ): Promise<DeviceAuthorizationResponse> {
    const validated = DeviceAuthorizationRequestSchema.parse(payload);
    const resp = await this.request(PATHS.enroll, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
      skipAuth: true,
    });
    return DeviceAuthorizationResponseSchema.parse(await this.json(resp));
  }

  /**
   * Poll for completion of a device-code enrollment. RFC 8628 §3.5
   * shape: success returns 200 + `{token, tokenId, member}`; the four
   * canonical pending/error states return 400 + `{error: <code>}`.
   *
   * Returns a discriminated union so the caller can `switch` on
   * `status` without parsing HTTP status codes themselves.
   *
   * Polling cadence: respect the `interval` returned by
   * `beginDeviceAuthorization`; on `slow_down` increment by 5 seconds.
   */
  async pollDeviceToken(
    deviceCode: string,
  ): Promise<
    | { status: 'approved'; data: DeviceTokenResponse }
    | { status: DeviceTokenErrorCode; description?: string }
  > {
    const resp = await this.request(PATHS.enrollPoll, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode }),
      skipAuth: true,
    });
    const text = await resp.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ClientError(`invalid JSON from poll`, resp.status, text);
    }
    if (resp.ok) {
      const data = DeviceTokenResponseSchema.parse(parsed);
      return { status: 'approved', data };
    }
    if (resp.status === 400) {
      const err = DeviceTokenErrorResponseSchema.safeParse(parsed);
      if (err.success) {
        const out: { status: DeviceTokenErrorCode; description?: string } = {
          status: err.data.error,
        };
        if (err.data.errorDescription !== undefined) {
          out.description = err.data.errorDescription;
        }
        return out;
      }
    }
    throw new ClientError(`poll failed: ${resp.status} ${resp.statusText}`, resp.status, text);
  }

  /** List currently-pending enrollment requests (`members.manage`). */
  async listPendingEnrollments(): Promise<PendingEnrollment[]> {
    const resp = await this.request(PATHS.enrollPending, { method: 'GET' });
    return ListPendingEnrollmentsResponseSchema.parse(await this.json(resp)).enrollments;
  }

  /** Approve a pending enrollment by user code (`members.manage`). */
  async approveEnrollment(payload: ApproveEnrollmentRequest): Promise<ApproveEnrollmentResponse> {
    const validated = ApproveEnrollmentRequestSchema.parse(payload);
    const resp = await this.request(PATHS.enrollApprove, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return ApproveEnrollmentResponseSchema.parse(await this.json(resp));
  }

  /** Reject a pending enrollment by user code (`members.manage`). */
  async rejectEnrollment(payload: RejectEnrollmentRequest): Promise<void> {
    const validated = RejectEnrollmentRequestSchema.parse(payload);
    const resp = await this.request(PATHS.enrollReject, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new ClientError(
        `rejectEnrollment failed: ${resp.status} ${resp.statusText}`,
        resp.status,
        body,
      );
    }
  }

  async history(query: HistoryQuery = {}): Promise<Message[]> {
    const params = new URLSearchParams();
    if (query.with) params.set('with', query.with);
    if (query.channel) params.set('channel', query.channel);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.before !== undefined) params.set('before', String(query.before));
    const qs = params.toString();
    const path = qs ? `${PATHS.history}?${qs}` : PATHS.history;
    const resp = await this.request(path, { method: 'GET' });
    const parsed = HistoryResponseSchema.parse(await this.json(resp));
    return parsed.messages;
  }

  // ─────────────────────────── Channels ─────────────────────────

  /**
   * List the channels visible to the caller. Always includes the
   * synthetic `general` channel (where membership is implicit).
   * Other channels appear regardless of join status; the per-row
   * `joined` flag drives whether the UI shows "Open" or "Join".
   */
  async listChannels(): Promise<ChannelSummary[]> {
    const resp = await this.request(PATHS.channels, { method: 'GET' });
    return ListChannelsResponseSchema.parse(await this.json(resp)).channels;
  }

  /** Fetch one channel + its full member list (general → empty list). */
  async getChannel(slug: string): Promise<GetChannelResponse> {
    const resp = await this.request(CHANNEL_PATHS.one(slug), { method: 'GET' });
    return GetChannelResponseSchema.parse(await this.json(resp));
  }

  /** Create a new channel. The caller joins as an ordinary member. */
  async createChannel(input: CreateChannelRequest): Promise<Channel> {
    const validated = CreateChannelRequestSchema.parse(input);
    const resp = await this.request(PATHS.channels, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return ChannelSchema.parse(await this.json(resp));
  }

  /** Update a channel (`channels.manage`). The id is unchanged. */
  async renameChannel(slug: string, input: RenameChannelRequest): Promise<Channel> {
    const validated = RenameChannelRequestSchema.parse(input);
    const resp = await this.request(CHANNEL_PATHS.one(slug), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return ChannelSchema.parse(await this.json(resp));
  }

  /** Change a channel slug and/or description (`channels.manage`). */
  async updateChannel(slug: string, input: UpdateChannelRequest): Promise<Channel> {
    const validated = UpdateChannelRequestSchema.parse(input);
    const resp = await this.request(CHANNEL_PATHS.one(slug), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return ChannelSchema.parse(await this.json(resp));
  }

  /** Soft-archive a channel (admin-only). */
  async archiveChannel(slug: string): Promise<Channel> {
    const resp = await this.request(CHANNEL_PATHS.one(slug), { method: 'DELETE' });
    return ChannelSchema.parse(await this.json(resp));
  }

  /** Read the immutable channel administration audit (`channels.manage`). */
  async getChannelAudit(slug: string) {
    const resp = await this.request(CHANNEL_PATHS.audit(slug), { method: 'GET' });
    return ChannelAuditResponseSchema.parse(await this.json(resp)).entries;
  }

  /**
   * Add a member to a channel. Self-join when `member` matches the
   * caller; admin-add otherwise. Returns the refreshed channel
   * detail so callers can re-render the member list.
   */
  async addChannelMember(
    slug: string,
    input: AddChannelMemberRequest,
  ): Promise<GetChannelResponse> {
    const validated = AddChannelMemberRequestSchema.parse(input);
    const resp = await this.request(CHANNEL_PATHS.members(slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return GetChannelResponseSchema.parse(await this.json(resp));
  }

  /**
   * Self-join helper — convenience over `addChannelMember` for the
   * common "I want to join this channel" flow. The caller's name is
   * inferred server-side from the auth context, so the body is empty
   * and the server uses the authenticated member.
   */
  async joinChannel(slug: string): Promise<GetChannelResponse> {
    const resp = await this.request(CHANNEL_PATHS.members(slug), { method: 'POST' });
    return GetChannelResponseSchema.parse(await this.json(resp));
  }

  /**
   * Remove a member from a channel. When `name` is the caller, this
   * is a self-leave; otherwise admin-remove. The last admin can't
   * leave a channel that still has members.
   */
  async removeChannelMember(slug: string, name: string): Promise<GetChannelResponse> {
    const resp = await this.request(CHANNEL_PATHS.member(slug, name), { method: 'DELETE' });
    return GetChannelResponseSchema.parse(await this.json(resp));
  }

  // ─────────────────────────── Tool sources ─────────────────────

  /** List registered tool sources (credentials always redacted). */
  async listToolSources(): Promise<ToolSourceSummary[]> {
    const resp = await this.request(PATHS.toolSources, { method: 'GET' });
    return ListToolSourcesResponseSchema.parse(await this.json(resp)).sources;
  }

  /** Fetch one tool source with its tool definitions. */
  async getToolSource(slug: string): Promise<GetToolSourceResponse> {
    const resp = await this.request(TOOL_SOURCE_PATHS.one(slug), { method: 'GET' });
    return GetToolSourceResponseSchema.parse(await this.json(resp));
  }

  /** Register a new tool source (requires `tools.manage`). */
  async createToolSource(input: CreateToolSourceRequest): Promise<ToolSource> {
    const validated = CreateToolSourceRequestSchema.parse(input);
    const resp = await this.request(PATHS.toolSources, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return ToolSourceSchema.parse(await this.json(resp));
  }

  /** Update displayName/config/enabled/allMembers (requires `tools.manage`). */
  async updateToolSource(slug: string, input: UpdateToolSourceRequest): Promise<ToolSource> {
    const validated = UpdateToolSourceRequestSchema.parse(input);
    const resp = await this.request(TOOL_SOURCE_PATHS.one(slug), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return ToolSourceSchema.parse(await this.json(resp));
  }

  /** Delete a tool source and everything under it (requires `tools.manage`). */
  async deleteToolSource(slug: string): Promise<void> {
    const resp = await this.request(TOOL_SOURCE_PATHS.one(slug), { method: 'DELETE' });
    await this.json(resp);
  }

  /**
   * Set the source's static credential. Write-only: the secret is
   * KEK-encrypted at rest and never returned by any endpoint.
   */
  async setToolCredential(slug: string, input: SetToolCredentialRequest): Promise<void> {
    const validated = SetToolCredentialRequestSchema.parse(input);
    const resp = await this.request(TOOL_SOURCE_PATHS.credential(slug), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    await this.json(resp);
  }

  /** Remove the source's credential (requires `tools.manage`). */
  async deleteToolCredential(slug: string): Promise<void> {
    const resp = await this.request(TOOL_SOURCE_PATHS.credential(slug), { method: 'DELETE' });
    await this.json(resp);
  }

  /** Bind a member to a source (requires `tools.manage`). */
  async bindToolSource(slug: string, input: BindToolSourceRequest): Promise<void> {
    const validated = BindToolSourceRequestSchema.parse(input);
    const resp = await this.request(TOOL_SOURCE_PATHS.bindings(slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    await this.json(resp);
  }

  /** Unbind a member from a source (requires `tools.manage`). */
  async unbindToolSource(slug: string, member: string): Promise<void> {
    const resp = await this.request(TOOL_SOURCE_PATHS.binding(slug, member), {
      method: 'DELETE',
    });
    await this.json(resp);
  }

  /** Set/replace a custom tool definition (kind=custom, `tools.manage`). */
  async setCustomTool(slug: string, name: string, input: SetCustomToolRequest): Promise<void> {
    const validated = SetCustomToolRequestSchema.parse(input);
    const resp = await this.request(TOOL_SOURCE_PATHS.tool(slug, name), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    await this.json(resp);
  }

  /** Delete a custom tool definition (kind=custom, `tools.manage`). */
  async deleteCustomTool(slug: string, name: string): Promise<void> {
    const resp = await this.request(TOOL_SOURCE_PATHS.tool(slug, name), { method: 'DELETE' });
    await this.json(resp);
  }

  /**
   * Re-discover upstream tools for an MCP source (`tools.manage`).
   * Synchronous — 502s if the upstream is unreachable.
   */
  async refreshToolSource(slug: string): Promise<RefreshToolSourceResponse> {
    const resp = await this.request(TOOL_SOURCE_PATHS.refresh(slug), { method: 'POST' });
    return RefreshToolSourceResponseSchema.parse(await this.json(resp));
  }

  /**
   * Invoke a tool on a source the caller is bound to. Returns an
   * MCP-shaped CallToolResult — tool-level failures come back as
   * `isError: true` results, not thrown errors; authz/registry
   * problems throw `ClientError` (403/404/409).
   */
  async invokeTool(
    source: string,
    name: string,
    args?: Record<string, unknown>,
  ): Promise<InvokeToolResponse> {
    const validated = InvokeToolRequestSchema.parse({ args });
    const resp = await this.request(TOOL_SOURCE_PATHS.invoke(source, name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return InvokeToolResponseSchema.parse(await this.json(resp));
  }

  // ─────────────────────────── Secrets ─────────────────────

  /** List secrets (values never returned — summaries carry `hasValue` only). */
  async listSecrets(): Promise<SecretSummary[]> {
    const resp = await this.request(PATHS.secrets, { method: 'GET' });
    return ListSecretsResponseSchema.parse(await this.json(resp)).secrets;
  }

  /** Fetch one secret's metadata (never the value). */
  async getSecret(slug: string): Promise<GetSecretResponse> {
    const resp = await this.request(SECRET_PATHS.one(slug), { method: 'GET' });
    return GetSecretResponseSchema.parse(await this.json(resp));
  }

  /** Register a new secret (requires `secrets.manage`). The value is set separately. */
  async createSecret(input: CreateSecretRequest): Promise<Secret> {
    const validated = CreateSecretRequestSchema.parse(input);
    const resp = await this.request(PATHS.secrets, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return SecretSchema.parse(await this.json(resp));
  }

  /** Update envName/description/enabled/allMembers (requires `secrets.manage`). */
  async updateSecret(slug: string, input: UpdateSecretRequest): Promise<Secret> {
    const validated = UpdateSecretRequestSchema.parse(input);
    const resp = await this.request(SECRET_PATHS.one(slug), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return SecretSchema.parse(await this.json(resp));
  }

  /** Delete a secret and its bindings (requires `secrets.manage`). */
  async deleteSecret(slug: string): Promise<void> {
    const resp = await this.request(SECRET_PATHS.one(slug), { method: 'DELETE' });
    await this.json(resp);
  }

  /**
   * Set the secret's value. Write-only: KEK-encrypted at rest and
   * never returned by any endpoint. Note that a value set from an
   * agent session necessarily passes through that session's
   * transcript — prefer the web UI for human-held credentials.
   */
  async setSecretValue(slug: string, input: SetSecretValueRequest): Promise<void> {
    const validated = SetSecretValueRequestSchema.parse(input);
    const resp = await this.request(SECRET_PATHS.value(slug), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    await this.json(resp);
  }

  /** Remove the secret's value (requires `secrets.manage`). */
  async deleteSecretValue(slug: string): Promise<void> {
    const resp = await this.request(SECRET_PATHS.value(slug), { method: 'DELETE' });
    await this.json(resp);
  }

  /** Bind a member to a secret (requires `secrets.manage`). */
  async bindSecret(slug: string, input: BindSecretRequest): Promise<void> {
    const validated = BindSecretRequestSchema.parse(input);
    const resp = await this.request(SECRET_PATHS.bindings(slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    await this.json(resp);
  }

  /** Unbind a member from a secret (requires `secrets.manage`). */
  async unbindSecret(slug: string, member: string): Promise<void> {
    const resp = await this.request(SECRET_PATHS.binding(slug, member), { method: 'DELETE' });
    await this.json(resp);
  }

  /**
   * Resolve the decrypted env delta for the calling member — every
   * enabled secret bound to them (directly or via allMembers), keyed
   * by envName. Called by the runner immediately before spawning the
   * agent; this is the only read path for secret values.
   */
  async resolveSecrets(): Promise<ResolveSecretsResponse> {
    const resp = await this.request(PATHS.secretsResolve, { method: 'GET' });
    return ResolveSecretsResponseSchema.parse(await this.json(resp));
  }

  // ────────────────────────── Variables ────────────────────
  //
  // Runner environment variables that are NOT secrets. Same shape as
  // the secrets methods above; the difference is that these return the
  // VALUE to a `secrets.manage` holder, and the values are never
  // registered with the trace redactor.

  /**
   * List variables. Summaries carry the value itself for a caller
   * holding `secrets.manage` — the capability that distinguishes a
   * variable from a secret.
   */
  async listVariables(): Promise<VariableSummary[]> {
    const resp = await this.request(PATHS.variables, { method: 'GET' });
    return ListVariablesResponseSchema.parse(await this.json(resp)).variables;
  }

  /** Fetch one variable, with its value for a `secrets.manage` holder. */
  async getVariable(slug: string): Promise<GetVariableResponse> {
    const resp = await this.request(VARIABLE_PATHS.one(slug), { method: 'GET' });
    return GetVariableResponseSchema.parse(await this.json(resp));
  }

  /** Register a new variable (requires `secrets.manage`). Value set separately. */
  async createVariable(input: CreateVariableRequest): Promise<VariableSummary> {
    const validated = CreateVariableRequestSchema.parse(input);
    const resp = await this.request(PATHS.variables, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return GetVariableResponseSchema.parse(await this.json(resp)).variable;
  }

  /** Update envName/description/enabled/allMembers (requires `secrets.manage`). */
  async updateVariable(slug: string, input: UpdateVariableRequest): Promise<VariableSummary> {
    const validated = UpdateVariableRequestSchema.parse(input);
    const resp = await this.request(VARIABLE_PATHS.one(slug), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return GetVariableResponseSchema.parse(await this.json(resp)).variable;
  }

  /** Delete a variable and its bindings (requires `secrets.manage`). */
  async deleteVariable(slug: string): Promise<void> {
    const resp = await this.request(VARIABLE_PATHS.one(slug), { method: 'DELETE' });
    await this.json(resp);
  }

  /**
   * Set the variable's value. Readable afterwards, unlike a secret —
   * an operator who cannot read back a git author name cannot check it
   * is the right one.
   */
  async setVariableValue(slug: string, input: SetVariableValueRequest): Promise<void> {
    const validated = SetVariableValueRequestSchema.parse(input);
    const resp = await this.request(VARIABLE_PATHS.value(slug), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    await this.json(resp);
  }

  /** Remove the variable's value (requires `secrets.manage`). */
  async deleteVariableValue(slug: string): Promise<void> {
    const resp = await this.request(VARIABLE_PATHS.value(slug), { method: 'DELETE' });
    await this.json(resp);
  }

  /** Bind a member to a variable (requires `secrets.manage`). */
  async bindVariable(slug: string, input: BindVariableRequest): Promise<void> {
    const validated = BindVariableRequestSchema.parse(input);
    const resp = await this.request(VARIABLE_PATHS.bindings(slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    await this.json(resp);
  }

  /** Unbind a member from a variable (requires `secrets.manage`). */
  async unbindVariable(slug: string, member: string): Promise<void> {
    const resp = await this.request(VARIABLE_PATHS.binding(slug, member), { method: 'DELETE' });
    await this.json(resp);
  }

  // ────────────────── External Notifications ───────────────

  /**
   * List notification endpoints. `notifications.manage` holders see
   * every endpoint; other members see only endpoints that target them.
   */
  async listNotificationEndpoints(): Promise<NotificationEndpointSummary[]> {
    const resp = await this.request(PATHS.notificationEndpoints, { method: 'GET' });
    return ListNotificationEndpointsResponseSchema.parse(await this.json(resp)).endpoints;
  }

  async getNotificationEndpoint(slug: string): Promise<GetNotificationEndpointResponse> {
    const resp = await this.request(NOTIFICATION_PATHS.endpoint(slug), { method: 'GET' });
    return GetNotificationEndpointResponseSchema.parse(await this.json(resp));
  }

  /** Create an endpoint (requires `notifications.manage`). The signing secret is set separately. */
  async createNotificationEndpoint(
    input: CreateNotificationEndpointRequest,
  ): Promise<NotificationEndpoint> {
    const validated = CreateNotificationEndpointRequestSchema.parse(input);
    const resp = await this.request(PATHS.notificationEndpoints, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return NotificationEndpointSchema.parse(await this.json(resp));
  }

  async updateNotificationEndpoint(
    slug: string,
    input: UpdateNotificationEndpointRequest,
  ): Promise<NotificationEndpoint> {
    const validated = UpdateNotificationEndpointRequestSchema.parse(input);
    const resp = await this.request(NOTIFICATION_PATHS.endpoint(slug), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return NotificationEndpointSchema.parse(await this.json(resp));
  }

  /** Delete an endpoint and its delivery receipts (requires `notifications.manage`). */
  async deleteNotificationEndpoint(slug: string): Promise<void> {
    const resp = await this.request(NOTIFICATION_PATHS.endpoint(slug), { method: 'DELETE' });
    await this.json(resp);
  }

  /** Set the endpoint's inline signing secret. Write-only: KEK-encrypted, never returned. */
  async setNotificationEndpointSecret(
    slug: string,
    input: SetNotificationSecretRequest,
  ): Promise<void> {
    const validated = SetNotificationSecretRequestSchema.parse(input);
    const resp = await this.request(NOTIFICATION_PATHS.endpointSecret(slug), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    await this.json(resp);
  }

  async deleteNotificationEndpointSecret(slug: string): Promise<void> {
    const resp = await this.request(NOTIFICATION_PATHS.endpointSecret(slug), {
      method: 'DELETE',
    });
    await this.json(resp);
  }

  /** Delivery receipts for one endpoint, newest first (requires `notifications.manage`). */
  async listNotificationDeliveries(
    slug: string,
    query?: { limit?: number; before?: number },
  ): Promise<NotificationDelivery[]> {
    const params = new URLSearchParams();
    if (query?.limit !== undefined) params.set('limit', String(query.limit));
    if (query?.before !== undefined) params.set('before', String(query.before));
    const qs = params.size > 0 ? `?${params.toString()}` : '';
    const resp = await this.request(`${NOTIFICATION_PATHS.endpointDeliveries(slug)}${qs}`, {
      method: 'GET',
    });
    return ListNotificationDeliveriesResponseSchema.parse(await this.json(resp)).deliveries;
  }

  /**
   * Re-run a stored delivery through the pipeline (verification and
   * dedup are skipped; filters, template, and policy apply). Returns
   * the fresh delivery receipt.
   */
  async replayNotificationDelivery(deliveryId: string): Promise<NotificationDelivery> {
    const resp = await this.request(NOTIFICATION_PATHS.replay(deliveryId), { method: 'POST' });
    return ReplayNotificationDeliveryResponseSchema.parse(await this.json(resp)).delivery;
  }

  /** List shared auth profiles (requires `notifications.manage`). */
  async listNotificationProfiles(): Promise<NotificationProfileSummary[]> {
    const resp = await this.request(PATHS.notificationProfiles, { method: 'GET' });
    return ListNotificationProfilesResponseSchema.parse(await this.json(resp)).profiles;
  }

  async createNotificationProfile(
    input: CreateNotificationProfileRequest,
  ): Promise<NotificationProfile> {
    const validated = CreateNotificationProfileRequestSchema.parse(input);
    const resp = await this.request(PATHS.notificationProfiles, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return NotificationProfileSchema.parse(await this.json(resp));
  }

  async updateNotificationProfile(
    slug: string,
    input: UpdateNotificationProfileRequest,
  ): Promise<NotificationProfile> {
    const validated = UpdateNotificationProfileRequestSchema.parse(input);
    const resp = await this.request(NOTIFICATION_PATHS.profile(slug), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return NotificationProfileSchema.parse(await this.json(resp));
  }

  /** Delete a profile. 409 while any endpoint still references it. */
  async deleteNotificationProfile(slug: string): Promise<void> {
    const resp = await this.request(NOTIFICATION_PATHS.profile(slug), { method: 'DELETE' });
    await this.json(resp);
  }

  /** Set the profile's shared secret. Write-only: KEK-encrypted, never returned. */
  async setNotificationProfileSecret(
    slug: string,
    input: SetNotificationSecretRequest,
  ): Promise<void> {
    const validated = SetNotificationSecretRequestSchema.parse(input);
    const resp = await this.request(NOTIFICATION_PATHS.profileSecret(slug), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    await this.json(resp);
  }

  async deleteNotificationProfileSecret(slug: string): Promise<void> {
    const resp = await this.request(NOTIFICATION_PATHS.profileSecret(slug), { method: 'DELETE' });
    await this.json(resp);
  }

  async push(payload: PushPayload): Promise<PushResult> {
    const validated = PushPayloadSchema.parse(payload);
    const resp = await this.request(PATHS.push, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    return PushResultSchema.parse(await this.json(resp));
  }

  /**
   * Runner-driven presence: report this agent's live activity state
   * (idle / working / blocked). The server keys this on the
   * authenticated member and applies a TTL so a runner that crashes
   * mid-turn doesn't leave the member stuck "working"/"blocked" forever
   * — stale state resets to idle. Callers should re-post the current
   * non-idle state periodically as a heartbeat so the TTL stays fresh,
   * then post `state: 'idle'` when the turn ends. `busy` is optional and
   * derived server-side from `state` when omitted (= `state === 'working'`).
   */
  async setActivity(report: ActivityReport): Promise<void> {
    const validated = ActivityReportSchema.parse(report);
    await this.request(PATHS.presenceActivity, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
  }

  // ─────────────────────────── Filesystem ─────────────────────────

  /**
   * List the immediate children of `path`. Directories are returned
   * first, alphabetized within each group. Members with
   * `members.manage` see every home when listing `/`; everyone else
   * sees only their own home.
   */
  async fsList(path: string): Promise<FsEntry[]> {
    const qs = new URLSearchParams({ path });
    const resp = await this.request(`${PATHS.fsList}?${qs.toString()}`, { method: 'GET' });
    return FsListResponseSchema.parse(await this.json(resp)).entries;
  }

  /** Fetch metadata for a single path, or null if it does not exist. */
  async fsStat(path: string): Promise<FsEntry | null> {
    const qs = new URLSearchParams({ path });
    const resp = await this.request(`${PATHS.fsStat}?${qs.toString()}`, { method: 'GET' });
    if (resp.status === 404) return null;
    return FsEntryResponseSchema.parse(await this.json(resp)).entry;
  }

  /**
   * Download a file as a `Blob`. Callers wanting a streaming
   * `ReadableStream` should use `fsReadStream` instead.
   */
  async fsRead(path: string): Promise<Blob> {
    const resp = await this.request(FS_PATHS.read(path), { method: 'GET' });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ClientError(`fsRead failed: ${resp.status} ${resp.statusText}`, resp.status, text);
    }
    return resp.blob();
  }

  /**
   * Download a file as a `ReadableStream`. Use when the caller wants
   * to pipe the body directly into another consumer (file, fetch,
   * DOM `<img>` via `URL.createObjectURL`, etc.) without buffering.
   */
  async fsReadStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const resp = await this.request(FS_PATHS.read(path), { method: 'GET' });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ClientError(
        `fsReadStream failed: ${resp.status} ${resp.statusText}`,
        resp.status,
        text,
      );
    }
    if (!resp.body) {
      throw new ClientError('fsReadStream: empty response body', resp.status, '');
    }
    return resp.body;
  }

  /**
   * Upload a file. The sender must have write access to the target
   * path (owns the containing home, or holds `members.manage`).
   * Parent directories are auto-created.
   */
  async fsWrite(input: FsWriteInput): Promise<FsWriteResponse> {
    const qs = new URLSearchParams({
      path: input.path,
      mime: input.mimeType,
      collide: input.collision ?? 'error',
    });
    const init: RequestInit & { duplex?: 'half' } = {
      method: 'POST',
      body: input.source,
    };
    // Node's fetch requires `duplex: 'half'` for a streaming request body.
    // Browsers do not support that option, so add it only for a
    // ReadableStream source; the cast remains local to the transport seam.
    if (input.source instanceof ReadableStream) init.duplex = 'half';
    const resp = await this.request(`${PATHS.fsWrite}?${qs.toString()}`, init);
    return FsWriteResponseSchema.parse(await this.json(resp));
  }

  /** Create a directory. Pass `recursive: true` to auto-create missing parents. */
  async fsMkdir(path: string, recursive = false): Promise<FsEntry> {
    const resp = await this.request(PATHS.fsMkdir, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, recursive }),
    });
    return FsEntryResponseSchema.parse(await this.json(resp)).entry;
  }

  /** Remove a file or directory. Pass `recursive: true` to cascade-delete directories. */
  async fsRm(path: string, recursive = false): Promise<void> {
    const qs = new URLSearchParams({ path });
    if (recursive) qs.set('recursive', 'true');
    const resp = await this.request(`${PATHS.fsRm}?${qs.toString()}`, { method: 'DELETE' });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new ClientError(`fsRm failed: ${resp.status} ${resp.statusText}`, resp.status, body);
    }
  }

  /** Rename or move a file (directories currently unsupported server-side). */
  async fsMv(from: string, to: string): Promise<FsEntry> {
    const resp = await this.request(PATHS.fsMv, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    return FsEntryResponseSchema.parse(await this.json(resp)).entry;
  }

  /**
   * Enumerate files shared with the caller via message or objective
   * attachments. Unique by path — a file referenced from multiple
   * messages appears once. Owner's own files aren't in this list;
   * use `fsList` under the owner home for those.
   */
  async fsShared(): Promise<FsEntry[]> {
    const resp = await this.request(PATHS.fsShared, { method: 'GET' });
    return FsListResponseSchema.parse(await this.json(resp)).entries;
  }

  /**
   * `members.manage`-only flat enumeration of every file in every home, newest
   * first. The server gates on `members.manage` and 403s otherwise;
   * non-admins should keep using `fsList` per-home and `fsShared` for
   * cross-home grants. Returned entries always have `kind === 'file'`.
   */
  async fsAll(): Promise<FsEntry[]> {
    const resp = await this.request(PATHS.fsAll, { method: 'GET' });
    return FsListResponseSchema.parse(await this.json(resp)).entries;
  }

  /**
   * Open a long-lived WebSocket subscription for the caller's member
   * `name` and yield messages as they arrive. Aborts cleanly when
   * `signal` is triggered. The server rejects `name` that doesn't
   * match the authenticated identity with a pre-upgrade 403, so the
   * handshake throws `ClientError` in that case.
   */
  async *subscribe(
    name: string,
    signal?: AbortSignal,
    clientIdentity?: ClientIdentity | RunnerIdentity,
  ): AsyncIterable<Message> {
    yield* this.subscribeInternal(name, signal, clientIdentity);
  }

  /**
   * Open the runner-only disposition-v1 subscription. Iteration owns the
   * socket lifetime; `disposition()` is available after iteration starts.
   */
  subscribeReliable(
    name: string,
    signal: AbortSignal | undefined,
    runnerIdentity: RunnerIdentity,
    liveness = false,
  ): ReliableSubscription {
    const identity = RunnerIdentitySchema.parse({
      ...runnerIdentity,
      deliveryProtocol: 'disposition-v1',
      ...(liveness ? { livenessProtocol: 'runner-state-v1' as const } : {}),
    });
    let socket: NodeWebSocket | null = null;
    let socketOpen = false;
    const pendingFrames: string[] = [];
    let iterated = false;
    const iterable = this.subscribeInternal(name, signal, identity, (ws) => {
      socket = ws;
      ws.once('open', () => {
        socketOpen = true;
        for (const encoded of pendingFrames.splice(0)) ws.send(encoded);
      });
    });
    const sendFrame = (encoded: string): void => {
      if (socket !== null && socketOpen) socket.send(encoded);
      else pendingFrames.push(encoded);
    };
    return {
      [Symbol.asyncIterator]() {
        if (iterated) throw new Error('reliable subscription can only be iterated once');
        iterated = true;
        return iterable[Symbol.asyncIterator]();
      },
      disposition(frame) {
        sendFrame(JSON.stringify(MessageDispositionFrameSchema.parse(frame)));
      },
      control(frame) {
        sendFrame(JSON.stringify(RunnerControlFrameSchema.parse(frame)));
      },
    };
  }

  private async *subscribeInternal(
    name: string,
    signal?: AbortSignal,
    clientIdentity?: ClientIdentity | RunnerIdentity,
    onSocket?: (socket: NodeWebSocket) => void,
  ): AsyncIterable<Message> {
    const url = this.buildWsUrl(PATHS.subscribe, { name });
    const headers: Record<string, string> = {
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    };
    if (this.token) {
      headers[AUTH_HEADER] = `Bearer ${this.token}`;
    }
    const normalized =
      clientIdentity === undefined
        ? this.clientIdentity
        : 'kind' in clientIdentity
          ? ClientIdentitySchema.parse(clientIdentity)
          : { kind: 'runner' as const, runnerIdentity: RunnerIdentitySchema.parse(clientIdentity) };
    headers[CLIENT_IDENTITY_HEADER] = JSON.stringify(normalized);
    const ws = new this.WebSocketImpl(url, { headers });
    this.activeSubscriptions.add(ws);
    onSocket?.(ws);

    // Async-iterator plumbing: messages arrive out-of-band via
    // `on('message')`, so we buffer them in a queue that the
    // generator drains. State lives on a single object so TS's flow
    // analysis doesn't collapse the closure-written fields to `null`.
    // `resolver` wakes the consumer when the queue is empty and a new
    // frame (or close/error) arrives.
    const state: { done: boolean; error: Error | null; resolver: (() => void) | null } = {
      done: false,
      error: null,
      resolver: null,
    };
    const queue: Message[] = [];
    const wake = (): void => {
      const r = state.resolver;
      state.resolver = null;
      r?.();
    };

    ws.on('message', (data: unknown) => {
      try {
        const text =
          typeof data === 'string'
            ? data
            : Buffer.isBuffer(data)
              ? data.toString('utf8')
              : data instanceof ArrayBuffer
                ? new TextDecoder().decode(data)
                : String(data);
        queue.push(MessageSchema.parse(JSON.parse(text)));
      } catch (err) {
        state.error = err instanceof Error ? err : new Error(String(err));
        state.done = true;
      }
      wake();
    });
    ws.on('close', () => {
      state.done = true;
      wake();
    });
    ws.on('error', (err: Error) => {
      if (/\b401\b/.test(err.message)) this.onUnauthorized?.('websocket');
      state.error = err;
      state.done = true;
      wake();
    });

    const abortHandler = (): void => {
      try {
        ws.close(1000, 'client abort');
      } catch {
        /* already closed */
      }
    };
    signal?.addEventListener('abort', abortHandler);

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as Message;
          continue;
        }
        if (state.done) {
          if (state.error !== null) {
            throw new ClientError(`subscribe: ${state.error.message}`, 0, '');
          }
          return;
        }
        await new Promise<void>((r) => {
          state.resolver = r;
        });
      }
    } finally {
      this.activeSubscriptions.delete(ws);
      signal?.removeEventListener('abort', abortHandler);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Compose a `ws://` or `wss://` URL for a subscription endpoint.
   * Upgrades the scheme from the HTTP baseUrl and URL-encodes any
   * query params. Path is the same as the HTTP route — only the
   * transport changes.
   */
  private buildWsUrl(path: string, query: Record<string, string> = {}): string {
    const u = new URL(path.replace(/^\//, ''), this.baseUrl);
    if (u.protocol === 'http:') u.protocol = 'ws:';
    else if (u.protocol === 'https:') u.protocol = 'wss:';
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }
}

/**
 * One codex inference to upload to the gen_ai ingest. `requestBase64` /
 * `responseBase64` are the VERBATIM `payloads/*.json` bytes from a
 * rollout-trace bundle (the Responses `response.create` body and the
 * completed response). The rest is envelope the broker stamps onto the
 * raw-exchange rows + derived record.
 */
export interface CodexGenaiInferenceUpload {
  requestBase64: string;
  responseBase64: string;
  model?: string | null;
  responseId?: string | null;
  upstreamRequestId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  querySource?: string | null;
  agentName?: string | null;
  ts?: number | null;
}
