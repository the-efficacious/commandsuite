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

/**
 * Whether a member's verbatim capture is reaching the broker.
 *
 * ```
 * ok            evaluated, no gap
 * gap           evaluated, definitive gap
 * unevaluated   this broker cannot assess this member
 * (absent)      old broker, no opinion
 * ```
 *
 * The last two are different claims and must not be collapsed.
 * **Field absence carries "no opinion"**; `unevaluated` is this broker
 * positively stating it did not evaluate. There is no `pending` —
 * healthy correlation lag leaves every normal turn briefly unmatched,
 * so a user-visible "maybe" would flicker on healthy traffic.
 */
export type CaptureHealthState = 'ok' | 'gap' | 'unevaluated';

// ─────────────────────────── Permissions ──────────────────────────────

/**
 * The set of elevated actions gated by membership policy. Baseline
 * participation (DM, posting to the primary thread, taking a contract
 * assigned to you, discussing on it, managing your own files) is NOT a
 * permission — it's what it means to be on the team.
 * Only actions that touch other members or shape the team itself are
 * permissions.
 *
 * Dotted noun-first naming groups permissions by resource so they
 * sort and scan naturally as the vocabulary grows.
 */
export const PERMISSIONS = [
  'team.manage',
  'members.manage',
  'activity.read',
  'tools.manage',
  'secrets.manage',
  'notifications.manage',
  /**
   * Edit the team's process document. A DEDICATED leaf rather than a
   * reuse of `spine.author`: under this design the permission is
   * the entire authority — whoever holds it can rewrite what binds the
   * team — and "can author a contract" is not a comparable power.
   */
  'process.manage',
  /**
   * Author or amend a spine contract — state what the world must
   * become, and change that statement afterwards.
   *
   * ONE leaf, and deliberately narrow. Everything else on the spine is
   * baseline participation: reading the annex, posting an attempt,
   * returning a verdict, raising an ask, discussing. Those are what it
   * means to be on the team, and the admission rule above says they
   * are not permissions.
   *
   * Verdict and ruling legitimacy is NOT modelled here either, because
   * it is structural rather than granted: a verdict may not come from
   * the assignee and a ruling may only come from the ask's named
   * authority, and the store refuses both regardless of what anyone
   * holds. A leaf would imply those refusals could be granted away.
   */
  'spine.author',
  /**
   * Light or unlight a spine contract — decide what is in the team's
   * FOCUS SET, the shared boundary of what is lit for travel now (D9).
   *
   * A SEPARATE leaf from `spine.author`, and the separation is the
   * whole point. Authoring a contract states what the world must
   * become; curating the focus set decides which of the team's
   * contracts are the ones to travel to *now* — the allocator's
   * authority, not the author's. A member may be able to author work
   * without deciding the team's sprint, and hold the sprint without
   * authoring, so the two powers are granted apart.
   *
   * It gates AUTHORING focus-membership events only. Reading the focus
   * set is baseline — every member plans against it, so `orient` carries
   * it and `GET /spine/contracts?focus=true` is open — and no heuristic
   * ever lights a contract: membership is authored by a holder of this
   * leaf, on the record, with a reason (§10, never take the photos).
   */
  'spine.focus',
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
 * = one team. The team defines the standing context every member
 * inherits, plus any reusable permission presets.
 *
 * `context` here is the team-level standing context: what the team
 * is here to do plus any background every member should carry.
 * Distinct from agent conversation context — the latter is
 * per-session and lives in the runner; the former is durable team
 * configuration, editable any time via the web UI, CLI, or MCP.
 */
export interface Team {
  name: string;
  context: string;
  /**
   * Named permission bundles members can reference instead of listing
   * every leaf permission. Always present (may be empty). Common
   * presets: `admin` (all permissions), `operator` (spine-only).
   */
  permissionPresets: PermissionPresets;
}

/**
 * A role is a short label + prose description. Unlike the previous
 * role model, there's no instructions template here — instructions
 * are personal to each member. The role is shared public context:
 * what this member does on the team, visible to every teammate in
 * the roster and instruction packet.
 */
export interface Role {
  /** Short freeform label ("director", "engineer", "qa-lead"). */
  title: string;
  /** Prose describing what this role does on the team. */
  description: string;
}

/**
 * Public projection of a team member — the subset visible to other
 * members in the roster and instruction packet. Omits personal fields
 * (`instructions`) that belong only to the member themselves and to
 * admins managing membership.
 */
export interface Teammate {
  name: string;
  role: Role;
  /** Resolved leaf permissions (presets expanded). */
  permissions: Permission[];
  /**
   * Person vs agent, for identity rendering (Helm plate 14 draws the
   * two differently). Derived server-side from the auth plane: a
   * member with TOTP enrollment is a person. Optional — older servers
   * omit it, and consumers must render the absent case as the neutral
   * (agent) treatment rather than guessing person.
   */
  kind?: 'person' | 'agent';
}

/**
 * Full member record — the shape an admin sees in the members admin
 * panel and the shape a member sees of themself in their instruction packet.
 * Adds `instructions` to the public `Teammate` projection.
 */
export interface Member extends Teammate {
  /**
   * Personal working directives + context for this member. Composed
   * into the member's own system prompt (for agents) or surfaced in
   * their instruction packet (for humans). Not visible to teammates — this is
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
  /**
   * Whether this member's VERBATIM capture is reaching the broker.
   *
   * **Absence means "this broker has no opinion" — NOT "healthy."** A
   * broker that knows about the field emits `'ok'` or `'gap'`
   * explicitly for every member it evaluates; only an older broker
   * omits it. Reading absence as healthy would reintroduce the exact
   * ambiguity the field exists to remove.
   *
   * `'gap'` means completed exchange markers have aged past the grace
   * window without their stored bodies appearing — the member is
   * working and their verbatim capture is not arriving. There is no
   * user-visible intermediate state: healthy correlation lag leaves
   * every normal turn briefly unmatched, so a "maybe" would flicker
   * continuously.
   */
  captureHealth?: CaptureHealthState;
  /**
   * Completeness failures the broker has RETAINED for this member and
   * that have not been observed to recover.
   *
   * Follows `captureHealth`'s absence rule, not `activity`'s: absent
   * means this broker retains no diagnostics and has no opinion — never
   * "this member is clean". `0` is the positive statement that it
   * looked and found none outstanding.
   *
   * This is the surface an agent reads about ITSELF. The failures it
   * counts are ones the product already detected and, until now, wrote
   * to a terminal nobody kept: the agent could not find out that its
   * own capture had failed.
   */
  diagnosticsUnresolved?: number;
  /**
   * Health of the retention subsystem itself.
   *
   * `unknown` is reachable and load-bearing: a store that cannot say "I
   * do not know" would make this signal the thing it exists to prevent,
   * one layer down.
   */
  diagnosticsRetention?: 'healthy' | 'degraded' | 'unknown';
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
  capabilities?: {
    rawBodyAck?: boolean;
  };
}

// ────────────────────────── Instructions / Session ────────────────────

/**
 * The named kinds of operator-authored instruction blocks composed
 * into a member's fixed context. The strings are a wire and telemetry
 * contract (`persistent_context kind="…"` re-sends, the context
 * watchdog's `context.block.kind` attribute) — pinned independently
 * of any TypeScript identifier; renaming code must never move them.
 */
export type InstructionBlockKind =
  | 'team_context'
  | 'role_description'
  | 'personal_instructions'
  | 'process_document';

/**
 * One instruction block as issued to a member, identified by content
 * hash. The text itself rides in the composed `instructions` string
 * (or `processDocument`); the descriptor names what was composed so a
 * runner or UI can compare versions without re-deriving composition.
 */
export interface InstructionBlockDescriptor {
  kind: InstructionBlockKind;
  /** sha256 (hex) of the exact block text as composed. */
  sha256: string;
}

/**
 * Full instruction packet returned from `GET /instructions`. Used by
 * the runner and the web UI to initialize themselves with team/
 * role and permissions context. Extends `Member` so the
 * caller's own name/role/permissions/instructions are flat at the
 * top level — teammates appear in the `teammates` list as the public
 * `Teammate` projection.
 */
export interface InstructionsResponse extends Member {
  team: Team;
  teammates: Teammate[];
  /**
   * External tools resolved for this member from the tool-source
   * registry — enabled sources the member is bound to (or that are
   * open to all members). The runner merges these into the agent's
   * MCP toolbox as `<source>__<name>` and dispatches invocations back
   * to the broker. Structured field only — never rendered into the
   * composed instructions — structured field only, never rendered.
   */
  toolSources: ResolvedToolSource[];
  /**
   * The team's process document as one authored whole, or `null` when
   * none has been set. Carried separately from `instructions` because
   * that field is authored by the member and this is authored by
   * whoever holds `process.manage` — one string would collapse two
   * authorities into one field.
   *
   * `undefined` when the broker did not send the field at all — an
   * older broker without the feature. Distinct from `null`, which is a
   * broker saying the team has no document.
   */
  processDocument?: ProcessDocument | null;
  /**
   * The named blocks composed into this packet, by content hash.
   * Absent from brokers that predate the instruction-block model.
   */
  blocks?: InstructionBlockDescriptor[];
  /**
   * sha256 (hex) of the CANONICAL composition — the composed
   * instructions with the transient broker/runner version line
   * normalized out, plus the process-document text. This is the
   * session's instruction-version identifier: the broker records it as
   * "issued" on each fetch and compares it against the current
   * composition to decide restart-pending. Two fetches that differ
   * only in reported runner version share a hash by construction.
   */
  composedSha256?: string;
}

/** Response from `GET /roster`. */
export interface RosterResponse {
  teammates: Teammate[];
  connected: Presence[];
  /**
   * Members whose current composed instructions differ from what
   * their live session was issued — a restart at the next safe
   * boundary picks up the edit. Absent from brokers that predate
   * instruction versioning; empty when nothing is pending. A member
   * whose issued version is unknown (broker restarted since their
   * fetch) is NOT listed — unknown is not pending.
   */
  restartPending?: string[];
  /**
   * Window the broker applied when deciding whether an activity report
   * is recent. Optional for compatibility with older brokers.
   */
  activityWindowMs?: number;
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
 * distributed to bound members via the instruction packet and invoked through
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
 * One tool as resolved for a member's instruction packet — the projection the
 * runner turns into an MCP tool named `<source>__<name>`.
 */
export interface ResolvedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A source and its resolved tools, as carried on the instruction packet. */
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
// variables on the agent child — they never appear in instruction packet
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
  /**
   * The merged env delta for the calling member — secrets AND
   * variables together, since the runner injects one environment map.
   */
  env: Record<string, string>;
  /**
   * Which keys of `env` came from the SECRETS store, and are therefore
   * the only ones the runner may register with the trace redactor.
   *
   * Optional for one reason: a runner talking to a broker that predates
   * this field must not silently stop redacting. When it is absent the
   * runner registers everything, which is the old behaviour and the
   * fail-closed direction. A broker that sends it is authoritative.
   */
  secretEnvNames?: string[];
}

// ────────────────────────── Variables ─────────────────────────────
//
// A runner environment variable that is NOT a secret. Structurally
// identical to `Secret` — slug, env name, bindings, one value — and
// different in exactly two ways: the value is READABLE by an
// authorised caller, and it is never registered with the trace
// redactor, so it survives verbatim in captured traces.
//
// The distinction exists because the secrets store used to be the only
// path into a runner's environment. Git identity had to be stored as a
// secret and was then scrubbed from every trace on the team — a value
// published in every commit, redacted from the record of the work that
// produced it.

/**
 * A broker-held runner environment variable. Same shape as `Secret`;
 * the difference is in what may be read and what gets redacted, not in
 * the metadata.
 */
export interface Variable {
  id: string;
  slug: string;
  /** Target environment variable name (validated, reserved names rejected). */
  envName: string;
  /** Freeform admin label / purpose note. */
  description: string;
  enabled: boolean;
  /** When true, every team member receives this variable. */
  allMembers: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** Per-viewer summary returned from `GET /variables`. */
export interface VariableSummary extends Variable {
  /** Whether a value is set. */
  hasValue: boolean;
  /** Whether the caller is bound (directly or via allMembers). */
  bound: boolean;
  /**
   * The value itself, in the clear. Present only for callers holding
   * `secrets.manage` — a variable is not secret, but who may configure
   * the team's runner environment is still a privileged question.
   */
  value?: string;
}

export interface ListVariablesResponse {
  variables: VariableSummary[];
}

export interface GetVariableResponse {
  variable: VariableSummary;
  /** Bound member names. Only present for viewers with `secrets.manage`. */
  boundMembers?: string[];
}

export interface CreateVariableRequest {
  slug: string;
  envName: string;
  description?: string;
  allMembers?: boolean;
  enabled?: boolean;
}

export interface UpdateVariableRequest {
  envName?: string;
  description?: string;
  allMembers?: boolean;
  enabled?: boolean;
}

export interface SetVariableValueRequest {
  value: string;
}

export interface BindVariableRequest {
  member: string;
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
 * `POST /enroll` response. Shape mirrors RFC 8628 §3.2, with the
 * field names camelCased to match the rest of the wire.
 *
 * `verificationUri` and `verificationUriComplete` are RELATIVE paths;
 * the CLI joins them with its configured broker URL. There is no
 * fully-qualified poll hint on this response — the caller polls the
 * enrollment endpoint it already knows, with `deviceCode`.
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

/**
 * Whether an amendment binds work that was already underway.
 *
 * The amender states this; it is not inferable from the text. A
 * criterion struck because it asserted something untrue is a
 * `correction` and work was never validly held to it. A criterion
 * added mid-flight is a `scope_change` and is a new demand on work
 * already in progress.
 *
 * An amender who cannot say which one it is has not finished thinking
 * about the amendment.
 */
export type AmendmentDisposition = 'correction' | 'scope_change';

// ─────────────────────── Team process document ────────────────────

/**
 * What an edit may change. Mirrors `EDITABLE_PROCESS_DOCUMENT_SHAPE`
 * in schemas.ts, which is the single runtime source that also drives
 * the request schema and the history record's `previous` map.
 */
export type ProcessDocumentField = 'text';

/**
 * The team's process, as one authored document.
 *
 * There is at most one per team. `version` is 1 after the first write
 * and increments on every edit; `createdBy` is whoever wrote version 1
 * and never changes, `updatedBy` is whoever wrote the current version.
 */
export interface ProcessDocument {
  text: string;
  version: number;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
}

/**
 * One entry in the append-only edit history.
 *
 * `previous` is empty for version 1 (creation has no prior text) and
 * carries the superseded text for every later version. The diff is
 * DERIVED from prior and current text, never stored — a cached diff is
 * a second copy that can drift from the text it describes, which is
 * the defect this whole feature treats.
 */
export interface ProcessDocumentEdit {
  /** The version this edit produced. */
  version: number;
  ts: number;
  actor: string;
  reason: string;
  disposition: AmendmentDisposition;
  fields: ProcessDocumentField[];
  previous: { text?: string };
}

export interface EditProcessDocumentRequest {
  text?: string;
  /** Required. What a reader has instead of the conversation you are in. */
  reason: string;
  /**
   * `correction` — retroactive; the prior text was never validly
   * binding. `scope_change` — forward-only; work already underway
   * finishes under the prior text. Same field and meaning as an
   * spine contract amendment, so "does work started under the old
   * process finish under it" has one answer across both.
   */
  disposition: AmendmentDisposition;
}

export interface GetProcessDocumentResponse {
  /** `null` when none has been set — an explicit state, not an absent field. */
  document: ProcessDocument | null;
}

export interface ProcessDocumentHistoryResponse {
  edits: ProcessDocumentEdit[];
}

// ─────────────────────────── Activity / Traces ────────────────────────

/**
 * Trace capture — one structured model exchange normalized from an
 * agent's native instrumentation (Claude Code's OpenTelemetry export,
 * the codex app-server stream). Each entry represents a single model
 * exchange the agent made while working, parsed from
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
  /** Exclusive composite cursor for oldest-first traversal. */
  cursor?: { ts: number; id: number };
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
 * do" — LLM exchanges, tool actions and prompts, bracketed per run by
 * `session_start` / `session_end`.
 */
export type ActivityEvent =
  | ActivitySessionStart
  | ActivitySessionEnd
  | ActivityLlmExchange
  | ActivityToolAction
  | ActivityUserPrompt;

export type ActivityKind = ActivityEvent['kind'];

/**
 * A runner session opened — the member's agent process came up under a
 * csuite runner. Emitted once per `csuite <runner>` invocation, before
 * any other activity of the run. Together with `session_end` it
 * brackets a run, so consumers can slice the stream per run
 * regardless of which agent produced it.
 */
export interface ActivitySessionStart {
  readonly kind: 'session_start';
  readonly ts: number;
  /** Runner id (`'claude-code'`, `'codex'`, ...). */
  readonly runner: string;
  /** csuite CLI version hosting the run. */
  readonly runnerVersion?: string;
  /** The runner's declared capture tier (0 operable … 3 full fidelity). */
  readonly captureTier?: number;
}

/**
 * The runner session ended — the terminal event of a run and the
 * machine-readable run summary. Every runner emits the same shape on
 * every exit path (agent exit, SIGINT/SIGTERM, crash teardown), so
 * cross-agent analysis never depends on per-runner log formats.
 */
export interface ActivitySessionEnd {
  readonly kind: 'session_end';
  readonly ts: number;
  /** Runner id (`'claude-code'`, `'codex'`, ...). */
  readonly runner: string;
  /** Why the session ended (`'agent-exited-0'`, `'SIGINT'`, ...). */
  readonly reason: string;
  /** Agent process exit code, when one was observed. */
  readonly exitCode?: number;
  /** Wall-clock duration of the session. */
  readonly durationMs: number;
  /** Agent-native session identity (codex thread id, ...), when known. */
  readonly agentSessionId?: string;
  /**
   * Capture accounting as of teardown: how many activity events the
   * runner's uploader saw, shipped, and dropped. Absent under
   * `--no-trace`. `dropped > 0` means the trace on the broker is
   * incomplete for this run.
   */
  readonly capture?: {
    readonly enqueued: number;
    readonly uploaded: number;
    readonly dropped: number;
    /** Peak instantaneous queue occupancy in events, when reported by the runner. */
    readonly peakQueuedEvents?: number;
    /** Peak serialized UTF-8 event payload queued at once, when reported by the runner. */
    readonly peakQueuedBytes?: number;
  };
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
 * turn a real opener WITHOUT depending on request-body capture at all.
 *
 * (The original rationale was that OTEL's INLINE body mode truncates
 * large prompts at ~60 KB. The runner no longer uses inline mode — it
 * sets `OTEL_LOG_RAW_API_BODIES=file:<dir>`, which writes complete
 * untruncated bodies — so that truncation no longer applies. The hook
 * remains the right source because it yields the opener directly rather
 * than requiring a body to be parsed for it.)
 *
 * The text is redacted runner-side before it leaves the process, so the
 * schema only validates shape.
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
  /** Exclusive composite cursor for newest-first traversal. */
  readonly cursor?: { ts: number; id: number };
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
  /**
   * Whether the requesting viewer may mutate this entry — the server's
   * `canWrite()` predicate, evaluated per request. Optional: an older
   * server omits it. Treat `undefined` as unknown rather than false, and
   * do not reconstruct the rule from `owner` — the rule is the
   * server's and a client cannot evaluate it for an arbitrary path.
   */
  canWrite?: boolean;
}

/**
 * Lightweight file reference embedded in a `Message`.
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

// ─────────────────────────────── Spine ────────────────────────────────
//
// The team's spine: one append-only annex of captioned events, the
// subjects those events are about, and the contracts folded out of
// them.
//
// The register is deliberately legal-epistemic — contract, verdict,
// ruling, testimony — because the vocabulary carries the behavioural
// priors an agent member needs before any instruction exists.
//
// Everything here is a photograph with a caption. A caption that is
// optional is a caption that will be missing exactly when it matters,
// so the required fields below are the ones without which the record
// silently lies once the world moves.

/**
 * What an event IS, epistemically. The three that matter are already
 * distinguishable here: an `observation` is the author's own flash, a
 * `testimony` is their account of someone else's, and a
 * `specification` is authored intent with no flash at all.
 *
 * The list is closed. A kind nobody can name is a kind nothing can
 * cite, and an uncitable event is inert.
 */
export const SPINE_EVENT_KINDS = [
  'observation',
  'testimony',
  'specification',
  'amendment',
  'attempt',
  'criterion_verdict',
  'ruling',
  'ask',
  'ask_action',
  'proceeding',
  'lifecycle',
  'correction',
  'discussion',
  'promotion',
  'focus',
] as const;

export type SpineEventKind = (typeof SPINE_EVENT_KINDS)[number];

/**
 * Whether an event moves a contract's `state_rev`.
 *
 * `authoritative` events carry a precondition and advance the counter;
 * `ambient` events never do. The split is what makes "a busy thread
 * can never veto a lifecycle act, and a lifecycle act can never sneak
 * past a verdict it didn't see" true at the same time.
 */
export type SpineEventClass = 'authoritative' | 'ambient';

/**
 * THE single statement of which kinds move a contract.
 *
 * One map, keyed by the closed kind list, so a new kind cannot be
 * added without someone answering the question — and so the store,
 * the schemas and the routes cannot disagree about the answer. A kind
 * whose class is decided in three places is a kind whose precondition
 * is enforced in two.
 *
 * `observation`, `testimony` and `discussion` are ambient: the room
 * moving, and the team talking about it, must never be able to veto a
 * lifecycle act. Everything else is a change to what the team owes.
 */
export const SPINE_EVENT_CLASSES: Record<SpineEventKind, SpineEventClass> = {
  observation: 'ambient',
  testimony: 'ambient',
  discussion: 'ambient',
  specification: 'authoritative',
  amendment: 'authoritative',
  attempt: 'authoritative',
  criterion_verdict: 'authoritative',
  ruling: 'authoritative',
  ask: 'authoritative',
  ask_action: 'authoritative',
  proceeding: 'authoritative',
  lifecycle: 'authoritative',
  correction: 'authoritative',
  promotion: 'authoritative',
  // Focus is a DECISION, not chatter: lighting a contract for travel
  // carries the same op_id idempotency and state_rev precondition as
  // any other authoritative act, and it generates the class-2 delta
  // that tells subscribers the contract entered (or left) the team's
  // focus set. It is deliberately NOT citation-locked — curating what
  // is lit is not an act on the world that a pending ask should gate.
  focus: 'authoritative',
};

/** The states from which no further authoritative event is accepted, correction excepted. */
export const SPINE_TERMINAL_STATES = ['done', 'cancelled', 'superseded'] as const;

/**
 * The kinds the CITATION LOCK binds — the acts that change what the
 * team owes, as against the acts that ask, answer, or talk.
 *
 * Published here rather than kept inside the store for the same reason
 * `SPINE_EVENT_CLASSES` is: the rule is stated in three places that
 * must not drift — the store enforces it, the tool descriptions teach
 * it, and an agent reading the refusal has to recognise the list it
 * names. A kind whose lockedness is decided in three places is a kind
 * that is locked in two.
 *
 * Everything absent from this list is deliberately absent.
 * `discussion`, `observation` and `testimony` are never locked because
 * the conversation must never become expensive; `ask`, `ruling`,
 * `ask_action` and `proceeding` are never locked because they are the
 * lock's own exits, and locking them would leave a member with an open
 * ask no legal move at all; `correction` is never locked because
 * stapling a correction is the only way a record ever becomes less
 * wrong; `promotion` is never locked because the typed event it
 * produces is locked on its own merits.
 */
export const SPINE_CITATION_LOCKED_KINDS = [
  'specification',
  'amendment',
  'attempt',
  'criterion_verdict',
  'lifecycle',
] as const;

/**
 * Native events were written by this system. `legacy_projection` marks
 * history imported from a predecessor, and it is permanent — an
 * imported row never acquires native status, because nobody ever took
 * that photograph.
 */
export type SpineProvenance = 'native' | 'legacy_projection';

/** The regions of the world a contract can be about. */
export type SpineSubjectType = 'repo' | 'pr' | 'file' | 'issue' | 'setting' | 'package' | 'doc';

/**
 * How a revision was obtained. `observed` means someone (or some
 * integration) looked; `asserted` means a member named it by hand.
 * Only `observed` revisions move a subject's head, so a member's
 * assertion can never make someone else's contract stale.
 */
export type SpineRevisionHow = 'observed' | 'asserted';

/** One verdict's answer about one criterion at one revision. */
export type SpineVerdictDecision = 'met' | 'unmet' | 'cannot_verify';

/** The lifecycle states of a contract. `done`, `cancelled` and `superseded` are terminal. */
export type SpineContractState =
  | 'active'
  | 'waiting_on'
  | 'waiting_for'
  | 'parked'
  | 'done'
  | 'cancelled'
  | 'superseded';

/** What an `ask_action` does to an outstanding ask. */
export type SpineAskAction = 'withdraw' | 'decline' | 'redirect' | 'defer';

/**
 * Where an ask stands. `open` and `deferred` are the states the
 * citation lock binds on — the two in which the question is still
 * unanswered.
 *
 * THERE IS NO `redirected`. A redirect re-addresses the question
 * rather than resolving it: the ask stays `open` with a new
 * `authority`, and the `ask_action` event records who moved it and
 * why. A state meaning "resolved by being handed on" would be a lie
 * about an ask nobody has answered, and it silently released the asker
 * from the lock at the exact moment their authority said "not me".
 *
 * `discharged` is the armed-setting class of ask (§9), and it is the
 * one resolution NO MEMBER TYPED: the asker armed a check on the ask,
 * the world did the thing, the probe observed it, and the authority's
 * queue item closed with that observation stapled to it. It is a real
 * resolution — the question has an answer — so it releases the citation
 * lock exactly as a ruling does.
 */
export type SpineAskState = 'open' | 'ruled' | 'withdrawn' | 'declined' | 'deferred' | 'discharged';

/**
 * A region of the world, registered before anything can be said about
 * it. `parent` is declared at registration and containment resolves
 * transitively, so a rule stated on a repo reaches a file inside it.
 */
export interface SpineSubject {
  id: string;
  type: SpineSubjectType;
  /** `null` for a root subject. Never retargeted after registration. */
  parent: string | null;
  registeredBy: string;
  /** ISO-8601. */
  at: string;
}

/**
 * An immutable observation point on a subject.
 *
 * There is deliberately no shape here that can carry a bare value:
 * `"verified at abc123"` cannot be serialized without `"observed at
 * 03:19:02 from the GitHub review event"` riding along. Honesty
 * enforced by the shape of the data rather than by a reviewer noticing.
 */
export interface SpineRevision {
  id: string;
  subject: string;
  value: string;
  how: SpineRevisionHow;
  /** Who or what produced it: `integration:github`, `member:rune`, … */
  source: string;
  /** ISO-8601. */
  at: string;
}

/** What a caller supplies to bind a revision. Every caption field required. */
export interface SpineRevisionInput {
  subject: string;
  value: string;
  how: SpineRevisionHow;
  source: string;
  /** ISO-8601. Defaults to the append instant. */
  at?: string;
}

/** One acceptance criterion inside a `specification`. Prose, not a predicate. */
export interface SpineCriterion {
  id: string;
  text: string;
}

// ─── Per-kind bodies ─────────────────────────────────────────────────

export interface SpineObservationBody {
  what: string;
  output: string;
}

export interface SpineTestimonyBody {
  what: string;
  account: string;
  /** Whose flash this is an account of. */
  observer: string;
}

export interface SpineSpecificationBody {
  title: string;
  criteria: SpineCriterion[];
  assignee: string;
  /** Named ⇒ completion needs verdicts. Absent ⇒ the result stands alone and says so. */
  verifier?: string;
  /** Whose rulings bind this contract. */
  authority?: string;
  constraints?: string[];
}

export interface SpineAmendmentBody {
  contract: string;
  changes: string;
  reason: string;
  /** `correction` — the prior text was never validly binding. `scope_change` — forward-only. */
  disposition: AmendmentDisposition;
  title?: string;
  criteria?: SpineCriterion[];
  constraints?: string[];
  /** Required when the amendment removes text. What the reader already saw cannot be unseen. */
  disclosure?: string;
}

export interface SpineAttemptBody {
  contract: string;
  summary: string;
}

export interface SpineCriterionVerdictBody {
  contract: string;
  criterion: string;
  decision: SpineVerdictDecision;
  evidence: string;
  /** Required on `cannot_verify`. A verdict that cannot say why is not a verdict. */
  why?: string;
}

export interface SpineRulingBody {
  ask: string;
  decision: string;
  reasoning: string;
  /** Set when the ruling binds a contract — that is what makes it citable at completion. */
  contract?: string;
}

export interface SpineAskBody {
  authority: string;
  question: string;
  context: string;
  /** What this ask is holding up. Required: an ask nobody can price is an ask nobody answers. */
  unblocks: string;
  contract?: string;
  trigger?: string;
  check?: string;
}

export interface SpineAskActionBody {
  ask: string;
  action: SpineAskAction;
  reason: string;
  /** Required on `redirect`. */
  redirectTo?: string;
  /** Optional on `defer` — the ask comes back armed. */
  trigger?: string;
}

export interface SpineProceedingBody {
  ask: string;
  reason: string;
}

export interface SpineLifecycleBody {
  contract: string;
  state: SpineContractState;
  reason?: string;
  /** `waiting_on` — the named member who can act. */
  member?: string;
  /** `waiting_for` — the event being waited on. */
  event?: string;
  /** `waiting_for` — the check that will re-light it. */
  check?: string;
  /** `parked` — what took priority. */
  preemptedBy?: string;
  /** `done` — the completion result. No cap: it is the durable one. */
  result?: string;
  /** `superseded` — the contract that carries the work forward. */
  successor?: string;
}

export interface SpineCorrectionBody {
  correction: string;
}

export interface SpineDiscussionBody {
  body: string;
  contract?: string;
}

export interface SpinePromotionBody {
  /** The typed kind the cited discussion is being promoted into. */
  as: SpineEventKind;
  note?: string;
}

/**
 * A focus-membership act (D9): a contract enters or leaves the team's
 * focus set — the shared boundary of what is lit for travel now.
 *
 * ONE KIND, a direction, and a reason. `lit: true` lights the contract
 * (it enters the set); `lit: false` unlights it. A boolean rather than
 * two kinds because entering and leaving are the same act in opposite
 * directions, and the projection is a SET — every focus event flips a
 * contract's membership, so re-lighting an already-lit contract (or
 * unlighting an unlit one) is refused rather than recorded as a no-op.
 *
 * The `reason` is required because membership is AUTHORED, never
 * derived: a contract is lit because a permissioned member said so, on
 * the record, with a reason someone can read later (§10 — the system
 * never takes the photos).
 */
export interface SpineFocusBody {
  contract: string;
  /** `true` lights the contract into the focus set; `false` unlights it. */
  lit: boolean;
  reason: string;
}

export type SpineEventBody =
  | SpineObservationBody
  | SpineTestimonyBody
  | SpineSpecificationBody
  | SpineAmendmentBody
  | SpineAttemptBody
  | SpineCriterionVerdictBody
  | SpineRulingBody
  | SpineAskBody
  | SpineAskActionBody
  | SpineProceedingBody
  | SpineLifecycleBody
  | SpineCorrectionBody
  | SpineDiscussionBody
  | SpinePromotionBody
  | SpineFocusBody;

/**
 * One captioned photograph in the annex.
 *
 * `seq` is the stream cursor — global, gapless, and the only thing
 * recovery needs. `stateRev` is the per-contract counter this event
 * produced when it was authoritative and bound to a contract; it is
 * `null` otherwise, which is a different statement from `0`.
 */
export interface SpineEvent {
  seq: number;
  id: string;
  kind: SpineEventKind;
  class: SpineEventClass;
  subject: string | null;
  /**
   * The revision this event was captioned with, WHOLE.
   *
   * An id here was the last place a derived value still rendered bare,
   * and it was the worst one: an event is what a stale refusal returns
   * as its delta, so a member being told what they raced was handed a
   * verdict reading "met at rev_01H…" — the exact recovery moment the
   * caption exists for, and the one payload with no second call
   * available to resolve it.
   */
  revision: SpineRevision | null;
  actor: string;
  /** For probe results: whose recipe fired. The member took the photo; the system held the camera. */
  authoredBy: string | null;
  /** ISO-8601. */
  at: string;
  provenance: SpineProvenance;
  opId: string | null;
  cites: string[];
  staplesTo: string | null;
  body: SpineEventBody;
  /** The contract this event is about, when it is about one. */
  contract: string | null;
  /** The contract's `state_rev` after this event. `null` when the event moved no contract. */
  stateRev: number | null;
}

/** A verdict as the contract projection holds it — latest per criterion per revision. */
export interface SpineCriterionStatus {
  criterion: string;
  text: string;
  decision: SpineVerdictDecision | null;
  /**
   * The revision the decision was reached at, WHOLE.
   *
   * An id here would be a derived value rendering bare — "met at
   * rev_01H…" says nothing a reader can act on, and there is no route
   * that resolves one. The caption travels with the verdict or the
   * verdict is not evidence.
   */
  revision: SpineRevision | null;
  /** The verdict event, so a reader can go and look. */
  event: string | null;
  /** A `cannot_verify` waived by the authority's ruling. Carries the ruling's event id. */
  waivedBy: string | null;
  /**
   * Whether `revision` is the revision the CONTRACT is bound to.
   *
   * A verdict is true of a revision, so a headline `unmet` reached at
   * a revision the contract has since moved off is a different claim
   * from an `unmet` at the revision the contract is sitting on — and
   * rendering both as "unmet" collapses them. `false` here is the
   * reader's cue that the decision and the contract are talking about
   * different states of the world.
   *
   * `false` when either side has no revision, since a relation needs
   * two operands.
   */
  atBoundRevision: boolean;
}

/**
 * A contract, folded out of the events that made it. Rebuildable from
 * `spine_events` alone — the annex is the only truth.
 */
export interface SpineContract {
  id: string;
  title: string;
  state: SpineContractState;
  /** Advanced only by authoritative events on this contract. */
  stateRev: number;
  /** Bumped by each amendment. */
  version: number;
  subject: string;
  /**
   * The revision the contract is bound to, WHOLE.
   *
   * Both operands of `stale` are hydrated for the same reason: a
   * staleness flag served with two opaque ids tells a member they are
   * behind and nothing about what they are behind.
   */
  revision: SpineRevision | null;
  criteria: SpineCriterion[];
  assignee: string;
  verifier: string | null;
  authority: string | null;
  constraints: string[];
  createdBy: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt: string;
  /** `waiting_on`. */
  waitingOn: string | null;
  /** `waiting_for` — what the room has to do. */
  waitingFor: { event: string; check: string } | null;
  /** `parked`. */
  preemptedBy: string | null;
  /** `done`. */
  result: string | null;
  /** `cancelled`, or any state whose author gave a reason. */
  reason: string | null;
  /** `superseded` — the contract carrying the work forward. Never retargeted. */
  successor: string | null;
  /**
   * The bound revision is no longer the subject's latest OBSERVED
   * revision. A reported state, never an edit — nothing retargets.
   */
  stale: boolean;
  /** The subject's latest observed revision, when there is one. WHOLE, like `revision`. */
  head: SpineRevision | null;
  /**
   * Whether this contract is in the team's FOCUS SET (D9) — the
   * EFFECTIVE set: its latest focus event is `lit` **and** it has not
   * reached a terminal state. A reported state, never derived: a
   * contract is in focus because a permissioned member lit it.
   *
   * `false` in three ways, and the third is the one to know about:
   * nobody ever lit it, somebody unlit it, or **it ended**. A lit
   * contract that reaches `done`/`cancelled`/`superseded` leaves the
   * set the moment it does, with no act required — and no act is
   * possible, since every authoritative event on a terminal contract is
   * refused, `focus` included. The focus set is what is lit for TRAVEL
   * now, and finished work is not travel.
   *
   * One definition, everywhere: this flag, `?focus=true`, and the
   * curator's own gate all read `lit ∧ non-terminal`, so a reader is
   * never shown a plate the scheduler does not act on. The raw
   * membership row is not lost — it survives in the focus events, which
   * are what the record is made of.
   *
   * Out-of-focus is attention-silence, not record-absence: a contract
   * with `inFocus: false` stays fully in the annex, in this list, and in
   * its owner's queue — it only stops spending the team's album on
   * ambient (class-2) traffic.
   */
  inFocus: boolean;
}

/** An outstanding request for a ruling. */
export interface SpineAsk {
  id: string;
  authority: string;
  asker: string;
  subject: string | null;
  contract: string | null;
  question: string;
  context: string;
  unblocks: string;
  state: SpineAskState;
  /** The event that resolved it — a ruling or an ask_action. */
  resolvedBy: string | null;
  /** ISO-8601. */
  at: string;
}

// ─── Requests ────────────────────────────────────────────────────────

/**
 * Captions every kind may carry. The ones a kind MUST carry are
 * redeclared as required on that kind's variant below.
 */
interface SpineAppendCaptions {
  subject?: string;
  /** Fully captioned or absent. There is no id-only form. */
  revision?: SpineRevisionInput;
  cites?: string[];
  /** Correction/disclosure target. Any event, including a terminal one. */
  staplesTo?: string;
  authoredBy?: string;
}

/**
 * The single append path, as FOURTEEN VARIANTS rather than one shape
 * with everything optional.
 *
 * The difference is the whole point. "A correction must staple to
 * something" written as an optional field plus a runtime check is a
 * rule enforced once, at the boundary a caller happens to cross. As a
 * variant it is enforced by the compiler at every call site in the
 * repo, and `spine-boundary.test-d.ts` puts the hostile calls in front
 * of `tsc` so the claim cannot rot into a comment.
 *
 * Two directions are encoded, not one. `opId` is REQUIRED on every
 * authoritative kind — a lost response is a miniature album dump and
 * the retry has to be free — and FORBIDDEN (`never`) on the ambient
 * ones, so a caller cannot make discussion look durable by handing it
 * an idempotency key. A specification likewise forbids
 * `expectedStateRev`: it creates the contract, so there is no prior
 * counter it could be expecting.
 */
export type AppendSpineEventRequest =
  // ── Ambient: no idempotency key, no precondition ──
  | (SpineAppendCaptions & {
      kind: 'observation';
      /** A flash is always OF somewhere. */
      subject: string;
      body: SpineObservationBody;
      opId?: never;
      expectedStateRev?: never;
    })
  | (SpineAppendCaptions & {
      kind: 'testimony';
      subject: string;
      body: SpineTestimonyBody;
      opId?: never;
      expectedStateRev?: never;
    })
  | (SpineAppendCaptions & {
      kind: 'discussion';
      body: SpineDiscussionBody;
      opId?: never;
      expectedStateRev?: never;
    })
  // ── Authoritative ──
  | (SpineAppendCaptions & {
      kind: 'specification';
      subject: string;
      body: SpineSpecificationBody;
      opId: string;
      expectedStateRev?: never;
    })
  | (SpineAppendCaptions & {
      kind: 'amendment';
      body: SpineAmendmentBody;
      opId: string;
      expectedStateRev: number;
    })
  | (SpineAppendCaptions & {
      kind: 'attempt';
      body: SpineAttemptBody;
      opId: string;
      expectedStateRev: number;
    })
  | (SpineAppendCaptions & {
      kind: 'criterion_verdict';
      /** A verdict is true of a revision or it is true of nothing. */
      revision: SpineRevisionInput;
      body: SpineCriterionVerdictBody;
      opId: string;
      expectedStateRev: number;
    })
  | (SpineAppendCaptions & {
      kind: 'ruling';
      body: SpineRulingBody;
      opId: string;
      /** Required exactly when the body names a contract. */
      expectedStateRev?: number;
    })
  | (SpineAppendCaptions & {
      kind: 'ask';
      body: SpineAskBody;
      opId: string;
      /** Required exactly when the body names a contract. */
      expectedStateRev?: number;
    })
  | (SpineAppendCaptions & {
      kind: 'ask_action';
      body: SpineAskActionBody;
      opId: string;
      expectedStateRev?: number;
    })
  | (SpineAppendCaptions & {
      kind: 'proceeding';
      subject: string;
      body: SpineProceedingBody;
      opId: string;
      expectedStateRev?: number;
    })
  | (SpineAppendCaptions & {
      kind: 'lifecycle';
      body: SpineLifecycleBody;
      opId: string;
      expectedStateRev: number;
    })
  | (SpineAppendCaptions & {
      kind: 'correction';
      /** A correction that staples to nothing is a second claim, not a correction. */
      staplesTo: string;
      body: SpineCorrectionBody;
      opId: string;
      expectedStateRev?: number;
    })
  | (SpineAppendCaptions & {
      kind: 'promotion';
      /** Exactly one origin post. */
      cites: string[];
      body: SpinePromotionBody;
      opId: string;
      expectedStateRev?: number;
    })
  | (SpineAppendCaptions & {
      kind: 'focus';
      body: SpineFocusBody;
      opId: string;
      /** Always required: focus is an authoritative act on the contract it lights. */
      expectedStateRev: number;
    });

export interface RegisterSpineSubjectRequest {
  id: string;
  type: SpineSubjectType;
  parent?: string;
}

export interface ListSpineEventsQuery {
  /** Exclusive lower bound on `seq`. Omit to start at the beginning. */
  since_seq?: number;
  limit?: number;
  kind?: SpineEventKind;
  subject?: string;
  contract?: string;
  actor?: string;
}

export interface ListSpineSubjectsQuery {
  type?: SpineSubjectType;
  /** Direct children only. */
  parent?: string;
  /** Transitive containment: this subject and everything inside it. */
  within?: string;
}

export interface ListSpineContractsQuery {
  state?: SpineContractState;
  /** Contracts where this member is assignee, verifier, or authority. */
  member?: string;
  subject?: string;
  /**
   * The team's focus set, EFFECTIVE: contracts whose latest focus event
   * is `lit` **and** that have not reached a terminal state. The
   * allocator's whole-plate view (#155 finding 8) — what is lit for
   * travel now, across the whole team, not only the caller's own
   * bindings. Reading it is baseline; only lighting is permissioned.
   *
   * The terminal narrowing is what keeps the plate from accumulating the
   * dead: a lit contract that completes can never be unlit (every
   * authoritative act on a terminal contract is refused, `focus`
   * included), so raw membership would weld finished work onto this view
   * with no act able to clear it — and completing lit work is the
   * prescribed way the set empties, so that is the normal path rather
   * than an edge case. The same predicate as `SpineContract.inFocus` and
   * as the curator's own gate: one meaning of "in focus".
   */
  focus?: boolean;
}

// ─── Responses ───────────────────────────────────────────────────────

export interface AppendSpineEventResponse {
  event: SpineEvent;
  /** The contract as it stands after the append, when the event named one. */
  contract: SpineContract | null;
  /** True when an `opId` replay resolved to an event that already existed. */
  replayed: boolean;
}

export interface ListSpineEventsResponse {
  events: SpineEvent[];
  /**
   * Feed this back as `since_seq`. `null` when the page reached the
   * head — which is a different statement from an empty page.
   */
  nextCursor: number | null;
  /** The annex head at the moment the page was cut. */
  headSeq: number;
}

export interface GetSpineEventResponse {
  event: SpineEvent;
}

export interface RegisterSpineSubjectResponse {
  subject: SpineSubject;
}

export interface ListSpineSubjectsResponse {
  subjects: SpineSubject[];
}

export interface ListSpineContractsResponse {
  contracts: SpineContract[];
}

export interface GetSpineContractResponse {
  contract: SpineContract;
}

// ─── Refusal payloads ────────────────────────────────────────────────
//
// The refusal IS the re-injection. These are what a caller gets back
// instead of a hint, delivered at exactly the moment stale beliefs
// would have caused harm.

export interface SpineStaleStateRevDetail {
  contract: string;
  expectedStateRev: number;
  currentStateRev: number;
  /** In full, not as ids. A caller that must fetch to understand has been told nothing useful. */
  intervening: SpineEvent[];
}

export interface SpineCoverageGapDetail {
  contract: string;
  /**
   * The revision the completion named, as it was supplied.
   *
   * The CAPTION, not an id — at the moment coverage is checked the
   * revision has not been written, so there is no id to give, and a
   * `null` here while the value sat in scope was the refusal failing
   * its own "never render bare" rule.
   */
  revision: SpineRevisionInput | null;
  /** Every criterion the completion does not cover, and why it does not. */
  missing: { criterion: string; text: string; why: string }[];
}

/**
 * A precondition that was not merely wrong but unusable: absent, or
 * naming a counter the contract has never reached.
 *
 * Separate from `SpineStaleStateRevDetail` because neither of these
 * has a delta. Reporting "you are behind, here are 0 events" for a
 * caller who is AHEAD is a refusal that contradicts itself, and a
 * caller cannot act on a contradiction.
 */
export interface SpinePreconditionDetail {
  contract: string;
  /** Where in the request the problem is, matching the shape zod would have produced. */
  path: string[];
  currentStateRev: number;
  /** `missing` — none supplied. `ahead` — supplied a counter the contract has never reached. */
  problem: 'missing' | 'ahead';
  suppliedStateRev: number | null;
}

/**
 * A write to a contract that has ended.
 *
 * Distinct from `SpineStaleStateRevDetail` because of one field: a
 * caller who supplied NO precondition must not have one echoed back at
 * them. Reporting `expectedStateRev: <the contract's own counter>` for
 * a caller who sent nothing invents a belief they never held, which is
 * the same class of lie as a bare derived value.
 */
export interface SpineTerminalDetail {
  contract: string;
  state: SpineContractState;
  currentStateRev: number;
  /** `null` when the caller supplied none. */
  suppliedStateRev: number | null;
  /** The authoritative events the caller missed, in full. Empty when they missed none. */
  intervening: SpineEvent[];
}

export interface SpineIdempotencyConflictDetail {
  opId: string;
  /** The event the id already resolved to. */
  originalEvent: string;
}

/**
 * The citation lock's refusal: the actor has an unresolved ask covering
 * what they just tried to change.
 *
 * The asks ride WHOLE rather than as ids, and that is the anti-
 * confabulation mechanism working rather than a courtesy. The failure
 * this closes is a member acting on an authorisation they remember
 * receiving; handing back `ask_01H…` invites them to remember what it
 * said. Handing back the question, the authority it went to, and what
 * it unblocks makes "did anyone actually decide this?" a thing the
 * refusal has already answered.
 */
export interface SpineCitationRequiredDetail {
  /** The subject the act landed on, after resolving through its contract. */
  subject: string;
  kind: SpineEventKind;
  contract: string | null;
  /**
   * The subject and every subject containing it — the scope that was
   * searched. A repo-level ask reaches an act on a file inside it, and
   * a member who cannot see the walk cannot tell why.
   */
  scope: string[];
  /** Every unresolved ask by this actor in that scope. Whole, not ids. */
  asks: SpineAsk[];
}

/** How the calling member is bound to a contract. */
export type SpineBinding = 'assignee' | 'verifier' | 'authority';

/** One contract as the Guaranteed Pack renders it. */
export interface OrientContract {
  /** Every way this member is bound, so a verifier who is also the authority sees both. */
  bindings: SpineBinding[];
  contract: string;
  title: string;
  state: SpineContractState;
  stateRev: number;
  criteria: SpineCriterionStatus[];
  subject: SpineSubject;
  revision: SpineRevision | null;
  /** The bound revision is behind the subject's head. Reported, never repaired. */
  stale: boolean;
  head: SpineRevision | null;
  /**
   * Whether this binding is in the team's focus set (D9) — lit AND not
   * yet ended, the same EFFECTIVE set `SpineContract.inFocus` reports.
   * Lets a member's `orient` distinguish in-focus from out-of-focus
   * bindings — out-of-focus work still reaches them here and as class 1,
   * but generates no ambient class-2 traffic.
   */
  inFocus: boolean;
  /** Rulings that bind this contract, newest last. */
  rulings: SpineEvent[];
}

/**
 * v0 of the Guaranteed Pack: what any member is promised on recovery,
 * small and fixed. Server-composed, one cheap call, and the only
 * recovery path there is.
 */
export interface OrientPack {
  member: string;
  /** ISO-8601 instant the pack was composed. Everything in it is true as of here. */
  at: string;
  /** The annex head. Feed to `GET /spine/events?since_seq=` for everything else. */
  cursor: number;
  contracts: OrientContract[];
  /** Asks awaiting this member's ruling. */
  asksForMe: SpineAsk[];
  /** This member's own asks that are still open. */
  myOpenAsks: SpineAsk[];
}

// ─── The human seat: the Queue ───────────────────────────────────────
//
// §9. The director is a member with the smallest album and the rarest
// flash, and the Queue is their orient pack rendered down to the two
// things that are theirs to move: asks awaiting their ruling, and
// contracts stuck on them. It is a READ, and a read that changes
// nothing — VISITING IS NOT HANDLING. The only thing that takes an item
// off the Queue is a resolving event landing (a ruling, an ask_action,
// a lifecycle move), never the human opening it and never the read
// itself. That is why the Queue does not ride `orient`: an orient
// advances a receipt, and a receipt advanced by looking would let the
// system mark its own homework.

/**
 * One ask awaiting this member's ruling, WITH the contract it is about.
 *
 * The contract rides WHOLE and not as an id because every act the human
 * can take on a contract-bound ask — defer, decline, redirect — is an
 * authoritative write on that contract and so must carry its current
 * `stateRev` as the precondition. Handing the id alone would make the
 * queue a screen a member cannot act from without a second call, and
 * the second call is a race. `null` when the ask names no contract, in
 * which case those acts carry no precondition.
 */
export interface SpineQueueAskItem {
  ask: SpineAsk;
  contract: SpineContract | null;
}

/**
 * The human seat's Queue: what is theirs to move, and nothing else.
 *
 * `asks` are OPEN asks where this member is the authority — deliberately
 * NOT deferred ones, because a defer re-arms the ask and it leaves the
 * queue until its trigger fires (the armed-setting shape of §9). Orient
 * keeps deferred asks; the Queue does not, and that difference is the
 * "an item leaves when its resolving event lands" property made visible.
 */
export interface SpineQueue {
  member: string;
  /** ISO-8601 instant the queue was read. Everything in it is true as of here. */
  at: string;
  /** Open asks awaiting this member's ruling. Question, context and unblocks ride verbatim. */
  asks: SpineQueueAskItem[];
  /** Contracts stuck on this member — `waiting_on(you)`. */
  waitingOn: SpineContract[];
}

export interface GetSpineQueueQuery {
  /** Defaults to the caller. The Queue is a free annex read, so naming another member is allowed. */
  member?: string;
}

export interface GetSpineQueueResponse {
  queue: SpineQueue;
}

/**
 * The four human acts, as CLIENT SHAPES over the single append path.
 *
 * There is deliberately no agent tool for any of these — §2 gives
 * humans levers 2–4 through the web UI, and these are that surface. Each
 * is one append: a `dictate a ruling` is a `ruling`, and defer / decline
 * / redirect are the three `ask_action`s an authority takes on an ask
 * they will not (yet) rule on. `opId` is generated per act when the
 * caller does not supply one, so a tap is idempotent on retry; a
 * contract-bound act carries the `expectedStateRev` the store demands.
 */
export interface DictateRulingRequest {
  ask: string;
  decision: string;
  reasoning: string;
  /** Bind the ruling to a contract so completion can cite it. Requires `expectedStateRev`. */
  contract?: string;
  expectedStateRev?: number;
  opId?: string;
}

export interface DeferAskRequest {
  ask: string;
  reason: string;
  /** The ask comes back armed on this trigger. */
  trigger?: string;
  /** Required when the ask names a contract — every act on one carries its precondition. */
  expectedStateRev?: number;
  opId?: string;
}

export interface DeclineAskRequest {
  ask: string;
  reason: string;
  expectedStateRev?: number;
  opId?: string;
}

export interface RedirectAskRequest {
  ask: string;
  /** The member the question moves to. The ask stays OPEN under the new authority. */
  redirectTo: string;
  reason: string;
  expectedStateRev?: number;
  opId?: string;
}

// ─── The curator ─────────────────────────────────────────────────────
//
// The annex records what members did. The curator records what the
// SYSTEM spent of whose album doing it — leases, receipts, injections,
// and the per-member policy that decides who hears what.
//
// The governing rule for everything below is the floor rule: the
// signals a runner reports make re-orientation SOONER and never make
// it exist. Delete every value in `SpineRunnerCapabilities` and every
// guarantee still holds; only the reactive window widens.

/**
 * What a runner can tell the server about a member's context lifecycle
 * WITHOUT reading their mind — each of these is an act, observed at
 * the floor.
 *
 *   bridge_connect / bridge_disconnect   the MCP bridge attached/left
 *   session_start  / session_end         the run bracket
 *   dump_declared                        the runner's own declaration
 *                                        that context was discarded
 *
 * `dump_declared` is the only ceiling entry in the list, and it is
 * deliberately shaped as a REPORT of something the runner already
 * knows rather than as an inference the server draws. A runner that
 * never sends one loses latency and nothing else.
 */
export const SPINE_FLOOR_SIGNALS = [
  'bridge_connect',
  'bridge_disconnect',
  'session_start',
  'session_end',
  'dump_declared',
] as const;

export type SpineFloorSignal = (typeof SPINE_FLOOR_SIGNALS)[number];

/**
 * Why a dump was declared. `compact` and `clear` are Claude Code's
 * SessionStart hook sources; `token_discontinuity` is the codex spike's
 * inference from `thread/tokenUsage/updated` and is the reason this is
 * a closed union rather than free text — a signal whose provenance
 * cannot be read is a signal nobody can later discount.
 */
export const SPINE_DUMP_SOURCES = ['compact', 'clear', 'token_discontinuity'] as const;

export type SpineDumpSource = (typeof SPINE_DUMP_SOURCES)[number];

/**
 * A runner's declared ceiling, sent once per session bracket.
 *
 * Nothing correctness-bearing may read this. It exists so an operator
 * can answer "whose recovery is accelerated and whose is purely
 * reactive" without guessing from the runner id.
 */
export interface SpineRunnerCapabilities {
  /** The runner can tell the server its context was discarded. */
  dumpSignal: boolean;
  /** The runner sees token counts against a declared context window. */
  tokenUsage: boolean;
}

export interface ReportSpineSignalRequest {
  signal: SpineFloorSignal;
  /** Required by nothing; meaningful on `dump_declared`. */
  source?: SpineDumpSource;
  /** Declared on `session_start`. Ignored on every other signal. */
  capabilities?: SpineRunnerCapabilities;
}

export interface ReportSpineSignalResponse {
  accepted: true;
  /**
   * How many live leases this signal invalidated. Zero is a normal
   * answer and is reported rather than omitted: "the signal arrived
   * and there was nothing holding" and "the signal was dropped" are
   * different facts.
   */
  leasesInvalidated: number;
}

/**
 * What kind of spend an injection was.
 *
 *   recovery_pack       the Guaranteed Pack — an `orient` read, which
 *                       is how the pack reaches an album.
 *   recovery_nudge      one line pointing at `orient`. The whole
 *                       budget an expired lease buys.
 *   addressed           class 1 — an act that named this member.
 *   subscription_delta  class 2 — a batched tick of what they asked to
 *                       hear about.
 */
export const SPINE_INJECTION_KINDS = [
  'recovery_pack',
  'recovery_nudge',
  'addressed',
  'subscription_delta',
  // The focus set ran dry — a curator-computed class-1 transition, not
  // an annex event addressed to anyone, so it earns its own ledger kind
  // rather than borrowing `addressed`. "What did the system spend of my
  // album" must be able to name this line for what it is.
  'running_dry',
] as const;

export type SpineInjectionKind = (typeof SPINE_INJECTION_KINDS)[number];

/**
 * One entry in the curator's ledger — "what did the system spend of my
 * album this week", answerable.
 *
 * `bytes` is on the row rather than derivable from it because the body
 * is not retained: the ledger is an accounting of spend, not a second
 * copy of the member's traffic. Keeping the text would make the audit
 * trail itself a place a member's album leaks from.
 */
export interface SpineInjection {
  id: number;
  member: string;
  /** 0 recovery · 1 addressed · 2 subscription delta. Class 3 is silence and has no row. */
  class: 0 | 1 | 2;
  kind: SpineInjectionKind;
  /** Event ids, contract ids, or the pack's contract set. Never the text. */
  refs: string[];
  /** The annex head the injection framed itself against — the "since seq N" it carried. */
  cursor: number;
  /** ISO-8601. */
  at: string;
  bytes: number;
  /** Whether the delivery sink accepted it. A lease is only recorded when this is true. */
  delivered: boolean;
}

export interface ListSpineInjectionsResponse {
  injections: SpineInjection[];
}

/**
 * A reader-side subscription level, per member per contract — #155
 * finding 1's answer, and the reason class 2 exists at all.
 *
 *   all        every authoritative event on the contract
 *   lifecycle  lifecycle events only
 *   none       silence
 */
export const SPINE_SUBSCRIPTION_LEVELS = ['all', 'lifecycle', 'none'] as const;

export type SpineSubscriptionLevel = (typeof SPINE_SUBSCRIPTION_LEVELS)[number];

/**
 * The EFFECTIVE level, with the fact of whether anyone chose it.
 *
 * A derived default and an authored choice render identically without
 * `explicit`, and they are different facts: one is what nobody has had
 * an opinion about yet, the other is a decision with an author. The
 * trail is null exactly when `explicit` is false.
 */
export interface SpineSubscription {
  member: string;
  contract: string;
  level: SpineSubscriptionLevel;
  /** False when this is the derived default rather than an authored row. */
  explicit: boolean;
  updatedBy: string | null;
  /** ISO-8601. */
  updatedAt: string | null;
}

/**
 * Per-member curator cadence. Policy is DATA — tuning attention
 * allocation must never mean shipping code, because attention is the
 * eternally contested resource and the argument outlives the schema.
 */
export interface SpineCuratorPolicy {
  member: string;
  /** How long a lease stands before an act or a read renews it. */
  leaseTtlMs: number;
  /** Floor on the gap between two nudges to the same member. */
  nudgeMinIntervalMs: number;
  /**
   * THE INTERRUPT WHITELIST — which class-1 event kinds may reach a
   * phone. §9.
   *
   * The whitelist gates the PHONE, never the queue. Every addressed
   * event is always in the durable Queue — that is free, it is a read —
   * and every class-1 event still reaches a live session over the WS
   * fanout. This list decides only which of them ALSO spend the rarest
   * budget there is: a push to a member who is away from their screen.
   * A kind absent from it is not silenced, it is un-buzzed. The director
   * default is a blocking ask naming them, a proceed past their ask, and
   * `focus` — the focus set running dry, the allocator's cue to set the
   * next one; everything else waits quietly in the queue until they look.
   */
  interruptWhitelist: SpineEventKind[];
  /** False when these are the team defaults rather than an authored row. */
  explicit: boolean;
  updatedBy: string | null;
  /** ISO-8601. */
  updatedAt: string | null;
}

export interface SpineCuratorConfigResponse {
  member: string;
  /** Every contract that binds this member, with the level that will reach them. */
  subscriptions: SpineSubscription[];
  policy: SpineCuratorPolicy;
  /**
   * What this member's runner declared it can signal, this process's
   * lifetime. `null` when no session has declared anything — which is
   * indistinguishable in effect from a runner that declared nothing,
   * and deliberately so.
   */
  capabilities: SpineRunnerCapabilities | null;
}

export interface SetSpineCuratorConfigRequest {
  /** Defaults to the caller. Naming somebody else requires `members.manage`. */
  member?: string;
  subscription?: { contract: string; level: SpineSubscriptionLevel };
  policy?: {
    leaseTtlMs?: number;
    nudgeMinIntervalMs?: number;
    /** Replace the interrupt whitelist wholesale — the set of class-1 kinds that may buzz a phone. */
    interruptWhitelist?: SpineEventKind[];
  };
}

export interface ListSpineInjectionsQuery {
  /** Defaults to the caller. Naming somebody else requires `members.manage`. */
  member?: string;
  limit?: number;
  /**
   * Page BACKWARD from here: rows strictly older than this id.
   *
   * The ledger is newest-first, so the cursor runs the same direction
   * or it is not a cursor. Feed back the `id` of a page's last row.
   */
  before_id?: number;
}

// ─── The probe engine ────────────────────────────────────────────────

/**
 * A recipe: what the system does when a member points it at something.
 *
 * §7 — the system cannot take photographs, because it has no judgement
 * about what matters. What it CAN do is press a button a member
 * composed. So a recipe is authored by a member, inside the very event
 * it discharges, and the observation it produces is captioned with that
 * member's name (`authoredBy`) beside the probe's (`actor`). The member
 * took the photo; the system held the camera.
 *
 * TWO KINDS IN PHASE 4 (workstation commands are deferred by the
 * design, not overlooked):
 *
 *   webhook     armed on the existing inbound endpoint registry. The
 *               inbox's HMAC verification and provider dedupe run
 *               FIRST; a check only ever sees a delivery the team
 *               already accepted as genuine.
 *   http_poll   an outbound GET on an interval, with the security pins
 *               below, none of which is negotiable at authoring time.
 */
export type SpineCheckRecipe = SpineWebhookRecipe | SpineHttpPollRecipe;

/** What every recipe carries, whatever presses the button. */
interface SpineRecipeCommon {
  /**
   * The predicate, as inbound-notification filter rules — the SAME
   * engine and the same evaluation semantics the webhook inbox has used
   * since it shipped. Reused rather than reinvented on purpose: a
   * second predicate language would be a second set of edge cases
   * around `exists`, empty arrays and type coercion, and members would
   * have to know which one they were writing.
   *
   * All rules must pass. An empty list is `true` — a check on "any
   * delivery at all", which is a legitimate thing to arm.
   */
  when: NotificationFilterRule[];
  /**
   * Dot-path to a value that IS an observation point on the subject —
   * a commit SHA, a build id, a version.
   *
   * When set and present, the firing observation carries an OBSERVED
   * revision reading it, sourced to the probe. When unset, the
   * observation carries no revision, which is the honest answer for a
   * recipe that watched something with no revision to it.
   */
  revisionPath?: string;
}

export interface SpineWebhookRecipe extends SpineRecipeCommon {
  kind: 'webhook';
  /** The inbound endpoint's slug. Immutable, so the arming survives a rename of its label. */
  endpoint: string;
}

export interface SpineHttpPollRecipe extends SpineRecipeCommon {
  kind: 'http_poll';
  /**
   * HTTPS ONLY, refused at authoring otherwise. The URL is part of the
   * authored check — the member took responsibility for where the
   * system points its camera, and a URL the server derived would be the
   * system deciding what to look at.
   */
  url: string;
  /** Floor of `SPINE_POLL_MIN_INTERVAL_MS`. A probe is not a monitoring agent. */
  intervalMs: number;
  /**
   * Slug of a secret in the team's secrets store, resolved SERVER-SIDE
   * at poll time and never stored here. A recipe is an annex event and
   * annex events are permanent; a token written into one could not be
   * rotated, redacted, or unseen.
   */
  authSecret?: string;
  /** Header the resolved secret is sent as. Defaults to `Authorization`. */
  authHeader?: string;
}

/** The floor on a poll interval. A probe presses a button; it does not monitor. */
export const SPINE_POLL_MIN_INTERVAL_MS = 60_000;

/**
 * Where a check stands.
 *
 * ONE FIRE PER ARMING, so `fired` is terminal and points at the
 * observation it produced. Re-arming takes a new carrier event — a new
 * ask, a fresh `waiting_for` — which keeps "did the thing I armed
 * actually happen" a lookup with exactly one answer rather than a
 * history to interpret.
 *
 * `disarmed` is the carrier going away: the ask withdrawn or answered,
 * the contract moved off `waiting_for`. Nothing was observed and
 * nothing will be.
 */
export type SpineCheckState = 'armed' | 'fired' | 'disarmed';

/** Which carrier event a check was born from. There is no standalone check tool. */
export type SpineCheckCarrier = 'ask' | 'waiting_for';

/**
 * A check, as the registry holds it.
 *
 * A FOLD OVER THE CARRIER EVENTS, not a table members write to. §5's
 * tool table has no `check_author` and that is deliberate: a check is
 * authored as part of the thing it discharges, so it cannot drift away
 * from what it was for, and withdrawing that thing takes the check with
 * it. `lastEvaluatedAt` is the one column that is pure bookkeeping —
 * lost on a rebuild, and a fact about the engine rather than the team.
 */
export interface SpineCheck {
  /** `chk_<ulid>`. */
  id: string;
  /** The `ask` or `lifecycle` event that armed it. */
  sourceEvent: string;
  carrier: SpineCheckCarrier;
  /** What the observation will be of. Always resolvable, or the carrier is refused. */
  subject: string;
  /** Set for a `waiting_for` check: the contract the firing re-lights. */
  contract: string | null;
  /** Set for an ask check: the ask the firing discharges. */
  ask: string | null;
  recipe: SpineCheckRecipe;
  /** The member who composed the recipe. Rides onto the observation as `authoredBy`. */
  authoredBy: string;
  state: SpineCheckState;
  /** The observation this check produced. Set iff `state` is `fired`. */
  firedEvent: string | null;
  /** ISO-8601. */
  firedAt: string | null;
  /** ISO-8601. Bookkeeping: the last time the predicate was evaluated, true or false. */
  lastEvaluatedAt: string | null;
  /** Why it stopped being armed, in the members' own terms. */
  disarmedReason: string | null;
  /** ISO-8601. */
  at: string;
}

export interface ListSpineChecksQuery {
  state?: SpineCheckState;
  contract?: string;
  ask?: string;
  subject?: string;
  limit?: number;
}

export interface ListSpineChecksResponse {
  checks: SpineCheck[];
}

export interface GetSpineCheckResponse {
  check: SpineCheck;
}
