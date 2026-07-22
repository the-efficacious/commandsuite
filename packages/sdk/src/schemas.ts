/**
 * Runtime validators for the csuite wire protocol.
 *
 * Both the server and the client use these to validate messages crossing
 * the network boundary. Pulling from `csuite-sdk/schemas` keeps zod
 * as an explicit runtime dependency for consumers that want it.
 */

import { z } from 'zod';
import { PERMISSIONS } from './types.js';

export const LogLevelSchema = z.enum(['debug', 'info', 'notice', 'warning', 'error', 'critical']);

/**
 * The 3-state activity model — orthogonal to connection presence.
 * `idle` (available), `working` (mid-turn: generation and/or tools),
 * `blocked` (waiting on a human). See `ActivityState` in types.ts.
 */
export const ActivityStateSchema = z.enum(['idle', 'working', 'blocked']);

/**
 * Member names — alphanumeric plus `.`, `_`, `-`, 1-128 chars.
 */
export const NameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._-]+$/, 'name must be alphanumeric with . _ - allowed');

/** One of the gated permission leaves. Extend `PERMISSIONS` to grow. */
export const PermissionSchema = z.enum(PERMISSIONS);

/**
 * Team-level named permission bundles. Keys are preset names
 * (short freeform strings), values are arrays of resolved leaf
 * permissions. Members reference preset names; the server resolves
 * at load time.
 */
export const PermissionPresetsSchema = z.record(
  z.string().min(1).max(64),
  z.array(PermissionSchema),
);

/**
 * A role is a short label + prose description, per-member. Unlike
 * the previous role model, there's no instructions template here —
 * instructions are personal to the member.
 */
export const RoleSchema = z.object({
  title: z.string().min(1).max(64),
  description: z.string().max(512).default(''),
});

export const TeamSchema = z.object({
  name: z.string().min(1).max(128),
  context: z.string().max(8192).default(''),
  permissionPresets: PermissionPresetsSchema.default({}),
});

/**
 * Public projection of a team member — what teammates see in the
 * roster and briefing. Omits `instructions` (private to the member).
 */
export const TeammateSchema = z.object({
  name: NameSchema,
  role: RoleSchema,
  permissions: z.array(PermissionSchema),
});

/**
 * Full member record — includes the private `instructions` field.
 * Returned from self-scope briefing and admin-scope member listings.
 */
export const MemberSchema = TeammateSchema.extend({
  instructions: z.string().max(8192).default(''),
});

/**
 * Filesystem path: absolute, Unix-like, enforced shape matches the
 * server's `normalizePath` rules (alphanumerics + . _ - and single
 * spaces, no traversal). The server re-normalizes on ingest so this
 * schema is a first-pass filter only.
 */
export const FsPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(
    /^\/(?:[a-zA-Z0-9._\- ]+(?:\/[a-zA-Z0-9._\- ]+)*)?$/,
    'path must be absolute Unix-style with [a-zA-Z0-9._- ] segments',
  )
  .refine((p) => !p.split('/').some((s) => s === '.' || s === '..'), {
    message: 'path may not contain . or .. segments',
  });

export const AttachmentSchema = z.object({
  path: FsPathSchema,
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  mimeType: z.string().min(1).max(255),
});

export const PushPayloadSchema = z.object({
  to: NameSchema.nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  body: z
    .string()
    .min(1)
    .max(64 * 1024),
  level: LogLevelSchema.default('info'),
  data: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(AttachmentSchema).max(64).optional(),
});

export const MessageSchema = z.object({
  id: z.string(),
  ts: z.number(),
  to: NameSchema.nullable(),
  from: z.string().nullable(),
  title: z.string().nullable(),
  body: z.string(),
  level: LogLevelSchema,
  data: z.record(z.string(), z.unknown()),
  attachments: z.array(AttachmentSchema).default([]),
});

export const PresenceSchema = z.object({
  name: NameSchema,
  connected: z.number().int().nonnegative(),
  createdAt: z.number(),
  lastSeen: z.number(),
  role: RoleSchema.nullable(),
  // Live 3-state activity. The server omits the field for members it
  // has no recent activity report for (treat absence as `idle`); older
  // clients that don't know about it ignore it and fall back to `busy`.
  activity: ActivityStateSchema.optional(),
  // Back-compat mirror of `activity === 'working'`. Omitted when
  // `activity` is; older UIs that only read the boolean keep working.
  busy: z.boolean().optional(),
});

/**
 * Body for `POST /presence/activity` — runner-side report of a
 * member's live activity transition (idle / working / blocked). The
 * server keys this on the authenticated member and applies a TTL so
 * stale state from a crashed runner clears itself back to idle. `busy`
 * is an optional back-compat mirror the server derives from `state`
 * (= `state === 'working'`) when omitted.
 */
export const ActivityReportSchema = z.object({
  state: ActivityStateSchema,
  busy: z.boolean().optional(),
});

export const DeliveryReportSchema = z.object({
  live: z.number().int().nonnegative(),
  targets: z.number().int().nonnegative(),
});

export const PushResultSchema = z.object({
  delivery: DeliveryReportSchema,
  message: MessageSchema,
});

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
});

// ───────────────────────── Objectives ─────────────────────────

export const ObjectiveStatusSchema = z.enum(['active', 'blocked', 'done', 'cancelled']);

