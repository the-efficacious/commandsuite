/**
 * Tool definitions and handlers for the link's MCP server face.
 *
 * Descriptions are STATIC for the lifetime of a session. The only
 * interpolation is boot-stable and functional — the member's fs home
 * path and permission-scoped wording — never live state and never
 * identity/roster prose (who-you-are and the teammate list live in the
 * system-prompt instructions; repeating them per-tool wastes context).
 * Live state reaches the agent by being PULLED — `orient` for the
 * record, `roster` for presence — never baked into a description.
 * `tools/list_changed` is reserved for genuine capability
 * changes (tools appearing or disappearing), never state freshness —
 * mutating descriptions mid-session would invalidate the model's
 * prompt-prefix cache.
 *
 * Chat tools:
 *   - roster         — list teammates
 *   - broadcast      — send to the general team channel
 *   - send           — DM a teammate by name
 *   - channels_list  — list named channels visible to this agent
 *   - channels_post  — post into a specific named channel by slug
 *   - recent         — fetch recent team-chat / DM / channel history
 *
 * Spine tools — the team's annex and the contracts folded out of it:
 *   - orient            — the recovery call; no args, never refuses
 *   - annex_read        — page the record from a cursor
 *   - attempt_post      — bind a revision; the readiness signal
 *   - verdict_post      — judge one criterion at one revision
 *   - state_set         — lifecycle transitions (not completion)
 *   - contract_complete — complete, citing the verdicts that cover it
 *   - ask_author        — request a ruling; binds the asker until answered
 *   - ruling_post       — answer an ask that names you
 *   - proceed           — go ahead without the ruling, on the record
 *   - observe           — record what you saw
 *   - discuss           — the cheap surface; largest cap; never gated
 *   - promote           — turn a post into the typed event it was
 *
 * Permission-gated spine tools:
 *   - contract_author   — requires `spine.author`
 *   - contract_amend    — requires `spine.author`
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Client as BrokerClient, ClientError } from 'csuite-sdk/client';
import { PROCESS_DOCUMENT_MAX, SPINE_DISCUSSION_MAX } from 'csuite-sdk/schemas';
import { formatTextMetrics } from 'csuite-sdk/text-metrics';
import type {
  AppendSpineEventRequest,
  AppendSpineEventResponse,
  Attachment,
  CustomToolBinding,
  FsEntry,
  InstructionsResponse,
  LogLevel,
  Message,
  NotificationAuthKind,
  NotificationDelivery,
  NotificationDeliveryPolicy,
  NotificationEndpointSummary,
  NotificationFilterOp,
  NotificationFilterRule,
  NotificationProfileSummary,
  NotificationTarget,
  OrientPack,
  ResolvedToolSource,
  SecretSummary,
  SpineAsk,
  SpineCitationRequiredDetail,
  SpineCoverageGapDetail,
  SpineEvent,
  SpineEventKind,
  SpineIdempotencyConflictDetail,
  SpineRevisionInput,
  SpineStaleStateRevDetail,
  SpineSubjectType,
  SpineTerminalDetail,
  ToolCredentialKind,
  ToolSourceKind,
  ToolSourceSummary,
  VariableSummary,
} from 'csuite-sdk/types';
import { SPINE_EVENT_CLASSES } from 'csuite-sdk/types';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical'];
const DEFAULT_RECENT_LIMIT = 50;
const MAX_RECENT_LIMIT = 500;

/**
 * Build the tool set. Descriptions are static per session — the only
 * interpolation is boot-stable and functional (fs home path,
 * permission-scoped wording). Identity and the teammate roster live in
 * the system-prompt instructions; live state is PULLED by the agent
 * when it needs it, never baked into tool metadata (see the file
 * header for the doctrine).
 *
 * `externalTools` is the resolved tool-source snapshot — platform-
 * defined tools the broker executes on the agent's behalf. It
 * defaults to the packet's boot-time set; the runner passes its
 * LIVE snapshot instead, which changes only on genuine registry
 * events (each one followed by a `tools/list_changed`).
 */
export function defineTools(
  instructions: InstructionsResponse,
  externalTools: ResolvedToolSource[] = instructions.toolSources,
): Tool[] {
  const { name } = instructions;

  return [
    {
      name: 'roster',
      description:
        `List all teammates currently on the csuite net. Returns each teammate's name, ` +
        `role, authority, connection state, and any recently reported working or blocked ` +
        `activity. The response uses the broker's reporting window when supplied and says ` +
        `when the window is unknown; recent activity is not executor liveness.`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'broadcast',
      description:
        `Broadcast a message to the team's general channel. Every teammate ` +
        `sees it in real time. Use this for team-wide announcements, status updates, and ` +
        `directives. For posts that should only reach a specific ` +
        `named channel's members, use \`channels_post\` instead — \`broadcast\` always goes ` +
        `to general. Optionally attach ` +
        `files from your home; recipients automatically receive read access ` +
        `to each attached path via the resulting message. Returns delivery counts (live ` +
        `subscribers, addressed targets) and the new message id.`,
      inputSchema: {
        type: 'object',
        properties: {
          body: {
            type: 'string',
            description: 'The message body the team will receive. Max 65536 characters.',
          },
          level: {
            type: 'string',
            enum: [...LEVELS],
            description: "Optional severity; defaults to 'info'.",
          },
          attachments: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Optional list of file paths (e.g. ['/<name>/uploads/report.pdf']). Max 64. Each must already exist and be readable to you. Use `fs_write` to upload a new file first.",
          },
        },
        required: ['body'],
      },
    },
    {
      name: 'send',
      description:
        `Send a direct message to a specific teammate. Messages are ` +
        `private to you and the target. Use \`roster\` for available names. ` +
        `Optionally attach files from your home; the recipient ` +
        `receives read access to each attached path. Returns delivery counts and the ` +
        `new message id.`,
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The name of the teammate to message.' },
          body: { type: 'string', description: 'The message body. Max 65536 characters.' },
          level: {
            type: 'string',
            enum: [...LEVELS],
            description: "Optional severity; defaults to 'info'.",
          },
          attachments: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional list of file paths to attach. Max 64. Each must already exist and be readable to you.',
          },
        },
        required: ['to', 'body'],
      },
    },
    {
      name: 'channels_list',
      description:
        `List named channels you have access to. Returns each ` +
        `channel's slug, member count, and whether you're an admin or a regular member. ` +
        `\`general\` is implicit and always included — it's the team-wide channel that ` +
        `\`broadcast\` writes into. To post into any other channel use \`channels_post\`; ` +
        `to read scrollback use \`recent\` with \`channel=<slug>\`. You can only see ` +
        `channels you've been added to (or that are public to the whole team).`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'channels_post',
      description:
        `Post a message into a specific named channel. Only members of ` +
        `that channel receive it; non-members do not. Use this for scoped conversations — ` +
        `e.g., a #frontend channel for frontend work — instead of broadcasting to the whole ` +
        `team. You must already be a member of the channel; ask a director to add you if ` +
        `not. Optionally attach files from your home; channel members ` +
        `receive read access to each attached path. To find available channels run ` +
        `\`channels_list\`. To post to the team-wide general channel use \`broadcast\`. ` +
        `Returns delivery counts and the new message id.`,
      inputSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            description: 'Channel slug (e.g. "frontend", "ops"). Must be a channel you belong to.',
          },
          body: { type: 'string', description: 'The message body. Max 65536 characters.' },
          level: {
            type: 'string',
            enum: [...LEVELS],
            description: "Optional severity; defaults to 'info'.",
          },
          attachments: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional list of file paths to attach. Max 64. Each must already exist and be readable to you.',
          },
        },
        required: ['channel', 'body'],
      },
    },
    {
      name: 'recent',
      description:
        `Fetch recent messages from the team's general channel, a specific ` +
        `DM thread, or a named channel. Pass exactly one of: ` +
        `\`with=NAME\` for DMs with that teammate, \`channel=SLUG\` for a named channel's ` +
        `scrollback, or no scope arg for the general team channel. Returns messages ` +
        `newest-first up to ${DEFAULT_RECENT_LIMIT} by default (max ${MAX_RECENT_LIMIT}).`,
      inputSchema: {
        type: 'object',
        properties: {
          with: {
            type: 'string',
            description:
              'Optional teammate name — narrows to DMs with that teammate. Mutually exclusive with `channel`.',
          },
          channel: {
            type: 'string',
            description:
              'Optional channel slug — narrows to messages tagged for that channel. Mutually exclusive with `with`.',
          },
          limit: {
            type: 'number',
            description: `Max messages to return (default ${DEFAULT_RECENT_LIMIT}, max ${MAX_RECENT_LIMIT}).`,
          },
        },
      },
    },
    // ── Filesystem tools ───────────────────────────────────────────
    //
    // Every slot has a home at `/<name>/` with full read/write access;
    // directors may also read/write anywhere. Reads outside your home
    // require either a grant (the file was attached to a message you
    // can see) or director authority. See `fs_shared` for a list of
    // files shared with you.
    //
    // There used to be a second scope — an objective namespace at
    // `/objectives/<id>/`, owned by a set of members rather than by a
    // person — and it went with the objectives subsystem. Two defects
    // it produced are recorded here because their SHAPE outlives it:
    //
    //   1. non-root `list()` gated on `members.manage || ownsPath` and
    //      never called `canRead()`, so a scope nobody individually
    //      owned refused everyone who could read files inside it.
    //      `stat`, `read` and `listShared` all gated on `canRead`
    //      already; `list` was the one that did not.
    //   2. `FsEntrySchema.owner` was `NameSchema`, whose pattern
    //      excludes `:`, so every entry in that namespace failed the
    //      schema shipped alongside the code producing it.
    //
    // Defect 2's failure mode is the one to remember, and it is not
    // about objectives at all: validation ran on the RESPONSE, after
    // the write had committed. `fs_write` and `fs_mkdir` reported an
    // error for work that had already succeeded, so an agent that
    // retried hit a collision on a file it was told it never wrote,
    // and one that gave up left a file it did not know existed.
    // `fs_rm` alone "worked" throughout — it returns void and parses
    // nothing. The only operation an agent could complete and be told
    // the truth about was the destructive one.
    ...buildFilesystemTools(name),
    // ── Permission-gated tools ──────────────────────────────────────
    //
    // These tools appear in the agent's toolbox only when their slot
    // holds the corresponding leaf permission on the team. The server
    // enforces the same rules independently — if a member somehow
    // invokes one (stale MCP client, prompt injection, etc.) the
    // request 403s — but keeping them out of the tool list is the
    // first line of defense and the natural UX.
    //
    // The team's process document. Reading it is not how an agent
    // learns what binds it — the document is already in its fixed
    // context. These cover the edit history, which injection
    // deliberately leaves out, and the write path.
    ...buildProcessDocumentTools(instructions),
    // The team's spine: the annex, the contracts folded out of it, and
    // the acts that move them. `orient` is the recovery call and the
    // cheapest thing in the toolbox; `discuss` is the cheapest way to
    // say something and never gated. Two tools — authoring and amending
    // a contract — are gated on `spine.author`; everything else is
    // baseline participation, because a member who cannot record what
    // they did cannot be held to anything.
    ...buildSpineTools(instructions),
    // Admin tools for live team/member/preset management. Each gated
    // on the corresponding `team.manage` or `members.manage`
    // permission so non-admin agents don't see them in their toolbox.
    // The broker enforces the same gates independently — these tools
    // exist for UX (don't offer what you can't do) and as a first line
    // of defense, not as the security boundary.
    ...buildAdminTools(instructions),
    // Tool-source registry administration, gated on `tools.manage`.
    // This is the agent-authorship surface: an admin agent can read an
    // API's docs, register a source, define its tools, bind members,
    // and iterate on failures — the whole connector lifecycle without
    // leaving its toolbox. Credentials are WRITE-ONLY end to end; no
    // endpoint returns a secret to anyone, agent or human.
    ...buildToolAdminTools(instructions),
    // Secrets administration, gated on `secrets.manage`. Registry
    // metadata management from the agent toolbox; values are
    // WRITE-ONLY end to end (an agent-set value passes through the
    // session transcript — the tool description teaches the human-
    // drops-the-key alternative).
    ...buildSecretsAdminTools(instructions),
    ...buildVariablesAdminTools(instructions),
    // External Notifications administration, gated on
    // `notifications.manage`. The agent-self-provisioning surface for
    // inbound webhooks: an admin agent can register an endpoint,
    // wire it to itself, set the signing secret, inspect delivery
    // receipts, and replay one while debugging a filter or template.
    // Signing secrets are WRITE-ONLY end to end.
    ...buildNotificationsAdminTools(instructions),
    // ── External tools (tool sources) ──────────────────────────────
    //
    // Platform-defined tools resolved for this member from the
    // broker's tool-source registry. Namespaced `<source>__<name>`
    // (source slugs contain no underscores, so the first `__` is an
    // unambiguous separator). Invocations dispatch back to the broker,
    // which holds the third-party credential — it never reaches this
    // process. The broker independently 403s members that lost their
    // binding mid-session; the toolbox filtering here is UX.
    ...buildExternalTools(externalTools),
  ];
}

/** Compose the MCP tool name for an external tool. */
export function externalToolName(source: string, tool: string): string {
  return `${source}__${tool}`;
}

/**
 * Split a namespaced external tool name back into (source, tool).
 * Returns null when the name has no `__` separator — i.e. it isn't an
 * external tool name.
 */
function parseExternalToolName(name: string): { source: string; tool: string } | null {
  const idx = name.indexOf('__');
  if (idx <= 0 || idx + 2 >= name.length) return null;
  return { source: name.slice(0, idx), tool: name.slice(idx + 2) };
}

function buildExternalTools(externalTools: ResolvedToolSource[]): Tool[] {
  const tools: Tool[] = [];
  for (const source of externalTools) {
    for (const t of source.tools) {
      const inputSchema =
        t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.type === 'object'
          ? (t.inputSchema as Tool['inputSchema'])
          : ({ type: 'object', properties: {} } as Tool['inputSchema']);
      tools.push({
        name: externalToolName(source.source, t.name),
        description: t.description,
        inputSchema,
      });
    }
  }
  return tools;
}

/**
 * Dispatch a namespaced external tool call to the broker's invoke
 * endpoint. Returns null when `name` doesn't match any tool in the
 * snapshot (the caller falls through to its unknown-tool error).
 * Broker responses are MCP-shaped CallToolResults and pass through
 * verbatim — including tool-level `isError` payloads.
 */
async function handleExternalToolCall(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  brokerClient: BrokerClient,
  externalTools: ResolvedToolSource[],
): Promise<CallToolResult | null> {
  const parsed = parseExternalToolName(name);
  if (!parsed) return null;
  const source = externalTools.find((s) => s.source === parsed.source);
  if (!source?.tools.some((t) => t.name === parsed.tool)) return null;
  const result = await brokerClient.invokeTool(parsed.source, parsed.tool, rawArgs ?? {});
  return result as CallToolResult;
}

function buildAdminTools(instructions: InstructionsResponse): Tool[] {
  const { permissions } = instructions;
  const canManageTeam = permissions.includes('team.manage');
  const canManageMembers = permissions.includes('members.manage');
  if (!canManageTeam && !canManageMembers) return [];

  const tools: Tool[] = [];

  // ─── Team config ──────────────────────────────────────────────
  // Read is allowed for anyone — same as `/team` on the HTTP API —
  // but we only surface the tool to admins so the toolbox stays
  // narrow for non-admin members. Any agent that needs team data can pull it from
  // the instructions on session start.
  if (canManageTeam) {
    tools.push({
      name: 'team_get',
      description:
        'Read the current team config: returns name, context, and the named ' +
        'permission presets. Use this to confirm team state before proposing edits, or ' +
        'to check whether a previous `team_update` landed.',
      inputSchema: { type: 'object', properties: {} },
    });
    tools.push({
      name: 'team_update',
      description:
        'Update one or more team-level fields. `context` changes the team ' +
        "instruction block composed into every member's fixed context; the broker " +
        'fans the edit out and each affected runner restarts its agent at the next ' +
        'idle boundary, resuming the same conversation under the new text. Until ' +
        'then the roster lists those members restart-pending. ' +
        'Pass at least one of `name`, `context`. Returns the updated team ' +
        'config (same shape as `team_get`).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'New team name (1–128 chars).' },
          context: {
            type: 'string',
            description:
              'New team context. The standing context every member ' +
              'inherits: what the team is here to do plus any shared background.',
          },
        },
      },
    });

    // ─── Permission presets ──────────────────────────────────────
    tools.push({
      name: 'presets_list',
      description:
        "List the team's permission presets — named bundles of leaf permissions. " +
        'Returns each preset as `{ name, permissions[] }`.',
      inputSchema: { type: 'object', properties: {} },
    });
    tools.push({
      name: 'presets_set',
      description:
        'Create or replace a permission preset. Members that reference this preset by ' +
        'name in their raw permissions automatically pick up the new leaf set on the next ' +
        'read — no member-by-member re-resolve required. Returns the upserted preset.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Preset name (alphanumeric + . _ -, ≤ 64 chars).',
          },
          permissions: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Leaf permissions, e.g. ["spine.author","spine.focus"]. Unknown leaves are rejected.',
          },
        },
        required: ['name', 'permissions'],
      },
    });
    tools.push({
      name: 'presets_delete',
      description:
        'Delete a permission preset. Use this with intent — there is no soft-delete. ' +
        'Returns the names of members that still reference the deleted preset (their ' +
        'resolved permissions silently drop those leaves on the next read).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Preset name to delete.' },
        },
        required: ['name'],
      },
    });
  }

  // ─── Member management ────────────────────────────────────────
  if (canManageMembers) {
    tools.push({
      name: 'members_add',
      description:
        'Create a new team member. `permissions` accepts preset names (e.g. "admin", ' +
        '"operator") or leaf permissions. Returns the new member plus the plaintext ' +
        'bearer token (emitted exactly once — capture it from the response and deliver ' +
        'it to the operator/agent securely).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Member name (alphanumeric + . _ -, ≤ 128 chars).' },
          title: { type: 'string', description: 'Role title (1–64 chars).' },
          description: {
            type: 'string',
            description: 'Optional role description.',
          },
          instructions: {
            type: 'string',
            description: 'Optional personal instructions for this member.',
          },
          permissions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Preset names or leaf permissions. Defaults to no permissions.',
          },
        },
        required: ['name', 'title'],
      },
    });
    tools.push({
      name: 'members_update',
      description:
        "Update an existing member's role, instructions, or permissions. Role and " +
        'instructions edits fan out as an instructions event: each affected runner ' +
        'restarts its agent at the next idle boundary with the new composed text ' +
        '(a role edit also reaches teammates whose roster line changed). Returns the ' +
        'updated member record (no token, no totp secret — those are not re-emitted).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Member name to update.' },
          title: { type: 'string', description: 'New role title.' },
          description: { type: 'string', description: 'New role description.' },
          instructions: { type: 'string', description: 'New personal instructions.' },
          permissions: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Replacement permission list (preset names or leaves). Enforces "at least one members.manage holder remains".',
          },
        },
        required: ['name'],
      },
    });
    tools.push({
      name: 'members_remove',
      description:
        'Delete a member. All bearer tokens for the member are revoked. Refused if this ' +
        'would leave the team with zero members holding `members.manage`. Returns nothing ' +
        'on success.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Member name to remove.' },
        },
        required: ['name'],
      },
    });
  }

  return tools;
}

/**
 * Tool-source registry administration — appears only for members
 * holding `tools.manage`. The descriptions double as the authoring
 * manual: the binding grammar and its guardrails are taught inline so
 * an agent can go from API docs to a working connector without
 * external references. The broker enforces the same permission
 * independently (403), and every save-time validation failure comes
 * back with a message naming the exact problem.
 */
function buildToolAdminTools(instructions: InstructionsResponse): Tool[] {
  if (!instructions.permissions.includes('tools.manage')) return [];

  return [
    {
      name: 'tool_sources_list',
      description:
        'List every registered tool source: slug, kind (custom = HTTP bindings the broker ' +
        'executes; mcp = a remote MCP server the broker proxies), enabled state, tool count, ' +
        'whether a credential is set, and whether it is open to all members. Start here ' +
        'before creating a source — slugs are unique and immutable.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'tool_sources_view',
      description:
        'Inspect one tool source: its tool definitions (custom defs or cached MCP ' +
        'discoveries), bound members, credential status (set or not — never the secret), ' +
        'and config. Use this before editing a tool or diagnosing why an invocation fails.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'The source slug.' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'tool_sources_create',
      description:
        'Register a new tool source. kind="custom" wraps a REST API as declarative tools ' +
        'you define with `tool_sources_define_tool`; kind="mcp" proxies a remote MCP server ' +
        '(requires `url`, a Streamable HTTP endpoint — run `tool_sources_refresh` after ' +
        'setting the credential to discover its tools). The slug is immutable and prefixes ' +
        'every tool name (`<slug>__<tool>`). Creating a source binds NOBODY — bind members ' +
        'with `tool_sources_bindings` or pass allMembers=true. Returns the created source.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            description: 'Lowercase letters/digits/dashes, max 32. Immutable.',
          },
          kind: { type: 'string', enum: ['custom', 'mcp'] },
          url: {
            type: 'string',
            description: 'kind=mcp only: the upstream Streamable HTTP endpoint URL.',
          },
          displayName: { type: 'string', description: 'Optional mutable label.' },
          allMembers: {
            type: 'boolean',
            description: 'Open to every member (including future ones). Default false.',
          },
        },
        required: ['slug', 'kind'],
      },
    },
    {
      name: 'tool_sources_update',
      description:
        'Update a source: displayName, enabled (disabling hides its tools from bound agents ' +
        'immediately — they are notified live), allMembers, or the upstream url (mcp). The ' +
        'slug cannot change. Returns the updated source.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          displayName: { type: 'string' },
          enabled: { type: 'boolean' },
          allMembers: { type: 'boolean' },
          url: { type: 'string', description: 'kind=mcp only.' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'tool_sources_delete',
      description:
        'Permanently delete a tool source and everything under it: bindings, the credential, ' +
        'tool definitions, and any MCP discovery cache. Bound agents lose the tools ' +
        'immediately. There is no undo — prefer `tool_sources_update` with enabled=false ' +
        'when you might want it back.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'tool_sources_define_tool',
      description:
        'Define or replace a tool on a kind=custom source. The definition is data, not code: ' +
        'a description, a JSON Schema for the arguments, and an HTTP `binding` the broker ' +
        'executes with the stored credential. Binding shape: { method: GET|POST|PUT|PATCH|' +
        'DELETE, urlTemplate, headers?, bodyTemplate?, contentType?, resultPath?, timeoutMs? }. ' +
        'Rules: placeholders are `{{args.<name>}}` (top-level args only); the URL origin must ' +
        'be static — placeholders only in path/query (they are URL-encoded); header values may ' +
        'be templated but `Authorization` and the credential header may not (the broker injects ' +
        'those); a JSON bodyTemplate string that is EXACTLY one placeholder passes the raw JSON ' +
        'value through, and a missing arg there omits the containing key (that is how optional ' +
        'API params work); `resultPath` is a dot-path extracted from JSON responses (e.g. ' +
        '"issues.0.key"). Validation errors name the exact problem — fix and retry. Bound ' +
        'agents pick the tool up live; test it yourself by binding yourself, calling ' +
        '`<slug>__<name>`, and reading the result (failures include the upstream response).',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'The kind=custom source slug.' },
          name: {
            type: 'string',
            description: 'Tool name: letters/digits/_/-, max 64. Agents see <slug>__<name>.',
          },
          description: {
            type: 'string',
            description: 'What the tool does — written for the agents who will call it.',
          },
          inputSchema: {
            type: 'object',
            description: 'JSON Schema for the tool arguments, passed to agents verbatim.',
          },
          binding: {
            type: 'object',
            description: 'The HTTP binding (shape and rules above).',
          },
        },
        required: ['slug', 'name', 'description', 'inputSchema', 'binding'],
      },
    },
    {
      name: 'tool_sources_delete_tool',
      description: 'Remove one tool definition from a kind=custom source.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['slug', 'name'],
      },
    },
    {
      name: 'tool_sources_bindings',
      description:
        "Grant or revoke members' access to a source. Bound members' agents see the tools " +
        'in their toolbox and may invoke them; everyone else gets a 403. Pass `add` and/or ' +
        '`remove` as arrays of member names. Not needed when the source has allMembers=true. ' +
        'Returns the updated binding list.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          add: { type: 'array', items: { type: 'string' } },
          remove: { type: 'array', items: { type: 'string' } },
        },
        required: ['slug'],
      },
    },
    {
      name: 'tool_sources_set_credential',
      description:
        'Set (or rotate) the static credential the broker attaches to every request for ' +
        'this source. kind="bearer" sends `Authorization: Bearer <secret>`; kind="header" ' +
        'sends `<headerName>: <secret>`. WRITE-ONLY: once set, no one — agent or human — can ' +
        'read it back; to rotate, set it again. Note the secret you pass becomes part of ' +
        'your session transcript: use this when you generated or were handed the key as part ' +
        'of your work; when a human holds the key, prefer asking them to drop it in via the ' +
        'web UI (Tools → source → Credential) so it never enters agent context.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          kind: { type: 'string', enum: ['bearer', 'header'] },
          headerName: {
            type: 'string',
            description: 'Required when kind=header (e.g. "X-Api-Key").',
          },
          secret: { type: 'string' },
        },
        required: ['slug', 'kind', 'secret'],
      },
    },
    {
      name: 'tool_sources_delete_credential',
      description: 'Remove the source credential. Subsequent invocations go out unauthenticated.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'tool_sources_refresh',
      description:
        "Re-discover a kind=mcp source's tools from its upstream server and update the " +
        'cache. Run after registering the source, after setting its credential, and whenever ' +
        'an invocation 404s with a stale-cache hint. Returns the discovered tool list and ' +
        'whether it changed (changes notify bound agents live).',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
        },
        required: ['slug'],
      },
    },
  ];
}

