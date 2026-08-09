/**
 * Runtime validators for the csuite wire protocol.
 *
 * Both the server and the client use these to validate messages crossing
 * the network boundary. Pulling from `csuite-sdk/schemas` keeps zod
 * as an explicit runtime dependency for consumers that want it.
 */

import { z } from 'zod';
import type { SpineEventKind } from './types.js';
import {
  PERMISSIONS,
  SPINE_DUMP_SOURCES,
  SPINE_EVENT_CLASSES,
  SPINE_EVENT_KINDS,
  SPINE_FLOOR_SIGNALS,
  SPINE_INJECTION_KINDS,
  SPINE_POLL_MIN_INTERVAL_MS,
  SPINE_SUBSCRIPTION_LEVELS,
} from './types.js';

export const LogLevelSchema = z.enum(['debug', 'info', 'notice', 'warning', 'error', 'critical']);

/**
 * The 3-state activity model — orthogonal to connection presence.
 * `idle` (available), `working` (mid-turn: generation and/or tools),
 * `blocked` (waiting on a human). See `ActivityState` in types.ts.
 */
export const ActivityStateSchema = z.enum(['idle', 'working', 'blocked']);

/**
 * Whether a member's VERBATIM capture is reaching the broker.
 *
 * Two states, both emitted explicitly — there is deliberately no
 * "unknown" or "pending" member here. A broker that knows about this
 * field always says which of the two applies to a member it has
 * evaluated; **the absence of the field is what carries "no opinion,"
 * and absence must never be read as `ok`.**
 *
 * No `pending`: healthy correlation lag means every normal turn is
 * briefly unmatched (measured p50 ~4.2s), so a user-visible "maybe"
 * would flicker continuously on healthy traffic. Pending is tracked
 * internally and reported as `ok` until the evidence threshold is met.
 *
 * `'unevaluated'` is a POSITIVE statement that this broker cannot
 * assess this member — currently Codex members, whose markers carry no
 * `responseId` to match on and whose containment join is not built.
 * Reporting them `ok` would assert a property never evaluated, which is
 * the same conflation this whole signal exists to remove, one layer up.
 */
export const CaptureHealthStateSchema = z.enum(['ok', 'gap', 'unevaluated']);

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
  description: z.string().default(''),
});

export const TeamSchema = z.object({
  name: z.string().min(1).max(128),
  context: z.string().default(''),
  permissionPresets: PermissionPresetsSchema.default({}),
});

/**
 * Public projection of a team member — what teammates see in the
 * roster and instruction packet. Omits `instructions` (private to the member).
 */
export const TeammateSchema = z.object({
  name: NameSchema,
  role: RoleSchema,
  permissions: z.array(PermissionSchema),
  // Person vs agent for identity rendering. Optional — older servers
  // omit it, and consumers render the absent case as the neutral
  // (agent) treatment. Must stay in the schema or zod strips it.
  kind: z.enum(['person', 'agent']).optional(),
});

/**
 * Full member record — includes the private `instructions` field.
 * Returned from self-scope instructions and admin-scope member listings.
 */
export const MemberSchema = TeammateSchema.extend({
  instructions: z.string().default(''),
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
  /**
   * Whether this member's VERBATIM capture is reaching the broker.
   *
   * `'ok'` and `'gap'` are BOTH emitted explicitly by a broker that
   * knows about this field. **Absence means "old broker, no opinion" —
   * never "healthy."** That distinction is the whole point: the
   * optional-for-compatibility precedent (`activityWindowMs`) is what
   * makes the field safe to add, and it would silently reintroduce the
   * exact ambiguity this exists to remove if absence read as fine.
   *
   * A member can report activity all day while none of their bodies
   * arrive — `TracePanel` renders their markers either way, by design,
   * because rich-layer coverage is deliberately best-effort. That makes
   * *this turn has no rich record* (normal) and *this member has none
   * at all* (systematic failure) look identical. This is the second
   * signal that separates them.
   *
   * `'gap'` is only ever set once a marker has aged past the grace
   * window; there is no user-visible "maybe" state, because healthy
   * correlation lag means every normal turn is briefly unmatched.
   */
  captureHealth: CaptureHealthStateSchema.optional(),
  // Retained completeness failures for this member that have not been
  // observed to recover. Absence means "this broker retains no
  // diagnostics", never "clean" — same rule as `captureHealth`.
  diagnosticsUnresolved: z.number().int().nonnegative().optional(),
  diagnosticsRetention: z.enum(['healthy', 'degraded', 'unknown']).optional(),
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
  capabilities: z
    .object({
      rawBodyAck: z.boolean().optional(),
    })
    .optional(),
});

// ───────────────────────── Objectives ─────────────────────────

export const ObjectiveStatusSchema = z.enum(['active', 'blocked', 'done', 'cancelled']);

export const ObjectiveEventKindSchema = z.enum([
  'assigned',
  'blocked',
  'unblocked',
  'completed',
  'cancelled',
  'reassigned',
  'watcher_added',
  'watcher_removed',
  'amended',
  'event_corrected',
]);

export const AmendmentDispositionSchema = z.enum(['correction', 'scope_change']);
export const AmendableFieldSchema = z.enum(['title', 'outcome', 'body']);

export const ObjectiveAmendmentSchema = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('contract'),
    version: z.number().int().positive(),
    ts: z.number().int().nonnegative(),
    actor: NameSchema,
    disposition: AmendmentDispositionSchema,
    reason: z.string().min(1).max(2048),
    fields: z.array(AmendableFieldSchema).min(1),
    previous: z
      .object({
        title: z.string().optional(),
        outcome: z.string().optional(),
        body: z.string().optional(),
      })
      .default({}),
  }),
  z.object({
    target: z.literal('event'),
    ts: z.number().int().nonnegative(),
    actor: NameSchema,
    reason: z.string().min(1).max(2048),
    eventId: z.string().min(1),
    eventKind: ObjectiveEventKindSchema,
    eventTs: z.number().int().nonnegative(),
    correction: z.string().min(1).max(4096),
  }),
]);

/**
 * At least one contract field, and `reason`/`disposition` are
 * required. An amendment that supplies no field is rejected upstream
 * rather than recorded as a no-op version bump.
 */
export const AmendObjectiveRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  outcome: z.string().min(1).max(2048).optional(),
  body: z.string().max(4096).optional(),
  reason: z.string().min(1).max(2048),
  disposition: AmendmentDispositionSchema,
});

export const CorrectObjectiveEventRequestSchema = z.object({
  eventId: z.string().min(1),
  correction: z.string().min(1).max(4096),
  reason: z.string().min(1).max(2048),
});

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
  // Defaulted so a client reading an older broker's response still
  // parses: absent means "never amended, version 1", which is the
  // truth for every objective created before amendment existed.
  outcomeVersion: z.number().int().positive().default(1),
  amendments: z.array(ObjectiveAmendmentSchema).default([]),
});

export const ObjectiveEventSchema = z.object({
  id: z.string().default(''),
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
  /**
   * Scope to every objective this member has ANY relationship with —
   * assigned, originated, or watching. Distinct from `assignee`, which
   * is the narrower "on their plate" question: a member who originates
   * or watches without being assigned matches `related` and not
   * `assignee`. Members without `objectives.create` may only pass their
   * own name.
   */
  related: NameSchema.optional(),
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
  /**
   * Optional so a runner keeps working against a broker that predates
   * it. Absent means "assume every key is secret" — the old behaviour,
   * and the safe direction to be wrong in.
   */
  secretEnvNames: z.array(z.string()).optional(),
});