export const ObjectiveSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  body: z.string().max(4096).default(''),
  outcome: z.string().min(1).max(2048),
  status: ObjectiveStatusSchema,
  assignee: NameSchema,
  originator: NameSchema,
  watchers: z.array(NameSchema).default([]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable(),
  result: z.string().nullable(),
  blockReason: z.string().nullable(),
  attachments: z.array(AttachmentSchema).default([]),
});

export const ObjectiveEventKindSchema = z.enum([
  'assigned',
  'blocked',
  'unblocked',
  'completed',
  'cancelled',
  'reassigned',
  'watcher_added',
  'watcher_removed',
]);

export const ObjectiveEventSchema = z.object({
  objectiveId: z.string().min(1),
  ts: z.number().int().nonnegative(),
  actor: NameSchema,
  kind: ObjectiveEventKindSchema,
  payload: z.record(z.string(), z.unknown()),
});

export const CreateObjectiveRequestSchema = z.object({
  title: z.string().min(1).max(200),
  outcome: z.string().min(1).max(2048),
  body: z.string().max(4096).optional(),
  assignee: NameSchema,
  watchers: z.array(NameSchema).max(64).optional(),
  attachments: z.array(AttachmentSchema).max(64).optional(),
});

export const UpdateWatchersRequestSchema = z
  .object({
    add: z.array(NameSchema).max(64).optional(),
    remove: z.array(NameSchema).max(64).optional(),
  })
  .refine(
    (v) => (v.add && v.add.length > 0) || (v.remove && v.remove.length > 0),
    'must include at least one of: add, remove',
  );

export const UpdateObjectiveRequestSchema = z
  .object({
    status: z.enum(['active', 'blocked']).optional(),
    blockReason: z.string().max(2048).optional(),
  })
  .refine(
    (v) => v.status !== undefined || v.blockReason !== undefined,
    'update must include at least one of: status, blockReason',
  );

export const DiscussObjectiveRequestSchema = z.object({
  body: z
    .string()
    .min(1)
    .max(16 * 1024),
  title: z.string().max(200).optional(),
  attachments: z.array(AttachmentSchema).max(64).optional(),
});

export const CompleteObjectiveRequestSchema = z.object({
  result: z.string().min(1).max(4096),
});

export const CancelObjectiveRequestSchema = z.object({
  reason: z.string().max(2048).optional(),
});

export const ReassignObjectiveRequestSchema = z.object({
  to: NameSchema,
  note: z.string().max(2048).optional(),
});

export const ListObjectivesResponseSchema = z.object({
  objectives: z.array(ObjectiveSchema),
});

export const GetObjectiveResponseSchema = z.object({
  objective: ObjectiveSchema,
  events: z.array(ObjectiveEventSchema),
});

export const ListObjectivesQuerySchema = z.object({
  assignee: NameSchema.optional(),
  status: ObjectiveStatusSchema.optional(),
});

// ───────────────────────── Channels ─────────────────────────
//
// Slack-style named team threads. Identified by an opaque immutable
// `id`; addressed in URLs and the UI by a mutable `slug`. Messages
// reference channels by id via `data.thread = 'chan:<id>'` so a
// rename never orphans history.

/**
 * Channel slug: 1–32 lowercase letters/digits/dashes, must start +
 * end alphanumeric, no consecutive dashes. Mirrors `validateSlug` on
 * the server.
 */
export const ChannelSlugSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(
    /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/,
    'slug must be lowercase letters/digits/dashes, no consecutive dashes, no leading/trailing dash',
  );

export const ChannelMemberRoleSchema = z.enum(['admin', 'member']);

export const ChannelSchema = z.object({
  id: z.string().min(1),
  slug: ChannelSlugSchema,
  createdBy: z.string(),
  createdAt: z.number().int().nonnegative(),
  archivedAt: z.number().int().nonnegative().nullable(),
});

export const ChannelMemberSchema = z.object({
  channelId: z.string().min(1),
  memberName: NameSchema,
  role: ChannelMemberRoleSchema,
  joinedAt: z.number().int().nonnegative(),
});

/**
 * One row in the per-viewer channel list. `joined` reflects whether
 * the caller is a member; `myRole` is non-null only when joined.
 * `general` is special-cased: every viewer sees `joined: true,
 * myRole: 'member'`. The list also reports `memberCount` so the UI
 * can render `(N members)` next to channel names.
 */
export const ChannelSummarySchema = ChannelSchema.extend({
  joined: z.boolean(),
  myRole: ChannelMemberRoleSchema.nullable(),
  memberCount: z.number().int().nonnegative(),
});

export const ListChannelsResponseSchema = z.object({
  channels: z.array(ChannelSummarySchema),
});

export const GetChannelResponseSchema = z.object({
  channel: ChannelSummarySchema,
  members: z.array(ChannelMemberSchema),
});

export const CreateChannelRequestSchema = z.object({
  slug: ChannelSlugSchema,
});

export const RenameChannelRequestSchema = z.object({
  slug: ChannelSlugSchema,
});

export const AddChannelMemberRequestSchema = z.object({
  member: NameSchema,
  role: ChannelMemberRoleSchema.default('member'),
});

// ───────────────────────── Tool sources ─────────────────────
//
// Platform-registered providers of external tools. Credentials are
// write-only over the wire (set, never read back) and KEK-encrypted
// at rest server-side. Tool results are MCP CallToolResult-shaped so
// the runner relays them verbatim.