/**
 * Secrets administration — appears only for members holding
 * `secrets.manage`. A secret is a broker-held value injected as an
 * environment variable on bound members' agent processes at runner
 * start; the agent's CLI tools (gh, terraform, npm, …) find it in the
 * environment without the value ever entering prompts or context.
 * The broker enforces the same permission independently (403).
 */
/**
 * Variables administration — same `secrets.manage` gate as secrets.
 * A variable is a broker-held runner environment variable that is NOT
 * a secret: its value is readable, and it is never registered with the
 * trace redactor, so it appears verbatim in captured traces.
 */
function buildVariablesAdminTools(instructions: InstructionsResponse): Tool[] {
  if (!instructions.permissions.includes('secrets.manage')) return [];

  return [
    {
      name: 'variables_list',
      description:
        'List every registered runner environment VARIABLE: slug, target env var name, the ' +
        'VALUE ITSELF, enabled state, and whether it is open to all members. Variables are ' +
        'the non-secret half of the runner environment — git identity (GIT_AUTHOR_NAME, ' +
        'GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL) lives here, not in ' +
        '`secrets_list`. Use `secrets_list` for credentials. A value here is NOT redacted ' +
        'from captured traces, by design — never put a credential in one.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'variables_view',
      description:
        'Inspect one variable: env var name, description, bound members, and its value. ' +
        'Unlike `secrets_view`, the value IS returned.',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string', description: 'The variable slug.' } },
        required: ['slug'],
      },
    },
    {
      name: 'variables_create',
      description:
        'Register a new runner environment variable that is not a secret. Use this ONLY for ' +
        'values you would be willing to read in a published trace — they are never redacted. ' +
        'Anything confidential belongs in `secrets_create`. `envName` follows the same rules ' +
        'as secrets (uppercase POSIX; CSUITE_/OTEL_ prefixes and PATH/NODE_OPTIONS-style ' +
        'control variables rejected), and a member may not resolve one env name from both a ' +
        'secret and a variable — binding a collision fails with 409. Creating stores NO value ' +
        'and binds NOBODY: follow with `variables_set_value` and `variables_bindings`. Members ' +
        'pick it up on their next runner start.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            description: 'Lowercase letters/digits/dashes, max 64. Immutable.',
          },
          envName: {
            type: 'string',
            description: 'Target environment variable, e.g. "GIT_AUTHOR_NAME".',
          },
          description: { type: 'string', description: 'What this variable is for.' },
          allMembers: {
            type: 'boolean',
            description: 'Deliver to every member (including future ones). Default false.',
          },
        },
        required: ['slug', 'envName'],
      },
    },
    {
      name: 'variables_update',
      description:
        'Update a variable: envName, description, enabled, or allMembers. The slug cannot ' +
        'change. Returns the updated variable.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          envName: { type: 'string' },
          description: { type: 'string' },
          enabled: { type: 'boolean' },
          allMembers: { type: 'boolean' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'variables_delete',
      description: 'Delete a variable, its value and every binding. Not reversible.',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
      },
    },
    {
      name: 'variables_set_value',
      description:
        "Set a variable's value. Readable afterwards by any `secrets.manage` holder and " +
        'NOT redacted from traces — this is the difference from `secrets_set_value`. Members ' +
        'receive it on their next runner start.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          value: { type: 'string', description: 'The value. Not a place for credentials.' },
        },
        required: ['slug', 'value'],
      },
    },
    {
      name: 'variables_delete_value',
      description: "Remove a variable's value. It delivers nothing until a new value is set.",
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
      },
    },
    {
      name: 'variables_bindings',
      description:
        'Add and/or remove member bindings on a variable. Binding fails with 409 when that ' +
        'member already resolves the same env name from a secret or another variable — the ' +
        'two stores share one environment namespace. Returns the resulting bound set.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          add: { type: 'array', items: { type: 'string' }, description: 'Member names to bind.' },
          remove: {
            type: 'array',
            items: { type: 'string' },
            description: 'Member names to unbind.',
          },
        },
        required: ['slug'],
      },
    },
  ];
}

function buildSecretsAdminTools(instructions: InstructionsResponse): Tool[] {
  if (!instructions.permissions.includes('secrets.manage')) return [];

  return [
    {
      name: 'secrets_list',
      description:
        'List every registered secret: slug, target env var name, enabled state, whether a ' +
        'value is set, and whether it is open to all members. Values are never shown — this ' +
        'lists metadata only. Start here before creating a secret; slugs and env names are ' +
        'unique.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'secrets_view',
      description:
        'Inspect one secret: env var name, description, bound members, and whether a value ' +
        'is set (never the value itself).',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'The secret slug.' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'secrets_create',
      description:
        "Register a new secret. `envName` is the environment variable bound members' agents " +
        'will see (uppercase POSIX name; runner-managed prefixes like CSUITE_/OTEL_ and ' +
        'loader/interpreter control variables like PATH or NODE_OPTIONS are rejected). ' +
        'Creating a secret stores NO value and binds NOBODY — set the value with ' +
        '`secrets_set_value` (or ask a human to drop it in the web UI), then bind members ' +
        'with `secrets_bindings` or pass allMembers=true. Members pick secrets up on their ' +
        'next runner start (the agent environment is frozen at spawn). Returns the created ' +
        'secret.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            description: 'Lowercase letters/digits/dashes, max 32. Immutable.',
          },
          envName: {
            type: 'string',
            description: 'Target environment variable, e.g. "GITHUB_TOKEN".',
          },
          description: { type: 'string', description: 'What this secret is for.' },
          allMembers: {
            type: 'boolean',
            description: 'Deliver to every member (including future ones). Default false.',
          },
        },
        required: ['slug', 'envName'],
      },
    },
    {
      name: 'secrets_update',
      description:
        'Update a secret: envName, description, enabled (disabling stops delivery on the ' +
        'next runner start of every bound member), or allMembers. The slug cannot change. ' +
        'Returns the updated secret.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          envName: { type: 'string' },
          description: { type: 'string' },
          enabled: { type: 'boolean' },
          allMembers: { type: 'boolean' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'secrets_delete',
      description:
        'Permanently delete a secret, its stored value, and its bindings. Running agents ' +
        'keep the env var until their runner restarts. There is no undo — prefer ' +
        '`secrets_update` with enabled=false when you might want it back.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'secrets_set_value',
      description:
        'Set (or rotate) the secret value. WRITE-ONLY: once set, no one — agent or human — ' +
        'can read it back through any csuite surface; to rotate, set it again. Members get ' +
        'the new value on their next runner start. Note the value you pass becomes part of ' +
        'your session transcript: use this when you generated or were handed the value as ' +
        'part of your work (a key you minted, a self-provisioned service account); when a ' +
        'human holds the value, prefer asking them to drop it in via the web UI (Secrets → ' +
        'secret → Value) so it never enters agent context.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['slug', 'value'],
      },
    },
    {
      name: 'secrets_delete_value',
      description:
        'Remove the stored value. The secret stays registered but delivers nothing until a ' +
        'new value is set.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'secrets_bindings',
      description:
        "Grant or revoke members' access to a secret. Bound members receive it as an env " +
        'var on their next runner start. Pass `add` and/or `remove` as arrays of member ' +
        'names. Not needed when the secret has allMembers=true. Returns the updated binding ' +
        'list.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          add: { type: 'array', items: { type: 'string' } },
          remove: { type: 'array', items: { type: 'string' } },
        },
        required: ['slug'],
      },
    },
  ];
}

/**
 * External Notifications administration, gated on
 * `notifications.manage`. An endpoint is a slug-addressed hook
 * receiver (`POST /hooks/<slug>` on the broker) that verifies
 * inbound requests, optionally filters/templates/debounces them,
 * and routes them to members or channels as ambient input. This is
 * the self-provisioning surface: an agent can wire an external
 * system to itself — register the endpoint, set the secret, point
 * the sender at the hook URL, then debug with delivery receipts and
 * replay. The broker enforces the same permission independently.
 */
function buildNotificationsAdminTools(instructions: InstructionsResponse): Tool[] {
  if (!instructions.permissions.includes('notifications.manage')) return [];

  const targetsSchema = {
    type: 'array',
    items: { type: 'string' },
    description:
      'Delivery targets: "@member" for a DM, "#channel" for a channel post (bare names ' +
      'count as members). Each member target gets its own DM copy.',
  };
  const filtersSchema = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Dot-path into the JSON payload.' },
        op: { type: 'string', enum: ['eq', 'ne', 'in', 'exists', 'contains'] },
        value: { description: 'Comparison value; array for `in`; omit for `exists`.' },
      },
      required: ['path', 'op'],
    },
    description:
      'Drop rules over the parsed JSON payload; ALL must pass or the delivery is dropped ' +
      'as `filtered`. Non-JSON bodies fail any configured rules.',
  };
  const policyProps = {
    ifOffline: {
      type: 'string',
      enum: ['drop', 'queue'],
      description:
        'Member target offline: drop (default) or queue until their runner next attaches.',
    },
    ifBusy: {
      type: 'string',
      enum: ['now', 'wait'],
      description:
        'Member target mid-turn: deliver now (default) or wait for idle (maxWaitMs guard).',
    },
    debounceMs: {
      type: 'number',
      description: 'Coalescing window in ms; bursts merge into one message. 0 (default) disables.',
    },
    debounceMax: { type: 'number', description: 'Buffered deliveries that force an early flush.' },
    queueTtlMs: {
      type: 'number',
      description: 'How long a queued (offline) delivery stays eligible. Default 24h.',
    },
    maxWaitMs: {
      type: 'number',
      description: 'Max busy-wait before delivering anyway. Default 15m.',
    },
  } as const;
  const authProps = {
    authKind: {
      type: 'string',
      enum: ['hmac-sha256', 'header-secret'],
      description:
        'Verification scheme. hmac-sha256 defaults are GitHub-compatible ' +
        '(x-hub-signature-256, prefix "sha256="); header-secret carries the shared secret ' +
        'verbatim (default header x-hook-secret).',
    },
    authHeader: { type: 'string', description: 'Override the signature/secret header name.' },
    authPrefix: {
      type: 'string',
      description: 'Literal prefix stripped from the header value (hmac only).',
    },
    authProfile: {
      type: 'string',
      description:
        'Slug of a shared auth profile; when set, the profile’s scheme + secret are used ' +
        'and the inline auth fields are ignored.',
    },
  } as const;

  return [
    {
      name: 'notifications_list',
      description:
        'List every external-notification endpoint: slug, targets, verification scheme, ' +
        'delivery policy, and whether a signing secret is set (never the secret itself). ' +
        'Start here; slugs are unique and immutable.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'notifications_view',
      description:
        'Inspect one endpoint: ingress URL, targets, verification config, filters, ' +
        'template, delivery policy, dedupe header. The signing secret is never shown.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'The endpoint slug.' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'notifications_create',
      description:
        'Register an external-notification endpoint. External systems then POST to ' +
        '`/hooks/<slug>` on the broker and verified events reach the targets as ambient ' +
        '<external_content> input. Creating an endpoint stores NO secret — it rejects ' +
        'everything until `notifications_set_secret` (or an authProfile with a secret) is ' +
        'in place. To wire an external system to yourself, target your own name. Returns ' +
        'the created endpoint.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            description: 'Lowercase letters/digits/dashes, max 32. Immutable (it is the URL).',
          },
          targets: targetsSchema,
          displayName: { type: 'string' },
          description: { type: 'string', description: 'What this endpoint is for.' },
          ...authProps,
          level: {
            type: 'string',
            enum: [...LEVELS],
            description:
              'Default level for delivered messages (per-delivery override: ?level= on the ' +
              'hook URL; critical skips debounce and busy-wait).',
          },
          title: { type: 'string', description: 'Message title. Default: displayName or slug.' },
          template: {
            type: 'string',
            description:
              'Body template rendered against the JSON payload ({{payload.<dot.path>}}). ' +
              'Omit for the pretty-printed payload. Templates control only the fenced ' +
              'content — the provenance wrap is not configurable.',
          },
          filters: filtersSchema,
          ...policyProps,
          dedupeHeader: {
            type: 'string',
            description: 'Header whose value dedupes provider retries (e.g. "x-github-delivery").',
          },
        },
        required: ['slug', 'targets'],
      },
    },
    {
      name: 'notifications_update',
      description:
        'Update an endpoint: targets, verification config, filters, template, delivery ' +
        'policy, enabled. The slug cannot change. Returns the updated endpoint.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          targets: targetsSchema,
          displayName: { type: 'string' },
          description: { type: 'string' },
          enabled: { type: 'boolean' },
          ...authProps,
          level: { type: 'string', enum: [...LEVELS] },
          title: { type: 'string' },
          template: { type: 'string' },
          filters: filtersSchema,
          ...policyProps,
          dedupeHeader: { type: 'string' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'notifications_delete',
      description:
        'Permanently delete an endpoint, its delivery receipts, and any queued ' +
        'deliveries. The hook URL starts returning 404. Prefer `notifications_update` ' +
        'with enabled=false when the sender might come back.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'notifications_set_secret',
      description:
        'Set (or rotate) the endpoint’s inline signing secret. WRITE-ONLY: once set, no ' +
        'one can read it back; set again to rotate. Note the value you pass becomes part ' +
        'of your session transcript: fine for secrets you generated yourself (mint a long ' +
        'random one and configure the same value at the sender); when a human holds the ' +
        'secret, prefer asking them to drop it in via the web UI so it never enters agent ' +
        'context.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          secret: { type: 'string' },
        },
        required: ['slug', 'secret'],
      },
    },
    {
      name: 'notifications_delete_secret',
      description:
        'Remove the endpoint’s inline signing secret. The endpoint then rejects every ' +
        'request (fail closed) unless it references an auth profile.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'notifications_deliveries',
      description:
        'List an endpoint’s delivery receipts, newest first: status (delivered / pending ' +
        '/ rejected / filtered / dropped / expired / duplicate / coalesced), reason, and ' +
        'the message ids each delivery became. This is the debugging surface — rejected ' +
        'receipts carry the verification failure reason the sender never sees.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          limit: { type: 'number', description: 'Max receipts (default 20, max 100).' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'notifications_replay',
      description:
        'Re-run a stored delivery through the pipeline using its retained raw body. ' +
        'Verification, dedupe, and rate limit are skipped; filters, template, and ' +
        'delivery policy apply — replay is for debugging exactly those. Returns the ' +
        'fresh receipt.',
      inputSchema: {
        type: 'object',
        properties: {
          deliveryId: { type: 'string' },
        },
        required: ['deliveryId'],
      },
    },
    {
      name: 'notifications_profiles',
      description:
        'List shared auth profiles: verification scheme, whether a secret is set, and ' +
        'how many endpoints reference each. A profile lets several endpoints share one ' +
        'sender secret so rotation is a single write.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'notifications_profile_create',
      description:
        'Register a shared auth profile. Set its secret with ' +
        '`notifications_profile_set_secret`, then reference it from endpoints via ' +
        'authProfile.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Lowercase letters/digits/dashes. Immutable.' },
          description: { type: 'string' },
          authKind: { type: 'string', enum: ['hmac-sha256', 'header-secret'] },
          authHeader: { type: 'string' },
          authPrefix: { type: 'string' },
        },
        required: ['slug', 'authKind'],
      },
    },
    {
      name: 'notifications_profile_delete',
      description:
        'Delete an auth profile. Refused (409) while any endpoint still references it — ' +
        'repoint those endpoints first; an endpoint silently losing its verifier is an ' +
        'outage.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'notifications_profile_set_secret',
      description:
        'Set (or rotate) a profile’s shared secret — one write re-keys every referencing ' +
        'endpoint. WRITE-ONLY, and the same transcript caveat as ' +
        '`notifications_set_secret` applies.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          secret: { type: 'string' },
        },
        required: ['slug', 'secret'],
      },
    },
  ];
}

function buildFilesystemTools(name: string): Tool[] {
  const home = `/${name}`;
  return [
    {
      name: 'fs_ls',
      description:
        `List the contents of a directory in the csuite virtual filesystem. ` +
        `Your home is \`${home}\`; passing "/" lists the set of homes you can see. ` +
        `Entries include per-item metadata (kind, size, mime type, owner). ` +
        `PATHS MUST NOT END IN "/". Directories are DISPLAYED with a trailing slash ` +
        `(\`/you/notes/\`) but are STORED without one, and the API rejects a trailing ` +
        `slash as an invalid path — so strip it before passing a directory path from ` +
        `this listing into any other call.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: `Absolute path to list. Defaults to your home ("${home}").`,
          },
        },
      },
    },
    {
      name: 'fs_stat',
      description:
        `Fetch metadata for a single path. Returns null if the path does not exist. ` +
        `Paths must not end in "/".`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to stat.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_read',
      description:
        `Read the contents of a file. Text-like files (mime \`text/*\` or \`application/json\`) ` +
        `are returned as UTF-8; everything else is returned as base64. The response ` +
        `always includes the path, size, mime type, and either \`text\` or \`base64\`.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to read.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_write',
      description:
        `Upload a file. Pass EITHER \`text\` (UTF-8 string) or \`base64\` (for binary ` +
        `content), never both. Parent directories are auto-created. By default errors on ` +
        `collision; use collide="suffix" to auto-rename ("foo.txt" → "foo-1.txt") or ` +
        `"overwrite" to replace the existing file. Your home is ${home}. ` +
        `Returns the resulting FsEntry (path, name, size, mime, owner) — note the path ` +
        `may differ from the requested one when collide="suffix" produced a rename.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              `Absolute path to write. Allowed under ${home} (your home), and ` +
              `anywhere if you're a director.`,
          },
          mimeType: {
            type: 'string',
            description: 'MIME type of the uploaded file, e.g. "text/plain" or "image/png".',
          },
          text: {
            type: 'string',
            description: 'UTF-8 content. Exclusive with `base64`.',
          },
          base64: {
            type: 'string',
            description: 'Base64-encoded binary content. Exclusive with `text`.',
          },
          collide: {
            type: 'string',
            enum: ['error', 'suffix', 'overwrite'],
            description: "Collision behavior (default 'error').",
          },
        },
        required: ['path', 'mimeType'],
      },
    },
    {
      name: 'fs_mkdir',
      description:
        `Create a directory. Pass recursive=true to auto-create missing parents. ` +
        `Your home is ${home}. Returns the directory's FsEntry.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute directory path to create.' },
          recursive: { type: 'boolean', description: 'Create missing parents (default false).' },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_rm',
      description:
        `Remove a file or directory. Directories require recursive=true if non-empty. ` +
        `Deletion cascades blob refcounts — the underlying content is purged only when the ` +
        `last referencing entry across the filesystem goes away. Returns nothing on success.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to remove.' },
          recursive: {
            type: 'boolean',
            description: 'Cascade-delete directory contents (default false).',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_mv',
      description:
        `Rename / move a file. Directory moves are not currently supported. ` +
        `Both the source and destination must sit under a tree you own (or you must be a director). ` +
        `Returns the FsEntry at the destination path.`,
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Current absolute path.' },
          to: { type: 'string', description: 'Destination absolute path.' },
        },
        required: ['from', 'to'],
      },
    },
    {
      name: 'fs_shared',
      description:
        `List every file that has been shared with you via a message attachment — ` +
        `entries another member explicitly attached to a thread you can see. Owner- ` +
        `private files from other slots never appear here. Returns each file's ` +
        `FsEntry (path, size, mime, owner).`,
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

/**
 * Process-document tools.
 *
 * The document itself is injected, so `get` is not how an agent learns
 * what binds it. These exist for the two things injection does not
 * carry: the superseded text behind each edit, and the write path.
 *
 * The write gate is `process.manage`, a DEDICATED leaf rather than a
 * reuse of `spine.author`. Under this design the permission IS
 * the authority — whoever holds it can rewrite what binds the team —
 * and "can author a contract" is not a comparable power.
 */
function buildProcessDocumentTools(instructions: InstructionsResponse): Tool[] {
  const tools: Tool[] = [
    {
      name: 'process_document_get',
      description:
        "Read the team's process document. **You do not need this to find out what binds " +
        'you** — the current document is already in your fixed context, injected as current ' +
        'state, and it stays correct across compaction. Call this when you want the version ' +
        'number, who last edited it, or to confirm what the broker holds. Returns `null` ' +
        'when no document has been set, which is a real state of a real team and not an ' +
        'error: it means nobody has written one yet, not that you cannot see it. Readable ' +
        'by every member — what binds you is not privileged information.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'process_document_history',
      description:
        'Retrieve the edit history of the process document, oldest first. This is the other ' +
        'half of "history retrievable, not resident": your injected context carries only the ' +
        'current text, so editing it fifty times costs what editing it once costs, and the ' +
        'superseded text lives here. Each entry records who edited it, when, why, the ' +
        '`disposition`, and the FULL text as it stood before that edit — so the diff is ' +
        'derived from two stored strings rather than cached. Use it to answer "was I working ' +
        'under different process when I started this?", which the current text cannot tell ' +
        'you. Version 1 is the creation and carries no prior text. Returns an empty list ' +
        'when no document has been set.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  if (!instructions.permissions.includes('process.manage')) return tools;

  tools.push({
    name: 'process_document_write',
    description:
      "Create or replace the team's process document. Requires `process.manage`. **This is " +
      'the whole authority** — whoever holds this leaf decides what binds every member, so ' +
      'the record of who changed it and why is the only accountability there is. ' +
      '**The text you supply REPLACES the document; it is not appended.** Read it first ' +
      'with `process_document_get` and send the full new text, or you will delete everything ' +
      'you did not retype. The first write creates version 1; every later write increments ' +
      'the version and retains the prior text, so nothing is destroyed. The document reaches ' +
      "every member's injected context at their NEXT runner start — it is NOT pushed into a " +
      'running session, so a teammate mid-session has not seen your edit. No broadcast is ' +
      'needed for it to take effect and none is sent.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'The complete new document, which REPLACES the current text entirely. Not a ' +
            'patch, not an addition. Max ' +
            String(PROCESS_DOCUMENT_MAX) +
            " characters — it is resident in every member's context in every session, so " +
            'its length is a recurring cost paid by everyone.',
        },
        reason: {
          type: 'string',
          description:
            'Why the process is changing. Required, max 2048 characters. This is what a ' +
            'reader six weeks from now has instead of the conversation you are in.',
        },
        disposition: {
          type: 'string',
          enum: ['correction', 'scope_change'],
          description:
            '`correction` — retroactive; the prior text was never validly binding. ' +
            '`scope_change` — forward-only; work already underway finishes under the prior ' +
            'text. Same field and meaning as `contract_amend`, so "does work started under ' +
            'the old process finish under it" has one answer across contracts and process.',
        },
      },
      required: ['text', 'reason', 'disposition'],
    },
  });

  return tools;
}