// ─────────────────────── Team process document ────────────────────
//
// The team's process as ONE authored document, injected into every
// member's fixed context. Not a list of rulings: a list is a changelog
// wearing the costume of a specification, and it only ever
// accumulates, whereas a document gets edited and superseded content
// leaves.
//
// Authority is the edit permission and nothing else. There is no
// per-statement provenance, no anchors and no citation machinery —
// whoever holds the leaf can change what binds the team, and the
// record says who did it, why, and what the text was before.

/**
 * The ceiling on the injected document, and therefore the answer to
 * "state the ceiling, or state that there is none."
 *
 * 16384 characters. Basis, so the number is arguable rather than
 * arbitrary: this document is resident in EVERY member's context in
 * EVERY session, so its size is a recurring cost paid by everyone, not
 * a one-off. 16384 is ample for a team process — the four rules this
 * team actually had rendered to 1085 characters — while bounding that
 * recurring cost at a number someone can reason about.
 *
 * The predecessor design had no ceiling at all: it held N rules with
 * nothing capping N, so the injected block was unbounded and nothing
 * reported it. One document with one cap is the whole fix.
 *
 * This is NOT an `instructions` cap — there is no longer any such
 * thing, since #122 removed every length cap on authored text in #129.
 * That is precisely why this ceiling has to stand on its own terms
 * rather than by analogy to a number that no longer exists.
 *
 * And the document rides in its own response field for a reason that
 * never depended on any cap: a member authors their own
 * `instructions`, this is authored by whoever holds `process.manage`,
 * and one string would collapse two authorities into one field.
 */
export const PROCESS_DOCUMENT_MAX = 16_384;

/**
 * THE single list of what an edit may change.
 *
 * One shape drives all three of: what the edit API accepts, what the
 * history record can hold, and what the field enum names. They cannot
 * disagree, because there is only one of them.
 *
 * This exists because of a real defect in the predecessor: the request
 * schema accepted two fields the history record had no columns for, so
 * editing them wrote the new value and recorded no prior one — and
 * paired with a tracked field it did that silently, because the record
 * looked well-formed. Adding the missing entries would have made the
 * two lists agree that day without stopping the next field from being
 * accepted before it was recordable.
 *
 * Today the list has one entry. That is exactly when this construction
 * is worth building, not a reason to skip it: the second field is
 * where the defect appears, and by then nobody is thinking about it.
 */
const EDITABLE_PROCESS_DOCUMENT_SHAPE = {
  text: z.string().min(1).max(PROCESS_DOCUMENT_MAX),
};

type EditableProcessDocumentField = keyof typeof EDITABLE_PROCESS_DOCUMENT_SHAPE;

/** Derived from the shape's own keys — not a second list to maintain. */
export const PROCESS_DOCUMENT_FIELDS = Object.keys(EDITABLE_PROCESS_DOCUMENT_SHAPE) as [
  EditableProcessDocumentField,
  ...EditableProcessDocumentField[],
];

export const ProcessDocumentFieldSchema = z.enum(PROCESS_DOCUMENT_FIELDS);

export const ProcessDocumentSchema = z.object({
  text: z.string().min(1).max(PROCESS_DOCUMENT_MAX),
  /** 1 on the first write. Incremented by every edit. */
  version: z.number().int().positive(),
  createdBy: NameSchema,
  createdAt: z.number().int().nonnegative(),
  updatedBy: NameSchema,
  updatedAt: z.number().int().nonnegative(),
});

/**
 * One entry in the append-only edit history.
 *
 * `previous` is empty on version 1 — the document was created, so
 * there is no prior text. Every later edit carries the text as it
 * stood before, retained rather than reconstructed, so the diff the
 * outcome asks for is derived from two stored strings.
 */
export const ProcessDocumentEditSchema = z
  .object({
    /** The version this edit PRODUCED. */
    version: z.number().int().positive(),
    ts: z.number().int().nonnegative(),
    actor: NameSchema,
    reason: z.string().min(1).max(2048),
    disposition: AmendmentDispositionSchema,
    /**
     * Non-empty and duplicate-free, because the writer cannot produce
     * either. `write()` rejects a no-op before it appends history, so a
     * stored `[]` is an edit event claiming nothing changed — and a
     * repeated name is a record asserting one field moved twice in one
     * edit. Both are shapes only corruption creates, and `z.array()`
     * alone accepts both.
     */
    fields: z
      .array(ProcessDocumentFieldSchema)
      .min(1, 'an edit that changed nothing cannot exist — write() rejects it before history')
      .refine((f) => new Set(f).size === f.length, {
        message: 'an edit cannot record the same field twice',
      }),
    /**
     * Same shape as what the edit API accepts — and REQUIRED and
     * STRICT, because `.partial().default({})` did two lossy things
     * before the refinement ever ran:
     *
     *   unknown key   silently STRIPPED, so corruption was erased
     *                 rather than rejected: `{"unknown":"v"}` became
     *                 `{}` and passed version 1 as a clean creation
     *   omitted       defaulted to `{}` — but the writer always emits
     *                 this column, so an absent one is not a record
     *                 the write path can produce
     *
     * Stripping is not degeneracy; it is the reader accepting
     * corruption and hiding it. Strict also makes the whole-map check
     * below actually whole, rather than true-of-known-keys.
     */
    previous: z.object(EDITABLE_PROCESS_DOCUMENT_SHAPE).partial().strict(),
  })
  .superRefine((edit, ctx) => {
    // RECORD-LEVEL INVARIANT, not a shape check.
    //
    // Shape alone cannot express this: `previous` is partial, so `{}`
    // is structurally valid for every version — and `{}` renders as
    // "created — no prior text", which is the same lie a corrupt row
    // told before. Syntactic JSON validation does not catch it either,
    // because `{}` is valid JSON.
    //
    // The relationship that has to hold: version 1 IS the creation and
    // has no prior text; any later edit that claims to have changed a
    // field must have retained that field's prior value. Criterion 3's
    // "retained, not reconstructed" is exactly this, and without it
    // the claim is unenforced.
    const previousKeys = Object.keys(edit.previous);

    if (edit.version === 1) {
      // The whole map, not just `text`. Checking one field would be
      // complete today and silently partial the moment a second field
      // exists — the reader would accept a creation carrying prior
      // values the writer never emits.
      if (previousKeys.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['previous'],
          message:
            'version 1 is the creation and cannot have prior values — a record claiming ' +
            `otherwise is not the history of this document (has: ${previousKeys.join(', ')})`,
        });
      }
      return;
    }

    // Both directions. `write()` retains a prior value for EXACTLY the
    // fields it changed, so the two sets are equal, and each direction
    // is a different lie:
    //
    //   field with no prior value    "nothing before" for something that moved
    //   prior value with no field    a change the record does not admit to
    for (const field of edit.fields) {
      if (edit.previous[field] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['previous', field],
          message:
            `edit v${edit.version} says it changed '${field}' but retained no prior ` +
            `value for it — reporting that as "nothing before" would be false`,
        });
      }
    }
    for (const key of previousKeys) {
      if (!edit.fields.includes(key as (typeof edit.fields)[number])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['previous', key],
          message:
            `edit v${edit.version} retained a prior '${key}' but does not list it as ` +
            'changed — a record holding evidence of a change it does not admit to',
        });
      }
    }
  });