/** Tool-source slug: same grammar as channel slugs. Immutable in v1. */
export const ToolSourceSlugSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(
    /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/,
    'slug must be lowercase letters/digits/dashes, no consecutive dashes, no leading/trailing dash',
  );

export const ToolSourceKindSchema = z.enum(['custom', 'mcp']);
export const ToolCredentialKindSchema = z.enum(['bearer', 'header']);

/**
 * Tool names become MCP tool names on the agent side (prefixed with
 * `<source>__`), so the grammar is MCP-safe.
 */
export const ToolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'tool name must be alphanumeric with _ - allowed');

export const ToolSourceConfigSchema = z.object({
  url: z.string().url('url must be a URL').max(2048).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
});

export const ToolSourceSchema = z.object({
  id: z.string().min(1),
  slug: ToolSourceSlugSchema,
  kind: ToolSourceKindSchema,
  displayName: z.string().max(128).default(''),
  enabled: z.boolean(),
  allMembers: z.boolean(),
  config: ToolSourceConfigSchema,
  createdBy: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const ToolSourceSummarySchema = ToolSourceSchema.extend({
  hasCredential: z.boolean(),
  toolCount: z.number().int().nonnegative(),
  bound: z.boolean(),
});

export const CustomToolBindingSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  urlTemplate: z.string().min(1).max(4096),
  headers: z.record(z.string().min(1).max(128), z.string().max(4096)).optional(),
  bodyTemplate: z
    .union([z.string().max(64 * 1024), z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .optional(),
  contentType: z.string().max(255).optional(),
  resultPath: z.string().max(512).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
});

/** JSON Schema passthrough — agents consume it verbatim. */
const InputSchemaSchema = z.record(z.string(), z.unknown());

export const CustomToolDefSchema = z.object({
  name: ToolNameSchema,
  description: z.string().max(4096).default(''),
  inputSchema: InputSchemaSchema,
  binding: CustomToolBindingSchema,
});

export const ResolvedToolSchema = z.object({
  name: ToolNameSchema,
  description: z.string().max(4096),
  inputSchema: InputSchemaSchema,
});

export const ResolvedToolSourceSchema = z.object({
  source: ToolSourceSlugSchema,
  kind: ToolSourceKindSchema,
  tools: z.array(ResolvedToolSchema),
});

export const ListToolSourcesResponseSchema = z.object({
  sources: z.array(ToolSourceSummarySchema),
});

export const GetToolSourceResponseSchema = z.object({
  source: ToolSourceSummarySchema,
  tools: z.union([z.array(CustomToolDefSchema), z.array(ResolvedToolSchema)]),
  boundMembers: z.array(NameSchema).optional(),
});

export const CreateToolSourceRequestSchema = z.object({
  slug: ToolSourceSlugSchema,
  kind: ToolSourceKindSchema,
  displayName: z.string().max(128).optional(),
  config: ToolSourceConfigSchema.optional(),
  allMembers: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export const UpdateToolSourceRequestSchema = z.object({
  displayName: z.string().max(128).optional(),
  config: ToolSourceConfigSchema.optional(),
  allMembers: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export const SetToolCredentialRequestSchema = z
  .object({
    kind: ToolCredentialKindSchema,
    headerName: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9-]+$/, 'headerName must be a valid HTTP header token')
      .optional(),
    secret: z.string().min(1).max(8192),
  })
  .refine((v) => v.kind !== 'header' || v.headerName !== undefined, {
    message: 'headerName is required when kind=header',
  });

export const BindToolSourceRequestSchema = z.object({
  member: NameSchema,
});

export const SetCustomToolRequestSchema = z.object({
  description: z.string().max(4096).default(''),
  inputSchema: InputSchemaSchema,
  binding: CustomToolBindingSchema,
});

export const InvokeToolRequestSchema = z.object({
  args: z.record(z.string(), z.unknown()).optional(),
});

export const InvokeToolResponseSchema = z.object({
  content: z.array(z.record(z.string(), z.unknown())),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

export const RefreshToolSourceResponseSchema = z.object({
  tools: z.array(ResolvedToolSchema),
  changed: z.boolean(),
});

// ───────────────────────────── Secrets ───────────────────────
//
// Broker-held environment secrets. Values are write-only over the
// wire and KEK-encrypted at rest; the runner resolves and injects
// them as env vars on the agent child at spawn.

/** Secret slug: same grammar as tool-source slugs. Immutable. */
export const SecretSlugSchema = ToolSourceSlugSchema;

/**
 * Environment variable names a secret may never target. These are
 * either runner-managed (clobbering them breaks trace capture or
 * broker auth) or interpreter/loader control variables that would
 * hand a `secrets.manage` holder code execution on every runner
 * machine (PATH, LD_PRELOAD, NODE_OPTIONS, askpass hooks, …).
 * Checked case-insensitively; shared by server-side validation, the
 * web UI, and the runner's defensive filter.
 */
export const RESERVED_ENV_PREFIXES = [
  'CSUITE_',
  'OTEL_',
  'CLAUDE_CODE_',
  'CODEX_',
  'LD_',
  'DYLD_',
] as const;

export const RESERVED_ENV_NAMES = [
  'PATH',
  'HOME',
  'SHELL',
  'TERM',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'IFS',
  'ENV',
  'BASH_ENV',
  'PS4',
  'PROMPT_COMMAND',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PERL5LIB',
  'PERL5OPT',
  'RUBYOPT',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
] as const;

/** True when `name` may not be used as a secret's target env var. */
export function isReservedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if ((RESERVED_ENV_NAMES as readonly string[]).includes(upper)) return true;
  return RESERVED_ENV_PREFIXES.some((p) => upper.startsWith(p));
}

export const SecretEnvNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Z][A-Z0-9_]*$/,
    'envName must be an uppercase POSIX environment variable name ([A-Z][A-Z0-9_]*)',
  )
  .refine((name) => !isReservedEnvName(name), {
    message: 'envName is reserved (runner-managed or an interpreter/loader control variable)',
  });

/**
 * Value bound: generous enough for PEM keys and service-account JSON
 * blobs, small enough to stay an env var.
 */
export const SecretValueSchema = z.string().min(1).max(32_768);

export const SecretSchema = z.object({
  id: z.string().min(1),
  slug: SecretSlugSchema,
  envName: SecretEnvNameSchema,
  description: z.string().max(1024).default(''),
  enabled: z.boolean(),
  allMembers: z.boolean(),
  createdBy: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const SecretSummarySchema = SecretSchema.extend({
  hasValue: z.boolean(),
  bound: z.boolean(),
});

export const ListSecretsResponseSchema = z.object({
  secrets: z.array(SecretSummarySchema),
});

export const GetSecretResponseSchema = z.object({
  secret: SecretSummarySchema,
  boundMembers: z.array(NameSchema).optional(),
});

export const CreateSecretRequestSchema = z.object({
  slug: SecretSlugSchema,
  envName: SecretEnvNameSchema,
  description: z.string().max(1024).optional(),
  allMembers: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export const UpdateSecretRequestSchema = z.object({
  envName: SecretEnvNameSchema.optional(),
  description: z.string().max(1024).optional(),
  allMembers: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

/** Write-only: the value is KEK-encrypted at rest and never returned. */
export const SetSecretValueRequestSchema = z.object({
  value: SecretValueSchema,
});

export const BindSecretRequestSchema = z.object({
  member: NameSchema,
});

export const ResolveSecretsResponseSchema = z.object({
  env: z.record(z.string(), z.string()),
});

// ────────────────── External Notifications ────────────────────
//
// Inbound webhooks / API calls received on `POST /hooks/:slug`,
// verified per-endpoint, and routed to members or channels as
// ambient input. Signing secrets are write-only over the wire and
// KEK-encrypted at rest.

/** Endpoint/profile slug: same grammar as tool-source slugs. Immutable. */
export const NotificationSlugSchema = ToolSourceSlugSchema;

export const NotificationAuthKindSchema = z.enum(['hmac-sha256', 'header-secret']);

/** HTTP header field name grammar (RFC 7230 token, pragmatically). */
const HeaderNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9-_]+$/, 'header name must be alphanumeric with - _ allowed');

export const NotificationAuthConfigSchema = z.object({
  kind: NotificationAuthKindSchema,
  headerName: HeaderNameSchema.nullable().default(null),
  prefix: z.string().max(32).nullable().default(null),
});

/** Input variant: `kind` required, the rest defaulted. */
export const NotificationAuthInputSchema = z.object({
  kind: NotificationAuthKindSchema,
  headerName: HeaderNameSchema.nullable().optional(),
  prefix: z.string().max(32).nullable().optional(),
});

export const NotificationTargetSchema = z
  .object({
    member: NameSchema.optional(),
    channel: z.string().min(1).max(128).optional(),
  })
  .refine((t) => (t.member === undefined) !== (t.channel === undefined), {
    message: 'target must set exactly one of member / channel',
  });

export const NotificationFilterOpSchema = z.enum(['eq', 'ne', 'in', 'exists', 'contains']);

export const NotificationFilterRuleSchema = z.object({
  path: z.string().min(1).max(256),
  op: NotificationFilterOpSchema,
  value: z.unknown().optional(),
});

const DebounceMsSchema = z
  .number()
  .int()
  .min(0)
  .max(10 * 60 * 1000);

export const NotificationDeliveryPolicySchema = z.object({
  ifOffline: z.enum(['drop', 'queue']).default('drop'),
  ifBusy: z.enum(['now', 'wait']).default('now'),
  debounceMs: DebounceMsSchema.default(0),
  debounceMax: z.number().int().min(2).max(500).default(20),
  queueTtlMs: z
    .number()
    .int()
    .min(60 * 1000)
    .max(7 * 24 * 60 * 60 * 1000)
    .default(24 * 60 * 60 * 1000),
  maxWaitMs: z
    .number()
    .int()
    .min(10 * 1000)
    .max(24 * 60 * 60 * 1000)
    .default(15 * 60 * 1000),
});

/** Input variant: every field optional; server fills defaults. */
export const NotificationDeliveryPolicyInputSchema = NotificationDeliveryPolicySchema.partial();

export const NotificationTemplateSchema = z.string().min(1).max(8192);

export const NotificationEndpointSchema = z.object({
  id: z.string().min(1),
  slug: NotificationSlugSchema,
  displayName: z.string().max(128).default(''),
  description: z.string().max(1024).default(''),
  enabled: z.boolean(),
  auth: NotificationAuthConfigSchema,
  authProfile: NotificationSlugSchema.nullable(),
  targets: z.array(NotificationTargetSchema).max(32),
  level: LogLevelSchema,
  title: z.string().max(200).nullable(),
  template: NotificationTemplateSchema.nullable(),
  filters: z.array(NotificationFilterRuleSchema).max(32),
  policy: NotificationDeliveryPolicySchema,
  dedupeHeader: HeaderNameSchema.nullable(),
  createdBy: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const NotificationEndpointSummarySchema = NotificationEndpointSchema.extend({
  hasSecret: z.boolean(),
});

export const NotificationProfileSchema = z.object({
  id: z.string().min(1),
  slug: NotificationSlugSchema,
  description: z.string().max(1024).default(''),
  auth: NotificationAuthConfigSchema,
  createdBy: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const NotificationProfileSummarySchema = NotificationProfileSchema.extend({
  hasSecret: z.boolean(),
  endpointCount: z.number().int().nonnegative(),
});

export const NotificationDeliveryStatusSchema = z.enum([
  'delivered',
  'pending',
  'expired',
  'dropped',
  'rejected',
  'filtered',
  'duplicate',
  'coalesced',
  'failed',
]);

export const NotificationOverridesSchema = z.object({
  ifOffline: z.enum(['drop', 'queue']).optional(),
  ifBusy: z.enum(['now', 'wait']).optional(),
  level: LogLevelSchema.optional(),
});

export const NotificationDeliverySchema = z.object({
  id: z.string().min(1),
  endpointSlug: NotificationSlugSchema,
  receivedAt: z.number().int().nonnegative(),
  status: NotificationDeliveryStatusSchema,
  statusReason: z.string().nullable(),
  dedupeKey: z.string().nullable(),
  messageIds: z.array(z.string()),
  bodyPreview: z.string(),
  contentType: z.string().nullable(),
  overrides: NotificationOverridesSchema.nullable(),
  deliveredAt: z.number().int().nonnegative().nullable(),
  replayOf: z.string().nullable(),
});

export const CreateNotificationEndpointRequestSchema = z.object({
  slug: NotificationSlugSchema,
  displayName: z.string().max(128).optional(),
  description: z.string().max(1024).optional(),
  enabled: z.boolean().optional(),
  auth: NotificationAuthInputSchema.optional(),
  authProfile: NotificationSlugSchema.nullable().optional(),
  targets: z.array(NotificationTargetSchema).min(1).max(32),
  level: LogLevelSchema.optional(),
  title: z.string().max(200).nullable().optional(),
  template: NotificationTemplateSchema.nullable().optional(),
  filters: z.array(NotificationFilterRuleSchema).max(32).optional(),
  policy: NotificationDeliveryPolicyInputSchema.optional(),
  dedupeHeader: HeaderNameSchema.nullable().optional(),
});

export const UpdateNotificationEndpointRequestSchema = CreateNotificationEndpointRequestSchema.omit(
  { slug: true },
).extend({
  targets: z.array(NotificationTargetSchema).min(1).max(32).optional(),
});

/** Write-only: stored KEK-encrypted, never returned. */
export const SetNotificationSecretRequestSchema = z.object({
  secret: z.string().min(1).max(4096),
});

export const CreateNotificationProfileRequestSchema = z.object({
  slug: NotificationSlugSchema,
  description: z.string().max(1024).optional(),
  auth: NotificationAuthInputSchema,
});

export const UpdateNotificationProfileRequestSchema = z.object({
  description: z.string().max(1024).optional(),
  auth: NotificationAuthInputSchema.optional(),
});

export const ListNotificationEndpointsResponseSchema = z.object({
  endpoints: z.array(NotificationEndpointSummarySchema),
});

export const GetNotificationEndpointResponseSchema = z.object({
  endpoint: NotificationEndpointSummarySchema,
});

export const ListNotificationProfilesResponseSchema = z.object({
  profiles: z.array(NotificationProfileSummarySchema),
});

export const ListNotificationDeliveriesResponseSchema = z.object({
  deliveries: z.array(NotificationDeliverySchema),
});

export const ReplayNotificationDeliveryResponseSchema = z.object({
  delivery: NotificationDeliverySchema,
});

export const HookIngressResponseSchema = z.object({
  id: z.string().min(1),
  status: NotificationDeliveryStatusSchema,
});

// ───────────────────────── Trace entries ─────────────────────
//
// Trace entries are normalized runner-side from each agent's native
// instrumentation (Claude Code OTEL bodies, the codex app-server
// stream). They flow through the member activity stream (below)
// rather than a per-objective table. Every captured exchange is an
// Anthropic `/v1/messages`-shaped record — there is no opaque HTTP
// catch-all, since the capture surface no longer intercepts arbitrary
// traffic. Schemas stay permissive because Anthropic's API shape
// evolves. The server stores them as JSON; the web UI walks them with
// its own renderer.

const AnthropicContentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string(),
    content: z.unknown(),
    isError: z.boolean(),
  }),
  z.object({ type: z.literal('image'), mediaType: z.string().nullable() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({ type: z.literal('unknown'), raw: z.unknown() }),
]);

const AnthropicMessageSchema = z.object({
  role: z.string(),
  content: z.array(AnthropicContentBlockSchema),
});

const AnthropicUsageSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cacheCreationInputTokens: z.number().nullable(),
  cacheReadInputTokens: z.number().nullable(),
});

const AnthropicToolSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  inputSchema: z.unknown(),
});

// The concrete captured-entry shape. An LLM exchange carries one of
// these (an `AnthropicMessagesEntry`); it is the only trace-entry
// variant now that arbitrary-HTTP capture is gone.
const AnthropicMessagesEntrySchema = z.object({
  kind: z.literal('anthropic_messages'),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative(),
  request: z.object({
    model: z.string().nullable(),
    maxTokens: z.number().nullable(),
    temperature: z.number().nullable(),
    system: z.string().nullable(),
    messages: z.array(AnthropicMessageSchema),
    tools: z.array(AnthropicToolSchema).nullable(),
  }),
  response: z
    .object({
      stopReason: z.string().nullable(),
      stopSequence: z.string().nullable(),
      messages: z.array(AnthropicMessageSchema),
      usage: AnthropicUsageSchema.nullable(),
      status: z.number().nullable(),
      // API response/message id (`msg_...`) — the exact join key to
      // the matching GenAI inference record. Optional: absent on rows
      // captured before this field existed, null when the capture
      // source has no id (codex turn aggregation).
      responseId: z.string().nullable().optional(),
    })
    .nullable(),
});

// ─────────────────────── GenAI inference records ──────────────────────
//
// Validators for the OpenTelemetry-GenAI-shaped inference records
// (see `GenAiInference` in types.ts). Kept deliberately PERMISSIVE:
// `GenAiPartSchema` is an extensible union of the known part shapes
// followed by a loose generic fallback so blocks we don't model yet
// pass through intact rather than failing validation.

export const GenAiPartSchema = z.union([
  z.object({ type: z.literal('text'), content: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    id: z.string().nullable(),
    name: z.string().nullable(),
    arguments: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_call_response'),
    id: z.string().nullable(),
    response: z.unknown(),
    is_error: z.boolean(),
  }),
  z.object({ type: z.literal('reasoning'), content: z.string() }),
  z.object({
    type: z.literal('blob'),
    mime_type: z.string().nullable(),
    data: z.string().nullable(),
  }),
  z.object({
    type: z.literal('file'),
    mime_type: z.string().nullable(),
    uri: z.string().nullable(),
  }),
  z.object({ type: z.literal('generic'), content: z.unknown() }),
  // Extensible fallback: any object carrying a string `type` survives.
  z.looseObject({ type: z.string() }),
]);

export const GenAiMessageSchema = z.object({
  role: z.string(),
  parts: z.array(GenAiPartSchema),
});

export const GenAiUsageSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cacheReadInputTokens: z.number().nullable(),
  cacheCreationInputTokens: z.number().nullable(),
});

export const GenAiInferenceSchema = z.object({
  operationName: z.literal('chat'),
  provider: z.union([z.literal('anthropic'), z.literal('openai')]),
  model: z.string().nullable(),
  responseId: z.string().nullable(),
  finishReasons: z.array(z.string()),
  usage: GenAiUsageSchema.nullable(),
  systemInstructions: z.array(GenAiPartSchema),
  inputMessages: z.array(GenAiMessageSchema),
  outputMessages: z.array(GenAiMessageSchema),
  // Thread attribution — which interleaved thread of a member's work
  // made this call. Sourced from the `api_request` OTEL event, not the
  // request body; null when the source attributes were absent.
  querySource: z.string().nullable(),
  agentName: z.string().nullable(),
  ts: z.number().int().nonnegative(),
});

/**
 * One stored inference record as served by `GET /members/:name/genai`
 * — the upload shape plus server-assigned row identity.
 */
export const GenAiInferenceRecordSchema = GenAiInferenceSchema.extend({
  id: z.number().int().nonnegative(),
  memberName: NameSchema,
  receivedAt: z.number().int().nonnegative(),
});

export const ListGenaiResponseSchema = z.object({
  inferences: z.array(GenAiInferenceRecordSchema),
});

/**
 * The light projection served by `GET /members/:name/genai?view=summary`
 * — a full record minus the heavy content arrays. Cheap enough to
 * hydrate per feed window; the turn-spine timeline joins these onto
 * `llm_exchange` markers and lazy-loads full bodies by id.
 */
export const GenAiInferenceSummarySchema = GenAiInferenceRecordSchema.omit({
  systemInstructions: true,
  inputMessages: true,
  outputMessages: true,
});

export const ListGenaiSummariesResponseSchema = z.object({
  inferences: z.array(GenAiInferenceSummarySchema),
});

export const GetGenaiInferenceResponseSchema = z.object({
  inference: GenAiInferenceRecordSchema,
});

// ───────────────────────── Activity stream ──────────────────────

export const ActivityKindSchema = z.enum([
  'objective_open',
  'objective_close',
  'llm_exchange',
  'tool_action',
  'user_prompt',
]);

export const ActivityEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('objective_open'),
    ts: z.number().int().nonnegative(),
    objectiveId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('objective_close'),
    ts: z.number().int().nonnegative(),
    objectiveId: z.string().min(1),
    result: z.enum(['done', 'cancelled', 'reassigned', 'runner_shutdown']),
  }),
  z.object({
    kind: z.literal('llm_exchange'),
    ts: z.number().int().nonnegative(),
    duration: z.number().int().nonnegative(),
    // Which agent produced it (`'claude'`, `'codex'`). Optional so
    // older captured rows without it still validate, but every live
    // producer stamps it — matching `tool_action` / `user_prompt`.
    agent: z.string().optional(),
    // Thread attribution: `codex_main_thread` vs `codex_subagent:<id8>`,
    // mirroring the gen_ai / raw layers. Optional; set by the codex
    // rollout reader so sub-agent turns are distinguishable in the feed.
    querySource: z.string().optional(),
    entry: AnthropicMessagesEntrySchema,
  }),
  // tool_action — captured from an agent's NATIVE instrumentation
  // (Claude Code hooks, codex item stream). `input`/`result` are
  // whatever the agent framework hands us, so they stay permissive
  // (z.unknown()) — a novel tool shape must never fail validation.
  z.object({
    kind: z.literal('tool_action'),
    ts: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative().optional(),
    agent: z.string().optional(),
    // Thread attribution (`codex_main_thread` / `codex_subagent:<id8>`),
    // set by the codex rollout reader; mirrors the gen_ai / raw layers.
    querySource: z.string().optional(),
    toolName: z.string(),
    input: z.unknown().optional(),
    result: z.unknown().optional(),
    isError: z.boolean().optional(),
    source: z.string().optional(),
    // The Anthropic tool_use id (from the PostToolUse hook's
    // `tool_use_id`) that lets the UI fold this action's result into
    // the matching tool_use block of the model's llm_exchange turn.
    toolUseId: z.string().optional(),
  }),
  // user_prompt — the prompt that woke the turn, captured from the
  // Claude UserPromptSubmit hook. Text is redacted runner-side, so the
  // schema only validates shape (a permissive string).
  z.object({
    kind: z.literal('user_prompt'),
    ts: z.number().int().nonnegative(),
    text: z.string(),
    promptId: z.string().optional(),
    agent: z.string().optional(),
    // Thread attribution (`codex_main_thread` / `codex_subagent:<id8>`),
    // set by the codex rollout reader; mirrors the gen_ai / raw layers.
    querySource: z.string().optional(),
  }),
]);