/**
 * The spine tool surface.
 *
 * THE SCHEMAS ARE THE LAW. This is the one lever CommandSuite has that
 * an agent cannot route around: a required field is a law of physics
 * for a member whose only way to act is a tool call. So the fields that
 * would silently lie by being absent are required here —
 * `expected_state_rev` on every write that changes what the team owes,
 * a whole `revision` caption wherever a value is claimed, `why` on a
 * verdict that could not be reached.
 *
 * THE REFUSALS ARE THE PRODUCT. The annex answers a stale write with
 * the events the caller missed, an incomplete completion with the
 * criteria it does not cover, and a state-changing act under an
 * unresolved ask with the ask itself. Those bodies are rendered in
 * full and never capped: the refusal IS the re-injection, delivered at
 * exactly the moment stale beliefs would have caused harm, and
 * truncating one is a broken guarantee rather than a tidier result.
 *
 * The cheapest call in the surface is `orient`, deliberately: recovery
 * has to cost less than guessing, or members guess.
 */
const SPINE_CITATION_RULE =
  'CITATION LOCK: while you have an unresolved `ask` on a subject — or on any subject ' +
  'CONTAINING it — the annex refuses your state-changing acts there (`contract_author`, ' +
  '`contract_amend`, `attempt_post`, `verdict_post`, `state_set`, `contract_complete`) until ' +
  'either the ask is answered or you record a `proceed` past it. Getting the ruling IS the ' +
  'release: it resolves the ask, and there is nothing further for you to cite. The refusal ' +
  'tells you, in so many words, that YOU DO NOT HAVE A RULING. Believing you were authorised ' +
  'is not a ruling; this is the one gate in the system that will not take your word for it. ' +
  'Proceeding is legitimate and always available — what is refused is inventing an answer ' +
  'nobody gave.';

/** Said once, in every description that returns a contract counter. */
const SPINE_STATE_REV_RULE =
  '`expected_state_rev` is the contract counter AS YOU LAST READ IT (from `orient`, ' +
  '`annex_read`, or the result of your own last write). If the contract has moved since, the ' +
  'write is refused AND the refusal carries every authoritative event you missed, in full — ' +
  'that is how you find out you lost context, so read them and retry deliberately rather than ' +
  'guessing a higher number.';

/**
 * The states `state_set` will move a contract to.
 *
 * ONE list, read by the tool's own enum and by the handler that
 * validates against it. It was two hand-written copies, and a mutation
 * shrinking the handler's copy to two entries passed the whole suite:
 * the schema an agent reads and the check that enforces it could
 * disagree with nothing to say so.
 *
 * `done` is deliberately absent. Completion goes through
 * `contract_complete`, where the evidence is checked, and a second
 * route to done that skipped it would be the gate's only hole.
 */
const SPINE_SETTABLE_STATES = [
  'active',
  'waiting_on',
  'waiting_for',
  'parked',
  'cancelled',
  'superseded',
] as const;

/**
 * THE RECIPE GRAMMAR, and the one string in this file that has to be
 * complete rather than merely honest.
 *
 * A check is authored inside the thing it discharges — there is no
 * `check_author` tool, deliberately — so this description is the ONLY
 * place a member learns that the field can do anything at all. Left as
 * "what would confirm the answer", every check in the team stays prose
 * forever and the probe engine watches an empty registry. So the two
 * recipe shapes are spelled out here, with a worked example of each,
 * and the refusal rules are stated where they are cheapest to obey.
 *
 * Prose is still legitimate and still records what the member meant;
 * it simply arms nothing, and that has to be said or the rule reads as
 * a trap.
 */
const SPINE_CHECK_RECIPE_HELP =
  'Prose is fine and arms nothing. To have the SYSTEM confirm it, write a JSON recipe here ' +
  'instead and it becomes a probe: the system presses the button, and the observation it ' +
  'produces is attributed to YOU (`authored_by`) with the probe as its actor — you composed ' +
  'the shot, the system held the camera. Two kinds. ' +
  '(1) webhook: {"kind":"webhook","endpoint":"<inbound endpoint slug>","when":[{"path":' +
  '"check_run.conclusion","op":"eq","value":"success"}],"revisionPath":"check_run.head_sha"} ' +
  '— fires on a VERIFIED delivery to that endpoint whose payload matches. ' +
  '(2) http_poll: {"kind":"http_poll","url":"https://…","intervalMs":300000,"when":[…],' +
  '"authSecret":"<secret slug>"} — an outbound GET on an interval. `when` is the inbound-' +
  'notification filter rules (ops: eq, ne, in, exists, contains; empty list means any ' +
  'delivery). `revisionPath` is optional and names a value that IS an observation point — a ' +
  'SHA, a build id — which rides in as an observed revision. Poll rules, refused here rather ' +
  'than at fire time: https only, no redirects followed, minimum interval 60000ms, and a ' +
  'secret named by SLUG which is resolved server-side as you (never write a token into this ' +
  'field — it would be in the annex permanently). It fires ONCE: re-arming takes a new ask or ' +
  'a fresh waiting_for.';

const SPINE_OP_ID_FIELD = {
  type: 'string',
  description:
    'Optional idempotency key of your choosing. Send the SAME id with the SAME payload on a ' +
    'retry and the annex returns the original event without appending a second one — which is ' +
    'what makes a lost response cheap. Omit it and one is generated for you, in which case a ' +
    'retry is a new write.',
} as const;

const SPINE_REVISION_FIELD = {
  type: 'object',
  description:
    'The observation point this act is about. Never a bare value: `how` and `source` ride ' +
    'along so "verified at abc123" cannot be recorded without "observed at 03:19 from the ' +
    'GitHub review event".',
  properties: {
    value: { type: 'string', description: 'The revision itself — a SHA, a version, a build id.' },
    how: {
      type: 'string',
      enum: ['observed', 'asserted'],
      description:
        '`observed` — you or an integration actually looked. `asserted` — you named it by ' +
        'hand. Only observed revisions move a subject’s head, so your assertion can never ' +
        "make someone else's contract stale.",
    },
    source: {
      type: 'string',
      description: 'Who or what produced it: `integration:github`, `member:rune`, `probe:ci`.',
    },
    subject: {
      type: 'string',
      description:
        "Optional. Defaults to the contract's own subject, which is almost always what you " +
        'mean.',
    },
  },
  required: ['value', 'how', 'source'],
} as const;

/**
 * The spine's tools.
 *
 * Two are gated on `spine.author` — authoring and amending a contract —
 * and everything else is baseline participation. Attempting, judging,
 * asking, ruling, proceeding, observing and talking are not privileges:
 * a member who cannot record what they did cannot be held to anything,
 * and gating the record would only produce work that happened off it.
 */
function buildSpineTools(instructions: InstructionsResponse): Tool[] {
  const tools: Tool[] = [
    {
      name: 'orient',
      // THE RECOVERY CALL, and the cheapest description in the surface
      // to act on: no arguments, no preconditions, no way to be
      // refused. Everything an agent needs in order to decide to call
      // it is in the first two sentences, because the moment it is
      // needed most is the moment there is least context left to read
      // with.
      description:
        'Get your bearings. **Call this first after any restart, compaction, or gap — and ' +
        'whenever you are not certain what you are working on.** No arguments, never refuses, ' +
        'and cheap by construction. Returns everything you are promised: every contract you ' +
        'are bound to and how (assignee / verifier / authority), its criteria with the verdict ' +
        'reached on each, the state and the counter, the subject and the exact revision it ' +
        'sits at, whether that revision is behind the world, the rulings that bind it, the ' +
        'asks awaiting YOUR ruling, your own open asks, and a cursor into everything else. ' +
        'Guessing is more expensive than this call. It is not a status report for anyone ' +
        'else — it is composed for you.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'annex_read',
      description:
        'Page the annex — the team’s append-only record of everything that has been ' +
        'observed, specified, attempted, judged, asked, ruled and said. `orient` gives you a ' +
        '`cursor`; pass it as `since_seq` here to read everything that happened while you were ' +
        'away, oldest first. Filter by `kind`, `subject` (containment resolves, so a repo ' +
        'reaches the files in it), `contract`, or `actor`. `next_cursor` is null ONLY when the ' +
        'page reached the head of the stream — an empty page with a cursor means "nothing new ' +
        'yet", which is a different claim. Never refuses.',
      inputSchema: {
        type: 'object',
        properties: {
          since_seq: {
            type: 'number',
            description:
              'Read everything after this stream position. Omit to start at the beginning.',
          },
          limit: { type: 'number', description: 'Page size, 1–500. Defaults to 100.' },
          kind: {
            type: 'string',
            description:
              'One kind only: observation, testimony, specification, amendment, attempt, ' +
              'criterion_verdict, ruling, ask, ask_action, proceeding, lifecycle, correction, ' +
              'discussion, promotion.',
          },
          subject: {
            type: 'string',
            description: 'A subject id. Resolves containment — a repo returns the files inside it.',
          },
          contract: { type: 'string', description: 'Everything that touched one contract.' },
          actor: { type: 'string', description: 'Everything one member (or probe) did.' },
        },
      },
    },
    {
      name: 'attempt_post',
      description:
        'Record an attempt on a contract: what you did, and the exact revision you did it at. ' +
        'This is the READINESS SIGNAL — it binds the contract to that revision and it is what ' +
        'lights up the verifier’s `orient`, so post it when the work is ready to be ' +
        'judged rather than when it is merged. ' +
        SPINE_STATE_REV_RULE +
        ' ' +
        SPINE_CITATION_RULE,
      inputSchema: {
        type: 'object',
        properties: {
          contract: { type: 'string', description: 'The contract id.' },
          summary: {
            type: 'string',
            description: 'What you did, and anything the verifier needs in order to judge it.',
          },
          revision: SPINE_REVISION_FIELD,
          expected_state_rev: {
            type: 'number',
            description: 'The contract counter as you last read it.',
          },
          op_id: SPINE_OP_ID_FIELD,
        },
        required: ['contract', 'summary', 'revision', 'expected_state_rev'],
      },
    },
    {
      name: 'verdict_post',
      description:
        'Judge ONE criterion of a contract at ONE revision. Verdicts are per-criterion by ' +
        'construction — partial is the native shape, and you never have to decide the whole ' +
        'contract to record what you actually checked. **You cannot judge a contract you are ' +
        'the assignee of**: arrival cannot be declared from the traveller’s own album, ' +
        'and the annex refuses it whatever permissions you hold. `cannot_verify` is a ' +
        'first-class answer and REQUIRES `why` — a verdict that cannot say why is ' +
        'indistinguishable from silence, and silence is what the three legal ways out of it ' +
        '(amend the criterion, re-scope the verifier, or get the authority to waive it by ' +
        'ruling) have to act on. ' +
        SPINE_STATE_REV_RULE +
        ' ' +
        SPINE_CITATION_RULE,
      inputSchema: {
        type: 'object',
        properties: {
          contract: { type: 'string', description: 'The contract id.' },
          criterion: {
            type: 'string',
            description: 'The criterion id, exactly as it appears in the contract.',
          },
          decision: {
            type: 'string',
            enum: ['met', 'unmet', 'cannot_verify'],
            description:
              '`met` / `unmet` — you looked and this is the answer at that revision. ' +
              '`cannot_verify` — you could not tell, which is a real answer and requires `why`.',
          },
          evidence: {
            type: 'string',
            description: 'What you actually looked at. This is the record of the check itself.',
          },
          why: {
            type: 'string',
            description:
              'REQUIRED on `cannot_verify`: what stopped you. No access, no environment, the ' +
              'criterion is unmeasurable as written — say which, because each has a different ' +
              'remedy.',
          },
          revision: SPINE_REVISION_FIELD,
          expected_state_rev: {
            type: 'number',
            description: 'The contract counter as you last read it.',
          },
          op_id: SPINE_OP_ID_FIELD,
        },
        required: [
          'contract',
          'criterion',
          'decision',
          'evidence',
          'revision',
          'expected_state_rev',
        ],
      },
    },
    {
      name: 'state_set',
      description:
        'Move a contract to a new lifecycle state: `active`, `waiting_on` (a named member who ' +
        'can act — they see it in their queue), `waiting_for` (the world; carries the event ' +
        'and the check that will re-light it, and stays SILENT until then), `parked` (the team ' +
        'chose to stop; visible, quiet, resumable), `cancelled`, or `superseded` (the successor ' +
        'contract carries the work forward — the old one stays terminal at its own revision ' +
        'with its verdicts intact, and is never silently retargeted). **Completion is not here: ' +
        'use `contract_complete`**, which is where the evidence gets checked. ' +
        SPINE_STATE_REV_RULE +
        ' ' +
        SPINE_CITATION_RULE,
      inputSchema: {
        type: 'object',
        properties: {
          contract: { type: 'string', description: 'The contract id.' },
          state: {
            type: 'string',
            enum: [...SPINE_SETTABLE_STATES],
            description: 'The state to move to. `done` is refused here — see `contract_complete`.',
          },
          expected_state_rev: {
            type: 'number',
            description: 'The contract counter as you last read it.',
          },
          reason: {
            type: 'string',
            description: 'Why. Required in practice for every terminal move.',
          },
          member: { type: 'string', description: 'REQUIRED on `waiting_on`: who can unblock it.' },
          event: {
            type: 'string',
            description: 'REQUIRED on `waiting_for`: the event being waited on.',
          },
          check: {
            type: 'string',
            description:
              'REQUIRED on `waiting_for`: what will confirm it. Without a check the contract ' +
              'goes silent with nothing able to wake it, which is how work disappears. ' +
              SPINE_CHECK_RECIPE_HELP +
              ' A recipe here re-lights this contract automatically: the observation lands and ' +
              'the contract goes back to `active` citing it, with nobody nagged.',
          },
          preempted_by: { type: 'string', description: 'On `parked`: what took priority.' },
          successor: {
            type: 'string',
            description: 'REQUIRED on `superseded`: the contract that carries the work forward.',
          },
          op_id: SPINE_OP_ID_FIELD,
        },
        required: ['contract', 'state', 'expected_state_rev'],
      },
    },
    {
      name: 'contract_complete',
      description:
        'Complete a contract: the result, the revision it is true at, and the verdicts that ' +
        'say so. **When the contract names a verifier this is a HARD GATE** — cited verdicts ' +
        '(or rulings waiving a `cannot_verify`) must cover EVERY criterion at ONE revision, and ' +
        'the refusal names each criterion that is not covered and why it is not. Read that list ' +
        'rather than re-sending: it is the shortest description of what is left to do. With no ' +
        'verifier named, the result stands alone and the record says so. ' +
        SPINE_STATE_REV_RULE +
        ' ' +
        SPINE_CITATION_RULE,
      inputSchema: {
        type: 'object',
        properties: {
          contract: { type: 'string', description: 'The contract id.' },
          result: {
            type: 'string',
            description:
              'What was delivered, and whether it satisfies the contract as written. No length ' +
              'cap — this is one of the permanent fields, and caps scale WITH durability here.',
          },
          revision: SPINE_REVISION_FIELD,
          cites: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The verdict event ids (and any waiving rulings) this completion stands on. ' +
              'Citing a verdict that a later one at the same revision superseded is refused — ' +
              'the annex checks the CURRENT verdict, and the citation proves you had it in hand.',
          },
          expected_state_rev: {
            type: 'number',
            description: 'The contract counter as you last read it.',
          },
          op_id: SPINE_OP_ID_FIELD,
        },
        required: ['contract', 'result', 'revision', 'cites', 'expected_state_rev'],
      },
    },
    {
      name: 'ask_author',
      description:
        'Ask another member for a ruling — a durable, citable decision, not a chat message. ' +
        'Every field is required because an ask that cannot be priced is an ask nobody answers: ' +
        '`question` (what is being decided), `context` (what they need in order to decide it), ' +
        'and `unblocks` (what is stopped until they do). It lands in their queue and stays ' +
        'there until they rule, decline, redirect or defer it — a redirect re-addresses the ' +
        'question rather than answering it, so the ask stays open under its new authority. ' +
        '**Raising one binds you, but only as far as it is scoped**: an ask carrying a ' +
        '`subject` or a `contract` locks your state-changing acts there; an ask carrying ' +
        'neither scopes nothing and holds you to nothing. ' +
        SPINE_CITATION_RULE,
      inputSchema: {
        type: 'object',
        properties: {
          authority: {
            type: 'string',
            description:
              'The member whose call this is. It cannot be you — an ask naming yourself would ' +
              'manufacture a ruling you could cite without anyone having decided anything.',
          },
          question: { type: 'string', description: 'The decision you need, stated as a question.' },
          context: { type: 'string', description: 'What they need in order to answer it.' },
          unblocks: {
            type: 'string',
            description: 'What is held up until they do. This is how they prioritise your ask.',
          },
          subject: {
            type: 'string',
            description:
              'The part of the world this is about. Scopes the citation lock: an ask on a repo ' +
              'binds your acts on every file in it.',
          },
          contract: {
            type: 'string',
            description: 'The contract this ask is about. Requires `expected_state_rev` with it.',
          },
          expected_state_rev: {
            type: 'number',
            description: 'REQUIRED when `contract` is given; refused when it is not.',
          },
          trigger: {
            type: 'string',
            description: 'Optional: what should re-raise this if deferred.',
          },
          check: {
            type: 'string',
            description:
              'Optional: what would confirm the answer on its own, so the authority never has ' +
              'to type one. ' +
              SPINE_CHECK_RECIPE_HELP +
              ' When it fires, this ask closes as `discharged` with the observation stapled to ' +
              'it — the authority does the thing and types nothing.',
          },
          op_id: SPINE_OP_ID_FIELD,
        },
        required: ['authority', 'question', 'context', 'unblocks'],
      },
    },
    {
      name: 'ruling_post',
      description:
        'Answer an ask that names YOU as its authority. A ruling is an authored, citable ' +
        'decision — the thing members point at afterwards instead of remembering. **Only the ' +
        'ask’s named authority can rule on it**: a ruling from anyone else is not a weaker ' +
        'ruling, it is not a ruling, and the annex refuses it whatever permissions you hold — ' +
        'including after a redirect, which moves the ask to a new authority and leaves it ' +
        'open rather than resolving it. ' +
        'A ruling that cites a `cannot_verify` verdict WAIVES that criterion, which is one of ' +
        'the three legal ways out of one. Ruling resolves the ask and releases the asker.',
      inputSchema: {
        type: 'object',
        properties: {
          ask: {
            type: 'string',
            description: 'The ask event id (see `orient` → asks awaiting you).',
          },
          decision: { type: 'string', description: 'What you decided, plainly.' },
          reasoning: {
            type: 'string',
            description:
              'Why. No length cap — this is what a member reads in six weeks instead of the ' +
              'conversation you are in now.',
          },
          contract: {
            type: 'string',
            description: 'The contract this ruling binds, if any. Requires `expected_state_rev`.',
          },
          expected_state_rev: {
            type: 'number',
            description: 'REQUIRED when `contract` is given; refused when it is not.',
          },
          cites: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Events this ruling stands on. Citing a `cannot_verify` verdict here is what ' +
              'makes this ruling a WAIVER of that criterion.',
          },
          op_id: SPINE_OP_ID_FIELD,
        },
        required: ['ask', 'decision', 'reasoning'],
      },
    },
    {
      name: 'proceed',
      description:
        'Go ahead without the ruling, on the record. This is the LEGAL way past your own ' +
        'unresolved ask and it is not a workaround — the annex refuses invented authority, ' +
        'never deliberate action without it. One `proceed` covers your later acts on that ' +
        'subject until the ask resolves, so it is one deliberate act of record rather than a ' +
        'toll on every write. The cover is keyed to the ASK, not to what you type in ' +
        '`subject`: the ask already carries the scope it locks, so `subject` here is caption ' +
        'only — naming a narrower one does not narrow what this proceeding covers, and naming ' +
        'a wider one does not widen it. `reason` is what a reader sees later instead of an ' +
        'answer nobody gave; say why waiting cost more than acting.',
      inputSchema: {
        type: 'object',
        properties: {
          ask: {
            type: 'string',
            description: 'The ask you are proceeding past. Must still be open.',
          },
          subject: { type: 'string', description: 'The part of the world you are acting on.' },
          reason: { type: 'string', description: 'Why you are going ahead without the ruling.' },
          op_id: SPINE_OP_ID_FIELD,
        },
        required: ['ask', 'subject', 'reason'],
      },
    },
    {
      name: 'observe',
      description:
        'Record what you saw. An observation is YOUR OWN look at part of the world — the test ' +
        'output, the file as it stands, the deploy that failed — and it is epistemically ' +
        'different from what someone told you, which is why the annex types them separately. ' +
        'Attach a `revision` when you are looking at a versioned thing: an `observed` one moves ' +
        'that subject’s head and can therefore make bound contracts render stale, which is ' +
        'reported, never repaired. Ambient and never refused by the citation lock — looking is ' +
        'never the act that needs authorising.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'The part of the world you looked at.' },
          what: { type: 'string', description: 'What you did to see it.' },
          output: { type: 'string', description: 'What you saw, verbatim where that matters.' },
          revision: SPINE_REVISION_FIELD,
        },
        required: ['subject', 'what', 'output'],
      },
    },
    {
      name: 'discuss',
      description:
        'Say something. The cheapest surface in the system and the largest cap in it (' +
        String(SPINE_DISCUSSION_MAX) +
        ' characters): thinking out loud, questions, findings, disagreement. It never advances ' +
        'a contract counter, so a busy thread can never veto a lifecycle act, and **it is ' +
        'never refused by the citation lock** — the record is expensive to get wrong and the ' +
        'conversation must never be. If a post turns out to have been a decision, an ' +
        'observation or a commitment, `promote` turns it into the typed event, citing the post ' +
        'as its origin, so nothing has to be retyped to be counted.',
      inputSchema: {
        type: 'object',
        properties: {
          body: {
            type: 'string',
            description: `What you want to say. Max ${String(SPINE_DISCUSSION_MAX)} characters.`,
          },
          contract: { type: 'string', description: 'The contract this is about, if any.' },
          subject: { type: 'string', description: 'The subject this is about, if any.' },
        },
        required: ['body'],
      },
    },
    {
      name: 'promote',
      description:
        'Turn a discussion post into the typed event it turned out to be. Give it the post’s ' +
        'event id and `as` — the kind it should become — and the post’s text becomes that ' +
        "kind's principal field (an `observation`'s output, an `attempt`'s summary, a " +
        "`ruling`'s reasoning). Supply anything else that kind requires in `fields`; if you " +
        'miss one, the refusal names it. The typed event CITES the post as its origin, so the ' +
        'record shows where the decision actually happened rather than pretending it arrived ' +
        'fully formed. The result is a real event of that kind and is held to every rule that ' +
        'kind carries — promoting is not a way around a precondition or the citation lock.',
      inputSchema: {
        type: 'object',
        properties: {
          event: { type: 'string', description: 'The discussion event id to promote.' },
          as: {
            type: 'string',
            description:
              'The kind it becomes: observation, testimony, specification, amendment, attempt, ' +
              'criterion_verdict, ruling, ask, ask_action, proceeding, lifecycle, correction.',
          },
          fields: {
            type: 'object',
            description:
              "The body fields that kind requires and the post does not supply — an attempt's " +
              "`contract`, a verdict's `criterion` and `decision`, an ask's `authority`. Any " +
              'field you set here overrides what would have been taken from the post.',
          },
          subject: {
            type: 'string',
            description: 'Subject for the new event; defaults to the post’s.',
          },
          revision: SPINE_REVISION_FIELD,
          cites: {
            type: 'array',
            items: { type: 'string' },
            description: 'Extra citations. The origin post is always cited first, automatically.',
          },
          expected_state_rev: {
            type: 'number',
            description: 'Required when the promoted kind reaches a contract.',
          },
          op_id: SPINE_OP_ID_FIELD,
        },
        required: ['event', 'as'],
      },
    },
    {
      name: 'subscribe',
      // The reader-side control #155 finding 1 asked for. Its
      // description leads with the DEFAULT, because the failure this
      // exists to fix was members drowning in fanout they never chose,
      // and a member who does not know silence is the default will
      // assume the noise is unavoidable.
      description:
        'Choose how much a contract tells you. Levels: `all` (every authoritative event on ' +
        'it), `lifecycle` (state changes only), `none` (silence). **The default is already ' +
        'quiet** — you hear nothing about a contract unless you authored it, in which case ' +
        'you hear its lifecycle. Anything that names you personally — an ask to you, a ' +
        'verdict on your contract, a ruling on your ask — reaches you regardless of every ' +
        'level here, so turning a contract to `none` never silences work that is actually ' +
        'yours. Use it to follow something you are not bound to, or to stop hearing about ' +
        'one you are done with. Deltas only ever carry an id, a title and what changed.',
      inputSchema: {
        type: 'object',
        properties: {
          contract: { type: 'string', description: 'The contract id (from `orient`).' },
          level: {
            type: 'string',
            description: 'all | lifecycle | none.',
          },
        },
        required: ['contract', 'level'],
      },
    },
  ];

  // `focus` is gated on a DIFFERENT leaf (`spine.focus`) and appears
  // BEFORE the `spine.author` early-return, because curating the focus
  // set and authoring work are separate authorities: an allocator may
  // hold one without the other. Reading the set needs no tool — `orient`
  // marks each binding in/out of focus and `annex_read` pages the events
  // — so only the lighting act is a tool, and only for its holder.
  if (instructions.permissions.includes('spine.focus')) {
    tools.push({
      name: 'focus',
      description:
        'Light or unlight a contract in the team FOCUS SET — the shared boundary of what is lit ' +
        'for travel now. Requires `spine.focus`. `lit: true` adds it, `lit: false` takes it out; ' +
        'the `reason` is required and lands on the record. Focus governs AMBIENT attention only: ' +
        'a contract out of focus generates no subscription deltas and no recovery nudges, so the ' +
        'team is not spammed about work that is not the current push — but it stays fully in the ' +
        'annex, in `orient`, and in its owner’s queue, and anything that names a member ' +
        'personally (an ask, a verdict, a contract ending) still reaches them out of focus. ' +
        'Lighting is a set operation: re-lighting what is already lit, or unlighting what is not, ' +
        'is refused. ' +
        SPINE_STATE_REV_RULE,
      inputSchema: {
        type: 'object',
        properties: {
          contract: { type: 'string', description: 'The contract id (from `orient`).' },
          lit: {
            type: 'boolean',
            description: 'true to light it into the focus set, false to unlight it.',
          },
          reason: {
            type: 'string',
            description: 'Why — it lands on the record for whoever reads the set later.',
          },
          expected_state_rev: {
            type: 'number',
            description: 'The contract counter as you last read it.',
          },
          op_id: SPINE_OP_ID_FIELD,
        },
        required: ['contract', 'lit', 'reason', 'expected_state_rev'],
      },
    });
  }

  // THE READ IS BASELINE, and it is outside the `spine.focus` block on
  // purpose. D9's claim is that agents PLAN against the focus set, and
  // an agent that cannot see the team's plate cannot plan against it —
  // it can only be silenced by it. `orient` marks a member's own
  // bindings, which answers "am I in the push"; this answers "what is
  // the push", which is the question anyone deciding what to pick up
  // next is actually asking. Changing the set still takes the leaf.
  tools.push({
    name: 'focus_set',
    description:
      'Read the team FOCUS SET — every contract lit for travel right now, whoever holds it. ' +
      'This is the shared boundary the team is working inside: work outside it generates no ' +
      'ambient traffic, so reading this is how you tell what the current push IS rather than ' +
      'only whether your own work is in it (`orient` marks that). A contract that ends leaves ' +
      'the set by ending — the read is what is lit AND still travelable, never a graveyard. ' +
      'Reading takes no permission; changing the set takes `spine.focus`.',
    inputSchema: { type: 'object', properties: {} },
  });

  // The gate, and its wording follows `process_document_write`: the
  // description says the leaf out loud so a member without it does not
  // discover the boundary by eating a 403 mid-task. Everything above is
  // baseline participation — a member who cannot record what they did
  // cannot be held to anything, and gating the record only produces
  // work that happens off it.
  if (!instructions.permissions.includes('spine.author')) return tools;

  tools.push(
    {
      name: 'contract_author',
      description:
        'Author a contract: what the world must BECOME, bound to a subject and decomposed into ' +
        'criteria. Requires `spine.author`. This is the destination photograph and the one that ' +
        'must never be blurred — there is no length cap on criteria, because a cap that ' +
        'punishes precision buys nothing. Each criterion is prose a person could check, not a ' +
        'predicate, and each gets its own verdict later. Naming a `verifier` means completion ' +
        'will need verdicts covering every criterion; naming none means the result will stand ' +
        'alone and say so. Naming an `authority` says whose rulings bind this work. The subject ' +
        'must already be registered, or pass `subject_type` and it is registered inline. ' +
        SPINE_CITATION_RULE,
      inputSchema: {
        type: 'object',
        properties: {
          subject: {
            type: 'string',
            description: 'The part of the world this contract is about, e.g. `repo:acme`.',
          },
          subject_type: {
            type: 'string',
            enum: ['repo', 'pr', 'file', 'issue', 'setting', 'package', 'doc'],
            description: 'Register the subject inline when it is new. Omit when it already exists.',
          },
          subject_parent: {
            type: 'string',
            description:
              'The subject containing it, when registering inline. Containment is declared here ' +
              'and never moved, and scoped rules follow it downward.',
          },
          title: { type: 'string', description: 'What this contract is, in one line.' },
          criteria: {
            type: 'array',
            description:
              'What must be true for this to be done. Each is judged separately, so write them ' +
              'as things a verifier can check one at a time. No length cap.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'A short stable handle, e.g. `c1`.' },
                text: { type: 'string', description: 'The criterion, as prose.' },
              },
              required: ['id', 'text'],
            },
          },
          assignee: { type: 'string', description: 'The member who will travel to it.' },
          verifier: {
            type: 'string',
            description:
              'The member who will judge it. Named ⇒ completion needs verdicts covering every ' +
              'criterion. Cannot be the assignee in practice — the annex refuses a verdict from ' +
              'the assignee.',
          },
          authority: { type: 'string', description: 'Whose rulings bind this contract.' },
          constraints: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Standing "do not" clauses: do not fix this here, do not publish anything. These ' +
              'come from you — nothing derives them.',
          },
          op_id: SPINE_OP_ID_FIELD,
        },
        required: ['subject', 'title', 'criteria', 'assignee'],
      },
    },
    {
      name: 'contract_amend',
      description:
        'Amend a contract — its title, criteria or constraints. Requires `spine.author`. The ' +
        'prior version is kept and this is versioned, never replaced. Two refusals worth ' +
        'knowing before you call: **removing text without a `disclosure` is refused** (what ' +
        'members have already read cannot be made never to have existed — say what went and ' +
        'why anyone working to it should know), and **dropping a criterion that already ' +
        'carries a verdict must CITE that verdict** (nothing here refuses the drop; it only ' +
        'stops a judged criterion disappearing quietly). Adding criteria or constraints, and ' +
        'appending to existing text, need neither. `disposition` is not optional and you must ' +
        'choose deliberately: `correction` means the prior text was never validly binding; ' +
        '`scope_change` means work already underway finishes under it. ' +
        SPINE_STATE_REV_RULE +
        ' ' +
        SPINE_CITATION_RULE,
      inputSchema: {
        type: 'object',
        properties: {
          contract: { type: 'string', description: 'The contract id.' },
          changes: { type: 'string', description: 'What is changing, in prose.' },
          reason: { type: 'string', description: 'Why it is changing.' },
          disposition: {
            type: 'string',
            enum: ['correction', 'scope_change'],
            description:
              '`correction` — retroactive; the prior text was never validly binding. ' +
              '`scope_change` — forward-only; work already underway finishes under the prior ' +
              'text. The same field and meaning as `process_document_write`.',
          },
          title: { type: 'string', description: 'Replacement title.' },
          criteria: {
            type: 'array',
            description:
              'The COMPLETE new criteria list, not a patch. Anything you leave out is removed, ' +
              'and removal needs a `disclosure`.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
              },
              required: ['id', 'text'],
            },
          },
          constraints: {
            type: 'array',
            items: { type: 'string' },
            description: 'The COMPLETE new constraints list, not a patch.',
          },
          disclosure: {
            type: 'string',
            description:
              'REQUIRED when this removes text: what was removed, and what anyone already ' +
              'working to it needs to know. Contamination is disclosed, never erased.',
          },
          cites: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Events this amendment stands on — including the verdicts it orphans when it ' +
              'drops a judged criterion.',
          },
          expected_state_rev: {
            type: 'number',
            description: 'The contract counter as you last read it.',
          },
          op_id: SPINE_OP_ID_FIELD,
        },
        required: ['contract', 'changes', 'reason', 'disposition', 'expected_state_rev'],
      },
    },
  );

  return tools;
}

