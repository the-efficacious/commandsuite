/**
 * Wire-protocol constants for csuite.
 *
 * Everything that defines the contract between a broker and its clients
 * lives here. Bump PROTOCOL_VERSION on any breaking wire change.
 */

export const PROTOCOL_VERSION = 2 as const;
export const PROTOCOL_HEADER = 'X-CSUITE-Protocol' as const;
export const AUTH_HEADER = 'Authorization' as const;
/** Loaded version of the long-lived runner requesting its instructions. */
export const RUNNER_VERSION_HEADER = 'X-CSUITE-Runner-Version' as const;
export const RUNNER_IDENTITY_HEADER = 'X-CSUITE-Runner-Identity' as const;
/** Typed, observational identity of a live presence subscriber. */
export const CLIENT_IDENTITY_HEADER = 'X-CSUITE-Client-Identity' as const;

/**
 * Set to `true` on any response whose request used a query parameter
 * name that has been renamed. Presence is the signal; the pairs are in
 * `DEPRECATED_QUERY_HEADER`.
 */
export const DEPRECATION_HEADER = 'Deprecation' as const;
/**
 * Which renamed query parameters this request used, as a comma-joined
 * list of `legacy=current` pairs — e.g. `cursor_ts=before_ts,
 * cursor_id=before_id`.
 *
 * DEPRECATION WINDOW — the legacy names are accepted for ONE release
 * and are REMOVED IN THE NEXT MINOR, together with this header. It is
 * the same courtesy the `process_document_*` tool aliases get, in the
 * shape an HTTP client can act on: a stale caller keeps working AND
 * learns, in the response itself, exactly which parameter to change.
 * A proxy log filtered on this header lists every caller still to fix.
 */
export const DEPRECATED_QUERY_HEADER = 'X-CSuite-Deprecated-Query' as const;