export const ActivityRowSchema = z.object({
  id: z.number().int().nonnegative(),
  memberName: NameSchema,
  event: ActivityEventSchema,
  createdAt: z.number().int().nonnegative(),
});

export const UploadActivityRequestSchema = z.object({
  events: z.array(ActivityEventSchema).min(1).max(500),
});

export const UploadActivityResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
});

export const ListActivityResponseSchema = z.object({
  activity: z.array(ActivityRowSchema),
});

export const ListActivityQuerySchema = z.object({
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(),
  kind: z.union([ActivityKindSchema, z.array(ActivityKindSchema)]).optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

// ───────────────────────── Members ────────────────────────────

/**
 * Permission list as sent over the wire — each entry is either a
 * preset name (resolved by the server) or a leaf permission. The
 * server validates every entry resolves.
 */
const PermissionRefListSchema = z.array(z.string().min(1).max(64)).max(32);

export const CreateMemberRequestSchema = z.object({
  name: NameSchema,
  role: RoleSchema,
  instructions: z.string().max(8192).default(''),
  permissions: PermissionRefListSchema,
});

export const UpdateMemberRequestSchema = z
  .object({
    role: RoleSchema.optional(),
    instructions: z.string().max(8192).optional(),
    permissions: PermissionRefListSchema.optional(),
  })
  .refine(
    (v) => v.role !== undefined || v.instructions !== undefined || v.permissions !== undefined,
    { message: 'update must include at least one of: role, instructions, permissions' },
  );

export const CreateMemberResponseSchema = z.object({
  member: TeammateSchema,
  token: z.string(),
});

export const ListMembersResponseSchema = z.object({
  members: z.array(MemberSchema),
});

export const RotateTokenResponseSchema = z.object({
  token: z.string(),
  tokenInfo: z.lazy(() => TokenInfoSchema).optional(),
});

export const EnrollTotpResponseSchema = z.object({
  totpSecret: z.string(),
  totpUri: z.string(),
});

// ───────────────────────── Tokens (multi-token) ────────────────

/**
 * Token row id — uuid v4 string. Stable across the token's lifetime;
 * used in revoke calls so an admin can revoke a specific device's
 * token without affecting peer tokens for the same member.
 */
export const TokenIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'token id must be a uuid',
  );

export const TokenLabelSchema = z.string().max(64).default('');

export const TokenOriginSchema = z.enum(['bootstrap', 'rotate', 'enroll']);

export const TokenInfoSchema = z.object({
  id: TokenIdSchema,
  memberName: NameSchema,
  label: TokenLabelSchema,
  origin: TokenOriginSchema,
  createdAt: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative().nullable(),
  expiresAt: z.number().int().nonnegative().nullable(),
  createdBy: NameSchema.nullable(),
});

export const ListTokensResponseSchema = z.object({
  tokens: z.array(TokenInfoSchema),
});

// ───────────────────────── Device-code enrollment ──────────────

/**
 * Public-facing 8-char user code, formatted with a hyphen for
 * readability (`XXXX-XXXX`). Crockford base32 alphabet (excludes
 * I, L, O, U) keeps it unambiguous when read aloud or transcribed.
 *
 * The server emits this exact format; on input (approve/reject)
 * we accept any case and any spacing/hyphenation that normalizes
 * to 8 valid chars — this regex matches the canonical wire form.
 */
export const UserCodeSchema = z
  .string()
  .regex(
    /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    'userCode must be `XXXX-XXXX` (Crockford base32)',
  );

/**
 * Device code: high-entropy opaque secret. 32 raw bytes → 43-char
 * base64url payload, prefixed for legibility in logs. Treated as a
 * shared secret on the wire; the server stores only its sha256 hash.
 */
export const DeviceCodeSchema = z
  .string()
  .regex(
    /^csuite-dc_[A-Za-z0-9_-]{40,64}$/,
    'deviceCode must be in the canonical `csuite-dc_<base64url>` form',
  );

export const DeviceAuthorizationRequestSchema = z.object({
  labelHint: z.string().max(64).optional(),
});

export const DeviceAuthorizationResponseSchema = z.object({
  deviceCode: DeviceCodeSchema,
  userCode: UserCodeSchema,
  verificationUri: z.string().min(1),
  verificationUriComplete: z.string().min(1),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
});

export const DeviceTokenRequestSchema = z.object({
  deviceCode: DeviceCodeSchema,
});

export const DeviceTokenResponseSchema = z.object({
  token: z.string(),
  tokenId: TokenIdSchema,
  member: TeammateSchema,
});

export const DeviceTokenErrorCodeSchema = z.enum([
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
]);

export const DeviceTokenErrorResponseSchema = z.object({
  error: DeviceTokenErrorCodeSchema,
  errorDescription: z.string().max(512).optional(),
});

export const PendingEnrollmentSchema = z.object({
  userCode: UserCodeSchema,
  labelHint: z.string().max(64),
  sourceIp: z.string().max(64).nullable(),
  sourceUa: z.string().max(512).nullable(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});

export const ListPendingEnrollmentsResponseSchema = z.object({
  enrollments: z.array(PendingEnrollmentSchema),
});

/**
 * Approve body. Discriminated union on `mode` so zod surfaces
 * clear errors when a `bind` payload is missing `memberName` or a
 * `create` payload is missing `role` / `permissions`. Inputs are
 * lenient on label (optional, capped) but strict on names and roles.
 */
export const ApproveEnrollmentRequestSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('bind'),
    userCode: UserCodeSchema,
    memberName: NameSchema,
    label: TokenLabelSchema.optional(),
  }),
  z.object({
    mode: z.literal('create'),
    userCode: UserCodeSchema,
    memberName: NameSchema,
    role: RoleSchema,
    instructions: z.string().max(8192).default(''),
    permissions: PermissionRefListSchema,
    label: TokenLabelSchema.optional(),
  }),
]);