export async function handleToolCall(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
  externalTools: ResolvedToolSource[] = instructions.toolSources,
): Promise<CallToolResult> {
  const args = rawArgs ?? {};
  try {
    switch (name) {
      case 'roster':
        return await handleRoster(brokerClient, instructions);
      case 'broadcast':
        return await handleBroadcast(args, brokerClient);
      case 'send':
        return await handleSend(args, brokerClient);
      case 'channels_list':
        return await handleChannelsList(brokerClient, instructions);
      case 'channels_post':
        return await handleChannelsPost(args, brokerClient);
      case 'recent':
        return await handleRecent(args, brokerClient, instructions);
      case 'process_document_get':
        return await handleProcessDocumentGet(brokerClient);
      case 'process_document_history':
        return await handleProcessDocumentHistory(brokerClient);
      case 'process_document_write':
        return await handleProcessDocumentWrite(args, brokerClient);
      // ─── Spine ────────────────────────────────────────────────
      // Enumerated rather than folded into the default arm, so this
      // switch stays the readable index of the surface. They share one
      // dispatcher because they share one refusal renderer: every
      // spine refusal carries a delta, a coverage gap or an ask, and
      // rendering that completely is the product.
      case 'orient':
      case 'annex_read':
      case 'contract_author':
      case 'contract_amend':
      case 'attempt_post':
      case 'verdict_post':
      case 'state_set':
      case 'contract_complete':
      case 'ask_author':
      case 'ruling_post':
      case 'proceed':
      case 'observe':
      case 'discuss':
      case 'promote':
      case 'subscribe':
      case 'focus':
      case 'focus_set':
        return await handleSpineTool(name, args, brokerClient, instructions);
      case 'fs_ls':
        return await handleFsLs(args, brokerClient, instructions);
      case 'fs_stat':
        return await handleFsStat(args, brokerClient);
      case 'fs_read':
        return await handleFsRead(args, brokerClient);
      case 'fs_write':
        return await handleFsWrite(args, brokerClient);
      case 'fs_mkdir':
        return await handleFsMkdir(args, brokerClient);
      case 'fs_rm':
        return await handleFsRm(args, brokerClient);
      case 'fs_mv':
        return await handleFsMv(args, brokerClient);
      case 'fs_shared':
        return await handleFsShared(brokerClient);
      case 'team_get':
        return await handleTeamGet(brokerClient);
      case 'team_update':
        return await handleTeamUpdate(args, brokerClient);
      case 'presets_list':
        return await handlePresetsList(brokerClient);
      case 'presets_set':
        return await handlePresetsSet(args, brokerClient);
      case 'presets_delete':
        return await handlePresetsDelete(args, brokerClient);
      case 'members_add':
        return await handleMembersAdd(args, brokerClient);
      case 'members_update':
        return await handleMembersUpdate(args, brokerClient);
      case 'members_remove':
        return await handleMembersRemove(args, brokerClient);
      case 'tool_sources_list':
        return await handleToolSourcesList(brokerClient, instructions);
      case 'tool_sources_view':
        return await handleToolSourcesView(args, brokerClient, instructions);
      case 'tool_sources_create':
        return await handleToolSourcesCreate(args, brokerClient, instructions);
      case 'tool_sources_update':
        return await handleToolSourcesUpdate(args, brokerClient, instructions);
      case 'tool_sources_delete':
        return await handleToolSourcesDelete(args, brokerClient, instructions);
      case 'tool_sources_define_tool':
        return await handleToolSourcesDefineTool(args, brokerClient, instructions);
      case 'tool_sources_delete_tool':
        return await handleToolSourcesDeleteTool(args, brokerClient, instructions);
      case 'tool_sources_bindings':
        return await handleToolSourcesBindings(args, brokerClient, instructions);
      case 'tool_sources_set_credential':
        return await handleToolSourcesSetCredential(args, brokerClient, instructions);
      case 'tool_sources_delete_credential':
        return await handleToolSourcesDeleteCredential(args, brokerClient, instructions);
      case 'tool_sources_refresh':
        return await handleToolSourcesRefresh(args, brokerClient, instructions);
      case 'secrets_list':
        return await handleSecretsList(brokerClient, instructions);
      case 'secrets_view':
        return await handleSecretsView(args, brokerClient, instructions);
      case 'secrets_create':
        return await handleSecretsCreate(args, brokerClient, instructions);
      case 'secrets_update':
        return await handleSecretsUpdate(args, brokerClient, instructions);
      case 'secrets_delete':
        return await handleSecretsDelete(args, brokerClient, instructions);
      case 'secrets_set_value':
        return await handleSecretsSetValue(args, brokerClient, instructions);
      case 'secrets_delete_value':
        return await handleSecretsDeleteValue(args, brokerClient, instructions);
      case 'secrets_bindings':
        return await handleSecretsBindings(args, brokerClient, instructions);
      case 'variables_list':
        return await handleVariablesList(brokerClient, instructions);
      case 'variables_view':
        return await handleVariablesView(args, brokerClient, instructions);
      case 'variables_create':
        return await handleVariablesCreate(args, brokerClient, instructions);
      case 'variables_update':
        return await handleVariablesUpdate(args, brokerClient, instructions);
      case 'variables_delete':
        return await handleVariablesDelete(args, brokerClient, instructions);
      case 'variables_set_value':
        return await handleVariablesSetValue(args, brokerClient, instructions);
      case 'variables_delete_value':
        return await handleVariablesDeleteValue(args, brokerClient, instructions);
      case 'variables_bindings':
        return await handleVariablesBindings(args, brokerClient, instructions);
      case 'notifications_list':
        return await handleNotificationsList(brokerClient, instructions);
      case 'notifications_view':
        return await handleNotificationsView(args, brokerClient, instructions);
      case 'notifications_create':
        return await handleNotificationsCreate(args, brokerClient, instructions);
      case 'notifications_update':
        return await handleNotificationsUpdate(args, brokerClient, instructions);
      case 'notifications_delete':
        return await handleNotificationsDelete(args, brokerClient, instructions);
      case 'notifications_set_secret':
        return await handleNotificationsSetSecret(args, brokerClient, instructions);
      case 'notifications_delete_secret':
        return await handleNotificationsDeleteSecret(args, brokerClient, instructions);
      case 'notifications_deliveries':
        return await handleNotificationsDeliveries(args, brokerClient, instructions);
      case 'notifications_replay':
        return await handleNotificationsReplay(args, brokerClient, instructions);
      case 'notifications_profiles':
        return await handleNotificationsProfiles(brokerClient, instructions);
      case 'notifications_profile_create':
        return await handleNotificationsProfileCreate(args, brokerClient, instructions);
      case 'notifications_profile_delete':
        return await handleNotificationsProfileDelete(args, brokerClient, instructions);
      case 'notifications_profile_set_secret':
        return await handleNotificationsProfileSetSecret(args, brokerClient, instructions);
      default: {
        // Namespaced external tool (`<source>__<name>`)? Dispatch to
        // the broker's invoke endpoint — the result is already an
        // MCP-shaped CallToolResult and passes through verbatim.
        const external = await handleExternalToolCall(name, rawArgs, brokerClient, externalTools);
        if (external !== null) return external;
        return errorResult(`unknown tool: ${name}`);
      }
    }
  } catch (err) {
    const ce = err as ClientError;
    if (ce?.name === 'ClientError') {
      return errorResult(`broker error ${ce.status}: ${ce.body || ce.message}`);
    }
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

async function handleRoster(
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const roster = await brokerClient.roster();
  const presenceByName = new Map(roster.connected.map((presence) => [presence.name, presence]));
  const activityWindow =
    roster.activityWindowMs === undefined
      ? 'within an unknown window'
      : `within last ${roster.activityWindowMs / 1_000}s`;
  if (roster.teammates.length === 0) {
    return textResult('team roster: (no slots defined)');
  }
  const lines = roster.teammates.map((t) => {
    const presence = presenceByName.get(t.name);
    const conn = presence?.connected ?? 0;
    const self = t.name === instructions.name ? ' (you)' : '';
    const state = conn > 0 ? `connected=${conn}` : 'offline';
    const activity =
      presence?.activity === 'working' || presence?.activity === 'blocked'
        ? `reported ${presence.activity} ${activityWindow}`
        : `no report ${activityWindow} (idle, lapsed, or never reported)`;
    const auth = t.permissions.includes('members.manage')
      ? ' [admin]'
      : t.permissions.includes('spine.author')
        ? ' [operator]'
        : '';
    return `- ${t.name}${self} [${t.role.title}]${auth} ${state}; activity=${activity}`;
  });
  return textResult(`team ${instructions.team.name} roster:\n${lines.join('\n')}`);
}

async function handleBroadcast(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const body = typeof args.body === 'string' ? args.body : '';
  if (!body) return errorResult('broadcast: `body` is required');
  const levelResult = parseLevel(args.level);
  if (levelResult.error) return errorResult(`broadcast: ${levelResult.error}`);
  const attachments = await resolveAttachmentPaths(args.attachments, brokerClient);
  if ('error' in attachments) return errorResult(`broadcast: ${attachments.error}`);
  const result = await brokerClient.push({
    body,
    level: levelResult.level,
    ...(attachments.list.length > 0 ? { attachments: attachments.list } : {}),
  });
  const attachmentSummary =
    attachments.list.length > 0 ? ` attachments=${attachments.list.length}` : '';
  return textResult(
    `broadcast delivered: live=${result.delivery.live} ` +
      `targets=${result.delivery.targets} msg=${result.message.id}${attachmentSummary}`,
  );
}

async function handleSend(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const to = typeof args.to === 'string' ? args.to : '';
  const body = typeof args.body === 'string' ? args.body : '';
  if (!to || !body) return errorResult('send: `to` and `body` are required');
  const levelResult = parseLevel(args.level);
  if (levelResult.error) return errorResult(`send: ${levelResult.error}`);
  const attachments = await resolveAttachmentPaths(args.attachments, brokerClient);
  if ('error' in attachments) return errorResult(`send: ${attachments.error}`);
  const result = await brokerClient.push({
    to,
    body,
    level: levelResult.level,
    ...(attachments.list.length > 0 ? { attachments: attachments.list } : {}),
  });
  const attachmentSummary =
    attachments.list.length > 0 ? ` attachments=${attachments.list.length}` : '';
  return textResult(
    `delivered to ${to}: live=${result.delivery.live} ` +
      `targets=${result.delivery.targets} msg=${result.message.id}${attachmentSummary}`,
  );
}

/**
 * Turn the agent's string[] of paths into the full Attachment
 * objects the broker expects. Resolves each via `fsStat`, reports
 * the first failure by path so the agent can fix the offender.
 */
async function resolveAttachmentPaths(
  raw: unknown,
  brokerClient: BrokerClient,
): Promise<{ list: Attachment[] } | { error: string }> {
  if (raw === undefined || raw === null) return { list: [] };
  if (!Array.isArray(raw)) {
    return { error: '`attachments` must be an array of paths' };
  }
  const list: Attachment[] = [];
  for (const p of raw) {
    if (typeof p !== 'string' || p.length === 0) {
      return { error: '`attachments` entries must be non-empty path strings' };
    }
    try {
      const entry = await brokerClient.fsStat(p);
      if (!entry) return { error: `attachment not found: ${p}` };
      if (entry.kind !== 'file') return { error: `attachment is a directory: ${p}` };
      if (entry.size === null || entry.mimeType === null) {
        return { error: `attachment is corrupt: ${p}` };
      }
      list.push({
        path: entry.path,
        name: entry.name,
        size: entry.size,
        mimeType: entry.mimeType,
      });
    } catch (err) {
      return { error: `attachment lookup failed for ${p}: ${String(err)}` };
    }
  }
  return { list };
}

async function handleRecent(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const withOther = typeof args.with === 'string' ? args.with : undefined;
  const channelSlug = typeof args.channel === 'string' ? args.channel : undefined;
  if (withOther && channelSlug) {
    return errorResult('recent: pass `with` OR `channel`, not both');
  }
  const limitRaw = typeof args.limit === 'number' ? args.limit : DEFAULT_RECENT_LIMIT;
  const limit = Math.min(Math.max(Math.floor(limitRaw), 1), MAX_RECENT_LIMIT);

  // Channel scoping needs slug → id resolution. The history endpoint
  // matches on the immutable channel id (slugs are renameable and
  // existing messages keep referencing the original id).
  let channelId: string | undefined;
  if (channelSlug) {
    try {
      const ch = await brokerClient.getChannel(channelSlug);
      channelId = ch.channel.id;
    } catch (err) {
      const ce = err as ClientError;
      if (ce?.name === 'ClientError' && ce.status === 404) {
        return errorResult(
          `recent: no channel '${channelSlug}'. Use \`channels_list\` to see available channels.`,
        );
      }
      throw err;
    }
  }

  const messages = await brokerClient.history({
    ...(withOther ? { with: withOther } : {}),
    ...(channelId ? { channel: channelId } : {}),
    limit,
  });

  if (messages.length === 0) {
    const scope = withOther
      ? `DM with ${withOther}`
      : channelSlug
        ? `channel #${channelSlug}`
        : `${instructions.team.name} team channel`;
    return textResult(`recent: no messages in ${scope}`);
  }

  const header = withOther
    ? `recent DMs with ${withOther} (${messages.length}):`
    : channelSlug
      ? `recent #${channelSlug} (${messages.length}):`
      : `recent ${instructions.team.name} team chat (${messages.length}):`;
  const lines = messages.map((m) => formatRecentLine(m));
  return textResult(`${header}\n${lines.join('\n')}`);
}

async function handleChannelsList(
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const channels = await brokerClient.listChannels();
  if (channels.length === 0) {
    return textResult(`team ${instructions.team.name}: no channels defined.`);
  }
  // Show joined channels first, then any visible non-joined ones, so
  // the agent's "what can I post into right now" is at the top.
  const joined = channels.filter((c) => c.joined);
  const others = channels.filter((c) => !c.joined);
  const fmt = (c: (typeof channels)[number]): string => {
    const role = c.myRole ? ` [${c.myRole}]` : '';
    const archived = c.archivedAt !== null ? ' (archived)' : '';
    return `- #${c.slug}${role}${archived}  members=${c.memberCount}`;
  };
  const sections: string[] = [];
  if (joined.length > 0) {
    sections.push(`channels you belong to (${joined.length}):\n${joined.map(fmt).join('\n')}`);
  }
  if (others.length > 0) {
    sections.push(
      `other visible channels (${others.length}, post requires joining first):\n` +
        others.map(fmt).join('\n'),
    );
  }
  return textResult(sections.join('\n\n'));
}

async function handleChannelsPost(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const slug = typeof args.channel === 'string' ? args.channel : '';
  const body = typeof args.body === 'string' ? args.body : '';
  if (!slug) return errorResult('channels_post: `channel` is required (the channel slug)');
  if (!body) return errorResult('channels_post: `body` is required');
  const levelResult = parseLevel(args.level);
  if (levelResult.error) return errorResult(`channels_post: ${levelResult.error}`);
  const attachments = await resolveAttachmentPaths(args.attachments, brokerClient);
  if ('error' in attachments) return errorResult(`channels_post: ${attachments.error}`);

  // Resolve slug → id. The push routing on the server side keys on
  // `data.thread = 'chan:<id>'`, not slug, so renames don't break
  // mid-conversation references. The server also enforces that the
  // sender is a member of the channel; we surface a friendlier error
  // up front by checking the client-side membership flag, but the
  // 403 is the source of truth.
  let channelId: string;
  try {
    const ch = await brokerClient.getChannel(slug);
    channelId = ch.channel.id;
    if (!ch.channel.joined) {
      return errorResult(
        `channels_post: you are not a member of #${slug}. Ask a director to add you, or use \`broadcast\` for the general channel.`,
      );
    }
  } catch (err) {
    const ce = err as ClientError;
    if (ce?.name === 'ClientError' && ce.status === 404) {
      return errorResult(
        `channels_post: no channel '${slug}'. Use \`channels_list\` to see available channels.`,
      );
    }
    throw err;
  }

  const result = await brokerClient.push({
    body,
    level: levelResult.level,
    data: { thread: `chan:${channelId}` },
    ...(attachments.list.length > 0 ? { attachments: attachments.list } : {}),
  });
  const attachmentSummary =
    attachments.list.length > 0 ? ` attachments=${attachments.list.length}` : '';
  return textResult(
    `posted to #${slug}: live=${result.delivery.live} ` +
      `targets=${result.delivery.targets} msg=${result.message.id}${attachmentSummary}`,
  );
}

async function handleProcessDocumentGet(brokerClient: BrokerClient): Promise<CallToolResult> {
  const doc = await brokerClient.getProcessDocument();
  if (doc === null) {
    return textResult(
      'no process document has been set for this team. That is a real state, not an error — ' +
        'nobody has written one yet.',
    );
  }
  return textResult(
    `process document v${doc.version}, last edited by ${doc.updatedBy}. ` +
      `Created by ${doc.createdBy}.\n\n${doc.text}`,
  );
}

async function handleProcessDocumentHistory(brokerClient: BrokerClient): Promise<CallToolResult> {
  const edits = await brokerClient.processDocumentHistory();
  if (edits.length === 0) {
    return textResult('no process document has been set, so there is no history.');
  }
  const lines = edits.map((e) => {
    const binding =
      e.disposition === 'correction'
        ? 'retroactive — the prior text was never validly binding'
        : 'forward-only — work already underway finished under the prior text';
    // The FULL prior text, delimited. Rendering a character count
    // here was a real defect: this tool IS the fetch — there is no
    // fetch-by-version — so a count told the one member who holds
    // `process.manage` that the text exists somewhere they cannot
    // reach. The description promises the full text; a renderer is a
    // compression step and this is where content gets silently
    // dropped.
    const prior =
      e.previous.text === undefined
        ? '      (created — no prior text)'
        : [
            `      --- text before v${e.version} (${e.previous.text.length} chars) ---`,
            e.previous.text,
            `      --- end text before v${e.version} ---`,
          ].join('\n');
    return `  v${e.version} by ${e.actor} — ${e.disposition} (${binding})\n      reason: ${e.reason}\n${prior}`;
  });
  return textResult(
    [`process document — ${edits.length} edit(s), oldest first:`, ...lines].join('\n'),
  );
}

async function handleProcessDocumentWrite(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const text = typeof args.text === 'string' ? args.text : '';
  if (!text) {
    return errorResult(
      'process_document_write: `text` is required, and it REPLACES the whole document — ' +
        'read the current one with `process_document_get` first',
    );
  }
  const reason = typeof args.reason === 'string' ? args.reason : '';
  if (!reason) return errorResult('process_document_write: `reason` is required');
  if (args.disposition !== 'correction' && args.disposition !== 'scope_change') {
    return errorResult(
      'process_document_write: `disposition` must be "correction" (retroactive) or ' +
        '"scope_change" (forward-only) — the same field and meaning as `contract_amend`',
    );
  }
  const { document, edit } = await brokerClient.writeProcessDocument({
    text,
    reason,
    disposition: args.disposition,
  });
  const binding =
    edit.disposition === 'correction'
      ? 'retroactive — work was never validly held to the prior text'
      : 'forward-only — work already underway finishes under the prior text';
  const created = edit.version === 1;
  return textResult(
    `${created ? 'created' : 'updated'} the process document at v${document.version} ` +
      `(${edit.disposition}: ${binding}). ` +
      `${created ? 'History begins here.' : 'The prior text is retained and retrievable via `process_document_history`.'} ` +
      'Every member receives it in their injected context at their NEXT runner start — ' +
      'a teammate already running has not seen it. No broadcast is needed and none was sent.',
  );
}

// ─── Spine ────────────────────────────────────────────────────────────
//
// One dispatcher for the whole surface, and the reason is the refusals.
// Every spine refusal carries a `detail` the caller can act on without
// a second call — the events they missed, the criteria they do not
// cover, the ask they have not had answered — and rendering that is one
// job, done once, rather than fourteen chances to forget it.

/**
 * An event, rendered whole.
 *
 * CAPTIONS THEN BODY, and the body as JSON on purpose. This renderer is
 * what a member reads when a refusal hands back what they missed, and a
 * prose renderer makes a default-value decision at every field — which
 * is exactly where one fact becomes indistinguishable from another. The
 * captions are named because they are what makes the event evidence;
 * the body is dumped because dropping a field of it is not a formatting
 * choice, it is data loss at the one moment the caller cannot go and
 * look.
 */
function renderSpineEvent(event: SpineEvent): string {
  const rev = event.revision;
  const lines = [
    `  #${event.seq} ${event.kind} ${event.id} — by ${event.actor} at ${event.at}` +
      (event.authoredBy !== null ? ` (recipe authored by ${event.authoredBy})` : ''),
    `      class: ${event.class}` +
      (event.contract !== null ? `  contract: ${event.contract}` : '') +
      (event.stateRev !== null ? `  state_rev: ${event.stateRev}` : '') +
      (event.provenance !== 'native' ? `  provenance: ${event.provenance}` : ''),
  ];
  if (event.subject !== null) lines.push(`      subject: ${event.subject}`);
  if (rev !== null) {
    // WHOLE. "met at rev_01H…" is a claim a member cannot check, and
    // this is the payload with no second call available to resolve it.
    lines.push(`      revision: ${rev.value} (${rev.how}, from ${rev.source}, at ${rev.at})`);
  }
  if (event.cites.length > 0) lines.push(`      cites: ${event.cites.join(', ')}`);
  if (event.staplesTo !== null) lines.push(`      staples to: ${event.staplesTo}`);
  if (event.opId !== null) lines.push(`      op_id: ${event.opId}`);
  lines.push(
    '      body:',
    ...JSON.stringify(event.body, null, 2)
      .split('\n')
      .map((l) => `        ${l}`),
  );
  return lines.join('\n');
}

/** Every intervening event, in full. No cap, ever — the delta IS the re-injection. */
function renderInterveningEvents(events: SpineEvent[], contract: string): string {
  const rendered = events.map(renderSpineEvent).join('\n');
  return (
    `\n\nThe ${events.length} authoritative event(s) that landed on ${contract} while you were ` +
    `away, in full — this refusal is your re-brief, so read them here rather than fetching ` +
    `them again:\n${rendered}`
  );
}

/** An ask, rendered with every field that makes it answerable. */
function renderSpineAsk(ask: SpineAsk): string {
  return [
    `  ${ask.id} — ${ask.state}, raised by ${ask.asker}, awaiting ${ask.authority}`,
    `      on: ${ask.subject ?? (ask.contract !== null ? `contract ${ask.contract}` : '(no subject)')}`,
    `      question: ${ask.question}`,
    `      context: ${ask.context}`,
    `      unblocks: ${ask.unblocks}`,
  ].join('\n');
}

interface SpineRefusalBody {
  error?: string;
  code?: string;
  detail?: unknown;
  /** Zod issues from a route-level schema refusal. */
  details?: { path?: (string | number)[]; message?: string }[];
}

/**
 * Turn a spine refusal into something an agent can act on, complete.
 *
 * Returns null when the error is not a spine refusal, so the caller
 * falls through to the generic handler rather than swallowing an
 * unrelated failure as if it were understood.
 *
 * NOTHING HERE IS CAPPED. §5 makes the refusal the recovery channel: it
 * arrives at exactly the moment staleness would have caused harm, on
 * any runner, forever. Truncating it to keep a tool result tidy trades
 * the guarantee for the appearance of one.
 */
function renderSpineRefusal(err: unknown): string | null {
  // A payload the SDK refused before it was ever sent. Rendering the
  // issues is the point: the schema is the law, so "which law did I
  // break" has to be answerable from the refusal.
  const issues = (err as { issues?: { path?: (string | number)[]; message?: string }[] }).issues;
  if (Array.isArray(issues)) {
    return [
      'the annex refused this payload before sending it — the schema is the law here, and ' +
        'these are the fields it names:',
      ...issues.map((i) => `  ${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? 'invalid'}`),
    ].join('\n');
  }

  const ce = err as ClientError;
  if (ce?.name !== 'ClientError') return null;
  let body: SpineRefusalBody;
  try {
    body = JSON.parse(ce.body) as SpineRefusalBody;
  } catch {
    return `the broker refused this (HTTP ${ce.status}): ${ce.body || ce.message}`;
  }
  const message = body.error ?? ce.message;
  if (body.code === undefined) {
    if (Array.isArray(body.details)) {
      return [
        `${message} (HTTP ${ce.status}) — the fields the schema names:`,
        ...body.details.map(
          (i) => `  ${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? 'invalid'}`,
        ),
      ].join('\n');
    }
    return `${message} (HTTP ${ce.status})`;
  }

  switch (body.code) {
    case 'stale_state_rev': {
      const detail = body.detail as SpineStaleStateRevDetail;
      return (
        message +
        renderInterveningEvents(detail.intervening, detail.contract) +
        `\n\nRetry with expected_state_rev=${detail.currentStateRev} once you have read them, and ` +
        'only if the act still makes sense.'
      );
    }
    case 'invalid_transition': {
      const detail = body.detail as SpineTerminalDetail | undefined;
      if (detail?.intervening === undefined) return message;
      return (
        message +
        (detail.intervening.length > 0
          ? renderInterveningEvents(detail.intervening, detail.contract)
          : '')
      );
    }
    case 'coverage_gap': {
      const detail = body.detail as SpineCoverageGapDetail;
      return [
        message,
        '',
        detail.revision === null
          ? 'No revision was named, so nothing can be covered:'
          : `Uncovered at ${detail.revision.value} (${detail.revision.how}, from ` +
            `${detail.revision.source}):`,
        // Every one of them. This list is the shortest description of
        // what is left to do, and a truncated one sends a member back
        // to guess the rest.
        ...detail.missing.map((m) => `  ${m.criterion}: ${m.text}\n      why: ${m.why}`),
      ].join('\n');
    }
    case 'citation_required': {
      const detail = body.detail as SpineCitationRequiredDetail;
      return [
        message,
        '',
        `The ask${detail.asks.length === 1 ? '' : 's'} holding this up, in full:`,
        ...detail.asks.map(renderSpineAsk),
        '',
        `Scope searched: ${detail.scope.join(' ⊃ ')} (your act was on ${detail.subject}).`,
        'Get the ruling — that resolves the ask and releases you, with nothing further to ' +
          'cite — or `proceed` past the ask and say why. Either is a real answer; acting as ' +
          'though it were already answered is not.',
      ].join('\n');
    }
    case 'idempotency_conflict': {
      const detail = body.detail as SpineIdempotencyConflictDetail;
      return (
        `${message}\n\nop_id ${detail.opId} already resolved to event ${detail.originalEvent}. ` +
        'Read that event before retrying: either your write already landed, or you are about ' +
        'to overwrite the meaning of somebody else’s.'
      );
    }
    default:
      return `${message} (${body.code})`;
  }
}

/**
 * Build a revision caption, defaulting its subject to the contract's.
 *
 * The value, `how` and `source` are never defaulted — those are the
 * three fields that make a revision evidence rather than a number, and
 * inventing any of them would be the system taking a photograph. The
 * SUBJECT is different: it is bookkeeping the contract already knows,
 * and making an agent restate it is how it gets restated wrongly.
 */
async function spineRevisionInput(
  raw: unknown,
  brokerClient: BrokerClient,
  contract: string | undefined,
): Promise<SpineRevisionInput | null> {
  if (raw === null || typeof raw !== 'object') return null;
  const rev = raw as Record<string, unknown>;
  const value = typeof rev.value === 'string' ? rev.value : '';
  const how = rev.how === 'observed' || rev.how === 'asserted' ? rev.how : null;
  const source = typeof rev.source === 'string' ? rev.source : '';
  if (!value || how === null || !source) return null;
  let subject = typeof rev.subject === 'string' ? rev.subject : '';
  if (!subject) {
    if (contract === undefined) return null;
    subject = (await brokerClient.spineContract(contract)).subject;
  }
  return { subject, value, how, source };
}

const SPINE_REVISION_HELP =
  '`revision` must carry `value`, `how` ("observed" — you looked — or "asserted" — you named ' +
  'it by hand) and `source` (who or what produced it). A bare value is not a revision: it is a ' +
  'claim with nobody standing behind it.';

/**
 * The kind → principal-prose-field map `promote` synthesises through.
 *
 * ONE FIELD PER KIND, chosen as the one that carries the argument
 * rather than the label: a post that turns out to be a ruling becomes
 * its `reasoning`, not its `decision`, because the reasoning is what
 * the member actually wrote and the decision is the one-line summary
 * they still have to state. Two kinds are deliberately absent —
 * promoting a discussion into a discussion is a no-op, and promoting
 * one into a promotion is a record of a record.
 */
const SPINE_PROMOTION_TEXT_FIELD: Partial<Record<SpineEventKind, string>> = {
  observation: 'output',
  testimony: 'account',
  specification: 'title',
  amendment: 'changes',
  attempt: 'summary',
  criterion_verdict: 'evidence',
  ruling: 'reasoning',
  ask: 'question',
  ask_action: 'reason',
  proceeding: 'reason',
  lifecycle: 'reason',
  correction: 'correction',
};

/**
 * Kinds whose body REQUIRES a contract, which the origin post can
 * supply. Only the required ones: inheriting a contract onto a kind
 * where it is optional would silently make the write state-changing and
 * demand a precondition the caller had no reason to send.
 */
const SPINE_PROMOTION_INHERITS_CONTRACT: readonly SpineEventKind[] = [
  'amendment',
  'attempt',
  'criterion_verdict',
  'lifecycle',
];

/**
 * The one cast in the surface, and it is deliberate.
 *
 * `AppendSpineEventRequest` is fourteen variants so that every call
 * site inside the server is checked by the compiler. This call site is
 * a tool handler assembling a body out of a JSON object an agent sent,
 * so there is nothing for the compiler to check against — the check
 * happens where it can: the SDK client parses the payload against the
 * schema BEFORE sending, and `renderSpineRefusal` renders the issues.
 */
function appendSpine(
  brokerClient: BrokerClient,
  payload: Record<string, unknown>,
): Promise<AppendSpineEventResponse> {
  return brokerClient.appendSpineEvent(payload as unknown as AppendSpineEventRequest);
}

/** `op_id` is optional on the tool and required by the annex; fill it in when omitted. */
function spineOpId(args: Record<string, unknown>): string {
  return typeof args.op_id === 'string' && args.op_id.length > 0
    ? args.op_id
    : `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function spineString(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? (args[key] as string) : '';
}

function spineStateRev(args: Record<string, unknown>): number | undefined {
  return typeof args.expected_state_rev === 'number' ? args.expected_state_rev : undefined;
}

function spineOptional(args: Record<string, unknown>, key: string): Record<string, string> {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? { [key]: value } : {};
}

/** What a write reports back: the event, and where the contract now stands. */
function renderAppendResult(result: AppendSpineEventResponse, what: string): CallToolResult {
  const { event, contract } = result;
  const replayed = result.replayed
    ? ' (REPLAY — this op_id had already landed, so nothing was appended a second time)'
    : '';
  const where =
    contract === null
      ? ''
      : `\ncontract ${contract.id} is now ${contract.state} at state_rev ${contract.stateRev}` +
        ` — pass that as expected_state_rev on your next write to it.` +
        (contract.stale && contract.head !== null
          ? `\nSTALE: it is bound to ${contract.revision?.value ?? '(none)'} and the subject has ` +
            `since been observed at ${contract.head.value} (${contract.head.source}, ` +
            `${contract.head.at}).`
          : '');
  return textResult(`${what} as ${event.id} (#${event.seq})${replayed}.${where}`);
}

async function handleSpineTool(
  name: string,
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  try {
    return await dispatchSpineTool(name, args, brokerClient, instructions);
  } catch (err) {
    const rendered = renderSpineRefusal(err);
    // Not a spine refusal — rethrow so the outer handler reports it
    // rather than this one guessing at what it was.
    if (rendered === null) throw err;
    return errorResult(rendered);
  }
}

async function dispatchSpineTool(
  name: string,
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  switch (name) {
    case 'orient':
      return await handleOrient(brokerClient, instructions);
    case 'annex_read':
      return await handleAnnexRead(args, brokerClient);
    case 'contract_author':
      return await handleContractAuthor(args, brokerClient);
    case 'contract_amend':
      return await handleContractAmend(args, brokerClient);
    case 'attempt_post':
      return await handleAttemptPost(args, brokerClient);
    case 'verdict_post':
      return await handleVerdictPost(args, brokerClient);
    case 'state_set':
      return await handleStateSet(args, brokerClient);
    case 'contract_complete':
      return await handleContractComplete(args, brokerClient);
    case 'ask_author':
      return await handleAskAuthor(args, brokerClient);
    case 'ruling_post':
      return await handleRulingPost(args, brokerClient);
    case 'proceed':
      return await handleProceed(args, brokerClient);
    case 'observe':
      return await handleObserve(args, brokerClient);
    case 'discuss':
      return await handleDiscuss(args, brokerClient);
    case 'subscribe':
      return await handleSubscribe(args, brokerClient);
    case 'focus':
      return await handleFocus(args, brokerClient);
    case 'focus_set':
      return await handleFocusSet(brokerClient);
    default:
      return await handlePromote(args, brokerClient);
  }
}

/**
 * The recovery call, rendered.
 *
 * Everything the pack carries reaches the page. This is what a member
 * reads when they have nothing else, so a renderer that summarised
 * would be deciding on their behalf which of their obligations they
 * still remember.
 *
 * EXPORTED, and composing NOTHING. The runner injects this same string
 * on its recovery triggers (fresh bridge, declared dump), and it must
 * be the same string the tool produces or a member's recovery would
 * depend on which door they came through. Everything in it comes off
 * the server's pack verbatim; the only thing this function decides is
 * where the line breaks go.
 */
export function renderOrientPack(pack: OrientPack, memberName: string): string {
  const lines = [`orient for ${pack.member} — as of ${pack.at}, annex cursor ${pack.cursor}.`];
  if (pack.contracts.length === 0) {
    lines.push('', 'No contracts bind you right now. That is a real state, not an empty read.');
  }
  for (const c of pack.contracts) {
    lines.push(
      '',
      `${c.contract} [${c.state}, state_rev ${c.stateRev}]${c.inFocus ? ' [in focus]' : ''} ${c.title}`,
      `  you are: ${c.bindings.join(' + ')}`,
      `  subject: ${c.subject.id} (${c.subject.type}${c.subject.parent !== null ? `, inside ${c.subject.parent}` : ''})`,
      c.revision === null
        ? '  revision: none bound yet'
        : `  revision: ${c.revision.value} (${c.revision.how}, from ${c.revision.source}, at ${c.revision.at})`,
    );
    if (c.stale && c.head !== null) {
      lines.push(
        `  STALE: the subject has since been observed at ${c.head.value} ` +
          `(${c.head.source}, ${c.head.at}). Reported, not repaired — decide what it means.`,
      );
    }
    lines.push('  criteria:');
    for (const crit of c.criteria) {
      const decision = crit.decision ?? 'no verdict yet';
      const at =
        crit.revision === null
          ? ''
          : ` at ${crit.revision.value}${crit.atBoundRevision ? '' : ' — NOT the revision this contract is bound to'}`;
      lines.push(
        `    ${crit.criterion}: ${decision}${at}` +
          (crit.event !== null ? ` [${crit.event}]` : '') +
          (crit.waivedBy !== null ? ` WAIVED by ruling ${crit.waivedBy}` : ''),
        `        ${crit.text}`,
      );
    }
    if (c.rulings.length > 0) {
      lines.push('  rulings that bind this contract:');
      for (const ruling of c.rulings) lines.push(renderSpineEvent(ruling));
    }
  }
  if (pack.asksForMe.length > 0) {
    lines.push('', `asks awaiting YOUR ruling (${pack.asksForMe.length}):`);
    for (const ask of pack.asksForMe) lines.push(renderSpineAsk(ask));
    lines.push('  Answer with `ruling_post`, or decline / redirect / defer.');
  }
  if (pack.myOpenAsks.length > 0) {
    lines.push('', `your own open asks (${pack.myOpenAsks.length}) — these bind YOU:`);
    for (const ask of pack.myOpenAsks) lines.push(renderSpineAsk(ask));
    lines.push(
      '  Until each resolves you cannot make state-changing acts on its subject without ' +
        'citing a ruling or recording a `proceed`.',
    );
  }
  lines.push(
    '',
    `Everything else since cursor ${pack.cursor}: \`annex_read since_seq=${pack.cursor}\`. ` +
      `You are ${memberName}.`,
  );
  return lines.join('\n');
}

async function handleOrient(
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  return textResult(renderOrientPack(await brokerClient.spineOrient(), instructions.name));
}

async function handleAnnexRead(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const page = await brokerClient.spineEvents({
    ...(typeof args.since_seq === 'number' ? { since_seq: args.since_seq } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    ...(typeof args.kind === 'string' ? { kind: args.kind as SpineEventKind } : {}),
    ...(typeof args.subject === 'string' ? { subject: args.subject } : {}),
    ...(typeof args.contract === 'string' ? { contract: args.contract } : {}),
    ...(typeof args.actor === 'string' ? { actor: args.actor } : {}),
  });
  if (page.events.length === 0) {
    return textResult(
      `no events matched. The annex head is at ${page.headSeq}, so this is "nothing here", ` +
        'not "nothing exists".',
    );
  }
  const tail =
    page.nextCursor === null
      ? `\n\nThis page reached the head (seq ${page.headSeq}). There is nothing after it yet.`
      : `\n\nMore to read: \`annex_read since_seq=${page.nextCursor}\` (head is at ${page.headSeq}).`;
  return textResult(
    `${page.events.length} event(s), oldest first:\n${page.events.map(renderSpineEvent).join('\n')}${tail}`,
  );
}

async function handleContractAuthor(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const subject = spineString(args, 'subject');
  const title = spineString(args, 'title');
  const assignee = spineString(args, 'assignee');
  if (!subject)
    return errorResult(
      'contract_author: `subject` is required — a contract is about a part of the world.',
    );
  if (!title) return errorResult('contract_author: `title` is required');
  if (!assignee)
    return errorResult('contract_author: `assignee` is required — somebody has to travel to it.');
  const criteria = Array.isArray(args.criteria) ? (args.criteria as unknown[]) : [];
  if (criteria.length === 0) {
    return errorResult(
      'contract_author: `criteria` is required and must not be empty. A contract with no ' +
        'criteria cannot be verified, completed, or argued with — it is a wish.',
    );
  }
  // Inline registration, per §4: member-referenced subjects are
  // registered explicitly, at first use or inline here. Idempotent on
  // an identical re-registration, refused on a conflicting one.
  const subjectType = spineString(args, 'subject_type');
  const subjectParent = spineString(args, 'subject_parent');
  if (subjectType) {
    await brokerClient.registerSpineSubject({
      id: subject,
      type: subjectType as SpineSubjectType,
      ...(subjectParent ? { parent: subjectParent } : {}),
    });
  }
  const result = await appendSpine(brokerClient, {
    kind: 'specification',
    subject,
    opId: spineOpId(args),
    body: {
      title,
      criteria,
      assignee,
      ...spineOptional(args, 'verifier'),
      ...spineOptional(args, 'authority'),
      ...(Array.isArray(args.constraints) ? { constraints: args.constraints } : {}),
    },
  });
  const verifier = spineString(args, 'verifier');
  return textResult(
    `authored contract ${result.event.id} at state_rev 1 on ${subject}: ${title}\n` +
      `criteria: ${(criteria as { id: string }[]).map((c) => c.id).join(', ')}\n` +
      `assignee ${assignee}` +
      (verifier ? `, verifier ${verifier}` : ', no verifier') +
      '\n' +
      (verifier
        ? `Completion will need verdicts from ${verifier} covering every criterion at one ` +
          'revision.'
        : 'With no verifier named, completion’s result will stand alone and the record will ' +
          'say so.'),
  );
}

async function handleContractAmend(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const contract = spineString(args, 'contract');
  if (!contract) return errorResult('contract_amend: `contract` is required');
  const changes = spineString(args, 'changes');
  const reason = spineString(args, 'reason');
  if (!changes) return errorResult('contract_amend: `changes` is required');
  if (!reason) return errorResult('contract_amend: `reason` is required');
  if (args.disposition !== 'correction' && args.disposition !== 'scope_change') {
    return errorResult(
      'contract_amend: `disposition` must be "correction" (retroactive — the prior text was ' +
        'never validly binding) or "scope_change" (forward-only — work already underway ' +
        'finishes under the prior text). If you cannot say which, you have not finished ' +
        'thinking about the amendment.',
    );
  }
  const stateRev = spineStateRev(args);
  if (stateRev === undefined) {
    return errorResult('contract_amend: `expected_state_rev` is required — read it from `orient`.');
  }
  const result = await appendSpine(brokerClient, {
    kind: 'amendment',
    opId: spineOpId(args),
    expectedStateRev: stateRev,
    ...(Array.isArray(args.cites) ? { cites: args.cites } : {}),
    body: {
      contract,
      changes,
      reason,
      disposition: args.disposition,
      ...spineOptional(args, 'title'),
      ...(Array.isArray(args.criteria) ? { criteria: args.criteria } : {}),
      ...(Array.isArray(args.constraints) ? { constraints: args.constraints } : {}),
      ...spineOptional(args, 'disclosure'),
    },
  });
  return renderAppendResult(
    result,
    `amended ${contract} to version ${result.contract?.version ?? '?'} (${String(args.disposition)})`,
  );
}

async function handleAttemptPost(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const contract = spineString(args, 'contract');
  const summary = spineString(args, 'summary');
  if (!contract) return errorResult('attempt_post: `contract` is required');
  if (!summary) return errorResult('attempt_post: `summary` is required');
  const stateRev = spineStateRev(args);
  if (stateRev === undefined) {
    return errorResult('attempt_post: `expected_state_rev` is required — read it from `orient`.');
  }
  const revision = await spineRevisionInput(args.revision, brokerClient, contract);
  if (revision === null) {
    return errorResult(
      `attempt_post: a complete \`revision\` is required — an attempt binds the contract to the ` +
        `point in the world you reached. ${SPINE_REVISION_HELP}`,
    );
  }
  const result = await appendSpine(brokerClient, {
    kind: 'attempt',
    opId: spineOpId(args),
    expectedStateRev: stateRev,
    revision,
    body: { contract, summary },
  });
  return renderAppendResult(result, `recorded an attempt at ${revision.value}`);
}

async function handleVerdictPost(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const contract = spineString(args, 'contract');
  const criterion = spineString(args, 'criterion');
  const evidence = spineString(args, 'evidence');
  if (!contract) return errorResult('verdict_post: `contract` is required');
  if (!criterion) return errorResult('verdict_post: `criterion` is required');
  if (args.decision !== 'met' && args.decision !== 'unmet' && args.decision !== 'cannot_verify') {
    return errorResult(
      'verdict_post: `decision` must be "met", "unmet" or "cannot_verify". `cannot_verify` is ' +
        'a real answer, not a failure to answer — use it rather than guessing.',
    );
  }
  if (!evidence) return errorResult('verdict_post: `evidence` is required — what did you look at?');
  const why = spineString(args, 'why');
  if (args.decision === 'cannot_verify' && !why) {
    return errorResult(
      'verdict_post: `why` is required on `cannot_verify`. A verdict that cannot say why it ' +
        'could not be reached is indistinguishable from silence, and the three ways out of it ' +
        '— amend the criterion, re-scope the verifier, waive it by ruling — each need a ' +
        'different one.',
    );
  }
  const stateRev = spineStateRev(args);
  if (stateRev === undefined) {
    return errorResult('verdict_post: `expected_state_rev` is required — read it from `orient`.');
  }
  const revision = await spineRevisionInput(args.revision, brokerClient, contract);
  if (revision === null) {
    return errorResult(
      `verdict_post: a complete \`revision\` is required — a verdict is true OF a revision or ` +
        `it is true of nothing. ${SPINE_REVISION_HELP}`,
    );
  }
  const result = await appendSpine(brokerClient, {
    kind: 'criterion_verdict',
    opId: spineOpId(args),
    expectedStateRev: stateRev,
    revision,
    body: {
      contract,
      criterion,
      decision: args.decision,
      evidence,
      ...(why ? { why } : {}),
    },
  });
  return renderAppendResult(
    result,
    `recorded ${String(args.decision)} on '${criterion}' at ${revision.value}`,
  );
}

async function handleStateSet(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const contract = spineString(args, 'contract');
  const state = spineString(args, 'state');
  if (!contract) return errorResult('state_set: `contract` is required');
  if (state === 'done') {
    return errorResult(
      'state_set: completion goes through `contract_complete`, which takes the result, the ' +
        'revision and the verdicts it stands on. That is where the evidence is checked; there ' +
        'is deliberately no second route to done that skips it.',
    );
  }
  if (!(SPINE_SETTABLE_STATES as readonly string[]).includes(state)) {
    return errorResult(
      `state_set: \`state\` must be one of: ${SPINE_SETTABLE_STATES.join(', ')} (got '${state}')`,
    );
  }
  const stateRev = spineStateRev(args);
  if (stateRev === undefined) {
    return errorResult('state_set: `expected_state_rev` is required — read it from `orient`.');
  }
  const result = await appendSpine(brokerClient, {
    kind: 'lifecycle',
    opId: spineOpId(args),
    expectedStateRev: stateRev,
    body: {
      contract,
      state,
      ...spineOptional(args, 'reason'),
      ...spineOptional(args, 'member'),
      ...spineOptional(args, 'event'),
      ...spineOptional(args, 'check'),
      ...(typeof args.preempted_by === 'string' && args.preempted_by.length > 0
        ? { preemptedBy: args.preempted_by }
        : {}),
      ...spineOptional(args, 'successor'),
    },
  });
  return renderAppendResult(result, `moved ${contract} to ${state}`);
}

async function handleContractComplete(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const contract = spineString(args, 'contract');
  const result_ = spineString(args, 'result');
  if (!contract) return errorResult('contract_complete: `contract` is required');
  if (!result_) {
    return errorResult(
      'contract_complete: `result` is required — say what was delivered and whether it ' +
        'satisfies the contract as written.',
    );
  }
  const stateRev = spineStateRev(args);
  if (stateRev === undefined) {
    return errorResult(
      'contract_complete: `expected_state_rev` is required — read it from `orient`.',
    );
  }
  const revision = await spineRevisionInput(args.revision, brokerClient, contract);
  if (revision === null) {
    return errorResult(
      `contract_complete: a complete \`revision\` is required — completion names the point in ` +
        `the world the verdicts were reached at. ${SPINE_REVISION_HELP}`,
    );
  }
  const cites = Array.isArray(args.cites) ? (args.cites as string[]) : [];
  const appended = await appendSpine(brokerClient, {
    kind: 'lifecycle',
    opId: spineOpId(args),
    expectedStateRev: stateRev,
    revision,
    cites,
    body: { contract, state: 'done', result: result_ },
  });
  return renderAppendResult(appended, `completed ${contract} at ${revision.value}`);
}

async function handleAskAuthor(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const authority = spineString(args, 'authority');
  const question = spineString(args, 'question');
  const context = spineString(args, 'context');
  const unblocks = spineString(args, 'unblocks');
  if (!authority) return errorResult('ask_author: `authority` is required — whose call is this?');
  if (!question) return errorResult('ask_author: `question` is required');
  if (!context) {
    return errorResult(
      'ask_author: `context` is required — what does the authority need in order to decide?',
    );
  }
  if (!unblocks) {
    return errorResult(
      'ask_author: `unblocks` is required — an ask nobody can price is an ask nobody answers.',
    );
  }
  const contract = spineString(args, 'contract');
  const stateRev = spineStateRev(args);
  if (contract && stateRev === undefined) {
    return errorResult(
      'ask_author: an ask naming a `contract` is a state-changing write on it and requires ' +
        '`expected_state_rev`.',
    );
  }
  const result = await appendSpine(brokerClient, {
    kind: 'ask',
    opId: spineOpId(args),
    ...spineOptional(args, 'subject'),
    ...(contract ? { expectedStateRev: stateRev } : {}),
    body: {
      authority,
      question,
      context,
      unblocks,
      ...(contract ? { contract } : {}),
      ...spineOptional(args, 'trigger'),
      ...spineOptional(args, 'check'),
    },
  });
  // WHAT IT BINDS DEPENDS ON WHETHER IT NAMES ANYTHING, and saying
  // otherwise was a false guarantee in the one place a member would
  // rely on it. The lock scopes on the ask's subject — or, failing
  // that, the subject of the contract it names — so an ask carrying
  // neither binds nothing at all. Telling every asker "THIS NOW BINDS
  // YOU" taught them a protection they did not have, which is worse
  // than teaching them nothing: a member who believes the annex is
  // holding the line stops holding it themselves.
  const scope = spineString(args, 'subject');
  const bound =
    scope || contract
      ? 'THIS NOW BINDS YOU: until it resolves, your state-changing acts on ' +
        `${scope || `contract ${contract}`} are refused unless you record a \`proceed\` past ` +
        'it. Getting the ruling releases you on its own — it resolves the ask.'
      : 'This ask has no `subject` and no `contract`, so it scopes nothing and does NOT bind ' +
        'your acts. Nothing will stop you acting as though it had been answered. Name a ' +
        'subject or a contract if it should hold you to waiting.';
  return textResult(
    `asked ${authority}: ${result.event.id} (#${result.event.seq}).\n` +
      'It is in their queue and stays there until they rule, decline, redirect or defer it.\n' +
      bound,
  );
}

async function handleRulingPost(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const ask = spineString(args, 'ask');
  const decision = spineString(args, 'decision');
  const reasoning = spineString(args, 'reasoning');
  if (!ask) return errorResult('ruling_post: `ask` is required (see `orient` → asks awaiting you)');
  if (!decision) return errorResult('ruling_post: `decision` is required');
  if (!reasoning) {
    return errorResult(
      'ruling_post: `reasoning` is required — it is what a member reads in six weeks instead ' +
        'of this conversation.',
    );
  }
  const contract = spineString(args, 'contract');
  const stateRev = spineStateRev(args);
  if (contract && stateRev === undefined) {
    return errorResult(
      'ruling_post: a ruling naming a `contract` is a state-changing write on it and requires ' +
        '`expected_state_rev`.',
    );
  }
  const result = await appendSpine(brokerClient, {
    kind: 'ruling',
    opId: spineOpId(args),
    ...(Array.isArray(args.cites) ? { cites: args.cites } : {}),
    ...(contract ? { expectedStateRev: stateRev } : {}),
    body: { ask, decision, reasoning, ...(contract ? { contract } : {}) },
  });
  return textResult(
    `ruled on ${ask} as ${result.event.id} (#${result.event.seq}). The ask is resolved and the ` +
      'asker is released; they cite this ruling when they act on it.',
  );
}

async function handleProceed(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const ask = spineString(args, 'ask');
  const subject = spineString(args, 'subject');
  const reason = spineString(args, 'reason');
  if (!ask) return errorResult('proceed: `ask` is required — which ask are you proceeding past?');
  if (!subject) return errorResult('proceed: `subject` is required');
  if (!reason) {
    return errorResult(
      'proceed: `reason` is required — it is what a reader gets later instead of an answer ' +
        'nobody gave.',
    );
  }
  const result = await appendSpine(brokerClient, {
    kind: 'proceeding',
    opId: spineOpId(args),
    subject,
    body: { ask, reason },
  });
  return textResult(
    `recorded a proceeding past ${ask} as ${result.event.id} (#${result.event.seq}). ` +
      `Your state-changing acts on ${subject} are covered until that ask resolves. This is on ` +
      'the record as your decision, not as an answer you were given.',
  );
}

async function handleObserve(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const subject = spineString(args, 'subject');
  const what = spineString(args, 'what');
  const output = spineString(args, 'output');
  if (!subject) return errorResult('observe: `subject` is required — what part of the world?');
  if (!what) return errorResult('observe: `what` is required — what did you do to see it?');
  if (!output) return errorResult('observe: `output` is required — what did you see?');
  const revision =
    args.revision === undefined
      ? null
      : await spineRevisionInput(args.revision, brokerClient, undefined);
  if (args.revision !== undefined && revision === null) {
    return errorResult(`observe: ${SPINE_REVISION_HELP}`);
  }
  const result = await appendSpine(brokerClient, {
    kind: 'observation',
    subject,
    ...(revision !== null ? { revision } : {}),
    body: { what, output },
  });
  return textResult(
    `recorded an observation of ${subject} as ${result.event.id} (#${result.event.seq})` +
      (revision !== null && revision.how === 'observed'
        ? `. It moves ${subject}'s head to ${revision.value}, so contracts bound to an earlier ` +
          'revision now render stale — reported, never repaired.'
        : '.'),
  );
}

async function handleDiscuss(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const body = spineString(args, 'body');
  if (!body) return errorResult('discuss: `body` is required');
  const result = await appendSpine(brokerClient, {
    kind: 'discussion',
    ...spineOptional(args, 'subject'),
    body: { body, ...spineOptional(args, 'contract') },
  });
  return textResult(
    `posted ${result.event.id} (#${result.event.seq}). Ambient: no counter moved, nothing was ` +
      'gated. If this turns out to have been a decision or an observation, `promote` it rather ' +
      'than retyping it.',
  );
}

/**
 * Reader-side subscription, set for the caller on one contract.
 *
 * The result restates what class 1 does regardless, because the
 * dangerous misreading of this tool is "I have turned this contract
 * off" — and a member who believes an ask to them can be silenced by
 * a level will stop trusting the queue.
 */
async function handleSubscribe(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const contract = spineString(args, 'contract');
  const level = spineString(args, 'level');
  if (!contract) return errorResult('subscribe: `contract` is required — read it from `orient`');
  if (level !== 'all' && level !== 'lifecycle' && level !== 'none') {
    return errorResult('subscribe: `level` must be one of all, lifecycle, none');
  }
  const config = await brokerClient.setSpineCuratorConfig({ subscription: { contract, level } });
  const set = config.subscriptions.find((s) => s.contract === contract);
  return textResult(
    `${contract} is now \`${set?.level ?? level}\` for you. ` +
      (level === 'none'
        ? 'You will hear nothing about it on the sweep. Anything that names you personally still ' +
          'reaches you — that is not a subscription and cannot be switched off.'
        : level === 'lifecycle'
          ? 'You will hear its state changes, batched, as an id and what changed.'
          : 'You will hear every authoritative event on it, batched per tick, as ids and what ' +
            'changed — never the contract text again.'),
  );
}

async function handleFocus(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const contract = spineString(args, 'contract');
  const reason = spineString(args, 'reason');
  if (!contract) return errorResult('focus: `contract` is required — read it from `orient`');
  if (typeof args.lit !== 'boolean') {
    return errorResult('focus: `lit` is required — true lights it into the set, false unlights it');
  }
  if (!reason) {
    return errorResult(
      'focus: `reason` is required — membership is authored, and it lands on the record for ' +
        'whoever reads the set later.',
    );
  }
  const stateRev = spineStateRev(args);
  if (stateRev === undefined) {
    return errorResult('focus: `expected_state_rev` is required — read it from `orient`.');
  }
  const result = await appendSpine(brokerClient, {
    kind: 'focus',
    opId: spineOpId(args),
    expectedStateRev: stateRev,
    body: { contract, lit: args.lit, reason },
  });
  return renderAppendResult(
    result,
    args.lit ? `lit ${contract} into the focus set` : `unlit ${contract} from the focus set`,
  );
}

/**
 * The team's plate, for an agent deciding what to pick up.
 *
 * Renders the whole set rather than a count, because a count answers a
 * question nobody has. An empty set is stated as a real state — the
 * team has not adopted focus, or the last thing finished — and not as
 * an empty list the reader has to interpret.
 */
async function handleFocusSet(brokerClient: BrokerClient): Promise<CallToolResult> {
  const contracts = await brokerClient.spineContracts({ focus: true });
  if (contracts.length === 0) {
    return textResult(
      'The team focus set is EMPTY. Nothing is lit for travel, which means focus is not ' +
        'currently narrowing anyone’s attention — ambient traffic flows for every contract.',
    );
  }
  const lines = [`The team focus set — ${contracts.length} contract(s) lit for travel:`];
  for (const c of contracts) {
    lines.push(
      '',
      `${c.id} [${c.state}, state_rev ${c.stateRev}] ${c.title}`,
      `  assignee: ${c.assignee}${c.verifier === null ? '' : ` · verifier: ${c.verifier}`}`,
      `  subject: ${c.subject}${c.stale ? ' (STALE — the room moved under it)' : ''}`,
    );
  }
  return textResult(lines.join('\n'));
}

async function handlePromote(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const eventId = spineString(args, 'event');
  const as = spineString(args, 'as') as SpineEventKind;
  if (!eventId) return errorResult('promote: `event` is required — the discussion post to promote');
  const textField = SPINE_PROMOTION_TEXT_FIELD[as];
  if (textField === undefined) {
    return errorResult(
      `promote: cannot promote into '${as || '(nothing)'}'. Promotion turns a discussion post ` +
        'into a typed event, so the target must be one of: ' +
        `${Object.keys(SPINE_PROMOTION_TEXT_FIELD).join(', ')}.`,
    );
  }
  const origin = await brokerClient.spineEvent(eventId);
  if (origin.kind !== 'discussion') {
    return errorResult(
      `promote: ${origin.id} is a ${origin.kind}, not a discussion. Promotion turns CHATTER ` +
        'into a typed event; a typed event is already what it is.',
    );
  }
  const post = origin.body as { body: string; contract?: string };
  const supplied =
    args.fields !== null && typeof args.fields === 'object'
      ? (args.fields as Record<string, unknown>)
      : {};
  const inheritsContract =
    SPINE_PROMOTION_INHERITS_CONTRACT.includes(as) &&
    supplied.contract === undefined &&
    origin.contract !== null;
  const body = {
    // The post's own text carries into the field that holds the
    // argument, and anything the caller states explicitly wins.
    [textField]: post.body,
    ...(inheritsContract ? { contract: origin.contract } : {}),
    ...supplied,
  };
  const extraCites = Array.isArray(args.cites) ? (args.cites as string[]) : [];
  const revision =
    args.revision === undefined
      ? null
      : await spineRevisionInput(
          args.revision,
          brokerClient,
          typeof body.contract === 'string' ? body.contract : undefined,
        );
  const stateRev = spineStateRev(args);
  const subject = spineString(args, 'subject') || origin.subject;
  const result = await appendSpine(brokerClient, {
    kind: as,
    // THE ORIGIN, CITED, ALWAYS AND FIRST. This is the whole point of
    // promotion over retyping: the record shows where the decision
    // actually happened instead of presenting it as having arrived
    // fully formed.
    cites: [origin.id, ...extraCites],
    ...(subject !== null && subject !== '' ? { subject } : {}),
    ...(revision !== null ? { revision } : {}),
    ...(stateRev !== undefined ? { expectedStateRev: stateRev } : {}),
    ...(SPINE_EVENT_CLASSES[as] === 'authoritative' ? { opId: spineOpId(args) } : {}),
    body,
  });
  return renderAppendResult(
    result,
    `promoted ${origin.id} (discussion by ${origin.actor}) into a ${as}, citing the post as its origin`,
  );
}

// ── Admin handlers (team / presets / members) ─────────────────────

async function handleTeamGet(brokerClient: BrokerClient): Promise<CallToolResult> {
  const team = await brokerClient.getTeam();
  const presetNames = Object.keys(team.permissionPresets);
  const lines = [
    `team: ${team.name}`,
    `context size: ${formatTextMetrics(team.context)}`,
    `context: ${team.context.length === 0 ? '(empty)' : team.context}`,
    `presets: ${presetNames.length === 0 ? '(none)' : presetNames.join(', ')}`,
  ];
  return textResult(lines.join('\n'));
}

async function handleTeamUpdate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const patch: { name?: string; context?: string } = {};
  if (typeof args.name === 'string') patch.name = args.name;
  if (typeof args.context === 'string') patch.context = args.context;
  if (Object.keys(patch).length === 0) {
    return errorResult('team_update: pass at least one of name, context');
  }
  const team = await brokerClient.updateTeam(patch);
  return textResult(
    `team_update applied: fields=${Object.keys(patch).join(',')} name='${team.name}'\n` +
      (patch.context !== undefined ? `context size: ${formatTextMetrics(team.context)}\n` : '') +
      `note: affected runners restart their agents at the next idle boundary to apply this; the roster lists them restart-pending until then.`,
  );
}

async function handlePresetsList(brokerClient: BrokerClient): Promise<CallToolResult> {
  const presets = await brokerClient.listPresets();
  const entries = Object.entries(presets);
  if (entries.length === 0) return textResult('(no presets)');
  const lines = entries.map(([name, leaves]) => `- ${name}: ${leaves.join(', ')}`);
  return textResult(lines.join('\n'));
}

async function handlePresetsSet(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const name = typeof args.name === 'string' ? args.name : '';
  const permissions = Array.isArray(args.permissions) ? args.permissions : null;
  if (!name) return errorResult('presets_set: `name` is required');
  if (permissions === null || permissions.some((p) => typeof p !== 'string')) {
    return errorResult('presets_set: `permissions` must be an array of leaf strings');
  }
  const result = await brokerClient.setPreset(
    name,
    permissions as import('csuite-sdk/types').Permission[],
  );
  return textResult(`preset '${result.name}' set: ${result.permissions.join(', ')}`);
}

async function handlePresetsDelete(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) return errorResult('presets_delete: `name` is required');
  const result = await brokerClient.deletePreset(name);
  const tail =
    result.referencedBy.length > 0
      ? `; still referenced by: ${result.referencedBy.join(', ')}`
      : '';
  return textResult(`preset '${result.deleted}' deleted${tail}`);
}

async function handleMembersAdd(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const name = typeof args.name === 'string' ? args.name : '';
  const title = typeof args.title === 'string' ? args.title : '';
  if (!name || !title) return errorResult('members_add: `name` and `title` are required');
  const description = typeof args.description === 'string' ? args.description : '';
  const instructions = typeof args.instructions === 'string' ? args.instructions : '';
  const permissions = Array.isArray(args.permissions)
    ? (args.permissions.filter((p) => typeof p === 'string') as string[])
    : [];
  const result = await brokerClient.createMember({
    name,
    role: { title, description },
    instructions,
    permissions,
  });
  return textResult(
    `member '${result.member.name}' created.\n` +
      `role description: ${formatTextMetrics(description)}\n` +
      `personal instructions: ${formatTextMetrics(instructions)}\n` +
      `bearer token (capture now — not shown again):\n  ${result.token}`,
  );
}

async function handleMembersUpdate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) return errorResult('members_update: `name` is required');
  const patch: {
    role?: { title: string; description: string };
    instructions?: string;
    permissions?: string[];
  } = {};
  if (typeof args.title === 'string' || typeof args.description === 'string') {
    patch.role = {
      title: typeof args.title === 'string' ? args.title : '',
      description: typeof args.description === 'string' ? args.description : '',
    };
  }
  if (typeof args.instructions === 'string') patch.instructions = args.instructions;
  if (Array.isArray(args.permissions)) {
    patch.permissions = args.permissions.filter((p) => typeof p === 'string') as string[];
  }
  if (Object.keys(patch).length === 0) {
    return errorResult(
      'members_update: nothing to update (title, description, instructions, permissions)',
    );
  }
  const member = await brokerClient.updateMember(name, patch);
  return textResult(
    `member '${member.name}' updated: fields=${Object.keys(patch).join(',')}\n` +
      (patch.role !== undefined
        ? `role description: ${formatTextMetrics(member.role.description)}\n`
        : '') +
      (patch.instructions !== undefined
        ? `personal instructions: ${formatTextMetrics(member.instructions)}\n`
        : '') +
      `note: the member's runner restarts their agent at the next idle boundary to apply this; the roster lists them restart-pending until then.`,
  );
}