export const PATHS = {
  health: '/healthz',
  /**
   * The member's composed instruction packet plus its named blocks
   * and the composed-content hash the broker tracks restart-pending
   * against.
   */
  instructions: '/instructions',
  roster: '/roster',
  /** Read-only, members.manage team-operability report. */
  teamStatus: '/team/status',
  push: '/push',
  subscribe: '/subscribe',
  history: '/history',
  // Human-plane session management (TOTP login + session cookie).
  sessionTotp: '/session/totp',
  sessionLogout: '/session/logout',
  session: '/session',
  // Web Push (browser) — VAPID public key + per-device subscriptions.
  pushVapidPublicKey: '/push/vapid-public-key',
  pushSubscriptions: '/push/subscriptions',
  // Objectives — members with `objectives.create` post and assign,
  // assignees execute, watchers observe.
  objectives: '/objectives',
  // Channels — Slack-style named team threads. Anyone can create;
  // `channels.manage` holders administer. The `general` channel is
  // synthetic and seeded server-side; everyone is implicitly a
  // member.
  channels: '/channels',
  // Members — requires `members.manage` for mutations. Top-level GET
  // is tri-auth (everyone can read the teammate list); mutating verbs
  // gate on the permission. The helpers below compose the `:name`
  // subpaths.
  members: '/members',
  // Team — name and context. `GET /team` is
  // tri-auth (every authenticated member sees the team they're on).
  // `PATCH /team` requires `team.manage`. Mutations apply immediately
  // to the DB; instruction-bearing edits also fan out a
  // `kind: 'instructions'` event to every member whose composed text
  // changed, and the roster lists them restart-pending until their
  // runner picks the change up in a fresh session.
  team: '/team',
  // Filesystem — per-member home directories with content-addressed
  // blob storage. The dedicated `read/*` catch-all supports friendly
  // URLs for <a href> and <img src>; other ops take path via query or body.
  fsList: '/fs/ls',
  fsStat: '/fs/stat',
  fsRead: '/fs/read',
  fsWrite: '/fs/write',
  fsMkdir: '/fs/mkdir',
  fsRm: '/fs/rm',
  fsMv: '/fs/mv',
  fsShared: '/fs/shared',
  fsAll: '/fs/all',
  // Device-code enrollment (RFC 8628-shaped). `enroll` mints a
  // device_code/user_code pair; `enrollPoll` is the device-side poll;
  // `enrollPending` lists requests waiting for a `members.manage` holder;
  // `enrollApprove` and `enrollReject` require the same leaf.
  enroll: '/enroll',
  enrollPoll: '/enroll/poll',
  enrollPending: '/enroll/pending',
  enrollApprove: '/enroll/approve',
  enrollReject: '/enroll/reject',
  /**
   * The web-UI route an operator visits to enter a user code. Lives
   * on the SPA, not the API — but pinned here so the broker can
   * include the same canonical path in the device-authorization
   * response without each consumer hard-coding it.
   */
  enrollVerify: '/enroll',
  // Runner-driven work-state reports. `presenceWorkState`: the runner
  // POSTs `{state: WorkState, busy?: bool}` on each work-state
  // transition (idle ↔ working ↔ blocked), plus a periodic heartbeat
  // while still working/blocked so the server's TTL doesn't lapse and
  // reset the member to idle mid-turn.
  presenceWorkState: '/presence/work-state',
  /**
   * @deprecated The pre-D6 spelling of {@link PATHS.presenceWorkState}.
   *
   * `activity` is reserved for the durable per-member stream
   * (`/members/:name/activity`); the live `idle`/`working`/`blocked`
   * signal is *work state*. The broker serves both paths with one
   * handler for one release and answers the old one with
   * `Deprecation: true` plus a `Link: …; rel="successor-version"`
   * header, so a client still on it is findable in a proxy log.
   * Removed in the next minor.
   */
  presenceActivity: '/presence/activity',
  // Tool sources — registry of admin-defined external tools
  // (custom HTTP-bound tools and proxied remote MCP servers). GET is
  // tri-auth; mutations gate on `tools.manage`; invoke gates on the
  // caller being bound to the source. Subresource paths compose via
  // TOOL_SOURCE_PATHS below.
  toolSources: '/tool-sources',
  // Secrets — broker-held environment secrets injected on the agent
  // child by the runner at spawn. GET is tri-auth (viewers see
  // write-only summaries); mutations gate on `secrets.manage`;
  // `resolve` returns the decrypted env delta for the calling member
  // only. Subresource paths compose via SECRET_PATHS below.
  secrets: '/secrets',
  secretsResolve: '/secrets/resolve',
  // Variables — broker-held runner environment variables that are NOT
  // secrets. Same lifecycle as `/secrets/*` and the same
  // `secrets.manage` gate on mutations; the difference is that a
  // variable's VALUE is readable by an authorised caller and is never
  // registered with the trace redactor. `/secrets/resolve` returns
  // both, merged, and marks which keys are secret.
  variables: '/variables',
  /** The team process. Singleton; no id in the path. */
  teamProcess: '/team-process',
  // External Notifications — inbound webhooks / API calls routed to
  // members and channels as ambient input. Admin surface under
  // `/notifications/*` gates on `notifications.manage`; the ingress
  // (`POST /hooks/:slug`) is unauthenticated at the middleware layer
  // and verified per-endpoint (HMAC / shared-secret header).
  // Subresource paths compose via NOTIFICATION_PATHS below.
  notificationEndpoints: '/notifications/endpoints',
  notificationProfiles: '/notifications/profiles',
  notificationDeliveries: '/notifications/deliveries',
  hooks: '/hooks',
  // The helpers below compose `:id` / `:name` paths at runtime
  // rather than templating here, since `PATHS` is keyed by
  // identifier not URL.
} as const;

/** Path builders for objective subresources (the `:id` segment varies). */
export const OBJECTIVE_PATHS = {
  one: (id: string) => `/objectives/${encodeURIComponent(id)}`,
  complete: (id: string) => `/objectives/${encodeURIComponent(id)}/complete`,
  cancel: (id: string) => `/objectives/${encodeURIComponent(id)}/cancel`,
  reassign: (id: string) => `/objectives/${encodeURIComponent(id)}/reassign`,
  discuss: (id: string) => `/objectives/${encodeURIComponent(id)}/discuss`,
} as const;