/**
 * Create-or-edit. One request shape and one endpoint for both, so the
 * invariant validator is exercised through the real path rather than
 * only by a unit test calling it directly.
 */
export const EditProcessDocumentRequestSchema = z
  .object(EDITABLE_PROCESS_DOCUMENT_SHAPE)
  .partial()
  .extend({
    reason: z.string().min(1).max(2048),
    disposition: AmendmentDispositionSchema,
  });

export const GetProcessDocumentResponseSchema = z.object({
  /** `null` when no document has been set — an explicit state, not an absent field. */
  document: ProcessDocumentSchema.nullable(),
});

export const ProcessDocumentHistoryResponseSchema = z.object({
  edits: z.array(ProcessDocumentEditSchema),
});

// ────────────────────────── Variables ─────────────────────────────
//
// Same grammar as secrets: a variable and a secret share one
// environment namespace, so they must share one name validator. A
// looser rule here would let a variable claim a name a secret is
// forbidden from taking.

export const VariableSummarySchema = SecretSummarySchema.extend({
  /** Readable — this is the field secrets deliberately do not have. */
  value: z.string().optional(),
});

export const ListVariablesResponseSchema = z.object({
  variables: z.array(VariableSummarySchema),
});

export const GetVariableResponseSchema = z.object({
  variable: VariableSummarySchema,
  boundMembers: z.array(NameSchema).optional(),
});