async function handleMembersRemove(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) return errorResult('members_remove: `name` is required');
  await brokerClient.deleteMember(name);
  return textResult(`member '${name}' removed; all bearer tokens revoked.`);
}

// ── Tool-source admin handlers ─────────────────────────────────────
// Same defensive posture as the other gated handlers: the broker is
// authoritative (403s independently); the local re-check just gives a
// faster, clearer error when a stale client name-calls a hidden tool.

function requireToolsManage(
  instructions: InstructionsResponse,
  tool: string,
): CallToolResult | null {
  if (!instructions.permissions.includes('tools.manage')) {
    return errorResult(`${tool}: you do not have the tools.manage permission on this team`);
  }
  return null;
}

function formatSourceLine(s: ToolSourceSummary): string {
  const flags = [
    s.enabled ? 'enabled' : 'DISABLED',
    s.allMembers ? 'all-members' : null,
    s.hasCredential ? 'credential-set' : 'no-credential',
  ]
    .filter(Boolean)
    .join(', ');
  const label = s.displayName.length > 0 ? ` "${s.displayName}"` : '';
  return `- ${s.slug} [${s.kind}]${label}  tools=${s.toolCount}  (${flags})`;
}

async function handleToolSourcesList(
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireToolsManage(instructions, 'tool_sources_list');
  if (denied) return denied;
  const sources = await brokerClient.listToolSources();
  if (sources.length === 0) {
    return textResult('no tool sources registered. Use `tool_sources_create` to register one.');
  }
  return textResult(
    `tool sources (${sources.length}):\n${sources.map(formatSourceLine).join('\n')}`,
  );
}