/**
 * Path builders for channel subresources. Channels are addressed by
 * slug (URL-facing, mutable); the server resolves slug → id on each
 * call so renames don't break URLs already in flight.
 *
 *   GET    /channels                              — list (per viewer)
 *   POST   /channels                              — create
 *   GET    /channels/:slug                        — detail + members
 *   PATCH  /channels/:slug                        — update (slug and/or
 *                                                   description)
 *   DELETE /channels/:slug                        — archive
 *   POST   /channels/:slug/members                — add member (admin)
 *                                                   or self-join
 *   DELETE /channels/:slug/members/:name          — remove member
 *                                                   (admin) or self-leave
 */
export const CHANNEL_PATHS = {
  one: (slug: string) => `/channels/${encodeURIComponent(slug)}`,
  members: (slug: string) => `/channels/${encodeURIComponent(slug)}/members`,
  member: (slug: string, name: string) =>
    `/channels/${encodeURIComponent(slug)}/members/${encodeURIComponent(name)}`,
  audit: (slug: string) => `/channels/${encodeURIComponent(slug)}/audit`,
} as const;

/**
 * Path builders for per-member subresources.
 *
 *   PATCH  /members/:name                   — update (members.manage)
 *   DELETE /members/:name                   — delete (members.manage)
 *   POST   /members/:name/rotate-token      — rotate bearer token (members.manage or self)
 *   POST   /members/:name/enroll-totp       — (re-)enroll TOTP (members.manage or self)
 *   POST   /members/:name/activity          — append activity event (self only)
 *   GET    /members/:name/activity          — range query (self or activity.read)
 *   GET    /members/:name/activity/stream   — WebSocket live tail (self or activity.read)
 *   GET    /members/:name/telemetry         — OTLP cost/token records (self or activity.read)
 */
export const MEMBER_PATHS = {
  one: (name: string) => `/members/${encodeURIComponent(name)}`,
  rotateToken: (name: string) => `/members/${encodeURIComponent(name)}/rotate-token`,
  enrollTotp: (name: string) => `/members/${encodeURIComponent(name)}/enroll-totp`,
  activity: (name: string) => `/members/${encodeURIComponent(name)}/activity`,
  activityStream: (name: string) => `/members/${encodeURIComponent(name)}/activity/stream`,
  /** POST — codex gen_ai inference upload (raw request/response bodies). Self-only. */
  genai: (name: string) => `/members/${encodeURIComponent(name)}/genai`,
  /**
   * GET — the operational telemetry this member's agent exported:
   * cost, token and lifecycle records, one row per OTLP log record or
   * metric data point. Self or `activity.read`.
   */
  telemetry: (name: string) => `/members/${encodeURIComponent(name)}/telemetry`,
  /** GET — list this member's active bearer tokens (members.manage or self). */
  tokens: (name: string) => `/members/${encodeURIComponent(name)}/tokens`,
  /** DELETE — revoke a specific token row by id (members.manage or self). */
  token: (name: string, tokenId: string) =>
    `/members/${encodeURIComponent(name)}/tokens/${encodeURIComponent(tokenId)}`,
  /** POST — ask this member's runner to compact or clear its context (members.context or self). */
  context: (name: string) => `/members/${encodeURIComponent(name)}/context`,
} as const;

/**
 * Path builders for tool-source subresources. Sources are addressed
 * by slug (immutable in v1 — the event thread key `tool:<slug>`
 * depends on it; `displayName` is the mutable label).
 *
 *   GET    /tool-sources                                — list (per viewer; credentials redacted)
 *   POST   /tool-sources                                — create (tools.manage)
 *   GET    /tool-sources/:slug                          — detail incl. tool defs (tools.manage sees bindings)
 *   PATCH  /tool-sources/:slug                          — update displayName/config/enabled/allMembers (tools.manage)
 *   DELETE /tool-sources/:slug                          — delete + cascade (tools.manage)
 *   PUT    /tool-sources/:slug/credential               — set static credential, write-only (tools.manage)
 *   DELETE /tool-sources/:slug/credential               — remove credential (tools.manage)
 *   POST   /tool-sources/:slug/bindings                 — bind a member (tools.manage)
 *   DELETE /tool-sources/:slug/bindings/:name           — unbind a member (tools.manage)
 *   PUT    /tool-sources/:slug/tools/:name              — set/replace a custom tool def (tools.manage, kind=custom)
 *   DELETE /tool-sources/:slug/tools/:name              — delete a custom tool def (tools.manage, kind=custom)
 *   POST   /tool-sources/:slug/tools/:name/invoke       — invoke (caller must be bound; returns CallToolResult)
 *   POST   /tool-sources/:slug/refresh                  — re-discover upstream MCP tools (tools.manage, kind=mcp)
 */
