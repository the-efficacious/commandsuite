/**
 * Wire-protocol constants for csuite.
 *
 * Everything that defines the contract between a broker and its clients
 * lives here. Bump PROTOCOL_VERSION on any breaking wire change.
 */

export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_HEADER = 'X-CSUITE-Protocol' as const;
export const AUTH_HEADER = 'Authorization' as const;

export const PATHS = {
  health: '/healthz',
  briefing: '/briefing',
  roster: '/roster',
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
  // admins (creator-by-default) manage. The `general` channel is
  // synthetic and seeded server-side; everyone is implicitly a
  // member.
  channels: '/channels',
  // Members — requires `members.manage` for mutations. Top-level GET
  // is dual-auth (everyone can read the teammate list); mutating verbs
  // gate on the permission. The helpers below compose the `:name`
  // subpaths.
  members: '/members',
  // Team — name, context, permission presets. `GET /team` is
  // dual-auth (every authenticated member sees the team they're on).
  // `PATCH /team` requires `team.manage`. Permission-preset CRUD lives
  // under `/team/presets` (same gate). Mutations apply immediately to
  // the DB; live MCP sessions still need a runner restart for changes
  // to `instructions`-class strings (the MCP protocol freezes those
  // per session).
  team: '/team',
  teamPresets: '/team/presets',
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
  // `enrollPending` lists requests waiting for director approval;
  // `enrollApprove` and `enrollReject` are director actions.
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
  // Runner-driven presence reports. `presenceActivity`: the runner
  // POSTs `{state: ActivityState, busy?: bool}` on each activity
  // transition (idle ↔ working ↔ blocked), plus a periodic heartbeat
  // while still working/blocked so the server's TTL doesn't lapse and
  // reset the member to idle mid-turn.
  presenceActivity: '/presence/activity',
  // Tool sources — registry of platform-defined external tools
  // (custom HTTP-bound tools and proxied remote MCP servers). GET is
  // dual-auth; mutations gate on `tools.manage`; invoke gates on the
  // caller being bound to the source. Subresource paths compose via
  // TOOL_SOURCE_PATHS below.
  toolSources: '/tool-sources',
  // Secrets — broker-held environment secrets injected on the agent
  // child by the runner at spawn. GET is dual-auth (viewers see
  // write-only summaries); mutations gate on `secrets.manage`;
  // `resolve` returns the decrypted env delta for the calling member
  // only. Subresource paths compose via SECRET_PATHS below.
  secrets: '/secrets',
  secretsResolve: '/secrets/resolve',
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
  watchers: (id: string) => `/objectives/${encodeURIComponent(id)}/watchers`,
} as const;

/**
 * Path builders for channel subresources. Channels are addressed by
 * slug (URL-facing, mutable); the server resolves slug → id on each
 * call so renames don't break URLs already in flight.
 *
 *   GET    /channels                              — list (per viewer)
 *   POST   /channels                              — create
 *   GET    /channels/:slug                        — detail + members
 *   PATCH  /channels/:slug                        — rename
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
 *   GET    /members/:name/activity/stream   — SSE live tail (self or activity.read)
 */
export const MEMBER_PATHS = {
  one: (name: string) => `/members/${encodeURIComponent(name)}`,
  rotateToken: (name: string) => `/members/${encodeURIComponent(name)}/rotate-token`,
  enrollTotp: (name: string) => `/members/${encodeURIComponent(name)}/enroll-totp`,
  activity: (name: string) => `/members/${encodeURIComponent(name)}/activity`,
  activityStream: (name: string) => `/members/${encodeURIComponent(name)}/activity/stream`,
  /** POST — codex gen_ai inference upload (raw request/response bodies). Self-only. */
  genai: (name: string) => `/members/${encodeURIComponent(name)}/genai`,
  /** GET — list this member's active bearer tokens (members.manage or self). */
  tokens: (name: string) => `/members/${encodeURIComponent(name)}/tokens`,
  /** DELETE — revoke a specific token row by id (members.manage or self). */
  token: (name: string, tokenId: string) =>
    `/members/${encodeURIComponent(name)}/tokens/${encodeURIComponent(tokenId)}`,
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

export const DEFAULT_PORT = 8717 as const;

export const ENV = {
  // Client-side: broker URL + bearer token held in env for `csuite` subcommands.
  url: 'CSUITE_URL',
  token: 'CSUITE_TOKEN',
  // Server-side: where to find the team config file + listener config.
  configPath: 'CSUITE_CONFIG_PATH',
  port: 'CSUITE_PORT',
  host: 'CSUITE_HOST',
  dbPath: 'CSUITE_DB_PATH',
} as const;

export const MCP_CHANNEL_CAPABILITY = 'claude/channel' as const;
export const MCP_CHANNEL_NOTIFICATION = 'notifications/claude/channel' as const;