async function handleToolSourcesView(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireToolsManage(instructions, 'tool_sources_view');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('tool_sources_view: `slug` is required');
  const detail = await brokerClient.getToolSource(slug);
  const lines: string[] = [formatSourceLine(detail.source)];
  if (detail.source.kind === 'mcp' && detail.source.config.url) {
    lines.push(`  upstream: ${detail.source.config.url}`);
  }
  lines.push(
    detail.source.allMembers
      ? '  access: all members'
      : `  bound: ${detail.boundMembers && detail.boundMembers.length > 0 ? detail.boundMembers.join(', ') : '(nobody — no agent sees these tools)'}`,
  );
  if (detail.tools.length === 0) {
    lines.push('  tools: (none)');
  } else {
    lines.push('  tools:');
    for (const t of detail.tools) {
      lines.push(`    ${detail.source.slug}__${t.name} — ${t.description}`);
      if ('binding' in t) {
        const binding = t.binding as CustomToolBinding;
        lines.push(`      ${binding.method} ${binding.urlTemplate}`);
      }
    }
  }
  return textResult(lines.join('\n'));
}

async function handleToolSourcesCreate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireToolsManage(instructions, 'tool_sources_create');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  const kind = args.kind === 'mcp' ? 'mcp' : args.kind === 'custom' ? 'custom' : null;
  if (!slug) return errorResult('tool_sources_create: `slug` is required');
  if (kind === null) {
    return errorResult("tool_sources_create: `kind` must be 'custom' or 'mcp'");
  }
  const url = typeof args.url === 'string' ? args.url : undefined;
  if (kind === 'mcp' && !url) {
    return errorResult('tool_sources_create: mcp sources require `url`');
  }
  const created = await brokerClient.createToolSource({
    slug,
    kind: kind as ToolSourceKind,
    ...(typeof args.displayName === 'string' ? { displayName: args.displayName } : {}),
    ...(url ? { config: { url } } : {}),
    ...(typeof args.allMembers === 'boolean' ? { allMembers: args.allMembers } : {}),
  });
  const next =
    kind === 'custom'
      ? 'Next: define tools with `tool_sources_define_tool`, then bind members.'
      : 'Next: set the credential (if the upstream needs one), run `tool_sources_refresh`, then bind members.';
  return textResult(`registered tool source '${created.slug}' (${created.kind}). ${next}`);
}