export const TOOL_SOURCE_PATHS = {
  one: (slug: string) => `/tool-sources/${encodeURIComponent(slug)}`,
  credential: (slug: string) => `/tool-sources/${encodeURIComponent(slug)}/credential`,
  bindings: (slug: string) => `/tool-sources/${encodeURIComponent(slug)}/bindings`,
  binding: (slug: string, name: string) =>
    `/tool-sources/${encodeURIComponent(slug)}/bindings/${encodeURIComponent(name)}`,
  tool: (slug: string, name: string) =>
    `/tool-sources/${encodeURIComponent(slug)}/tools/${encodeURIComponent(name)}`,
  invoke: (slug: string, name: string) =>
    `/tool-sources/${encodeURIComponent(slug)}/tools/${encodeURIComponent(name)}/invoke`,
  refresh: (slug: string) => `/tool-sources/${encodeURIComponent(slug)}/refresh`,
} as const;

/**
 * Path builders for secret subresources. Secrets are addressed by
 * slug (immutable; `envName` and `description` are the mutable
 * fields).
 *
 *   GET    /secrets                          — list (per viewer; values never returned)
 *   POST   /secrets                          — create (secrets.manage)
 *   GET    /secrets/resolve                  — decrypted env map for the calling member
 *   GET    /secrets/:slug                    — detail (secrets.manage sees bindings)
 *   PATCH  /secrets/:slug                    — update envName/description/enabled/allMembers (secrets.manage)
 *   DELETE /secrets/:slug                    — delete + cascade bindings (secrets.manage)
 *   PUT    /secrets/:slug/value              — set value, write-only (secrets.manage)
 *   DELETE /secrets/:slug/value              — remove value (secrets.manage)
 *   POST   /secrets/:slug/bindings           — bind a member (secrets.manage)
 *   DELETE /secrets/:slug/bindings/:name     — unbind a member (secrets.manage)
 *
 * Note: `resolve` is registered before `:slug` server-side so the
 * literal segment wins.
 */
export const SECRET_PATHS = {
  one: (slug: string) => `/secrets/${encodeURIComponent(slug)}`,
  value: (slug: string) => `/secrets/${encodeURIComponent(slug)}/value`,
  bindings: (slug: string) => `/secrets/${encodeURIComponent(slug)}/bindings`,
  binding: (slug: string, name: string) =>
    `/secrets/${encodeURIComponent(slug)}/bindings/${encodeURIComponent(name)}`,
} as const;

/** The team process's edit history — RETRIEVED, never injected. */
export const TEAM_PROCESS_PATHS = {
  history: '/team-process/history',
} as const;

/** Path builders for variable subresources. Mirrors `SECRET_PATHS`. */
export const VARIABLE_PATHS = {
  one: (slug: string) => `/variables/${encodeURIComponent(slug)}`,
  value: (slug: string) => `/variables/${encodeURIComponent(slug)}/value`,
  bindings: (slug: string) => `/variables/${encodeURIComponent(slug)}/bindings`,
  binding: (slug: string, name: string) =>
    `/variables/${encodeURIComponent(slug)}/bindings/${encodeURIComponent(name)}`,
} as const;

/**
 * Path builders for External Notification subresources. Endpoints
 * and profiles are addressed by slug (immutable — the ingress URL
 * and the `hook:<slug>` sender identity ride on it; `displayName`
 * is the mutable label).
 *
 *   GET    /notifications/endpoints                    — list (notifications.manage sees all; others see endpoints targeting them)
 *   POST   /notifications/endpoints                    — create (notifications.manage)
 *   GET    /notifications/endpoints/:slug              — detail
 *   PATCH  /notifications/endpoints/:slug              — update (notifications.manage)
 *   DELETE /notifications/endpoints/:slug              — delete + cascade deliveries (notifications.manage)
 *   PUT    /notifications/endpoints/:slug/secret       — set inline signing secret, write-only (notifications.manage)
 *   DELETE /notifications/endpoints/:slug/secret       — remove inline secret (notifications.manage)
 *   GET    /notifications/endpoints/:slug/deliveries   — receipts, newest first (notifications.manage)
 *   GET    /notifications/profiles                     — list (notifications.manage)
 *   POST   /notifications/profiles                     — create (notifications.manage)
 *   PATCH  /notifications/profiles/:slug               — update (notifications.manage)
 *   DELETE /notifications/profiles/:slug               — delete; 409 while referenced (notifications.manage)
 *   PUT    /notifications/profiles/:slug/secret        — set shared secret, write-only (notifications.manage)
 *   DELETE /notifications/profiles/:slug/secret        — remove shared secret (notifications.manage)
 *   POST   /notifications/deliveries/:id/replay        — re-run a stored delivery through the pipeline (notifications.manage)
 *   POST   /hooks/:slug                                — ingress (per-endpoint verification; `?if_offline=&if_busy=&level=` overrides)
 */