export const CreateVariableRequestSchema = z.object({
  slug: SecretSlugSchema,
  envName: SecretEnvNameSchema,
  description: z.string().max(1024).optional(),
  allMembers: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export const UpdateVariableRequestSchema = z.object({
  envName: SecretEnvNameSchema.optional(),
  description: z.string().max(1024).optional(),
  allMembers: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

/** Readable at rest, unlike `SetSecretValueRequestSchema`. */
export const SetVariableValueRequestSchema = z.object({
  value: SecretValueSchema,
});

export const BindVariableRequestSchema = z.object({
  member: NameSchema,
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
  'session_start',
  'session_end',
  'objective_open',
  'objective_close',
  'llm_exchange',
  'tool_action',
  'user_prompt',
]);

export const ActivityEventSchema = z.discriminatedUnion('kind', [
  // session_start / session_end — run brackets emitted by every runner
  // (one pair per `csuite <runner>` invocation). `session_end` doubles
  // as the machine-readable run summary; its shape is identical across
  // agent frameworks so cross-agent analysis never parses per-runner
  // log formats.
  z.object({
    kind: z.literal('session_start'),
    ts: z.number().int().nonnegative(),
    runner: z.string().min(1),
    runnerVersion: z.string().optional(),
    captureTier: z.number().int().min(0).max(3).optional(),
  }),
  z.object({
    kind: z.literal('session_end'),
    ts: z.number().int().nonnegative(),
    runner: z.string().min(1),
    reason: z.string().min(1),
    exitCode: z.number().int().optional(),
    durationMs: z.number().int().nonnegative(),
    agentSessionId: z.string().optional(),
    capture: z
      .object({
        enqueued: z.number().int().nonnegative(),
        uploaded: z.number().int().nonnegative(),
        dropped: z.number().int().nonnegative(),
        peakQueuedEvents: z.number().int().nonnegative().optional(),
        peakQueuedBytes: z.number().int().nonnegative().optional(),
      })
      .optional(),
  }),
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
  cursor: z
    .object({
      ts: z.number().int().nonnegative(),
      id: z.number().int().nonnegative(),
    })
    .optional(),
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
  instructions: z.string().default(''),
  permissions: PermissionRefListSchema,
});

export const UpdateMemberRequestSchema = z
  .object({
    role: RoleSchema.optional(),
    instructions: z.string().optional(),
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
    instructions: z.string().default(''),
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

// ─────────────────────── Instructions + session ───────────────

/** The wire-stable block kinds — see `InstructionBlockKind` in types. */
export const InstructionBlockKindSchema = z.enum([
  'team_context',
  'role_description',
  'personal_instructions',
  'process_document',
]);

export const InstructionBlockDescriptorSchema = z.object({
  kind: InstructionBlockKindSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const InstructionsResponseSchema = MemberSchema.extend({
  team: TeamSchema,
  teammates: z.array(TeammateSchema),
  openObjectives: z.array(ObjectiveSchema),
  // Defaulted so pre-tool-sources brokers (and test fixtures) that
  // omit the field still parse.
  toolSources: z.array(ResolvedToolSourceSchema).default([]),
  /**
   * The team's process document, or `null` when none is set.
   *
   * Its OWN field, and the reason is authority separation: a member
   * authors their own `instructions`, while the process document is
   * authored by whoever holds `process.manage`. One string would
   * collapse two authorities into one field.
   *
   * THREE states, and `.default(null)` would destroy the one that
   * matters. An older broker OMITS this field; a broker that has it
   * and holds no document sends `null`. Defaulting absent to `null`
   * makes a new runner tell its member "this team has no process
   * document" when the truth is "this broker has no opinion" — the
   * exact collapse the explicit empty state exists to prevent, done
   * before the renderer ever sees it.
   *
   *   absent     -> unavailable from this broker
   *   null       -> no document has been set
   *   document   -> render it
   */
  processDocument: ProcessDocumentSchema.nullable().optional(),
  // Optional: absent from brokers that predate the instruction-block
  // model. Same reasoning as processDocument's absent state — a
  // missing field is an older broker, not an empty answer.
  blocks: z.array(InstructionBlockDescriptorSchema).optional(),
  composedSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export const RosterResponseSchema = z.object({
  teammates: z.array(TeammateSchema),
  connected: z.array(PresenceSchema),
  // Optional so clients remain compatible with brokers that predate
  // server-reported activity-window semantics.
  activityWindowMs: z.number().int().positive().optional(),
  // Optional so clients remain compatible with brokers that predate
  // instruction versioning. Unknown-issued members are never listed —
  // unknown is not pending.
  restartPending: z.array(NameSchema).optional(),
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

/**
 * Owner of a filesystem entry.
 *
 * Two legitimate kinds, and the second is why this is not `NameSchema`:
 *
 *   - a member name — `Cora`, the owner of `/Cora/...`
 *   - an objective namespace — `obj:<objective-id>`, the owner of
 *     `/objectives/<id>/...`, where the ACL gate is membership of the
 *     objective rather than any one member
 *
 * The server has always produced both (`OBJECTIVE_OWNER_PREFIX` in
 * `files/paths.ts`), while this field accepted only the first. Because
 * `NameSchema`'s pattern excludes `:`, every objective-namespace entry
 * failed the schema that ships alongside the code producing it — the
 * write committed and the caller was told it failed, since validation
 * happens on the response.
 *
 * Widened rather than changing the producer: `obj:<id>` is part of the
 * shipped authorization model, not a malformed name. That is the
 * opposite call from `Broker.push`, where nothing legitimate produced
 * the rejected value and the producer moved instead.
 */
export const FsOwnerSchema = z.union([
  NameSchema,
  z
    .string()
    .max(133)
    .regex(/^obj:[a-zA-Z0-9._-]+$/, 'objective owner must be obj:<objective-id>'),
]);

export const FsEntrySchema = z.object({
  path: FsPathSchema,
  name: z.string().min(1).max(255),
  kind: FsEntryKindSchema,
  owner: FsOwnerSchema,
  size: z.number().int().nonnegative().nullable(),
  mimeType: z.string().max(255).nullable(),
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'hash must be sha256 hex')
    .nullable(),
  createdAt: z.number().int().nonnegative(),
  createdBy: NameSchema,
  /**
   * Whether the requesting viewer may mutate this entry — the server's
   * own `canWrite()` predicate, evaluated per request.
   *
   * Present so a client does not have to RECONSTRUCT the rule. A UI that
   * infers "can I delete this" from `owner === me` is wrong for objective
   * namespace entries, whose owner is `obj:<id>` and whose write rule
   * includes objective membership — information the client does not have
   * and cannot derive. Optional so older servers that omit it still
   * parse; a client seeing `undefined` should ask rather than guess.
   */
  canWrite: z.boolean().optional(),
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

// ───────────────────────────── Spine ──────────────────────────────
//
// The annex's write path is where every guarantee in the spine lives,
// and these schemas are the enforcement. A required field is a law of
// physics for an agent: the cheapest way to do the important thing has
// to be the way that records it, and that is a property of the shape,
// not of anybody's diligence.

/**
 * A single large SANITY BOUND on durable prose — NOT a budget.
 *
 * Caps scale WITH durability here, which is the opposite of the usual
 * instinct. The fields this bounds (criteria, result, reasoning,
 * disclosure, evidence, a correction) are the permanent ones, and a
 * cap that punishes precision on a permanent field is a cap that
 * degrades the record forever to save bytes once. 1 MiB exists to stop
 * abuse, and nothing about it should be read as guidance on length.
 */
export const SPINE_DURABLE_SANITY_BOUND = 1_048_576;

/**
 * The largest real CAP in the system, and it belongs to the cheapest
 * event. Conversation must never be expensive; if it is, the record
 * gets routed around and the annex measures nothing.
 */
export const SPINE_DISCUSSION_MAX = 65_536;

/** Identifiers: event ids, subject ids, criterion ids, op ids. */
const SpineIdSchema = z.string().min(1).max(256);

/** Durable prose. Sanity-bounded, never budgeted. */
const SpineProseSchema = z.string().min(1).max(SPINE_DURABLE_SANITY_BOUND);

export const SpineEventKindSchema = z.enum(SPINE_EVENT_KINDS);
export const SpineEventClassSchema = z.enum(['authoritative', 'ambient']);
export const SpineProvenanceSchema = z.enum(['native', 'legacy_projection']);
export const SpineSubjectTypeSchema = z.enum([
  'repo',
  'pr',
  'file',
  'issue',
  'setting',
  'package',
  'doc',
]);
export const SpineRevisionHowSchema = z.enum(['observed', 'asserted']);
export const SpineVerdictDecisionSchema = z.enum(['met', 'unmet', 'cannot_verify']);
export const SpineContractStateSchema = z.enum([
  'active',
  'waiting_on',
  'waiting_for',
  'parked',
  'done',
  'cancelled',
  'superseded',
]);
export const SpineAskActionSchema = z.enum(['withdraw', 'decline', 'redirect', 'defer']);
export const SpineAskStateSchema = z.enum([
  'open',
  'ruled',
  'withdrawn',
  'declined',
  'deferred',
  // The armed-setting class (§9): the probe was the confirmation, and
  // nobody typed anything.
  'discharged',
]);

/** ISO-8601. Instants are strings on the wire so a reader never has to guess a zone. */
const SpineInstantSchema = z.iso.datetime();

export const SpineSubjectSchema = z.object({
  id: SpineIdSchema,
  type: SpineSubjectTypeSchema,
  parent: SpineIdSchema.nullable(),
  registeredBy: NameSchema,
  at: SpineInstantSchema,
});

export const SpineRevisionSchema = z.object({
  id: SpineIdSchema,
  subject: SpineIdSchema,
  value: z.string().min(1).max(4096),
  how: SpineRevisionHowSchema,
  source: z.string().min(1).max(512),
  at: SpineInstantSchema,
});

/**
 * There is NO id-only form, and that is the whole point.
 *
 * `{value}` alone is a derived value rendering bare — *"verified at
 * abc123"* with nothing saying who looked or when. All four caption
 * fields are required so the dishonest shape is unrepresentable rather
 * than merely discouraged.
 */
export const SpineRevisionInputSchema = z.object({
  subject: SpineIdSchema,
  value: z.string().min(1).max(4096),
  how: SpineRevisionHowSchema,
  source: z.string().min(1).max(512),
  at: SpineInstantSchema.optional(),
});

export const SpineCriterionSchema = z.object({
  id: SpineIdSchema,
  /** Durable and uncapped in practice. D4: no cap that punishes precision. */
  text: SpineProseSchema,
});

const SpineCriteriaSchema = z
  .array(SpineCriterionSchema)
  .min(1, 'a contract with no criteria cannot be verified and cannot be completed')
  .max(256)
  .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, {
    message: 'criterion ids must be unique within a contract — a verdict names exactly one',
  });

// ─── Per-kind bodies ─────────────────────────────────────────────────

export const SpineObservationBodySchema = z.object({
  what: SpineProseSchema,
  output: SpineProseSchema,
});

export const SpineTestimonyBodySchema = z.object({
  what: SpineProseSchema,
  account: SpineProseSchema,
  observer: NameSchema,
});

export const SpineSpecificationBodySchema = z.object({
  title: SpineProseSchema,
  criteria: SpineCriteriaSchema,
  assignee: NameSchema,
  verifier: NameSchema.optional(),
  authority: NameSchema.optional(),
  constraints: z.array(SpineProseSchema).max(64).optional(),
});

export const SpineAmendmentBodySchema = z
  .object({
    contract: SpineIdSchema,
    changes: SpineProseSchema,
    reason: SpineProseSchema,
    disposition: AmendmentDispositionSchema,
    title: SpineProseSchema.optional(),
    criteria: SpineCriteriaSchema.optional(),
    constraints: z.array(SpineProseSchema).max(64).optional(),
    disclosure: SpineProseSchema.optional(),
  })
  .refine((b) => b.title !== undefined || b.criteria !== undefined || b.constraints !== undefined, {
    message:
      'an amendment that changes no field of the contract is a discussion post wearing an ' +
      'amendment costume — supply title, criteria, or constraints',
  });

export const SpineAttemptBodySchema = z.object({
  contract: SpineIdSchema,
  summary: SpineProseSchema,
});

export const SpineCriterionVerdictBodySchema = z
  .object({
    contract: SpineIdSchema,
    criterion: SpineIdSchema,
    decision: SpineVerdictDecisionSchema,
    evidence: SpineProseSchema,
    why: SpineProseSchema.optional(),
  })
  .refine((b) => b.decision !== 'cannot_verify' || b.why !== undefined, {
    path: ['why'],
    message:
      "a 'cannot_verify' without a reason is indistinguishable from silence, and silence is " +
      'what the three legal resolution moves need to act on',
  });

export const SpineRulingBodySchema = z.object({
  ask: SpineIdSchema,
  decision: SpineProseSchema,
  reasoning: SpineProseSchema,
  contract: SpineIdSchema.optional(),
});

export const SpineAskBodySchema = z.object({
  authority: NameSchema,
  question: SpineProseSchema,
  context: SpineProseSchema,
  unblocks: SpineProseSchema,
  contract: SpineIdSchema.optional(),
  trigger: SpineProseSchema.optional(),
  check: SpineProseSchema.optional(),
});

export const SpineAskActionBodySchema = z
  .object({
    ask: SpineIdSchema,
    action: SpineAskActionSchema,
    reason: SpineProseSchema,
    redirectTo: NameSchema.optional(),
    trigger: SpineProseSchema.optional(),
  })
  .refine((b) => b.action !== 'redirect' || b.redirectTo !== undefined, {
    path: ['redirectTo'],
    message: 'a redirect that names nobody has not redirected the ask, it has dropped it',
  });

export const SpineProceedingBodySchema = z.object({
  ask: SpineIdSchema,
  reason: SpineProseSchema,
});

/**
 * The lifecycle body carries the fields ITS OWN STATE needs and
 * refuses the ones it does not.
 *
 * Both directions are checked. A `waiting_for` with no check is a
 * contract that goes silent with nothing to re-light it — the exact
 * shape that made the predecessor's blocked state a place work went to
 * die. A `done` carrying a `successor` is a record contradicting
 * itself; accepting it would let a reader draw either conclusion.
 */
export const SpineLifecycleBodySchema = z
  .object({
    contract: SpineIdSchema,
    state: SpineContractStateSchema,
    reason: SpineProseSchema.optional(),
    member: NameSchema.optional(),
    event: SpineProseSchema.optional(),
    check: SpineProseSchema.optional(),
    preemptedBy: SpineProseSchema.optional(),
    result: SpineProseSchema.optional(),
    successor: SpineIdSchema.optional(),
  })
  .superRefine((b, ctx) => {
    const required: Partial<Record<string, readonly string[]>> = {
      waiting_on: ['member'],
      waiting_for: ['event', 'check'],
      parked: ['preemptedBy'],
      done: ['result'],
      cancelled: ['reason'],
      superseded: ['successor'],
    };
    const allowed: Record<string, readonly string[]> = {
      active: ['reason'],
      waiting_on: ['member', 'reason'],
      waiting_for: ['event', 'check', 'reason'],
      parked: ['preemptedBy', 'reason'],
      done: ['result', 'reason'],
      cancelled: ['reason'],
      superseded: ['successor', 'reason'],
    };
    for (const field of required[b.state] ?? []) {
      if ((b as Record<string, unknown>)[field] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `state '${b.state}' requires '${field}'`,
        });
      }
    }
    for (const field of ['member', 'event', 'check', 'preemptedBy', 'result', 'successor']) {
      if ((b as Record<string, unknown>)[field] === undefined) continue;
      if ((allowed[b.state] ?? []).includes(field)) continue;
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `state '${b.state}' does not carry '${field}' — the record would contradict itself`,
      });
    }
  });

export const SpineCorrectionBodySchema = z.object({
  correction: SpineProseSchema,
});

export const SpineDiscussionBodySchema = z.object({
  /** The one cap that is a real cap, and it is the largest. */
  body: z.string().min(1).max(SPINE_DISCUSSION_MAX),
  contract: SpineIdSchema.optional(),
});

export const SpinePromotionBodySchema = z.object({
  as: SpineEventKindSchema,
  note: SpineProseSchema.optional(),
});

/**
 * ONE map from kind to body schema, keyed by the closed kind list.
 *
 * Both the append request and the event response are built from it, so
 * an endpoint cannot accept a body shape the wire format cannot
 * describe — the divergence class the process-document field list was
 * built to remove, one layer up.
 */
export const SPINE_BODY_SCHEMAS = {
  observation: SpineObservationBodySchema,
  testimony: SpineTestimonyBodySchema,
  specification: SpineSpecificationBodySchema,
  amendment: SpineAmendmentBodySchema,
  attempt: SpineAttemptBodySchema,
  criterion_verdict: SpineCriterionVerdictBodySchema,
  ruling: SpineRulingBodySchema,
  ask: SpineAskBodySchema,
  ask_action: SpineAskActionBodySchema,
  proceeding: SpineProceedingBodySchema,
  lifecycle: SpineLifecycleBodySchema,
  correction: SpineCorrectionBodySchema,
  discussion: SpineDiscussionBodySchema,
  promotion: SpinePromotionBodySchema,
} as const satisfies Record<SpineEventKind, z.ZodType>;

// ─── The event as it comes back ──────────────────────────────────────

const SPINE_EVENT_SHAPE = {
  seq: z.number().int().positive(),
  id: SpineIdSchema,
  class: SpineEventClassSchema,
  subject: SpineIdSchema.nullable(),
  /** WHOLE. An event is what a stale refusal hands back, and that is no place for an id. */
  revision: SpineRevisionSchema.nullable(),
  actor: z.string().min(1).max(256),
  authoredBy: NameSchema.nullable(),
  at: SpineInstantSchema,
  provenance: SpineProvenanceSchema,
  opId: SpineIdSchema.nullable(),
  cites: z.array(SpineIdSchema),
  staplesTo: SpineIdSchema.nullable(),
  contract: SpineIdSchema.nullable(),
  stateRev: z.number().int().nonnegative().nullable(),
};

const spineEventVariants = SPINE_EVENT_KINDS.map((kind) =>
  z.object({ ...SPINE_EVENT_SHAPE, kind: z.literal(kind), body: SPINE_BODY_SCHEMAS[kind] }),
);

export const SpineEventSchema = z.discriminatedUnion(
  'kind',
  spineEventVariants as [(typeof spineEventVariants)[number], ...typeof spineEventVariants],
);

// ─── Requests ────────────────────────────────────────────────────────

/**
 * Which kinds must carry which envelope fields.
 *
 * Tables rather than fourteen hand-written variants, because the
 * fourteenth is where the omission lands. Each list is the answer to
 * one question and the variants below are derived from all of them.
 */
const SPINE_KINDS_REQUIRING_SUBJECT: readonly SpineEventKind[] = [
  'observation',
  'testimony',
  'specification',
  'proceeding',
];
/** A verdict with no revision is an opinion about nothing in particular. */
const SPINE_KINDS_REQUIRING_REVISION: readonly SpineEventKind[] = ['criterion_verdict'];
/** A correction that staples to nothing is a second claim, not a correction. */
const SPINE_KINDS_REQUIRING_STAPLE: readonly SpineEventKind[] = ['correction'];
/** A promotion names exactly one origin post. */
const SPINE_KINDS_REQUIRING_ONE_CITE: readonly SpineEventKind[] = ['promotion'];
/**
 * Authoritative AND unconditionally contract-bound. `ask`, `ruling`
 * and `correction` reach a contract only sometimes, so their
 * precondition is enforced where the contract is known — in the store.
 */
const SPINE_KINDS_REQUIRING_STATE_REV: readonly SpineEventKind[] = [
  'amendment',
  'attempt',
  'criterion_verdict',
  'lifecycle',
];

const spineAppendVariants = SPINE_EVENT_KINDS.map((kind) => {
  const authoritative = SPINE_EVENT_CLASSES[kind] === 'authoritative';
  const base = {
    kind: z.literal(kind),
    body: SPINE_BODY_SCHEMAS[kind],
    subject: SPINE_KINDS_REQUIRING_SUBJECT.includes(kind)
      ? SpineIdSchema
      : SpineIdSchema.optional(),
    revision: SPINE_KINDS_REQUIRING_REVISION.includes(kind)
      ? SpineRevisionInputSchema
      : SpineRevisionInputSchema.optional(),
    cites: SPINE_KINDS_REQUIRING_ONE_CITE.includes(kind)
      ? z.array(SpineIdSchema).length(1)
      : z.array(SpineIdSchema).max(256).optional(),
    staplesTo: SPINE_KINDS_REQUIRING_STAPLE.includes(kind)
      ? SpineIdSchema
      : SpineIdSchema.optional(),
    // Idempotency is not optional on a durable write. A lost response
    // is a miniature album dump and the retry has to be free.
    opId: authoritative ? SpineIdSchema : z.undefined().optional(),
    expectedStateRev: SPINE_KINDS_REQUIRING_STATE_REV.includes(kind)
      ? z.number().int().nonnegative()
      : z.number().int().nonnegative().optional(),
    authoredBy: NameSchema.optional(),
  };
  return z.object(base);
});

export const AppendSpineEventRequestSchema = z
  .discriminatedUnion(
    'kind',
    spineAppendVariants as [(typeof spineAppendVariants)[number], ...typeof spineAppendVariants],
  )
  .superRefine((input, ctx) => {
    // A specification CREATES the contract, so there is no prior
    // `state_rev` to have believed. Accepting one would let a caller
    // assert a precondition about a thing that does not exist.
    if (input.kind === 'specification' && input.expectedStateRev !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['expectedStateRev'],
        message:
          'a specification creates the contract — there is no prior state_rev to expect, and ' +
          'the contract id is the specification event id',
      });
    }
    // Conditionally contract-bound kinds: the moment the body names a
    // contract, the write is state-changing and carries a precondition.
    //
    // The variants are built from the kind list rather than written
    // out fourteen times, so `kind` does not narrow `body` here. The
    // read below is one optional field the map above already validated.
    if (input.kind === 'ask' || input.kind === 'ruling') {
      const named = (input.body as { contract?: string }).contract !== undefined;
      if (named && input.expectedStateRev === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['expectedStateRev'],
          message: `a ${input.kind} naming a contract is a state-changing write on it and requires expectedStateRev`,
        });
      }
      if (!named && input.expectedStateRev !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['expectedStateRev'],
          message: `this ${input.kind} names no contract, so there is no state_rev it could be expecting`,
        });
      }
    }
  });

export const RegisterSpineSubjectRequestSchema = z.object({
  id: SpineIdSchema,
  type: SpineSubjectTypeSchema,
  parent: SpineIdSchema.optional(),
});

/** Query params arrive as strings; coerce so the route reads one shape. */
const spineQueryInt = (max: number) => z.coerce.number().int().nonnegative().max(max).optional();

export const ListSpineEventsQuerySchema = z.object({
  since_seq: spineQueryInt(Number.MAX_SAFE_INTEGER),
  /**
   * POSITIVE, not merely non-negative.
   *
   * `limit=0` returns an empty page with a null cursor, and the
   * published contract says a null cursor means the page REACHED THE
   * HEAD. So a zero page does not return nothing — it returns "you are
   * fully caught up" to a caller who has seen nothing, which is the
   * one answer recovery must never give wrongly.
   */
  limit: z.coerce.number().int().positive().max(500).optional(),
  kind: SpineEventKindSchema.optional(),
  subject: SpineIdSchema.optional(),
  contract: SpineIdSchema.optional(),
  actor: z.string().min(1).max(256).optional(),
});

export const ListSpineSubjectsQuerySchema = z.object({
  type: SpineSubjectTypeSchema.optional(),
  parent: SpineIdSchema.optional(),
  within: SpineIdSchema.optional(),
});

export const ListSpineContractsQuerySchema = z.object({
  state: SpineContractStateSchema.optional(),
  member: NameSchema.optional(),
  subject: SpineIdSchema.optional(),
});

// ─── Responses ───────────────────────────────────────────────────────

export const SpineCriterionStatusSchema = z.object({
  criterion: SpineIdSchema,
  text: SpineProseSchema,
  decision: SpineVerdictDecisionSchema.nullable(),
  /** WHOLE. A bare id is a derived value rendering bare, and no route resolves one. */
  revision: SpineRevisionSchema.nullable(),
  event: SpineIdSchema.nullable(),
  waivedBy: SpineIdSchema.nullable(),
  /** Whether the verdict's revision is the one the contract is bound to. */
  atBoundRevision: z.boolean(),
});

export const SpineContractSchema = z.object({
  id: SpineIdSchema,
  title: SpineProseSchema,
  state: SpineContractStateSchema,
  stateRev: z.number().int().positive(),
  version: z.number().int().positive(),
  subject: SpineIdSchema,
  /** Both operands of `stale` are hydrated, or the flag is unactionable. */
  revision: SpineRevisionSchema.nullable(),
  criteria: z.array(SpineCriterionSchema),
  assignee: NameSchema,
  verifier: NameSchema.nullable(),
  authority: NameSchema.nullable(),
  constraints: z.array(SpineProseSchema),
  createdBy: NameSchema,
  createdAt: SpineInstantSchema,
  updatedAt: SpineInstantSchema,
  waitingOn: NameSchema.nullable(),
  waitingFor: z.object({ event: SpineProseSchema, check: SpineProseSchema }).nullable(),
  preemptedBy: SpineProseSchema.nullable(),
  result: SpineProseSchema.nullable(),
  reason: SpineProseSchema.nullable(),
  successor: SpineIdSchema.nullable(),
  stale: z.boolean(),
  head: SpineRevisionSchema.nullable(),
});

export const SpineAskSchema = z.object({
  id: SpineIdSchema,
  authority: NameSchema,
  asker: NameSchema,
  subject: SpineIdSchema.nullable(),
  contract: SpineIdSchema.nullable(),
  question: SpineProseSchema,
  context: SpineProseSchema,
  unblocks: SpineProseSchema,
  state: SpineAskStateSchema,
  resolvedBy: SpineIdSchema.nullable(),
  at: SpineInstantSchema,
});

export const AppendSpineEventResponseSchema = z.object({
  event: SpineEventSchema,
  contract: SpineContractSchema.nullable(),
  replayed: z.boolean(),
});

export const ListSpineEventsResponseSchema = z.object({
  events: z.array(SpineEventSchema),
  /** `null` means the page reached the head — not the same as an empty page. */
  nextCursor: z.number().int().positive().nullable(),
  headSeq: z.number().int().nonnegative(),
});

export const GetSpineEventResponseSchema = z.object({
  event: SpineEventSchema,
});

export const RegisterSpineSubjectResponseSchema = z.object({
  subject: SpineSubjectSchema,
});

export const ListSpineSubjectsResponseSchema = z.object({
  subjects: z.array(SpineSubjectSchema),
});

export const ListSpineContractsResponseSchema = z.object({
  contracts: z.array(SpineContractSchema),
});

export const GetSpineContractResponseSchema = z.object({
  contract: SpineContractSchema,
});

export const SpineBindingSchema = z.enum(['assignee', 'verifier', 'authority']);

export const OrientContractSchema = z.object({
  bindings: z.array(SpineBindingSchema).min(1),
  contract: SpineIdSchema,
  title: SpineProseSchema,
  state: SpineContractStateSchema,
  stateRev: z.number().int().positive(),
  criteria: z.array(SpineCriterionStatusSchema),
  subject: SpineSubjectSchema,
  revision: SpineRevisionSchema.nullable(),
  stale: z.boolean(),
  head: SpineRevisionSchema.nullable(),
  rulings: z.array(SpineEventSchema),
});

export const OrientPackSchema = z.object({
  member: NameSchema,
  at: SpineInstantSchema,
  cursor: z.number().int().nonnegative(),
  contracts: z.array(OrientContractSchema),
  asksForMe: z.array(SpineAskSchema),
  myOpenAsks: z.array(SpineAskSchema),
});

/**
 * The human seat's Queue — asks awaiting my ruling (with the contract
 * each is about, whole, so the acts carry their precondition) and the
 * contracts stuck on me. A read that advances nothing: visiting is not
 * handling.
 */
export const SpineQueueAskItemSchema = z.object({
  ask: SpineAskSchema,
  contract: SpineContractSchema.nullable(),
});

export const SpineQueueSchema = z.object({
  member: NameSchema,
  at: SpineInstantSchema,
  asks: z.array(SpineQueueAskItemSchema),
  waitingOn: z.array(SpineContractSchema),
});

export const GetSpineQueueResponseSchema = z.object({
  queue: SpineQueueSchema,
});

export const GetSpineQueueQuerySchema = z.object({
  member: NameSchema.optional(),
});

/**
 * The delta a stale write gets back.
 *
 * The refusal IS the re-injection: it is delivered through the tool
 * result at exactly the moment staleness would have caused harm, on
 * any runner, forever. So it carries the intervening events in full
 * rather than a count or a hint — a caller who has to make a second
 * call to find out what it raced has been told there is a problem and
 * not what it is.
 */
export const SpineStaleStateRevDetailSchema = z.object({
  contract: SpineIdSchema,
  expectedStateRev: z.number().int().nonnegative(),
  currentStateRev: z.number().int().nonnegative(),
  intervening: z.array(SpineEventSchema),
});

/** What completion is missing, named criterion by criterion. */
export const SpineCoverageGapDetailSchema = z.object({
  contract: SpineIdSchema,
  /** The caption the completion supplied — there is no id yet at the moment of refusal. */
  revision: SpineRevisionInputSchema.nullable(),
  missing: z.array(
    z.object({ criterion: SpineIdSchema, text: SpineProseSchema, why: SpineProseSchema }),
  ),
});

/**
 * A precondition that is absent or ahead of the contract. Neither has
 * a delta, so neither may borrow the stale refusal's shape and claim
 * one.
 */
export const SpinePreconditionDetailSchema = z.object({
  contract: SpineIdSchema,
  path: z.array(z.string()),
  currentStateRev: z.number().int().nonnegative(),
  problem: z.enum(['missing', 'ahead']),
  suppliedStateRev: z.number().int().nonnegative().nullable(),
});

/** A write to a contract that has ended. `suppliedStateRev` is null when none was sent. */
export const SpineTerminalDetailSchema = z.object({
  contract: SpineIdSchema,
  state: SpineContractStateSchema,
  currentStateRev: z.number().int().nonnegative(),
  suppliedStateRev: z.number().int().nonnegative().nullable(),
  intervening: z.array(SpineEventSchema),
});

export const SpineIdempotencyConflictDetailSchema = z.object({
  opId: SpineIdSchema,
  originalEvent: SpineIdSchema,
});

/**
 * The citation lock's refusal. The asks are whole: an id would ask the
 * member to remember what they asked, which is the failure mode the
 * lock exists to close.
 */
export const SpineCitationRequiredDetailSchema = z.object({
  subject: SpineIdSchema,
  kind: SpineEventKindSchema,
  contract: SpineIdSchema.nullable(),
  scope: z.array(SpineIdSchema),
  asks: z.array(SpineAskSchema),
});

// ─── The curator ─────────────────────────────────────────────────────

export const SpineFloorSignalSchema = z.enum(SPINE_FLOOR_SIGNALS);

export const SpineDumpSourceSchema = z.enum(SPINE_DUMP_SOURCES);

export const SpineRunnerCapabilitiesSchema = z.object({
  dumpSignal: z.boolean(),
  tokenUsage: z.boolean(),
});

export const ReportSpineSignalRequestSchema = z.object({
  signal: SpineFloorSignalSchema,
  source: SpineDumpSourceSchema.optional(),
  capabilities: SpineRunnerCapabilitiesSchema.optional(),
});

export const ReportSpineSignalResponseSchema = z.object({
  accepted: z.literal(true),
  leasesInvalidated: z.number().int().nonnegative(),
});

export const SpineInjectionKindSchema = z.enum(SPINE_INJECTION_KINDS);

export const SpineInjectionSchema = z.object({
  id: z.number().int().positive(),
  member: NameSchema,
  // Literal union rather than `min(0).max(2)`: class 3 is SILENCE, so a
  // row claiming it is a contradiction in terms and must not parse.
  class: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  kind: SpineInjectionKindSchema,
  refs: z.array(SpineIdSchema),
  cursor: z.number().int().nonnegative(),
  at: SpineInstantSchema,
  bytes: z.number().int().nonnegative(),
  delivered: z.boolean(),
});

export const ListSpineInjectionsResponseSchema = z.object({
  injections: z.array(SpineInjectionSchema),
});

export const SpineSubscriptionLevelSchema = z.enum(SPINE_SUBSCRIPTION_LEVELS);

export const SpineSubscriptionSchema = z.object({
  member: NameSchema,
  contract: SpineIdSchema,
  level: SpineSubscriptionLevelSchema,
  explicit: z.boolean(),
  updatedBy: NameSchema.nullable(),
  updatedAt: SpineInstantSchema.nullable(),
});

export const SpineCuratorPolicySchema = z.object({
  member: NameSchema,
  leaseTtlMs: z.number().int().positive(),
  nudgeMinIntervalMs: z.number().int().nonnegative(),
  explicit: z.boolean(),
  updatedBy: NameSchema.nullable(),
  updatedAt: SpineInstantSchema.nullable(),
});

export const SpineCuratorConfigResponseSchema = z.object({
  member: NameSchema,
  subscriptions: z.array(SpineSubscriptionSchema),
  policy: SpineCuratorPolicySchema,
  capabilities: SpineRunnerCapabilitiesSchema.nullable(),
});

/**
 * A curator-config write, with the empty write refused.
 *
 * `{}` parses as a perfectly valid object under a shape where both
 * fields are optional, and it would resolve to "read the config and
 * report it changed" — a write that lies about having written. The
 * refinement is what makes the request type mean what its name says.
 */
export const SetSpineCuratorConfigRequestSchema = z
  .object({
    member: NameSchema.optional(),
    subscription: z
      .object({ contract: SpineIdSchema, level: SpineSubscriptionLevelSchema })
      .optional(),
    policy: z
      .object({
        leaseTtlMs: z.number().int().positive().optional(),
        nudgeMinIntervalMs: z.number().int().nonnegative().optional(),
      })
      .refine((p) => p.leaseTtlMs !== undefined || p.nudgeMinIntervalMs !== undefined, {
        message: 'policy must set at least one of leaseTtlMs, nudgeMinIntervalMs',
      })
      .optional(),
  })
  .refine((body) => body.subscription !== undefined || body.policy !== undefined, {
    message: 'supply `subscription`, `policy`, or both — an empty write changes nothing',
  });

export const ListSpineInjectionsQuerySchema = z.object({
  member: NameSchema.optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  // POSITIVE: id 0 exists in no ledger, so `before_id=0` could only
  // mean "everything older than the first row", which is an empty page
  // dressed up as a cursor.
  before_id: z.coerce.number().int().positive().optional(),
});

export const SpineCuratorConfigQuerySchema = z.object({
  member: NameSchema.optional(),
});

// ─── The probe engine ────────────────────────────────────────────────

/**
 * A dot-path into a JSON payload, in the notification inbox's own
 * syntax. Bounded because it is authored inside a permanent event.
 */
const SpineDotPathSchema = z.string().min(1).max(256);

/**
 * The predicate, as the SAME filter rules the webhook inbox evaluates.
 *
 * NOT A NEW LANGUAGE, deliberately. `applyFilters` has been deciding
 * whether an inbound payload matches since External Notifications
 * shipped; a check asks exactly that question of exactly those
 * payloads. A second predicate dialect would double the edge cases
 * around `exists`, empty arrays and coercion, and would make a member
 * guess which one they were writing.
 */
const SpineCheckPredicateSchema = z.array(NotificationFilterRuleSchema).max(32);

/**
 * Whether a poll URL's own text puts it inside a private network.
 *
 * DUPLICATED FROM THE SERVER'S `egress.ts` ON PURPOSE, and the
 * duplication is the smaller cost. The SDK is the wire contract and is
 * published to clients; making it depend on the server package to
 * validate a URL would invert the dependency the whole repo is built
 * on. What is duplicated is a list of IANA-assigned constants, which is
 * the one class of thing that does not drift — and the server checks
 * again at fire time with the authoritative list, against resolved
 * addresses rather than text, so a divergence here can only ever be
 * this half being more permissive than the half that actually holds.
 *
 * Names are deliberately NOT judged: `vault.internal` is a well-formed
 * hostname and only a resolver knows where it points. That check is the
 * server's, at fire time, and it is the load-bearing one.
 */
const SPINE_BLOCKED_V4: readonly [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function spineV4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = ((out << 8) | n) >>> 0;
  }
  return out;
}

function spinePollHostReason(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  // A v4-MAPPED v6 LITERAL IS A V4 ADDRESS WEARING A V6 SPELLING, and
  // it arrives in two forms: the dotted one a member types
  // (`::ffff:169.254.169.254`) and the hex one `new URL()` normalises
  // it to (`::ffff:a9fe:a9fe`). Reading only the first is a documented
  // bypass, because the URL parser rewrites it before anything here
  // sees it.
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(bare);
  const candidate =
    dotted !== null
      ? (dotted[1] as string)
      : hex !== null
        ? [
            Number.parseInt(hex[1] as string, 16) >> 8,
            Number.parseInt(hex[1] as string, 16) & 0xff,
            Number.parseInt(hex[2] as string, 16) >> 8,
            Number.parseInt(hex[2] as string, 16) & 0xff,
          ].join('.')
        : bare;
  const asInt = spineV4ToInt(candidate);
  if (asInt !== null) {
    for (const [prefix, bits] of SPINE_BLOCKED_V4) {
      const base = spineV4ToInt(prefix) as number;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((asInt & mask) >>> 0 === (base & mask) >>> 0) {
        return `${candidate} is inside ${prefix}/${bits}`;
      }
    }
    return null;
  }
  if (!bare.includes(':')) return null;
  const lower = bare.toLowerCase();
  if (lower === '::1' || lower === '::') return `${bare} is loopback or unspecified`;
  const head = Number.parseInt(lower.split(':')[0] ?? '', 16);
  if (Number.isInteger(head)) {
    if ((head & 0xfe00) === 0xfc00) return `${bare} is inside fc00::/7`;
    if ((head & 0xffc0) === 0xfe80) return `${bare} is inside fe80::/10`;
  }
  return null;
}

export const SpineWebhookRecipeSchema = z.object({
  kind: z.literal('webhook'),
  endpoint: z.string().min(1).max(128),
  when: SpineCheckPredicateSchema,
  revisionPath: SpineDotPathSchema.optional(),
});

/**
 * The outbound poll, with its security pins IN THE SCHEMA rather than
 * in the engine that runs it.
 *
 * Each of these is refused at AUTHORING TIME, which is the only moment
 * a member is present to be told. A pin checked at fire time would fail
 * silently, hours later, into a log — and a check that quietly never
 * fires is indistinguishable from a world that never did the thing.
 */
export const SpineHttpPollRecipeSchema = z.object({
  kind: z.literal('http_poll'),
  url: z
    .string()
    .min(1)
    .max(2048)
    .refine((raw) => {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return false;
      }
      // HTTPS ONLY. A poll carries a resolved secret in a header on
      // some deployments, and cleartext is not a tuning knob.
      return parsed.protocol === 'https:';
    }, 'a poll URL must be an absolute https:// URL — the probe will not send a team credential in cleartext')
    .superRefine((raw, ctx) => {
      const reason = spinePollHostReason(raw);
      if (reason === null) return;
      ctx.addIssue({
        code: 'custom',
        message:
          `this poll points inside the deployment's own network: ${reason}. A probe fetches ` +
          'from the SERVER, attaches the author’s secret, and writes the response into a ' +
          'permanent observation every member can read — so a private address here is a way to ' +
          'read the server’s own network and publish it. A name is checked again when the poll ' +
          'actually fires, against every address it resolves to.',
      });
    }),
  intervalMs: z
    .number()
    .int()
    .min(SPINE_POLL_MIN_INTERVAL_MS)
    .max(24 * 60 * 60 * 1000),
  // A SLUG, never a value. The recipe lives in an append-only event;
  // a token written into one could never be rotated or unseen.
  authSecret: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'name the secret by slug; the probe resolves it server-side')
    .optional(),
  authHeader: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9-]+$/)
    .optional(),
  when: SpineCheckPredicateSchema,
  revisionPath: SpineDotPathSchema.optional(),
});