async function handleToolSourcesUpdate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireToolsManage(instructions, 'tool_sources_update');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('tool_sources_update: `slug` is required');
  const updated = await brokerClient.updateToolSource(slug, {
    ...(typeof args.displayName === 'string' ? { displayName: args.displayName } : {}),
    ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
    ...(typeof args.allMembers === 'boolean' ? { allMembers: args.allMembers } : {}),
    ...(typeof args.url === 'string' ? { config: { url: args.url } } : {}),
  });
  return textResult(
    `updated '${updated.slug}': enabled=${updated.enabled} allMembers=${updated.allMembers}` +
      (updated.displayName ? ` displayName="${updated.displayName}"` : ''),
  );
}

async function handleToolSourcesDelete(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireToolsManage(instructions, 'tool_sources_delete');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('tool_sources_delete: `slug` is required');
  await brokerClient.deleteToolSource(slug);
  return textResult(
    `deleted tool source '${slug}' (bindings, credential, and tool definitions removed).`,
  );
}

async function handleToolSourcesDefineTool(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireToolsManage(instructions, 'tool_sources_define_tool');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  const name = typeof args.name === 'string' ? args.name : '';
  if (!slug || !name) {
    return errorResult('tool_sources_define_tool: `slug` and `name` are required');
  }
  const description = typeof args.description === 'string' ? args.description : '';
  const inputSchema =
    args.inputSchema !== null && typeof args.inputSchema === 'object'
      ? (args.inputSchema as Record<string, unknown>)
      : null;
  const binding =
    args.binding !== null && typeof args.binding === 'object'
      ? (args.binding as CustomToolBinding)
      : null;
  if (inputSchema === null) {
    return errorResult('tool_sources_define_tool: `inputSchema` must be a JSON Schema object');
  }
  if (binding === null) {
    return errorResult('tool_sources_define_tool: `binding` must be a binding object');
  }
  await brokerClient.setCustomTool(slug, name, { description, inputSchema, binding });
  return textResult(
    `tool '${slug}__${name}' defined. Bound members pick it up live. To verify it works, ` +
      `bind yourself (tool_sources_bindings), call ${slug}__${name}, and read the result — ` +
      `failures include the upstream response.`,
  );
}

async function handleToolSourcesDeleteTool(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireToolsManage(instructions, 'tool_sources_delete_tool');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  const name = typeof args.name === 'string' ? args.name : '';
  if (!slug || !name) {
    return errorResult('tool_sources_delete_tool: `slug` and `name` are required');
  }
  await brokerClient.deleteCustomTool(slug, name);
  return textResult(`tool '${slug}__${name}' removed.`);
}

async function handleToolSourcesBindings(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireToolsManage(instructions, 'tool_sources_bindings');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('tool_sources_bindings: `slug` is required');
  const add = Array.isArray(args.add)
    ? args.add.filter((v): v is string => typeof v === 'string')
    : [];
  const remove = Array.isArray(args.remove)
    ? args.remove.filter((v): v is string => typeof v === 'string')
    : [];
  if (add.length === 0 && remove.length === 0) {
    return errorResult('tool_sources_bindings: pass `add` and/or `remove` member names');
  }
  for (const member of add) {
    await brokerClient.bindToolSource(slug, { member });
  }
  for (const member of remove) {
    await brokerClient.unbindToolSource(slug, member);
  }
  const detail = await brokerClient.getToolSource(slug);
  const bound = detail.boundMembers ?? [];
  return textResult(
    `bindings updated for '${slug}'. Now bound: ${bound.length > 0 ? bound.join(', ') : '(nobody)'}`,
  );
}

async function handleToolSourcesSetCredential(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireToolsManage(instructions, 'tool_sources_set_credential');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  const kind = args.kind === 'header' ? 'header' : args.kind === 'bearer' ? 'bearer' : null;
  const secret = typeof args.secret === 'string' ? args.secret : '';
  if (!slug) return errorResult('tool_sources_set_credential: `slug` is required');
  if (kind === null) {
    return errorResult("tool_sources_set_credential: `kind` must be 'bearer' or 'header'");
  }
  if (!secret) return errorResult('tool_sources_set_credential: `secret` is required');
  const headerName = typeof args.headerName === 'string' ? args.headerName : undefined;
  if (kind === 'header' && !headerName) {
    return errorResult('tool_sources_set_credential: `headerName` is required when kind=header');
  }
  await brokerClient.setToolCredential(slug, {
    kind: kind as ToolCredentialKind,
    ...(headerName ? { headerName } : {}),
    secret,
  });
  return textResult(
    `credential set for '${slug}' (${kind}${headerName ? ` ${headerName}` : ''}). ` +
      'It is write-only from here — nobody can read it back; set again to rotate.',
  );
}

async function handleToolSourcesDeleteCredential(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireToolsManage(instructions, 'tool_sources_delete_credential');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('tool_sources_delete_credential: `slug` is required');
  await brokerClient.deleteToolCredential(slug);
  return textResult(`credential removed from '${slug}'.`);
}

async function handleToolSourcesRefresh(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireToolsManage(instructions, 'tool_sources_refresh');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('tool_sources_refresh: `slug` is required');
  const { tools, changed } = await brokerClient.refreshToolSource(slug);
  const names = tools.map((t) => `  ${t.name}`).join('\n');
  return textResult(
    `refreshed '${slug}': ${tools.length} tool(s) discovered${changed ? ' (changed — bound members notified)' : ' (unchanged)'}` +
      (tools.length > 0 ? `\n${names}` : ''),
  );
}

// ── Secrets admin handlers ─────────────────────────────────────────
// Same defensive posture as the tool-source handlers: the broker is
// authoritative (403s independently); the local re-check just gives a
// faster, clearer error. Values NEVER appear in any result text.

function requireSecretsManage(
  instructions: InstructionsResponse,
  tool: string,
): CallToolResult | null {
  if (!instructions.permissions.includes('secrets.manage')) {
    return errorResult(`${tool}: you do not have the secrets.manage permission on this team`);
  }
  return null;
}

function formatSecretLine(s: SecretSummary): string {
  const flags = [
    s.enabled ? 'enabled' : 'DISABLED',
    s.allMembers ? 'all-members' : null,
    s.hasValue ? 'value-set' : 'NO-VALUE',
  ]
    .filter(Boolean)
    .join(', ');
  const desc = s.description.length > 0 ? ` — ${s.description}` : '';
  return `- ${s.slug} → $${s.envName}${desc}  (${flags})`;
}

async function handleSecretsList(
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'secrets_list');
  if (denied) return denied;
  const secrets = await brokerClient.listSecrets();
  if (secrets.length === 0) {
    return textResult('no secrets registered. Use `secrets_create` to register one.');
  }
  return textResult(`secrets (${secrets.length}):\n${secrets.map(formatSecretLine).join('\n')}`);
}

async function handleSecretsView(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'secrets_view');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('secrets_view: `slug` is required');
  const detail = await brokerClient.getSecret(slug);
  const lines: string[] = [formatSecretLine(detail.secret)];
  lines.push(
    detail.secret.allMembers
      ? '  access: all members'
      : `  bound: ${detail.boundMembers && detail.boundMembers.length > 0 ? detail.boundMembers.join(', ') : '(nobody — no agent receives this secret)'}`,
  );
  return textResult(lines.join('\n'));
}

async function handleSecretsCreate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'secrets_create');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  const envName = typeof args.envName === 'string' ? args.envName : '';
  if (!slug) return errorResult('secrets_create: `slug` is required');
  if (!envName) return errorResult('secrets_create: `envName` is required');
  const created = await brokerClient.createSecret({
    slug,
    envName,
    ...(typeof args.description === 'string' ? { description: args.description } : {}),
    ...(typeof args.allMembers === 'boolean' ? { allMembers: args.allMembers } : {}),
  });
  return textResult(
    `registered secret '${created.slug}' → $${created.envName}. ` +
      'Next: set the value (`secrets_set_value`, or ask a human to drop it in the web UI so ' +
      'it never enters agent context), then bind members with `secrets_bindings`.',
  );
}

async function handleSecretsUpdate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'secrets_update');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('secrets_update: `slug` is required');
  const updated = await brokerClient.updateSecret(slug, {
    ...(typeof args.envName === 'string' ? { envName: args.envName } : {}),
    ...(typeof args.description === 'string' ? { description: args.description } : {}),
    ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
    ...(typeof args.allMembers === 'boolean' ? { allMembers: args.allMembers } : {}),
  });
  return textResult(
    `updated '${updated.slug}': envName=${updated.envName} enabled=${updated.enabled} ` +
      `allMembers=${updated.allMembers}. Changes apply on each member's next runner start.`,
  );
}

async function handleSecretsDelete(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'secrets_delete');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('secrets_delete: `slug` is required');
  await brokerClient.deleteSecret(slug);
  return textResult(`deleted secret '${slug}' (value and bindings removed).`);
}

async function handleSecretsSetValue(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'secrets_set_value');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  const value = typeof args.value === 'string' ? args.value : '';
  if (!slug) return errorResult('secrets_set_value: `slug` is required');
  if (!value) return errorResult('secrets_set_value: `value` is required');
  await brokerClient.setSecretValue(slug, { value });
  return textResult(
    `value set for '${slug}'. It is write-only from here — nobody can read it back; set ` +
      'again to rotate. Members receive it on their next runner start.',
  );
}

async function handleSecretsDeleteValue(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'secrets_delete_value');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('secrets_delete_value: `slug` is required');
  await brokerClient.deleteSecretValue(slug);
  return textResult(`value removed from '${slug}'. It delivers nothing until a new value is set.`);
}

function formatVariableLine(v: VariableSummary): string {
  const flags = [v.enabled ? 'enabled' : 'DISABLED', v.allMembers ? 'all-members' : null]
    .filter(Boolean)
    .join(', ');
  const desc = v.description.length > 0 ? ` — ${v.description}` : '';
  // The value is shown because that is the point of the surface. When
  // it is absent, say WHICH absence: unset, or set but not visible to
  // this caller. Rendering both as blank is how an agent concludes a
  // variable is unconfigured when it is merely unreadable.
  const value =
    v.value !== undefined
      ? `= ${JSON.stringify(v.value)}`
      : v.hasValue
        ? '(value hidden)'
        : 'NO-VALUE';
  return `- ${v.slug} → $${v.envName} ${value}${desc}  (${flags})`;
}

async function handleVariablesList(
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'variables_list');
  if (denied) return denied;
  const variables = await brokerClient.listVariables();
  if (variables.length === 0) {
    return textResult('no variables registered. Use `variables_create` to register one.');
  }
  return textResult(
    `variables (${variables.length}) — values are NOT redacted from traces:\n${variables
      .map(formatVariableLine)
      .join('\n')}`,
  );
}

async function handleVariablesView(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'variables_view');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('variables_view: `slug` is required');
  const detail = await brokerClient.getVariable(slug);
  const lines: string[] = [formatVariableLine(detail.variable)];
  lines.push(
    detail.variable.allMembers
      ? '  access: all members'
      : `  bound: ${detail.boundMembers && detail.boundMembers.length > 0 ? detail.boundMembers.join(', ') : '(nobody — no agent receives this variable)'}`,
  );
  return textResult(lines.join('\n'));
}

async function handleVariablesCreate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'variables_create');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  const envName = typeof args.envName === 'string' ? args.envName : '';
  if (!slug) return errorResult('variables_create: `slug` is required');
  if (!envName) return errorResult('variables_create: `envName` is required');
  const created = await brokerClient.createVariable({
    slug,
    envName,
    ...(typeof args.description === 'string' ? { description: args.description } : {}),
    ...(typeof args.allMembers === 'boolean' ? { allMembers: args.allMembers } : {}),
  });
  return textResult(
    `registered variable '${created.slug}' → $${created.envName}. Its value will NOT be ` +
      'redacted from captured traces. Next: `variables_set_value`, then `variables_bindings`.',
  );
}

async function handleVariablesUpdate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'variables_update');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('variables_update: `slug` is required');
  const updated = await brokerClient.updateVariable(slug, {
    ...(typeof args.envName === 'string' ? { envName: args.envName } : {}),
    ...(typeof args.description === 'string' ? { description: args.description } : {}),
    ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
    ...(typeof args.allMembers === 'boolean' ? { allMembers: args.allMembers } : {}),
  });
  return textResult(
    `updated '${updated.slug}': envName=${updated.envName} enabled=${updated.enabled} ` +
      `allMembers=${updated.allMembers}. Changes apply on each member's next runner start.`,
  );
}

async function handleVariablesDelete(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'variables_delete');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('variables_delete: `slug` is required');
  await brokerClient.deleteVariable(slug);
  return textResult(`deleted variable '${slug}' (value and bindings removed).`);
}

