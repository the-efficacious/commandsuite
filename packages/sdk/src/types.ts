/**
 * Pure TypeScript types for the csuite wire protocol.
 *
 * Zero runtime dependencies. Consumers that only want types should import
 * from `csuite-sdk/types`.
 */

export type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';

/**
 * Live activity of a member — orthogonal to the connection dimension
 * (online/connecting/offline) that presence tracks over SSE. Where
 * connection answers "is the link alive", activity answers "what is the
 * agent doing right now on that link":
 *
 *   idle     — connected, not in a turn, available for work.
 *   working  — actively processing a turn: model generation AND/OR tool
 *              execution, for the WHOLE turn (not just tool windows).
 *   blocked  — stuck waiting on a human (needs input / an approval it
 *              cannot self-resolve). An operator should look.
 *
 * Derived runner-side with priority blocked > working > idle: a blocking
 * signal wins; else an active turn OR any in-flight tool means working;
 * else idle. The runner reports transitions; the broker holds the last
 * reported state per member and surfaces it on `/roster`.
 */
export type ActivityState = 'idle' | 'working' | 'blocked';

// ─────────────────────────── Permissions ──────────────────────────────

/**
 * The set of elevated actions gated by membership policy. Baseline
 * participation (DM, posting to the primary thread, taking an assigned
 * objective, discussing on your own objectives, managing your own
 * files) is NOT a permission — it's what it means to be on the team.
 * Only actions that touch other members or shape the team itself are
 * permissions.
 *
 * Dotted noun-first naming groups permissions by resource so they
 * sort and scan naturally as the vocabulary grows.
 */