export const NOTIFICATION_PATHS = {
  endpoint: (slug: string) => `/notifications/endpoints/${encodeURIComponent(slug)}`,
  endpointSecret: (slug: string) => `/notifications/endpoints/${encodeURIComponent(slug)}/secret`,
  endpointDeliveries: (slug: string) =>
    `/notifications/endpoints/${encodeURIComponent(slug)}/deliveries`,
  profile: (slug: string) => `/notifications/profiles/${encodeURIComponent(slug)}`,
  profileSecret: (slug: string) => `/notifications/profiles/${encodeURIComponent(slug)}/secret`,
  replay: (deliveryId: string) =>
    `/notifications/deliveries/${encodeURIComponent(deliveryId)}/replay`,
  hook: (slug: string) => `/hooks/${encodeURIComponent(slug)}`,
} as const;

/**
 * Path builder for the `/fs/read/<path>` download endpoint. The
 * server treats the trailing segment as a catch-all so friendly URLs
 * like `/fs/read/alice/uploads/foo.pdf` work directly in `<a href>`
 * and `<img src>`. Each segment is URL-encoded individually so names
 * with spaces or special characters stay safe.
 */
export const FS_PATHS = {
  read: (virtualPath: string): string => {
    const segments = virtualPath.split('/').filter((s) => s.length > 0);
    return `/fs/read/${segments.map(encodeURIComponent).join('/')}`;
  },
} as const;

/**
 * The slug grammar. One definition, for every store that has one.
 *
 * A slug is the human-typed, URL-facing identifier of a record inside
 * one store — channel, tool source, secret, variable, notification
 * endpoint, notification profile. It is 1–32 characters of lowercase
 * letters, digits and dashes, starting and ending alphanumeric, with no
 * consecutive dashes.
 *
 * These three constants are the single source of that rule. They live
 * in the SDK because the grammar describes the wire and the broker's
 * validators must not be able to drift from it: before this, the same
 * regex was written out four times (`ChannelSlugSchema`,
 * `ToolSourceSlugSchema`, `validateSlug`, `validateSourceSlug`) and a
 * fifth copy in the variables store disagreed with all of them, at 64
 * characters and a pattern admitting `foo--bar` and `foo-` (#15, #171).
 *
 * A slug is unique **within its store, never across stores**: a secret
 * and a variable may both be `git-token`, which is why the web UI's
 * detail routes stay per-kind. What *is* shared across the secret and
 * variable pair is the env-name namespace, which is a different field
 * with its own check (#136).
 */
export const SLUG_MAX_LENGTH = 32 as const;

/** Non-global, so it holds no `lastIndex` and is safe to share. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/;

/** The one sentence every layer tells a caller when a slug is refused. */
export const SLUG_RULE =
  'slug must be lowercase letters/digits/dashes, no consecutive dashes, no leading/trailing dash';

export const DEFAULT_PORT = 8717 as const;

export const ENV = {
  // Client-side: broker URL + bearer token held in env for `csuite` subcommands.
  url: 'CSUITE_URL',
  token: 'CSUITE_TOKEN',
  // Server-side: where to find the team config file + listener config
  // (`host` is the listener bind address, not a hostname to dial).
  configPath: 'CSUITE_CONFIG_PATH',
  port: 'CSUITE_PORT',
  host: 'CSUITE_HOST',
  dbPath: 'CSUITE_DB_PATH',
} as const;