async function handleVariablesSetValue(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'variables_set_value');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  const value = typeof args.value === 'string' ? args.value : '';
  if (!slug) return errorResult('variables_set_value: `slug` is required');
  if (!value) return errorResult('variables_set_value: `value` is required');
  await brokerClient.setVariableValue(slug, { value });
  return textResult(
    `value set for '${slug}'. It is readable and is NOT redacted from traces. Members ` +
      'receive it on their next runner start.',
  );
}

async function handleVariablesDeleteValue(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'variables_delete_value');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('variables_delete_value: `slug` is required');
  await brokerClient.deleteVariableValue(slug);
  return textResult(`value removed from '${slug}'. It delivers nothing until a new value is set.`);
}

async function handleVariablesBindings(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'variables_bindings');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('variables_bindings: `slug` is required');
  const add = Array.isArray(args.add)
    ? args.add.filter((v): v is string => typeof v === 'string')
    : [];
  const remove = Array.isArray(args.remove)
    ? args.remove.filter((v): v is string => typeof v === 'string')
    : [];
  if (add.length === 0 && remove.length === 0) {
    return errorResult('variables_bindings: pass `add` and/or `remove` member names');
  }
  for (const member of add) {
    await brokerClient.bindVariable(slug, { member });
  }
  for (const member of remove) {
    await brokerClient.unbindVariable(slug, member);
  }
  const detail = await brokerClient.getVariable(slug);
  const bound = detail.boundMembers ?? [];
  return textResult(
    `'${slug}' bound to: ${bound.length > 0 ? bound.join(', ') : '(nobody)'}. ` +
      "Applies on each member's next runner start.",
  );
}

async function handleSecretsBindings(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireSecretsManage(instructions, 'secrets_bindings');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('secrets_bindings: `slug` is required');
  const add = Array.isArray(args.add)
    ? args.add.filter((v): v is string => typeof v === 'string')
    : [];
  const remove = Array.isArray(args.remove)
    ? args.remove.filter((v): v is string => typeof v === 'string')
    : [];
  if (add.length === 0 && remove.length === 0) {
    return errorResult('secrets_bindings: pass `add` and/or `remove` member names');
  }
  for (const member of add) {
    await brokerClient.bindSecret(slug, { member });
  }
  for (const member of remove) {
    await brokerClient.unbindSecret(slug, member);
  }
  const detail = await brokerClient.getSecret(slug);
  const bound = detail.boundMembers ?? [];
  return textResult(
    `bindings updated for '${slug}'. Now bound: ${bound.length > 0 ? bound.join(', ') : '(nobody)'}. ` +
      'Members pick the secret up on their next runner start.',
  );
}

// ── External Notifications admin handlers ─────────────────────────
// Same defensive posture as the tool-source/secrets handlers: the
// broker is authoritative (403s independently); the local re-check
// just gives a faster, clearer error. Signing secrets NEVER appear
// in any result text.

function requireNotificationsManage(
  instructions: InstructionsResponse,
  tool: string,
): CallToolResult | null {
  if (!instructions.permissions.includes('notifications.manage')) {
    return errorResult(`${tool}: you do not have the notifications.manage permission on this team`);
  }
  return null;
}

function describeNotificationTarget(t: NotificationTarget): string {
  return t.member !== undefined ? `@${t.member}` : `#${t.channel ?? '?'}`;
}

function formatEndpointLine(e: NotificationEndpointSummary): string {
  const flags = [
    e.enabled ? 'enabled' : 'DISABLED',
    e.authProfile !== null ? `profile:${e.authProfile}` : e.auth.kind,
    e.hasSecret || e.authProfile !== null ? null : 'NO-SECRET',
    e.policy.ifOffline === 'queue' ? 'queue-offline' : null,
    e.policy.ifBusy === 'wait' ? 'wait-busy' : null,
    e.policy.debounceMs > 0 ? `debounce:${e.policy.debounceMs}ms` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const targets = e.targets.map(describeNotificationTarget).join(' ');
  return `- ${e.slug} → ${targets}  (${flags})`;
}

function formatDeliveryLine(d: NotificationDelivery): string {
  const when = new Date(d.receivedAt).toISOString();
  const reason = d.statusReason ? `  ${d.statusReason}` : '';
  const replay = d.replayOf ? `  (replay of ${d.replayOf})` : '';
  return `- ${when}  ${d.status}  ${d.id}${reason}${replay}`;
}

/** Parse "@member" / "#channel" target strings (bare names = members). */
function parseNotificationTargets(raw: unknown): NotificationTarget[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const targets: NotificationTarget[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) return null;
    if (entry.startsWith('#')) targets.push({ channel: entry.slice(1) });
    else targets.push({ member: entry.startsWith('@') ? entry.slice(1) : entry });
  }
  return targets;
}

function parseNotificationFilters(raw: unknown): NotificationFilterRule[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rules: NotificationFilterRule[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rule = entry as Record<string, unknown>;
    if (typeof rule.path !== 'string' || typeof rule.op !== 'string') continue;
    rules.push({
      path: rule.path,
      op: rule.op as NotificationFilterOp,
      ...(rule.value !== undefined ? { value: rule.value } : {}),
    });
  }
  return rules;
}

/** Flattened auth args → the request's nested auth object (or nothing). */
function parseNotificationAuth(
  args: Record<string, unknown>,
): { kind: NotificationAuthKind; headerName?: string | null; prefix?: string | null } | undefined {
  if (typeof args.authKind !== 'string') return undefined;
  return {
    kind: args.authKind as NotificationAuthKind,
    ...(typeof args.authHeader === 'string' ? { headerName: args.authHeader } : {}),
    ...(typeof args.authPrefix === 'string' ? { prefix: args.authPrefix } : {}),
  };
}

/** Flattened policy args → a partial policy (or nothing). */
function parseNotificationPolicy(
  args: Record<string, unknown>,
): Partial<NotificationDeliveryPolicy> | undefined {
  const policy: Partial<NotificationDeliveryPolicy> = {
    ...(args.ifOffline === 'drop' || args.ifOffline === 'queue'
      ? { ifOffline: args.ifOffline }
      : {}),
    ...(args.ifBusy === 'now' || args.ifBusy === 'wait' ? { ifBusy: args.ifBusy } : {}),
    ...(typeof args.debounceMs === 'number' ? { debounceMs: args.debounceMs } : {}),
    ...(typeof args.debounceMax === 'number' ? { debounceMax: args.debounceMax } : {}),
    ...(typeof args.queueTtlMs === 'number' ? { queueTtlMs: args.queueTtlMs } : {}),
    ...(typeof args.maxWaitMs === 'number' ? { maxWaitMs: args.maxWaitMs } : {}),
  };
  return Object.keys(policy).length > 0 ? policy : undefined;
}

async function handleNotificationsList(
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireNotificationsManage(instructions, 'notifications_list');
  if (denied) return denied;
  const endpoints = await brokerClient.listNotificationEndpoints();
  if (endpoints.length === 0) {
    return textResult(
      'no notification endpoints registered. Use `notifications_create` to register one.',
    );
  }
  return textResult(
    `notification endpoints (${endpoints.length}):\n${endpoints.map(formatEndpointLine).join('\n')}`,
  );
}

async function handleNotificationsView(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireNotificationsManage(instructions, 'notifications_view');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('notifications_view: `slug` is required');
  const { endpoint } = await brokerClient.getNotificationEndpoint(slug);
  const lines: string[] = [formatEndpointLine(endpoint)];
  lines.push(`  ingress: POST <broker>/hooks/${endpoint.slug}`);
  if (endpoint.description) lines.push(`  description: ${endpoint.description}`);
  if (endpoint.authProfile !== null) {
    lines.push(`  auth: profile '${endpoint.authProfile}'`);
  } else {
    const header = endpoint.auth.headerName ? ` header=${endpoint.auth.headerName}` : '';
    const prefix = endpoint.auth.prefix ? ` prefix=${endpoint.auth.prefix}` : '';
    lines.push(
      `  auth: ${endpoint.auth.kind}${header}${prefix}${endpoint.hasSecret ? '' : '  (NO SECRET — rejects everything)'}`,
    );
  }
  lines.push(
    `  level: ${endpoint.level}${endpoint.dedupeHeader ? `  dedupe: ${endpoint.dedupeHeader}` : ''}`,
  );
  lines.push(
    `  policy: if-offline=${endpoint.policy.ifOffline} if-busy=${endpoint.policy.ifBusy} ` +
      `debounce=${endpoint.policy.debounceMs}ms/${endpoint.policy.debounceMax} ` +
      `queue-ttl=${endpoint.policy.queueTtlMs}ms max-wait=${endpoint.policy.maxWaitMs}ms`,
  );
  if (endpoint.filters.length > 0) lines.push(`  filters: ${JSON.stringify(endpoint.filters)}`);
  if (endpoint.template !== null) lines.push(`  template: ${endpoint.template}`);
  return textResult(lines.join('\n'));
}

async function handleNotificationsCreate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireNotificationsManage(instructions, 'notifications_create');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('notifications_create: `slug` is required');
  const targets = parseNotificationTargets(args.targets);
  if (targets === null) {
    return errorResult(
      'notifications_create: `targets` must be a non-empty array of "@member" / "#channel" strings',
    );
  }
  const auth = parseNotificationAuth(args);
  const policy = parseNotificationPolicy(args);
  const filters = parseNotificationFilters(args.filters);
  const created = await brokerClient.createNotificationEndpoint({
    slug,
    targets,
    ...(typeof args.displayName === 'string' ? { displayName: args.displayName } : {}),
    ...(typeof args.description === 'string' ? { description: args.description } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(typeof args.authProfile === 'string' ? { authProfile: args.authProfile } : {}),
    ...(typeof args.level === 'string' ? { level: args.level as LogLevel } : {}),
    ...(typeof args.title === 'string' ? { title: args.title } : {}),
    ...(typeof args.template === 'string' ? { template: args.template } : {}),
    ...(filters !== undefined ? { filters } : {}),
    ...(policy !== undefined ? { policy } : {}),
    ...(typeof args.dedupeHeader === 'string' ? { dedupeHeader: args.dedupeHeader } : {}),
  });
  const next =
    created.authProfile === null
      ? 'Next: set the signing secret (`notifications_set_secret`, or ask a human to drop ' +
        'it in the web UI so it never enters agent context) — the endpoint rejects ' +
        'everything until then. '
      : '';
  return textResult(
    `registered endpoint '${created.slug}' → ${created.targets
      .map(describeNotificationTarget)
      .join(' ')}. ${next}Point the sender at POST <broker>/hooks/${created.slug}.`,
  );
}

async function handleNotificationsUpdate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireNotificationsManage(instructions, 'notifications_update');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('notifications_update: `slug` is required');
  const targets = args.targets !== undefined ? parseNotificationTargets(args.targets) : undefined;
  if (targets === null) {
    return errorResult(
      'notifications_update: `targets` must be a non-empty array of "@member" / "#channel" strings',
    );
  }
  const auth = parseNotificationAuth(args);
  const policy = parseNotificationPolicy(args);
  const filters = parseNotificationFilters(args.filters);
  const updated = await brokerClient.updateNotificationEndpoint(slug, {
    ...(targets !== undefined ? { targets } : {}),
    ...(typeof args.displayName === 'string' ? { displayName: args.displayName } : {}),
    ...(typeof args.description === 'string' ? { description: args.description } : {}),
    ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(typeof args.authProfile === 'string' ? { authProfile: args.authProfile } : {}),
    ...(typeof args.level === 'string' ? { level: args.level as LogLevel } : {}),
    ...(typeof args.title === 'string' ? { title: args.title } : {}),
    ...(typeof args.template === 'string' ? { template: args.template } : {}),
    ...(filters !== undefined ? { filters } : {}),
    ...(policy !== undefined ? { policy } : {}),
    ...(typeof args.dedupeHeader === 'string' ? { dedupeHeader: args.dedupeHeader } : {}),
  });
  return textResult(
    `updated '${updated.slug}': enabled=${updated.enabled} targets=${updated.targets
      .map(describeNotificationTarget)
      .join(' ')}.`,
  );
}

async function handleNotificationsDelete(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireNotificationsManage(instructions, 'notifications_delete');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('notifications_delete: `slug` is required');
  await brokerClient.deleteNotificationEndpoint(slug);
  return textResult(
    `deleted endpoint '${slug}' (delivery receipts and queued deliveries removed). ` +
      `POST /hooks/${slug} now returns 404.`,
  );
}

async function handleNotificationsSetSecret(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireNotificationsManage(instructions, 'notifications_set_secret');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  const secret = typeof args.secret === 'string' ? args.secret : '';
  if (!slug) return errorResult('notifications_set_secret: `slug` is required');
  if (!secret) return errorResult('notifications_set_secret: `secret` is required');
  await brokerClient.setNotificationEndpointSecret(slug, { secret });
  return textResult(
    `signing secret set for '${slug}'. It is write-only from here — configure the same ` +
      'value at the sender; set again to rotate.',
  );
}

async function handleNotificationsDeleteSecret(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireNotificationsManage(instructions, 'notifications_delete_secret');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('notifications_delete_secret: `slug` is required');
  await brokerClient.deleteNotificationEndpointSecret(slug);
  return textResult(`signing secret removed from '${slug}' — it now rejects every request.`);
}

async function handleNotificationsDeliveries(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireNotificationsManage(instructions, 'notifications_deliveries');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('notifications_deliveries: `slug` is required');
  const limit =
    typeof args.limit === 'number' ? Math.max(1, Math.min(Math.floor(args.limit), 100)) : 20;
  const deliveries = await brokerClient.listNotificationDeliveries(slug, { limit });
  if (deliveries.length === 0) {
    return textResult(`no deliveries recorded for '${slug}'.`);
  }
  return textResult(
    `deliveries for '${slug}' (${deliveries.length}, newest first):\n${deliveries
      .map(formatDeliveryLine)
      .join('\n')}`,
  );
}

async function handleNotificationsReplay(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireNotificationsManage(instructions, 'notifications_replay');
  if (denied) return denied;
  const deliveryId = typeof args.deliveryId === 'string' ? args.deliveryId : '';
  if (!deliveryId) return errorResult('notifications_replay: `deliveryId` is required');
  const delivery = await brokerClient.replayNotificationDelivery(deliveryId);
  const reason = delivery.statusReason ? ` (${delivery.statusReason})` : '';
  return textResult(`replayed as ${delivery.id}: ${delivery.status}${reason}`);
}

function formatProfileLine(p: NotificationProfileSummary): string {
  const refs = `${p.endpointCount} endpoint${p.endpointCount === 1 ? '' : 's'}`;
  return `- ${p.slug}  ${p.auth.kind}  (${p.hasSecret ? 'secret-set' : 'NO-SECRET'}, ${refs})`;
}

async function handleNotificationsProfiles(
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireNotificationsManage(instructions, 'notifications_profiles');
  if (denied) return denied;
  const profiles = await brokerClient.listNotificationProfiles();
  if (profiles.length === 0) {
    return textResult(
      'no auth profiles registered. Use `notifications_profile_create` to add one.',
    );
  }
  return textResult(
    `auth profiles (${profiles.length}):\n${profiles.map(formatProfileLine).join('\n')}`,
  );
}

async function handleNotificationsProfileCreate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireNotificationsManage(instructions, 'notifications_profile_create');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('notifications_profile_create: `slug` is required');
  const auth = parseNotificationAuth(args);
  if (auth === undefined) {
    return errorResult('notifications_profile_create: `authKind` is required');
  }
  const created = await brokerClient.createNotificationProfile({
    slug,
    auth,
    ...(typeof args.description === 'string' ? { description: args.description } : {}),
  });
  return textResult(
    `registered auth profile '${created.slug}' (${created.auth.kind}). ` +
      'Next: `notifications_profile_set_secret`, then reference it from endpoints via authProfile.',
  );
}

async function handleNotificationsProfileDelete(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireNotificationsManage(instructions, 'notifications_profile_delete');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  if (!slug) return errorResult('notifications_profile_delete: `slug` is required');
  await brokerClient.deleteNotificationProfile(slug);
  return textResult(`deleted auth profile '${slug}'.`);
}

async function handleNotificationsProfileSetSecret(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const denied = requireNotificationsManage(instructions, 'notifications_profile_set_secret');
  if (denied) return denied;
  const slug = typeof args.slug === 'string' ? args.slug : '';
  const secret = typeof args.secret === 'string' ? args.secret : '';
  if (!slug) return errorResult('notifications_profile_set_secret: `slug` is required');
  if (!secret) return errorResult('notifications_profile_set_secret: `secret` is required');
  await brokerClient.setNotificationProfileSecret(slug, { secret });
  return textResult(
    `secret set for profile '${slug}' — every referencing endpoint now verifies against ` +
      'it. Write-only from here; set again to rotate.',
  );
}

// ── Filesystem handlers ────────────────────────────────────────────

const TEXT_MIME_RE = /^(text\/|application\/json\b|application\/xml\b)/i;

function formatFsEntry(entry: FsEntry): string {
  if (entry.kind === 'directory') {
    return `d  ${entry.path}/  owner=${entry.owner}`;
  }
  const sizeKb = entry.size !== null ? `${Math.max(entry.size, 0)}B` : '?';
  return `f  ${entry.path}  ${sizeKb}  ${entry.mimeType ?? 'unknown'}  owner=${entry.owner}`;
}

async function handleFsLs(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const raw = typeof args.path === 'string' ? args.path : `/${instructions.name}`;
  const entries = await brokerClient.fsList(raw);
  if (entries.length === 0) {
    return textResult(`${raw}: (empty)`);
  }
  return textResult(`${raw}:\n${entries.map((e) => `  ${formatFsEntry(e)}`).join('\n')}`);
}

async function handleFsStat(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) return errorResult('fs_stat: `path` is required');
  const entry = await brokerClient.fsStat(path);
  if (!entry) return textResult(`${path}: not found`);
  return textResult(formatFsEntry(entry));
}

async function handleFsRead(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) return errorResult('fs_read: `path` is required');
  const entry = await brokerClient.fsStat(path);
  if (!entry) return errorResult(`fs_read: not found: ${path}`);
  if (entry.kind !== 'file') return errorResult(`fs_read: not a file: ${path}`);
  const blob = await brokerClient.fsRead(path);
  const buffer = Buffer.from(await blob.arrayBuffer());
  const mime = entry.mimeType ?? 'application/octet-stream';
  const header = `path=${entry.path}\nsize=${entry.size ?? 0}\nmime=${mime}`;
  if (TEXT_MIME_RE.test(mime)) {
    return textResult(`${header}\ntext:\n${buffer.toString('utf8')}`);
  }
  return textResult(`${header}\nbase64:\n${buffer.toString('base64')}`);
}

async function handleFsWrite(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const path = typeof args.path === 'string' ? args.path : '';
  const mimeType = typeof args.mimeType === 'string' ? args.mimeType : '';
  if (!path || !mimeType) return errorResult('fs_write: `path` and `mimeType` are required');
  const text = typeof args.text === 'string' ? args.text : undefined;
  const b64 = typeof args.base64 === 'string' ? args.base64 : undefined;
  if ((text === undefined && b64 === undefined) || (text !== undefined && b64 !== undefined)) {
    return errorResult('fs_write: provide exactly one of `text` or `base64`');
  }
  const collideRaw = typeof args.collide === 'string' ? args.collide : 'error';
  if (collideRaw !== 'error' && collideRaw !== 'overwrite' && collideRaw !== 'suffix') {
    return errorResult(`fs_write: invalid collide strategy '${collideRaw}'`);
  }
  const source =
    text !== undefined ? Buffer.from(text, 'utf8') : Buffer.from(b64 as string, 'base64');
  const result = await brokerClient.fsWrite({
    path,
    mimeType,
    source: new Uint8Array(source),
    collision: collideRaw,
  });
  const renamedNote = result.renamed ? ` (renamed to ${result.entry.path})` : '';
  return textResult(
    `wrote ${result.entry.path}${renamedNote}: size=${result.entry.size ?? source.length} mime=${result.entry.mimeType}`,
  );
}

async function handleFsMkdir(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) return errorResult('fs_mkdir: `path` is required');
  const recursive = args.recursive === true;
  const entry = await brokerClient.fsMkdir(path, recursive);
  return textResult(`mkdir ${entry.path} (owner=${entry.owner})`);
}

async function handleFsRm(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) return errorResult('fs_rm: `path` is required');
  const recursive = args.recursive === true;
  await brokerClient.fsRm(path, recursive);
  return textResult(`rm ${path}${recursive ? ' (recursive)' : ''}`);
}

async function handleFsMv(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const from = typeof args.from === 'string' ? args.from : '';
  const to = typeof args.to === 'string' ? args.to : '';
  if (!from || !to) return errorResult('fs_mv: both `from` and `to` are required');
  const entry = await brokerClient.fsMv(from, to);
  return textResult(`mv ${from} → ${entry.path}`);
}

async function handleFsShared(brokerClient: BrokerClient): Promise<CallToolResult> {
  const entries = await brokerClient.fsShared();
  if (entries.length === 0) {
    return textResult('no files currently shared with you');
  }
  return textResult(
    `files shared with you:\n${entries.map((e) => `  ${formatFsEntry(e)}`).join('\n')}`,
  );
}

function formatRecentLine(m: Message): string {
  const ts = formatAgentTimestamp(m.ts);
  const from = m.from ?? '?';
  const target = m.to ? ` → ${m.to}` : '';
  const title = m.title ? ` [${m.title}]` : '';
  return `  ${ts} ${from}${target}${title}: ${m.body}`;
}

/**
 * Format a unix-ms timestamp for agent consumption. Shape:
 *   04/15/26 14:23:45 UTC
 *
 * Rationale: agents receive timestamps in channel metadata and tool
 * output inline with text they're reading. A raw unix-ms number or a
 * bare `HH:MM` string forces them to run a tool (or guess) to figure
 * out when something happened. This format is:
 *
 *   - Unambiguous about timezone (UTC label)
 *   - Dated (mm/dd/yy so the agent can tell "today" vs "three weeks ago")
 *   - Precise to the second (distinguishes near-simultaneous events,
 *     which happens in rapid lifecycle transitions)
 *   - Fixed-width (21 chars) so columns line up cleanly in tables
 *
 * We intentionally don't include milliseconds — the second granularity
 * is enough for human-reasoning and avoids noise. We don't include
 * day-of-week because it's redundant with the date and bloats the line.
 */
export function formatAgentTimestamp(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yy = String(d.getUTCFullYear()).slice(-2);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${mm}/${dd}/${yy} ${hh}:${min}:${ss} UTC`;
}

/**
 * Format a relative time hint from a unix-ms timestamp. Used in the
 * event log to answer "how long ago was that?" at a glance
 * without making the agent do subtraction. Caller supplies `now` so
 * tests can pin time; production uses Date.now.
 *
 * Examples: "just now", "5m ago", "2h ago", "3d ago", "future".
 */
export function formatRelativeAge(ms: number, now: number = Date.now()): string {
  const delta = now - ms;
  if (delta < 0) return 'future';
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v);
}

function parseLevel(
  raw: unknown,
): { level: LogLevel; error?: undefined } | { error: string; level?: undefined } {
  if (raw === undefined || raw === null) return { level: 'info' };
  if (isLogLevel(raw)) return { level: raw };
  return {
    error: `unknown level '${String(raw)}'. Must be one of: ${LEVELS.join(', ')}.`,
  };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