export const SpineCheckRecipeSchema = z.discriminatedUnion('kind', [
  SpineWebhookRecipeSchema,
  SpineHttpPollRecipeSchema,
]);

export const SpineCheckStateSchema = z.enum(['armed', 'fired', 'disarmed']);
export const SpineCheckCarrierSchema = z.enum(['ask', 'waiting_for']);

export const SpineCheckSchema = z.object({
  id: SpineIdSchema,
  sourceEvent: SpineIdSchema,
  carrier: SpineCheckCarrierSchema,
  subject: SpineIdSchema,
  contract: SpineIdSchema.nullable(),
  ask: SpineIdSchema.nullable(),
  recipe: SpineCheckRecipeSchema,
  authoredBy: NameSchema,
  state: SpineCheckStateSchema,
  firedEvent: SpineIdSchema.nullable(),
  firedAt: SpineInstantSchema.nullable(),
  lastEvaluatedAt: SpineInstantSchema.nullable(),
  disarmedReason: z.string().min(1).max(2048).nullable(),
  at: SpineInstantSchema,
});

export const ListSpineChecksQuerySchema = z.object({
  state: SpineCheckStateSchema.optional(),
  contract: SpineIdSchema.optional(),
  ask: SpineIdSchema.optional(),
  subject: SpineIdSchema.optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export const ListSpineChecksResponseSchema = z.object({ checks: z.array(SpineCheckSchema) });
export const GetSpineCheckResponseSchema = z.object({ check: SpineCheckSchema });