export const ApproveEnrollmentResponseSchema = z.object({
  member: TeammateSchema,
  tokenInfo: TokenInfoSchema,
});

export const RejectEnrollmentRequestSchema = z.object({
  userCode: UserCodeSchema,
  reason: z.string().max(256).optional(),
});

// ───────────────────────── Briefing + session ─────────────────

export const BriefingResponseSchema = MemberSchema.extend({
  team: TeamSchema,
  teammates: z.array(TeammateSchema),
  openObjectives: z.array(ObjectiveSchema),
  // Defaulted so pre-tool-sources brokers (and test fixtures) that
  // omit the field still parse.
  toolSources: z.array(ResolvedToolSourceSchema).default([]),
});

export const RosterResponseSchema = z.object({
  teammates: z.array(TeammateSchema),
  connected: z.array(PresenceSchema),
});

export const HistoryResponseSchema = z.object({
  messages: z.array(MessageSchema),
});

export const TotpLoginRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'code must be exactly 6 digits'),
  member: NameSchema.optional(),
});

export const SessionResponseSchema = z.object({
  member: NameSchema,
  role: RoleSchema,
  permissions: z.array(PermissionSchema),
  expiresAt: z.number().int().positive(),
});

export const VapidPublicKeyResponseSchema = z.object({
  publicKey: z.string().min(1),
});