export const PERMISSIONS = [
  'team.manage',
  'members.manage',
  'objectives.create',
  'objectives.cancel',
  'objectives.reassign',
  'objectives.watch',
  'activity.read',
  'tools.manage',
  'secrets.manage',
  'notifications.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Team-level named bundles of permissions. Members reference them by
 * name in the raw config — the server resolves to a flat `Permission[]`
 * at load time.
 */
export type PermissionPresets = Record<string, Permission[]>;

/**
 * Check whether a resolved permission set grants a specific action.
 * Callers typically work with `Member.permissions`, which is already
 * resolved (presets expanded to leaves) by the time it leaves the
 * server.
 */
export function hasPermission(permissions: readonly Permission[], required: Permission): boolean {
  return permissions.includes(required);
}

// ─────────────────────────── Team / Member ────────────────────────────

/**
 * A team is the top-level unit the server controls. One deployment
 * = one team. The team defines the directive and the context every
 * member inherits, plus any reusable permission presets.
 *
 * `context` here is the team-level standing context (the longer
 * background paragraph that complements `directive`). Distinct
 * from agent conversation context — the latter is per-session and
 * lives in the runner; the former is durable team configuration.
 */
export interface Team {
  name: string;
  directive: string;
  context: string;
  /**
   * Named permission bundles members can reference instead of listing
   * every leaf permission. Always present (may be empty). Common
   * presets: `admin` (all permissions), `operator` (objectives-only).
   */
  permissionPresets: PermissionPresets;
}

/**
 * A role is a short label + prose description. Unlike the previous
 * role model, there's no instructions template here — instructions
 * are personal to each member. The role is shared public context:
 * what this member does on the team, visible to every teammate in
 * the roster and briefing.
 */
export interface Role {
  /** Short freeform label ("director", "engineer", "qa-lead"). */
  title: string;
  /** Prose describing what this role does on the team. */
  description: string;
}

/**
 * Public projection of a team member — the subset visible to other
 * members in the roster and briefing. Omits personal fields
 * (`instructions`) that belong only to the member themselves and to
 * admins managing membership.
 */
export interface Teammate {
  name: string;
  role: Role;
  /** Resolved leaf permissions (presets expanded). */
  permissions: Permission[];
}

/**
 * Full member record — the shape an admin sees in the members admin
 * panel and the shape a member sees of themself in their briefing.
 * Adds `instructions` to the public `Teammate` projection.
 */
export interface Member extends Teammate {
  /**
   * Personal working directives + context for this member. Composed
   * into the member's own system prompt (for agents) or surfaced in
   * their briefing (for humans). Not visible to teammates — this is
   * private to the member and to admins.
   */
  instructions: string;
}

/**
 * Live connection state for one member. Presence describes any
 * member currently on the wire, whether they're a human with a
 * browser tab open or an agent with its MCP link alive.
 */
export interface Presence {
  name: string;
  /** Number of live SSE subscribers currently attached. */
  connected: number;
  createdAt: number;
  lastSeen: number;
  role: Role | null;
  /**
   * Live activity of this member — the 3-state model reported by the
   * runner via `POST /presence/activity` and cleared to `idle` by a
   * server-side TTL when no report arrives, so a crashed runner doesn't
   * leave the member stuck "working"/"blocked" forever. Driven by the
   * agent's native instrumentation (Claude Code hooks, codex app-server
   * turn lifecycle), not by intercepted traffic. Optional — absent on
   * members the server has no recent activity report for (treat as
   * `idle`).
   */
  activity?: ActivityState;
  /**
   * Back-compat mirror of `activity === 'working'`. Older UIs that only
   * understand the boolean keep working; new UIs should prefer
   * `activity` so they can distinguish `blocked` (an operator should
   * look) from plain `idle`. Optional — absent when `activity` is absent.
   */
  busy?: boolean;
}

/**
 * Body for `POST /presence/activity` — the runner-side report of a
 * member's live activity transition. `state` is authoritative; `busy`
 * is an optional back-compat mirror the server derives from `state`
 * (= `state === 'working'`) when omitted.
 */
export interface ActivityReport {
  state: ActivityState;
  /** Optional back-compat mirror; server derives `state === 'working'` if absent. */
  busy?: boolean;
}

// ─────────────────────────── Messaging ────────────────────────────────

export interface PushPayload {
  /** Target member name, or null for a broadcast. */
  to?: string | null;
  title?: string | null;
  body: string;
  level?: LogLevel;
  data?: Record<string, unknown>;
  /**
   * Optional file attachments. Each entry is a reference to a path in
   * the csuite virtual filesystem that the sender already owns write
   * access to. The broker validates each path exists and
   * materializes per-recipient grants so recipients can download the
   * file via `GET /fs/read/<path>`.
   */
  attachments?: Attachment[];
}

export interface Message {
  id: string;
  ts: number;
  /** Target member name, or null for a broadcast. */
  to: string | null;
  /**
   * Authoritative sender name, stamped by the broker based on the
   * caller's authenticated member. Never trusted from the request payload.
   */
  from: string | null;
  title: string | null;
  body: string;
  level: LogLevel;
  data: Record<string, unknown>;
  /**
   * Attachments associated with this message. Always an array — empty
   * when the message carries no files. Render inline for `image/*`
   * mime types; otherwise surface as download chips.
   */
  attachments: Attachment[];
}

export interface DeliveryReport {
  /** Count of live WebSocket subscribers that received the message. */
  live: number;
  /** Count of registered recipients the message was addressed to. */
  targets: number;
}

export interface PushResult {
  delivery: DeliveryReport;
  message: Message;
}

export interface HealthResponse {
  status: 'ok';
  version: string;
}

// ─────────────────────────── Briefing / Session ───────────────────────

/**
 * Full team-context packet returned from `GET /briefing`. Used by
 * the runner and the web UI to initialize themselves with team/
 * role/permissions/objectives context. Extends `Member` so the
 * caller's own name/role/permissions/instructions are flat at the
 * top level — teammates appear in the `teammates` list as the
 * public `Teammate` projection.
 */
export interface BriefingResponse extends Member {
  team: Team;
  teammates: Teammate[];
  /** Objectives currently assigned to this member with status === 'active' or 'blocked'. */
  openObjectives: Objective[];
  /**
   * External tools resolved for this member from the tool-source
   * registry — enabled sources the member is bound to (or that are
   * open to all members). The runner merges these into the agent's
   * MCP toolbox as `<source>__<name>` and dispatches invocations back
   * to the broker. Structured field only — never rendered into the
   * briefing prose (same staleness rule as `openObjectives`).
   */
  toolSources: ResolvedToolSource[];
}

/** Response from `GET /roster`. */
export interface RosterResponse {
  teammates: Teammate[];
  connected: Presence[];
}

/** Query parameters for `GET /history`. */
export interface HistoryQuery {
  with?: string;
  /**
   * Filter to messages tagged for a specific channel. Matches the
   * channel id (server treats `general` as the implicit-broadcast
   * channel). Mutually exclusive with `with`.
   */
  channel?: string;
  limit?: number;
  before?: number;
}

export interface HistoryResponse {
  messages: Message[];
}

// ─────────────────────────── Channels ─────────────────────────────────

export type ChannelMemberRole = 'admin' | 'member';

/**
 * A team channel record. `id` is opaque + immutable; `slug` is
 * mutable + URL-facing. Messages tag their channel via
 * `data.thread = 'chan:<id>'` (note: by id, not slug — renames are
 * decoupled from existing message references).
 */
export interface Channel {
  id: string;
  slug: string;
  createdBy: string;
  createdAt: number;
  /** null when active; epoch-ms timestamp when soft-archived. */
  archivedAt: number | null;
}

export interface ChannelMember {
  channelId: string;
  memberName: string;
  role: ChannelMemberRole;
  joinedAt: number;
}

/**
 * Per-viewer channel summary returned from `GET /channels`. Includes
 * the channel itself plus the caller's relationship to it.
 *
 * `general` is special-cased: every viewer always sees `joined: true`
 * because membership is implicit on that channel.
 */
export interface ChannelSummary extends Channel {
  joined: boolean;
  myRole: ChannelMemberRole | null;
  memberCount: number;
}

export interface ListChannelsResponse {
  channels: ChannelSummary[];
}

export interface GetChannelResponse {
  channel: ChannelSummary;
  members: ChannelMember[];
}

export interface CreateChannelRequest {
  slug: string;
}

export interface RenameChannelRequest {
  slug: string;
}

export interface AddChannelMemberRequest {
  member: string;
  role?: ChannelMemberRole;
}

// ─────────────────────────── Tool sources ─────────────────────────────

/**
 * A tool source is a platform-registered provider of external tools,
 * distributed to bound members via the briefing and invoked through
 * the broker (the broker holds the third-party credential; the agent
 * never sees it).
 *
 *   - `custom` — tools defined declaratively on the platform (name,
 *     description, JSON input schema, HTTP binding) and executed
 *     broker-side against a third-party API.
 *   - `mcp` — a remote MCP server (Streamable HTTP) the broker
 *     connects to as an MCP client; upstream tools are discovered,
 *     cached, and relayed.
 */
export type ToolSourceKind = 'custom' | 'mcp';

/** Static credential kinds supported in v1 (OAuth is a follow-up). */
export type ToolCredentialKind = 'bearer' | 'header';

/**
 * Kind-specific source configuration. Never carries secrets — the
 * credential is a separate write-only subresource.
 */
export interface ToolSourceConfig {
  /** kind=mcp only: the upstream Streamable HTTP endpoint URL. */
  url?: string;
  /** Default per-call timeout override, clamped server-side to [1s, 120s]. */
  timeoutMs?: number;
}

/**
 * A tool source record. `slug` is immutable in v1 (the change-event
 * thread key `tool:<slug>` depends on it); `displayName` is the
 * mutable label.
 */
export interface ToolSource {
  id: string;
  slug: string;
  kind: ToolSourceKind;
  displayName: string;
  enabled: boolean;
  /** When true, every team member is implicitly bound. */
  allMembers: boolean;
  config: ToolSourceConfig;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** Per-viewer summary returned from `GET /tool-sources`. */
export interface ToolSourceSummary extends ToolSource {
  /** Whether a credential is set. The secret itself is never returned. */
  hasCredential: boolean;
  /** Number of tools this source currently exposes (defs or cached). */
  toolCount: number;
  /** Whether the caller is bound (directly or via allMembers). */
  bound: boolean;
}

/**
 * HTTP binding for a custom tool. Placeholders use `{{args.<name>}}`
 * (top-level args only). The URL origin must be static — placeholders
 * are allowed in path/query only (SSRF guard, enforced at save and
 * re-checked at execute). Credentials are injected by the executor
 * from the source credential, never via templates.
 */
export interface CustomToolBinding {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  urlTemplate: string;
  /** Header values may contain placeholders; names are static. */
  headers?: Record<string, string>;
  /**
   * String → raw text body (placeholders interpolated). JSON value →
   * structural template: a string value that is exactly one
   * placeholder is replaced by the arg's raw JSON value, and a
   * missing arg omits the containing object key (optional params).
   */
  bodyTemplate?: string | Record<string, unknown> | unknown[];
  /** Defaults: application/json for JSON bodies, text/plain for strings. */
  contentType?: string;
  /** Dot-path into a JSON response to extract (e.g. "issues.0.key"). */
  resultPath?: string;
  timeoutMs?: number;
}

/** A custom tool definition (kind=custom sources). */
export interface CustomToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments, passed to agents verbatim. */
  inputSchema: Record<string, unknown>;
  binding: CustomToolBinding;
}

/**
 * One tool as resolved for a member's briefing — the projection the
 * runner turns into an MCP tool named `<source>__<name>`.
 */
export interface ResolvedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A source and its resolved tools, as carried on the briefing. */
export interface ResolvedToolSource {
  source: string;
  kind: ToolSourceKind;
  tools: ResolvedTool[];
}

export interface ListToolSourcesResponse {
  sources: ToolSourceSummary[];
}

export interface GetToolSourceResponse {
  source: ToolSourceSummary;
  /** Custom tool defs (kind=custom) or cached upstream tools (kind=mcp). */
  tools: CustomToolDef[] | ResolvedTool[];
  /** Bound member names. Only present for viewers with tools.manage. */
  boundMembers?: string[];
}

export interface CreateToolSourceRequest {
  slug: string;
  kind: ToolSourceKind;
  displayName?: string;
  config?: ToolSourceConfig;
  allMembers?: boolean;
  enabled?: boolean;
}

export interface UpdateToolSourceRequest {
  displayName?: string;
  config?: ToolSourceConfig;
  allMembers?: boolean;
  enabled?: boolean;
}

/** Write-only: the secret is stored KEK-encrypted and never returned. */
export interface SetToolCredentialRequest {
  kind: ToolCredentialKind;
  /** Required when kind=header (e.g. "X-Api-Key"). */
  headerName?: string;
  secret: string;
}

export interface BindToolSourceRequest {
  member: string;
}

/** `PUT /tool-sources/:slug/tools/:name` body (kind=custom). */
export interface SetCustomToolRequest {
  description: string;
  inputSchema: Record<string, unknown>;
  binding: CustomToolBinding;
}

export interface InvokeToolRequest {
  args?: Record<string, unknown>;
}

/**
 * MCP-shaped tool result. Mirrors CallToolResult so the runner can
 * pass it through the bridge verbatim. Tool-level failures are
 * successful calls with `isError: true` (MCP convention).
 */
export interface InvokeToolResponse {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface RefreshToolSourceResponse {
  tools: ResolvedTool[];
  /** Whether the discovered set differed from the previous cache. */
  changed: boolean;
}

// ─────────────────────────── Secrets ──────────────────────────────
//
// Broker-held environment secrets. The value is write-only over the
// wire (set, never read back by any admin surface) and KEK-encrypted
// at rest. A runner resolves the secrets bound to its member right
// before spawning the agent and injects them as environment
// variables on the agent child — they never appear in briefing
// prose, prompts, or MCP traffic. Delivery = enabled && (allMembers
// || bound), the same rule as tool sources.

/**
 * A secret record. `slug` is the immutable address; `envName` is the
 * environment variable the runner sets on the agent child. The value
 * itself is never carried on this shape.
 */
export interface Secret {
  id: string;
  slug: string;
  /** Target environment variable name (validated, reserved names rejected). */
  envName: string;
  /** Freeform admin label / purpose note. */
  description: string;
  enabled: boolean;
  /** When true, every team member receives this secret. */
  allMembers: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** Per-viewer summary returned from `GET /secrets`. */
export interface SecretSummary extends Secret {
  /** Whether a value is set. The value itself is never returned. */
  hasValue: boolean;
  /** Whether the caller is bound (directly or via allMembers). */
  bound: boolean;
}

export interface ListSecretsResponse {
  secrets: SecretSummary[];
}

export interface GetSecretResponse {
  secret: SecretSummary;
  /** Bound member names. Only present for viewers with secrets.manage. */
  boundMembers?: string[];
}

export interface CreateSecretRequest {
  slug: string;
  envName: string;
  description?: string;
  allMembers?: boolean;
  enabled?: boolean;
}

export interface UpdateSecretRequest {
  envName?: string;
  description?: string;
  allMembers?: boolean;
  enabled?: boolean;
}

/** Write-only: the value is stored KEK-encrypted and never returned. */
export interface SetSecretValueRequest {
  value: string;
}

export interface BindSecretRequest {
  member: string;
}

/**
 * Response of `GET /secrets/resolve` — the decrypted env delta for
 * the calling member, keyed by `envName`. Requested by a runner on
 * its own bearer immediately before spawning the agent; the values
 * exist in plaintext only in that response and in the agent child's
 * environment.
 */
export interface ResolveSecretsResponse {
  env: Record<string, string>;
}

// ────────────────── External Notifications ────────────────────────
//
// Inbound events from outside the team — webhooks and plain API
// calls — received on the unauthenticated-but-verified ingress
// (`POST /hooks/:slug`), normalized, and routed to members or
// channels as ambient `<channel>` input. The configured entity is an
// ENDPOINT (slug-addressed); each inbound instance is a DELIVERY
// (the receipt/audit/replay unit). Signing secrets are write-only
// over the wire and KEK-encrypted at rest, same posture as
// tool-source credentials.

/**
 * How an inbound request proves it came from the configured sender.
 *
 * - `hmac-sha256` — hex HMAC of the raw body carried in a header.
 *   Defaults are GitHub-compatible (`x-hub-signature-256`,
 *   prefix `sha256=`); Stripe/Linear-style senders configure
 *   `headerName`/`prefix` to match.
 * - `header-secret` — a shared secret carried verbatim in a header
 *   (default `x-hook-secret`). For senders that can't sign.
 */
export type NotificationAuthKind = 'hmac-sha256' | 'header-secret';

export interface NotificationAuthConfig {
  kind: NotificationAuthKind;
  /** Header carrying the signature/secret. Null → the kind's default. */
  headerName: string | null;
  /** Literal prefix stripped from the header value (`sha256=`). hmac only. */
  prefix: string | null;
}

/**
 * Where a verified delivery lands. Exactly one of `member` /
 * `channel` is set. Multiple member targets fan out as separate DMs
 * (one copy per member — there is no multi-recipient DM primitive).
 * `channel` is the channel ID in responses; create/update requests
 * accept a slug and the server resolves it.
 */
export interface NotificationTarget {
  member?: string;
  channel?: string;
}

export type NotificationFilterOp = 'eq' | 'ne' | 'in' | 'exists' | 'contains';

/**
 * A drop-filter rule evaluated against the parsed JSON payload. All
 * rules must pass (AND) or the delivery is recorded as `filtered`
 * and nothing reaches the targets. A non-JSON body fails any
 * configured rules.
 */
export interface NotificationFilterRule {
  /** Dot-path into the payload (`action`, `check_run.conclusion`). */
  path: string;
  op: NotificationFilterOp;
  /** Comparison value; array for `in`. Unused for `exists`. */
  value?: unknown;
}

/**
 * Per-endpoint delivery policy — the contract between the endpoint
 * and its member targets. `ifOffline`/`ifBusy`/`level` can be
 * overridden per delivery via query params on the hook URL
 * (`?if_offline=queue&if_busy=now&level=critical`). Channel targets
 * always deliver immediately (a channel has no offline/busy state);
 * debounce applies before target fanout either way. `critical`
 * deliveries skip debounce and busy-wait.
 */
export interface NotificationDeliveryPolicy {
  /** Member target offline: drop (default) or queue until wake. */
  ifOffline: 'drop' | 'queue';
  /** Member target mid-turn: deliver now (default) or wait for idle. */
  ifBusy: 'now' | 'wait';
  /** Coalescing window in ms; 0 disables debounce. */
  debounceMs: number;
  /** Buffered deliveries that force an early flush. */
  debounceMax: number;
  /** How long a queued (offline) delivery stays eligible before expiring. */
  queueTtlMs: number;
  /** Max busy-wait before delivering anyway (starvation guard). */
  maxWaitMs: number;
}

export interface NotificationEndpoint {
  id: string;
  /** Immutable ingress address: `POST /hooks/<slug>`. */
  slug: string;
  displayName: string;
  description: string;
  enabled: boolean;
  /** Inline verification config. Ignored when `authProfile` is set. */
  auth: NotificationAuthConfig;
  /** Slug of a shared auth profile, or null for inline auth. */
  authProfile: string | null;
  targets: NotificationTarget[];
  /** Default level for delivered messages. */
  level: LogLevel;
  /** Title for delivered messages. Null → displayName (or slug). */
  title: string | null;
  /**
   * Body template rendered against the parsed payload
   * (`{{payload.<dot.path>}}`). Null → pretty-printed payload,
   * capped. The rendered text always sits inside the non-templatable
   * provenance wrap — templates cannot remove the framing.
   */
  template: string | null;
  filters: NotificationFilterRule[];
  policy: NotificationDeliveryPolicy;
  /**
   * Header whose value dedupes provider retries
   * (`x-github-delivery`). Null disables dedup.
   */
  dedupeHeader: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface NotificationEndpointSummary extends NotificationEndpoint {
  /** Whether an inline signing secret is set. Never the value. */
  hasSecret: boolean;
}

/**
 * A shared auth profile — one verification config + secret reused by
 * several endpoints, so rotating the sender's secret is one write.
 * Deleting a profile still referenced by an endpoint is a 409.
 */
export interface NotificationProfile {
  id: string;
  slug: string;
  description: string;
  auth: NotificationAuthConfig;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface NotificationProfileSummary extends NotificationProfile {
  hasSecret: boolean;
  /** Endpoints currently referencing this profile. */
  endpointCount: number;
}

export type NotificationDeliveryStatus =
  /** Pushed to at least one target. */
  | 'delivered'
  /** Buffered (debounce), queued (offline), or waiting (busy). */
  | 'pending'
  /** Queued past `queueTtlMs` without a wake; never delivered. */
  | 'expired'
  /** Every member target was offline and the policy said drop. */
  | 'dropped'
  /** Signature verification failed (or no secret was configured). */
  | 'rejected'
  /** Dropped by the endpoint's filter rules. */
  | 'filtered'
  /** Same dedupe key as an earlier delivery; not re-delivered. */
  | 'duplicate'
  /** Merged into another delivery's coalesced message. */
  | 'coalesced'
  /** Internal dispatch error; see `statusReason`. */
  | 'failed';

/** Per-delivery overrides parsed from the hook URL's query string. */
export interface NotificationOverrides {
  ifOffline?: 'drop' | 'queue';
  ifBusy?: 'now' | 'wait';
  level?: LogLevel;
}

/**
 * The receipt for one inbound request — the audit/debug/replay unit.
 * The full raw body is retained server-side (capped) for replay;
 * the wire shape carries only a preview.
 */
export interface NotificationDelivery {
  id: string;
  endpointSlug: string;
  receivedAt: number;
  status: NotificationDeliveryStatus;
  statusReason: string | null;
  dedupeKey: string | null;
  /** Message ids this delivery became (one per member target / channel post). */
  messageIds: string[];
  /** First bytes of the raw body, for the receipts view. */
  bodyPreview: string;
  contentType: string | null;
  overrides: NotificationOverrides | null;
  deliveredAt: number | null;
  /** Set when this row was created by replaying another delivery. */
  replayOf: string | null;
}

export interface CreateNotificationEndpointRequest {
  slug: string;
  displayName?: string;
  description?: string;
  enabled?: boolean;
  auth?: Partial<NotificationAuthConfig> & { kind: NotificationAuthKind };
  authProfile?: string | null;
  targets: NotificationTarget[];
  level?: LogLevel;
  title?: string | null;
  template?: string | null;
  filters?: NotificationFilterRule[];
  policy?: Partial<NotificationDeliveryPolicy>;
  dedupeHeader?: string | null;
}

export interface UpdateNotificationEndpointRequest {
  displayName?: string;
  description?: string;
  enabled?: boolean;
  auth?: Partial<NotificationAuthConfig> & { kind: NotificationAuthKind };
  authProfile?: string | null;
  targets?: NotificationTarget[];
  level?: LogLevel;
  title?: string | null;
  template?: string | null;
  filters?: NotificationFilterRule[];
  policy?: Partial<NotificationDeliveryPolicy>;
  dedupeHeader?: string | null;
}

/** Write-only: stored KEK-encrypted, never returned. */
export interface SetNotificationSecretRequest {
  secret: string;
}

export interface CreateNotificationProfileRequest {
  slug: string;
  description?: string;
  auth: Partial<NotificationAuthConfig> & { kind: NotificationAuthKind };
}

export interface UpdateNotificationProfileRequest {
  description?: string;
  auth?: Partial<NotificationAuthConfig> & { kind: NotificationAuthKind };
}

export interface ListNotificationEndpointsResponse {
  endpoints: NotificationEndpointSummary[];
}

export interface GetNotificationEndpointResponse {
  endpoint: NotificationEndpointSummary;
}

export interface ListNotificationProfilesResponse {
  profiles: NotificationProfileSummary[];
}

export interface ListNotificationDeliveriesResponse {
  deliveries: NotificationDelivery[];
}

export interface ReplayNotificationDeliveryResponse {
  delivery: NotificationDelivery;
}

/** 202 body returned by the ingress for accepted (and duplicate) requests. */
export interface HookIngressResponse {
  id: string;
  status: NotificationDeliveryStatus;
}

/**
 * Request body for `POST /session/totp`. The SPA submits a 6-digit
 * code and the server iterates enrolled members to find a match. The
 * optional `member` field is a CLI hint: when present, the server
 * skips iteration and verifies against that specific member only,
 * preserving the targeted-login flow for automation that already
 * knows which name is logging in.
 */
export interface TotpLoginRequest {
  code: string;
  member?: string;
}

export interface SessionResponse {
  /** Authenticated member name. */
  member: string;
  role: Role;
  permissions: Permission[];
  expiresAt: number;
}

export interface VapidPublicKeyResponse {
  publicKey: string;
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushSubscriptionResponse {
  id: number;
  endpoint: string;
  createdAt: number;
}

// ─────────────────────────── Members ──────────────────────────────────

/**
 * `POST /members` body — requires `members.manage`. Server generates
 * the bearer token; the plaintext is returned exactly once in
 * `CreateMemberResponse` and never again. TOTP is optional and
 * enrolled separately via `POST /members/:name/enroll-totp` — it's
 * no longer gated by a type, anyone can enroll.
 *
 * `permissions` accepts either preset names or leaf permissions in a
 * flat array; the server resolves presets and validates every entry.
 */
export interface CreateMemberRequest {
  name: string;
  role: Role;
  instructions?: string;
  /** Each entry: preset name (resolved by server) or leaf permission. */
  permissions: string[];
}

/**
 * `POST /members` response. The plaintext `token` is shown to the
 * admin who created the member, then immediately hashed on disk.
 */
export interface CreateMemberResponse {
  member: Teammate;
  token: string;
}

/**
 * `PATCH /members/:name` body. Any subset of fields may be present;
 * omit a field to leave it alone. Changing permissions enforces the
 * "at least one member with `members.manage` must remain" invariant.
 */
export interface UpdateMemberRequest {
  role?: Role;
  instructions?: string;
  /** Same preset-or-leaf shape as CreateMemberRequest. */
  permissions?: string[];
}

/** `GET /members` response — requires `members.manage`. */
export interface ListMembersResponse {
  members: Member[];
}

/**
 * `POST /members/:name/rotate-token` response — requires
 * `members.manage` OR self. Returns the new plaintext token; the
 * server-side metadata for the new row is included in `tokenInfo`
 * so the caller can display label / id without a follow-up list.
 *
 * The response shape was extended for multi-token: pre-multi-token
 * callers (older CLI builds) still find `token` at the same path.
 */
export interface RotateTokenResponse {
  token: string;
  tokenInfo?: TokenInfo;
}

/**
 * `POST /members/:name/enroll-totp` response — requires
 * `members.manage` OR self. Returns the new TOTP secret + otpauth
 * URI. Any member may enroll; there's no type gate.
 */
export interface EnrollTotpResponse {
  totpSecret: string;
  totpUri: string;
}

// ─────────────────────────── Tokens ───────────────────────────────────

/**
 * Public projection of a bearer token row. The plaintext token is
 * NEVER exposed by this shape — it's returned exactly once at
 * issuance (rotate, device-code approve) and only the metadata round-
 * trips through list / revoke endpoints.
 *
 * Multi-token support: a member may have several active tokens at
 * once, each with a label that names what it's for ("laptop",
 * "ci-runner", "prod-vm"). Listing surfaces the metadata so admins
 * can revoke a stolen device without invalidating peer tokens.
 */
export interface TokenInfo {
  /** Stable id (uuid). Used in revoke calls. */
  id: string;
  memberName: string;
  /** Human-friendly description ("laptop", "prod-vm"). May be empty. */
  label: string;
  /** Provenance — where this token was minted from. */
  origin: TokenOrigin;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms; null if never used. */
  lastUsedAt: number | null;
  /** Epoch ms; null = no expiry. */
  expiresAt: number | null;
  /** Member name that issued this token, or null on bootstrap migration. */
  createdBy: string | null;
}

/**
 * How a token came into existence. `bootstrap` covers tokens carried
 * across the first-boot config-file → SQLite migration; `rotate` is
 * `POST /members/:name/rotate-token`; `enroll` is the device-code
 * flow. Useful for filtering and audit — directors investigating a
 * leak start from `enroll` rows because the metadata identifies the
 * device a token was bound to.
 */
export type TokenOrigin = 'bootstrap' | 'rotate' | 'enroll';

/** `GET /members/:name/tokens` — requires `members.manage` or self. */
export interface ListTokensResponse {
  tokens: TokenInfo[];
}

/**
 * `DELETE /members/:name/tokens/:id` — requires `members.manage` or
 * self. Returns 204 on success; revoking the token currently
 * authenticating the request is allowed (caller is signing off this
 * device themselves). No response body on success — kept here as a
 * named alias for symmetry with the other endpoint type aliases.
 */
export type RevokeTokenResponse = undefined;

// ─────────────────────────── Device-code enrollment ────────────────────

/**
 * `POST /enroll` body — anonymous (no auth). The CLI calls this from
 * the device that needs a token; `labelHint` proposes a friendly
 * label the approving director can accept or override.
 */
export interface DeviceAuthorizationRequest {
  /** Suggested label the director can accept or override on approve. */
  labelHint?: string;
}

/**
 * `POST /enroll` response. Shape mirrors RFC 8628 §3.2 with two
 * additions — `verificationUri` is camelCase to match the rest of
 * the wire and `pollUrl` is a fully-qualified hint so CLI consumers
 * don't have to reconstruct it.
 *
 * The `userCode` is what the human types into the web UI; the
 * `deviceCode` is what the CLI polls with and MUST be kept secret —
 * the broker stores only its hash.
 */
export interface DeviceAuthorizationResponse {
  /** Long, opaque secret the CLI keeps in memory and presents on poll. */
  deviceCode: string;
  /** Short, human-typeable code displayed to the operator (`XXXX-XXXX`). */
  userCode: string;
  /** Path the operator visits to enter the code. Relative; CLI joins with broker URL. */
  verificationUri: string;
  /** Path with the user code prefilled. Operator can deep-link from CLI output. */
  verificationUriComplete: string;
  /** TTL of this enrollment, in seconds. RFC 8628 §3.2 — always 300 (5 min). */
  expiresIn: number;
  /** Minimum poll interval, in seconds. RFC 8628 §3.5 — default 5. */
  interval: number;
}

/**
 * `POST /enroll/poll` body. RFC 8628 §3.4 grant_type encoding is
 * implicit — this endpoint only accepts the device-code grant, so we
 * skip the `grant_type` field for ergonomics and require only the
 * device code itself.
 */
export interface DeviceTokenRequest {
  deviceCode: string;
}

/**
 * `POST /enroll/poll` success response. Returns the freshly-minted
 * bearer token plaintext exactly once (the row is deleted in the
 * same transaction). The `member` projection lets the CLI write
 * `~/.config/csuite/auth.json` with the bound identity.
 */
export interface DeviceTokenResponse {
  /** Bearer token plaintext — `csuite_<base64url>`. Save once; never again. */
  token: string;
  /** Stable id of the issued token row. Useful for later revoke. */
  tokenId: string;
  member: Teammate;
}

/**
 * RFC 8628 §3.5 standard error responses. Returned as 400 + JSON body
 * `{error: <code>}`. Clients distinguish on the `error` string:
 *
 *   authorization_pending — keep polling, user hasn't approved yet
 *   slow_down             — back off; increment poll interval by 5s
 *   expired_token         — the device_code TTL elapsed; restart enrollment
 *   access_denied         — director rejected; abort
 */
export type DeviceTokenErrorCode =
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token'
  | 'access_denied';

export interface DeviceTokenErrorResponse {
  error: DeviceTokenErrorCode;
  /** Free-form note (e.g. director's reject reason). Not machine-parsed. */
  errorDescription?: string;
}

/**
 * Pending-enrollments listing for directors. Shows everything that's
 * currently waiting for approval, with enough metadata that a
 * director can spot an unexpected request (different sourceIp, odd
 * UA, etc.) before approving.
 *
 * `userCode` is the same code the device-side CLI is showing the
 * operator — directors rarely use it directly, but it lets the same
 * row be approved either by URL deep-link or by typing the code from
 * the device.
 */
export interface PendingEnrollment {
  /** The 8-char user code, hyphen-formatted: `XXXX-XXXX`. */
  userCode: string;
  /** Caller-provided hint, may be empty. */
  labelHint: string;
  /** Best-effort source IP captured at /enroll time. May be null. */
  sourceIp: string | null;
  /** Best-effort User-Agent captured at /enroll time. May be null. */
  sourceUa: string | null;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms — when this row will auto-expire. */
  expiresAt: number;
}

export interface ListPendingEnrollmentsResponse {
  enrollments: PendingEnrollment[];
}

/**
 * `POST /enroll/approve` body. Two modes:
 *
 *   bind   — issue a token bound to an existing member (`memberName`)
 *   create — issue a token AND create a new member with the supplied
 *            role / permissions / instructions. The new member name
 *            must not collide with an existing one.
 *
 * `label` is optional; absent means "leave whatever the device-side
 * suggested in labelHint." `permissions` follows the same preset-or-
 * leaf shape as `CreateMemberRequest`.
 */
export type ApproveEnrollmentRequest =
  | {
      userCode: string;
      mode: 'bind';
      memberName: string;
      label?: string;
    }
  | {
      userCode: string;
      mode: 'create';
      memberName: string;
      role: Role;
      instructions?: string;
      permissions: string[];
      label?: string;
    };

/**
 * `POST /enroll/approve` response — confirmation only. The plaintext
 * token is delivered to the device-side CLI on its next poll, NOT to
 * the approver. This keeps the secret entirely on the device the
 * operator is sitting at and out of the director's browser scrollback.
 */
export interface ApproveEnrollmentResponse {
  member: Teammate;
  /** The token row that will be issued — without the plaintext. */
  tokenInfo: TokenInfo;
}

/** `POST /enroll/reject` body. */
export interface RejectEnrollmentRequest {
  userCode: string;
  /** Free-form note returned to the device-side CLI as `errorDescription`. */
  reason?: string;
}

// ─────────────────────────── Objectives ───────────────────────────────

export type ObjectiveStatus = 'active' | 'blocked' | 'done' | 'cancelled';

/**
 * An objective is the apex task primitive on a team: push-assigned,
 * outcome-required, single-assignee. The `outcome` field is the tangible
 * definition of "done" that propagates into channel pushes and the runner's
 * `context_refresh` re-briefs so the assignee always has the acceptance
 * criteria in front of them.
 */
export interface Objective {
  id: string;
  title: string;
  /** Optional longer context. */
  body: string;
  /** Required — the tangible outcome that defines "done". */
  outcome: string;
  status: ObjectiveStatus;
  assignee: string;
  originator: string;
  /**
   * Additional names that have been explicitly added to the
   * objective's discussion thread. Watchers receive every lifecycle
   * event and every discussion post on their SSE streams without
   * being the assignee. Members with `objectives.watch` can add
   * themselves or others; originators can manage their own
   * objectives' watchers. Members with `members.manage` are implicit
   * observers regardless and do NOT appear in this list.
   */
  watchers: string[];
  createdAt: number;
  updatedAt: number;
  /** Set iff status === 'done'. */
  completedAt: number | null;
  /** Required on completion; explains what was delivered. */
  result: string | null;
  /** Set while status === 'blocked'; cleared on unblock. */
  blockReason: string | null;
  /**
   * Files attached to the objective at creation time. Thread members
   * (originator, assignee, watchers) all receive read grants for each
   * attachment, so any thread-scoped UI can render them alongside
   * the objective body.
   */
  attachments: Attachment[];
}

/**
 * Events on an objective's audit log. Kinds split into two groups:
 *
 *   Lifecycle transitions (the state machine of the work):
 *     assigned | blocked | unblocked | completed | cancelled | reassigned
 *
 *   Membership changes (the audience of the thread):
 *     watcher_added | watcher_removed
 *
 * Discussion — ordinary conversation about the objective — lives in
 * the `obj:<id>` thread as regular messages and is NOT in the event
 * log. The event log is strictly auditable transitions.
 */
export type ObjectiveEventKind =
  | 'assigned'
  | 'blocked'
  | 'unblocked'
  | 'completed'
  | 'cancelled'
  | 'reassigned'
  | 'watcher_added'
  | 'watcher_removed';

export interface ObjectiveEvent {
  objectiveId: string;
  ts: number;
  actor: string;
  kind: ObjectiveEventKind;
  payload: Record<string, unknown>;
}

export interface CreateObjectiveRequest {
  title: string;
  outcome: string;
  body?: string;
  assignee: string;
  /**
   * Optional initial watchers (names that should be looped into
   * the objective's thread from the start). Duplicates and the
   * objective's own assignee/originator are de-duped server-side.
   * Every name must resolve to a known team member.
   */
  watchers?: string[];
  /**
   * Optional files to attach. The originator must have read access
   * to each path. Thread members receive automatic read grants as
   * part of the `assigned` event fanout.
   */
  attachments?: Attachment[];
}

/**
 * Add or remove watchers on an existing objective. Either field may
 * be omitted; both may be present for a combined add + remove.
 * Names that are already watchers are no-ops on `add`, and
 * names that aren't currently watchers are no-ops on `remove`.
 * Every name in both lists must resolve to a known team member.
 */
export interface UpdateWatchersRequest {
  add?: string[];
  remove?: string[];
}

export interface UpdateObjectiveRequest {
  status?: 'active' | 'blocked';
  blockReason?: string;
}

export interface CompleteObjectiveRequest {
  result: string;
}

export interface CancelObjectiveRequest {
  reason?: string;
}

export interface ReassignObjectiveRequest {
  to: string;
  note?: string;
}

/**
 * Post a discussion message into an objective's thread. Members of the
 * thread (originator, assignee, watchers) all receive it via their
 * SSE streams. The post is a normal team `Message` with thread
 * key `obj:<id>`, not an event-log entry.
 */
export interface DiscussObjectiveRequest {
  body: string;
  title?: string;
  /**
   * Optional files to attach to this discussion post. Resolved and
   * grant-propagated the same way attachments on `/push` are —
   * every thread member who receives the post also gets read
   * access to each attachment.
   */
  attachments?: Attachment[];
}

export interface ListObjectivesResponse {
  objectives: Objective[];
}

export interface GetObjectiveResponse {
  objective: Objective;
  events: ObjectiveEvent[];
}

export interface ListObjectivesQuery {
  assignee?: string;
  status?: ObjectiveStatus;
}

// ─────────────────────────── Activity / Traces ────────────────────────

/**
 * Trace capture — one structured model exchange normalized from an
 * agent's native instrumentation (Claude Code's OpenTelemetry export,
 * the codex app-server stream). Each entry represents a single model
 * exchange the agent made while working on an objective, parsed from
 * an Anthropic `/v1/messages`-shaped body into a typed shape.
 *
 * There is no opaque catch-all variant: the capture surface no longer
 * intercepts arbitrary HTTP, so an exchange that isn't an Anthropic
 * messages call is simply not captured rather than kept as a headers +
 * body-preview record.
 */
export interface AnthropicMessagesEntry {
  kind: 'anthropic_messages';
  startedAt: number;
  endedAt: number;
  request: {
    model: string | null;
    maxTokens: number | null;
    temperature: number | null;
    system: string | null;
    messages: AnthropicMessage[];
    tools: AnthropicTool[] | null;
  };
  response: {
    stopReason: string | null;
    stopSequence: string | null;
    messages: AnthropicMessage[];
    usage: AnthropicUsage | null;
    status: number | null;
    /**
     * The API response/message id (`msg_...`), when the capture source
     * carries one (the Claude transcript does; codex turn aggregation
     * doesn't). This is the exact join key to the matching
     * `GenAiInferenceRecord.responseId` — the full-request record that
     * holds system instructions and input messages. Optional: absent on
     * rows captured before this field existed.
     */
    responseId?: string | null;
  } | null;
}

export interface AnthropicMessage {
  role: string;
  content: AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError: boolean }
  | { type: 'image'; mediaType: string | null }
  | { type: 'thinking'; text: string }
  | { type: 'unknown'; raw: unknown };

export interface AnthropicTool {
  name: string;
  description: string | null;
  inputSchema: unknown;
}

export interface AnthropicUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

// ─────────────────────── GenAI inference records ──────────────────────
//
// The full-fidelity inference layer, modeled on the OpenTelemetry GenAI
// semantic conventions (Development). One `GenAiInference` record is
// emitted per Claude `/v1/messages` API call and carries the COMPLETE
// input context actually sent on the wire (mutations/compaction
// included), the system prompt kept SEPARATE from chat history, and the
// assistant's response. It is additive to `AnthropicMessagesEntry` /
// the activity stream (the UI + ops view) — these records feed a
// downstream content-addressed store, so the O(n²) redundancy across
// turns is intended (raw material for content-identity dedup).

/**
 * Anthropic-flavored token accounting for one inference operation.
 * `cacheRead`/`cacheCreation` are the Anthropic extensions to the
 * standard `gen_ai.usage.*` attributes.
 */
export interface GenAiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
}

/**
 * A typed content part — the mapping target for an Anthropic content
 * block. The union is intentionally EXTENSIBLE: any block we don't
 * recognize (or one that fails to parse) becomes a `generic` part
 * carrying the raw value rather than being dropped.
 *
 *   Anthropic block          → GenAiPart
 *   ─────────────────────────────────────────────────────────────────
 *   {type:'text'}            → {type:'text', content}
 *   {type:'tool_use'}        → {type:'tool_call', id, name, arguments}
 *   {type:'tool_result'}     → {type:'tool_call_response', id, response, is_error}
 *   {type:'thinking'}        → {type:'reasoning', content}
 *   {type:'image', base64}   → {type:'blob', mime_type, data}
 *   {type:'image', url}      → {type:'file', mime_type, uri}
 *   anything else            → {type:'generic', content: <raw>}
 */
export type GenAiPart =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string | null; name: string | null; arguments: unknown }
  | { type: 'tool_call_response'; id: string | null; response: unknown; is_error: boolean }
  | { type: 'reasoning'; content: string }
  | { type: 'blob'; mime_type: string | null; data: string | null }
  | { type: 'file'; mime_type: string | null; uri: string | null }
  | { type: 'generic'; content: unknown };

/**
 * One message in an inference operation's context or output.
 * `role` is a free string ('system' | 'user' | 'assistant' | 'tool'
 * in practice) so unknown roles survive intact.
 */
export interface GenAiMessage {
  role: string;
  parts: GenAiPart[];
}

/**
 * A single Claude inference operation, mapped to the OpenTelemetry
 * GenAI semantic conventions. One record per API call. `inputMessages`
 * is the FULL context actually sent (in send order); `systemInstructions`
 * is the system prompt, kept separate from the chat history;
 * `outputMessages` is the assistant response ([{role:'assistant', ...}]).
 */
export interface GenAiInference {
  /** `gen_ai.operation.name` */
  operationName: 'chat';
  /** `gen_ai.provider.name` — `anthropic` (Claude Code) or `openai` (codex). */
  provider: 'anthropic' | 'openai';
  /** `gen_ai.request.model` — from the request body. */
  model: string | null;
  /** `gen_ai.response.id` */
  responseId: string | null;
  /**
   * `gen_ai.response.finish_reasons` — from the Anthropic response
   * `stop_reason`, or derived from the codex/OpenAI Responses output items.
   */
  finishReasons: string[];
  /** `gen_ai.usage.*` (incl. the Anthropic cache extensions). */
  usage: GenAiUsage | null;
  /** `gen_ai.system_instructions` — the system prompt, kept separate. */
  systemInstructions: GenAiPart[];
  /** `gen_ai.input.messages` — the full sent context, in send order. */
  inputMessages: GenAiMessage[];
  /** `gen_ai.output.messages` — the assistant response. */
  outputMessages: GenAiMessage[];
  /**
   * Thread attribution: the `query_source` of the Claude Code call this
   * record came from — which INTERLEAVED thread of a member's work made
   * it. Values seen: `repl_main_thread` (the member's main thread),
   * `agent:builtin:general-purpose` (a subagent), `web_search_tool` /
   * `web_fetch_apply` (server-tool auxiliary calls). Null when the
   * source attribute was absent. Sourced from the `api_request` OTEL
   * event, not the request body.
   */
  querySource: string | null;
  /**
   * The named agent that made the call, for NAMED agents only
   * (`general-purpose` for the builtin subagent). Null/absent for the
   * main thread and server-tool auxiliary calls. Sourced from the
   * `agent.name` attribute on the `api_request` OTEL event.
   */
  agentName: string | null;
  /** Capture timestamp (epoch ms). */
  ts: number;
}

/**
 * One stored GenAI inference record as served by
 * `GET /members/:name/genai` — the full-fidelity "what exactly was
 * sent and returned" ledger (system instructions + complete input
 * context), gated like the activity stream (`activity.read` OR
 * self). Coverage is best-effort: rows exist only for calls whose
 * request/response bodies the agent's native instrumentation
 * exported, so consumers should treat this as an ENRICHMENT source
 * joined onto the always-present `llm_exchange` activity markers
 * (by `responseId` when the marker carries one, else by
 * timestamp/model proximity), never as the call ledger itself.
 */
export interface GenAiInferenceRecord extends GenAiInference {
  /** Server-assigned row id (per-member-stream ordering). */
  id: number;
  memberName: string;
  /** Server receive time (epoch ms); `ts` is the capture time. */
  receivedAt: number;
}

export interface ListGenaiResponse {
  inferences: GenAiInferenceRecord[];
}

/**
 * The light projection of a stored inference record — everything
 * EXCEPT the heavy content fields (`systemInstructions`,
 * `inputMessages`, `outputMessages`). Served by
 * `GET /members/:name/genai?view=summary`, cheap enough to hydrate
 * for a whole feed window at once. This is the call LEDGER the
 * turn-spine timeline joins onto its `llm_exchange` markers: identity
 * (`id`, `responseId`), attribution (`querySource`, `agentName`),
 * cost (`usage`), and timing (`ts`) — the full body loads on demand
 * via `GET /members/:name/genai/:id` when a viewer expands the call.
 */
export interface GenAiInferenceSummary {
  id: number;
  memberName: string;
  operationName: 'chat';
  provider: 'anthropic' | 'openai';
  model: string | null;
  responseId: string | null;
  finishReasons: string[];
  usage: GenAiUsage | null;
  querySource: string | null;
  agentName: string | null;
  ts: number;
  receivedAt: number;
}

export interface ListGenaiSummariesResponse {
  inferences: GenAiInferenceSummary[];
}

/** Response of `GET /members/:name/genai/:id` — one full record. */
export interface GetGenaiInferenceResponse {
  inference: GenAiInferenceRecord;
}

/** Query for `GET /members/:name/genai`. Bounds apply to `ts`. */
export interface ListGenaiQuery {
  from?: number;
  to?: number;
  limit?: number;
}

/**
 * Activity event — one entry in the append-only timeline a member
 * streams to the server while their connection is alive. Humans
 * rarely emit these (no MCP runner); agents produce the bulk from
 * their own native instrumentation (Claude Code OTEL export, codex
 * app-server stream), normalized runner-side into this model.
 *
 * Activity is the source of truth for "what did this member actually
 * do" — LLM exchanges, tool actions, and objective lifecycle markers.
 * Objective "traces" are a time-range slice of this stream between
 * `objective_open` and `objective_close` markers for a given
 * objectiveId.
 */
export type ActivityEvent =
  | ActivityObjectiveOpen
  | ActivityObjectiveClose
  | ActivityLlmExchange
  | ActivityToolAction
  | ActivityUserPrompt;

export type ActivityKind = ActivityEvent['kind'];

export interface ActivityObjectiveOpen {
  readonly kind: 'objective_open';
  readonly ts: number;
  readonly objectiveId: string;
}

export interface ActivityObjectiveClose {
  readonly kind: 'objective_close';
  readonly ts: number;
  readonly objectiveId: string;
  /** Terminal state that caused the close. */
  readonly result: 'done' | 'cancelled' | 'reassigned' | 'runner_shutdown';
}

export interface ActivityLlmExchange {
  readonly kind: 'llm_exchange';
  /** Start of the model request (as reported by the capture source). */
  readonly ts: number;
  /** Milliseconds between request start and response end. */
  readonly duration: number;
  /** Which agent produced it (`'claude'`, `'codex'`). */
  readonly agent?: string;
  /** Thread attribution: `codex_main_thread` / `codex_subagent:<id8>`. */
  readonly querySource?: string;
  readonly entry: AnthropicMessagesEntry;
}

/**
 * A single tool invocation captured from the agent's NATIVE
 * instrumentation rather than the network wire — Claude Code hook
 * callbacks (PostToolUse / PostToolUseFailure) and, later, the codex
 * app-server item stream. Records the tool name plus its (redacted)
 * input and result so a reviewer can see what the agent actually did
 * in the tool-execution windows that never generate an LLM call.
 *
 * `input` / `result` are deliberately untyped (`unknown`) — they carry
 * whatever the agent framework hands us (a shell command string, a
 * file-edit patch, a search result blob) and the schema stays
 * permissive so a new tool shape never fails validation.
 */
export interface ActivityToolAction {
  readonly kind: 'tool_action';
  /** When the tool action was recorded (PostToolUse fire time). */
  readonly ts: number;
  /** Optional wall-clock duration of the tool call, if known. */
  readonly durationMs?: number;
  /** Which agent produced it (`'claude'`, `'codex'`). */
  readonly agent?: string;
  /** Tool name as the agent reports it (`Bash`, `Edit`, `Read`, …). */
  readonly toolName: string;
  /** Redacted tool input (arguments). */
  readonly input?: unknown;
  /** Redacted tool result / response. */
  readonly result?: unknown;
  /** True when the tool call failed (PostToolUseFailure). */
  readonly isError?: boolean;
  /** Capture source tag (e.g. `'claude_hook'`, `'codex_item'`). */
  readonly source?: string;
  /** Thread attribution: `codex_main_thread` / `codex_subagent:<id8>`. */
  readonly querySource?: string;
  /**
   * The Anthropic `tool_use` id this action corresponds to (carried on
   * the Claude PostToolUse hook as `tool_use_id`). Lets the UI fold a
   * tool's RESULT into the matching `tool_use` block of the model's
   * `llm_exchange` turn instead of rendering it as a standalone row.
   * Absent for sources that don't expose a tool_use id (e.g. codex).
   */
  readonly toolUseId?: string;
}

/**
 * The prompt that WOKE an agent turn — captured from the Claude Code
 * `UserPromptSubmit` hook (the same signal the runner already consumes
 * for presence). In csuite this is often an injected ambient broker
 * event rather than a human keystroke. Capturing it here gives a Claude
 * turn a real opener WITHOUT depending on the OTEL request body, which
 * truncates large (~60KB+) prompts. The text is redacted runner-side
 * before it leaves the process, so the schema only validates shape.
 */
export interface ActivityUserPrompt {
  readonly kind: 'user_prompt';
  /** When the prompt was submitted. */
  readonly ts: number;
  /** Redacted prompt text that woke the turn. */
  readonly text: string;
  /** Optional stable id for the prompt, if the source provides one. */
  readonly promptId?: string;
  /** Which agent produced it (`'claude'`, `'codex'`). */
  readonly agent?: string;
  /** Thread attribution: `codex_main_thread` / `codex_subagent:<id8>`. */
  readonly querySource?: string;
}

/**
 * One activity row as the server stores it — the upload event plus
 * the server-assigned id + member name.
 */
export interface ActivityRow {
  readonly id: number;
  readonly memberName: string;
  readonly event: ActivityEvent;
  readonly createdAt: number;
}

/**
 * Upload payload. Runners batch events and POST them in bursts of
 * up to a few dozen at a time. The server stamps each with an id
 * and broadcasts to any live SSE subscribers.
 */
export interface UploadActivityRequest {
  readonly events: ActivityEvent[];
}

export interface UploadActivityResponse {
  readonly accepted: number;
}

export interface ListActivityQuery {
  /** Inclusive lower bound on ts (ms since epoch). */
  readonly from?: number;
  /** Inclusive upper bound on ts (ms since epoch). */
  readonly to?: number;
  /** Filter by kind — single or array. Omit for all kinds. */
  readonly kind?: ActivityKind | ActivityKind[];
  /** Max rows to return. Default 200, max 1000. Newest first. */
  readonly limit?: number;
}

export interface ListActivityResponse {
  readonly activity: ActivityRow[];
}

// ─────────────────────────── Filesystem ───────────────────────────────

/**
 * One entry in the csuite virtual filesystem — either a file or a
 * directory. Paths are absolute Unix-style; the first segment is
 * the owning member (`/<membername>/...`).
 *
 * For directories: `size`, `mimeType`, and `hash` are null.
 * For files: all three are populated; `hash` is SHA-256 hex of the
 * blob content and doubles as the dedup key for the blob store.
 */
/**
 * Collision strategy for `fs_write` when the target path already exists:
 * `'error'` (default) rejects, `'overwrite'` replaces in place, `'suffix'`
 * writes to a deduped `name (1).ext`-style path. Validated by
 * `FsWriteCollisionSchema` in `./schemas`.
 */
export type FsWriteCollisionStrategy = 'error' | 'overwrite' | 'suffix';

export interface FsEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  owner: string;
  size: number | null;
  mimeType: string | null;
  hash: string | null;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
}

/**
 * Lightweight file reference embedded in a `Message` or an objective.
 * Recipients resolve downloads via `GET /fs/read/<path>`. The
 * accompanying `size` and `mimeType` let clients render previews
 * without an extra round-trip.
 */
export interface Attachment {
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

export interface FsListResponse {
  entries: FsEntry[];
}

export interface FsEntryResponse {
  entry: FsEntry;
}

export interface FsWriteResponse {
  entry: FsEntry;
  /** True when a collide-suffix strategy caused the final path to differ from the request. */
  renamed: boolean;
}

export interface FsMkdirRequest {
  path: string;
  recursive?: boolean;
}

export interface FsRemoveQuery {
  path: string;
  recursive?: boolean;
}

export interface FsMoveRequest {
  from: string;
  to: string;
}