export const PushSubscriptionPayloadSchema = z.object({
  endpoint: z.string().url('endpoint must be a URL').max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
});

export const PushSubscriptionResponseSchema = z.object({
  id: z.number().int().nonnegative(),
  endpoint: z.string(),
  createdAt: z.number().int().nonnegative(),
});

// ───────────────────────── Filesystem ─────────────────────────

export const FsEntryKindSchema = z.enum(['file', 'directory']);

export const FsEntrySchema = z.object({
  path: FsPathSchema,
  name: z.string().min(1).max(255),
  kind: FsEntryKindSchema,
  owner: NameSchema,
  size: z.number().int().nonnegative().nullable(),
  mimeType: z.string().max(255).nullable(),
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'hash must be sha256 hex')
    .nullable(),
  createdAt: z.number().int().nonnegative(),
  createdBy: NameSchema,
  updatedAt: z.number().int().nonnegative(),
});

export const FsListResponseSchema = z.object({
  entries: z.array(FsEntrySchema),
});

export const FsEntryResponseSchema = z.object({
  entry: FsEntrySchema,
});

export const FsWriteResponseSchema = z.object({
  entry: FsEntrySchema,
  renamed: z.boolean(),
});

export const FsMkdirRequestSchema = z.object({
  path: FsPathSchema,
  recursive: z.boolean().optional(),
});

export const FsMoveRequestSchema = z.object({
  from: FsPathSchema,
  to: FsPathSchema,
});

export const FsWriteCollisionSchema = z.enum(['error', 'overwrite', 'suffix']);
