/**
 * Tool definitions and handlers for the link's MCP server face.
 *
 * Descriptions are STATIC for the lifetime of a session. The only
 * interpolation is boot-stable and functional — the member's fs home
 * path and permission-scoped wording — never live state and never
 * identity/roster prose (who-you-are and the teammate list live in the
 * system-prompt instructions; repeating them per-tool wastes context).
 * Live state (open objectives, presence) reaches the agent as message
 * traffic: channel events plus the runner's `context_refresh`
 * re-briefs. `tools/list_changed` is reserved for genuine capability
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
 * Objective tools:
 *   - objectives_list     — the caller's active plate
 *   - objectives_view     — full detail on one objective
 *   - objectives_update   — status, assignee and watcher changes
 *   - objectives_discuss  — post into the objective thread
 *   - objectives_complete — mark done with required result
 *
 * Permission-gated objective tools:
 *   - objectives_create   — assign work to teammates
 *   - objectives_cancel   — cancel your own-originated work, or anyone's with `objectives.cancel`
 */

import { basename } from 'node:path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Client as BrokerClient, ClientError } from 'csuite-sdk/client';
import { PROCESS_DOCUMENT_MAX } from 'csuite-sdk/schemas';
import { formatTextMetrics } from 'csuite-sdk/text-metrics';
import type {
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
  ObjectiveStatus,
  PushResult,
  ResolvedToolSource,
  SecretSummary,
  ToolCredentialKind,
  ToolSourceKind,
  ToolSourceSummary,
  VariableSummary,
} from 'csuite-sdk/types';
import { downloadLocalFile, uploadLocalFile } from '../commands/fs.js';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical'];
const OBJECTIVE_STATUSES: readonly ObjectiveStatus[] = ['active', 'blocked', 'done', 'cancelled'];

/**
 * The non-terminal statuses. An agent's "open plate" is the union of the
 * two, which is why `objectives_list` accepts `open` as a filter: a
 * lifecycle status selects one, and recovering agents need both in a
 * single call. `status=active` alone silently omits blocked work.
 */
const OPEN_OBJECTIVE_STATUSES: readonly ObjectiveStatus[] = ['active', 'blocked'];

/** What `objectives_list` accepts: the four statuses plus the `open` union. */
const OBJECTIVE_LIST_FILTERS: readonly string[] = [...OBJECTIVE_STATUSES, 'open'];

const DEFAULT_RECENT_LIMIT = 50;
const MAX_RECENT_LIMIT = 500;

const LOCAL_OR_REMOTE_ATTACHMENT_SCHEMA = {
  oneOf: [
    { type: 'string', description: 'An existing readable path in the csuite filesystem.' },
    {
      type: 'object',
      properties: {
        localPath: { type: 'string', description: "A file on the runner's own disk." },
        path: {
          type: 'string',
          description: 'Optional csuite target; defaults to /<self>/uploads/<basename>.',
        },
        mimeType: { type: 'string', description: 'Optional MIME override.' },
        collide: {
          type: 'string',
          enum: ['error', 'suffix', 'overwrite'],
          description: "Upload collision behavior (default 'suffix').",
        },
      },
      required: ['localPath'],
      additionalProperties: false,
    },
  ],
} as const;

/**
 * Build the tool set. Descriptions are static per session — the only
 * interpolation is boot-stable and functional (fs home path,
 * permission-scoped wording). Identity and the teammate roster live in
 * the system-prompt instructions; live objective state is delivered via
 * channel notifications and `context_refresh` re-briefs, never baked
 * into tool metadata (see the file header for the doctrine).
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
            items: LOCAL_OR_REMOTE_ATTACHMENT_SCHEMA,
            description:
              'Optional existing csuite paths or local-file upload objects. Max 64. Local bytes stream from the runner and never enter the tool call or result.',
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
        `team. You must already be a member of the channel; ask a channel manager to add you if ` +
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
            items: LOCAL_OR_REMOTE_ATTACHMENT_SCHEMA,
            description:
              'Optional existing csuite paths or local-file upload objects. Max 64. Local bytes stream from the runner and never enter the tool call or result.',
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
    {
      name: 'context_control',
      description:
        'Ask a runner to compact, clear, or reload its agent context. Targets yourself by default; controlling a teammate requires members.context. The immediate result only confirms delivery. The runner later records a context_control activity acknowledgement with the same requestId and the actual outcome.',
      inputSchema: {
        type: 'object',
        properties: {
          verb: {
            type: 'string',
            enum: ['compact', 'clear', 'reload'],
            description:
              'compact summarizes; clear starts cold; reload refreshes instructions and environment then resumes.',
          },
          member: {
            type: 'string',
            description: 'Target member. Defaults to yourself.',
          },
          reason: { type: 'string', description: 'Optional reason, max 500 characters.' },
        },
        required: ['verb'],
      },
    },
    {
      name: 'objectives_list',
      description:
        `List objectives you have a relationship with — ` +
        `assigned to you, originated by you, or objectives you're watching. ` +
        `**After a restart or context compaction, call this with \`status: "open"\`** — ` +
        `that is your whole open plate (active + blocked) in one call. ` +
        `The unfiltered call also returns every completed and cancelled objective you ` +
        `have ever been related to, which on a long-running team is large enough to ` +
        `overflow an agent's tool-result limit; prefer \`open\` for recovery and reach ` +
        `for the unfiltered call when you actually want history. ` +
        `\`status\` accepts a single lifecycle state (active | blocked | done | cancelled) ` +
        `or \`open\` for the active+blocked union; omit it to return all statuses. ` +
        `\`assignee\` narrows to one member's plate — pass your own name to separate ` +
        `what you own from what you merely watch or originated. ` +
        `Objectives always carry a required outcome — use \`objectives_view\` ` +
        `for full detail including the body, watcher list, attachments and audit log. ` +
        `Each row renders the objective's id, status, title, assignee, originator, ` +
        `outcome, and last-updated time.`,
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: [...OBJECTIVE_LIST_FILTERS],
            description:
              'Filter by lifecycle status, or `open` for the active+blocked union — ' +
              'the whole open plate in one call, which is what recovery wants. ' +
              'Omit to return all statuses including completed and cancelled history.',
          },
          assignee: {
            type: 'string',
            description:
              'Narrow to objectives assigned to this member. Pass your own name for ' +
              'your own plate as distinct from what you watch or originated. Always a ' +
              'subset of what you can already see.',
          },
        },
      },
    },
    {
      name: 'objectives_view',
      description:
        `Fetch the full state of a single objective. Use this before calling ` +
        `\`objectives_update\` or \`objectives_complete\` so you have the latest acceptance ` +
        `criteria fresh in context. Returns the full objective record (id, title, outcome, ` +
        `body, status, assignee, originator, watchers, attachments, block reason if any, ` +
        `result if completed) plus the append-only event log.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The objective id (e.g. obj-xxxxx-y).' },
        },
        required: ['id'],
      },
    },
    {
      name: 'objectives_update',
      description:
        `Update an objective's live state. Status: use status='blocked' (ideally with a ` +
        `short blockReason) when you're stuck or sequenced behind other work, and ` +
        `status='active' to resume. Assignee: pass \`assignee\` to hand the work to a ` +
        `different teammate (requires objectives.reassign; the previous assignee stays on ` +
        `the thread as a watcher). Watchers: pass \`addWatchers\`/\`removeWatchers\` to ` +
        `change who follows the thread (originator or objectives.watch). This tool is ` +
        `for STATE, not conversation — progress notes and questions go in ` +
        `\`objectives_discuss\` — and it never transitions to 'done'; call ` +
        `\`objectives_complete\` for that. Returns the updated objective.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The objective id.' },
          status: {
            type: 'string',
            enum: ['active', 'blocked'],
            description: "Use 'blocked' when stuck; 'active' to resume.",
          },
          blockReason: {
            type: 'string',
            description:
              'Recommended with status=blocked — one line on what is blocking you. ' +
              'Max 2048 characters.',
          },
          assignee: {
            type: 'string',
            description:
              'New assignee. Both the previous and new assignee are notified. ' +
              'Requires objectives.reassign.',
          },
          note: {
            type: 'string',
            description: 'Handover context when changing the assignee.',
          },
          addWatchers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Teammate names to add as watchers. Max 64.',
          },
          removeWatchers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Teammate names to remove from watchers. Max 64.',
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'objectives_discuss',
      description:
        `Post a message into an objective's dedicated discussion thread. The thread ` +
        `members are the originator, the assignee, and all directors on the team — ` +
        `everyone who needs visibility into the work gets the message immediately on ` +
        `their live stream. Use this for progress updates, questions, intermediate ` +
        `findings, coordination with the originator, or acknowledgments — anything that's ` +
        `conversation rather than a state transition. Every post is archived alongside ` +
        `the objective's event log and is visible in the web UI's inline thread view. ` +
        `Optionally attach files from your home; thread members receive automatic read access. ` +
        `Returns the new message id.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The objective id.' },
          body: {
            type: 'string',
            description:
              'The message body to post into the objective thread. Max 16384 characters.',
          },
          attachments: {
            type: 'array',
            items: LOCAL_OR_REMOTE_ATTACHMENT_SCHEMA,
            description:
              'Optional existing csuite paths or local-file upload objects. Max 64. Local bytes stream from the runner and never enter the tool call or result.',
          },
        },
        required: ['id', 'body'],
      },
    },
    {
      name: 'objectives_complete',
      description:
        `Mark an objective as done with a required result summary. Call ` +
        `\`objectives_view\` first to refresh the acceptance criteria in context. The ` +
        `\`result\` should explicitly address whether the stated outcome was met and link ` +
        `or describe the deliverable. Only the current assignee may call this. Returns ` +
        `the now-completed objective with its \`completedAt\` and \`result\` filled in.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The objective id.' },
          result: {
            type: 'string',
            description:
              'Required summary of what was delivered and how it meets the stated outcome. ' +
              'Max 4096 characters — the call is rejected if you exceed it, so check the ' +
              'length before writing a long completion rather than after.',
          },
        },
        required: ['id', 'result'],
      },
    },
    // ── Filesystem tools ───────────────────────────────────────────
    //
    // Every slot has a home at `/<name>/` with full read/write access;
    // directors may also read/write anywhere. Reads outside your home
    // require either a grant (the file was attached to a message you
    // can see) or `members.manage`. See `fs_shared` for a list of
    // files shared with you.
    //
    // Objective namespaces live at `/objectives/<id>/`. Files attached
    // at objective-create time are mirrored there automatically, and
    // the server-side membership ACL is real.
    //
    // Collaborative read/write/delete by every member of an objective
    // (originator + assignee + watchers) is what this namespace is FOR,
    // and it works. It did not until 2026-07-30, and the two defects
    // are recorded here because their shape is worth keeping:
    //
    //   1. `filesystem-store.ts` non-root `list()` gated on
    //      `members.manage || ownsPath` and never called `canRead()`.
    //      An objective namespace is owned by `obj:<id>` and by no
    //      member, so an ownership test refused every member of the
    //      objective, including its assignee. `stat`, `read` and
    //      `listShared` all gated on `canRead` already; `list` was the
    //      one that did not.
    //   2. `FsEntrySchema.owner` was `NameSchema`, whose pattern
    //      excludes `:`, so every namespace entry failed the schema
    //      shipped alongside the code producing it. The server
    //      responded correctly and the SDK client threw parsing that
    //      successful response.
    //
    // Defect 2's failure mode is the one to remember: validation ran on
    // the RESPONSE, after the write had committed. `fs_write` and
    // `fs_mkdir` reported an error for work that had already succeeded,
    // so an agent that retried hit a collision on a file it was told it
    // never wrote, and one that gave up left a file it did not know
    // existed. `fs_rm` alone "worked" throughout — it returns void and
    // parses nothing. The only namespace operation an agent could
    // complete and be told the truth about was the destructive one.
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
    //   objectives.create: objectives_create
    //   objectives.cancel: cancel objectives originated by someone else
    //
    // For members without the broader permission, the descriptions
    // call out the "only objectives you originated" rule so the
    // agent doesn't try to touch someone
    // else's objective and eat a 403.
    ...buildAuthorityTools(instructions),
    // The team's process document. Reading it is not how an agent
    // learns what binds it — the document is already in its fixed
    // context. These cover the edit history, which injection
    // deliberately leaves out, and the write path.
    ...buildProcessDocumentTools(instructions),
    // Live team/member management. Each tool is gated
    // on the corresponding `team.manage` or `members.manage`
    // on its exact leaf so other members don't see it in their toolbox.
    // The broker enforces the same gates independently — these tools
    // exist for UX (don't offer what you can't do) and as a first line
    // of defense, not as the security boundary.
    ...buildManagementTools(instructions),
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

function buildManagementTools(instructions: InstructionsResponse): Tool[] {
  const { permissions } = instructions;
  const canManageTeam = permissions.includes('team.manage');
  const canManageMembers = permissions.includes('members.manage');
  if (!canManageTeam && !canManageMembers) return [];

  const tools: Tool[] = [];

  // ─── Team config ──────────────────────────────────────────────
  // Read is allowed for anyone — same as `/team` on the HTTP API —
  // but we only surface the tool to `team.manage` holders so the toolbox stays
  // narrow for other members. Any agent that needs team data can pull it from
  // the instructions on session start.
  if (canManageTeam) {
    tools.push({
      name: 'team_get',
      description:
        'Read the current team config: returns its name and shared context. ' +
        'Use this to confirm team state before proposing edits, or ' +
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
  }

  // ─── Member management ────────────────────────────────────────
  if (canManageMembers) {
    tools.push({
      name: 'members_add',
      description:
        'Create a new team member with an explicit list of permission leaves. ' +
        'Returns the new member plus the plaintext ' +
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
            description: 'Permission leaves. Defaults to no permissions.',
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
              'Replacement permission leaves. Enforces "at least one members.manage holder remains".',
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
        'reload it at their next idle boundary (or next start for opted-out/older runners).',
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
        'reload it at their next idle boundary (or next start for opted-out/older runners).',
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
        'with `secrets_bindings` or pass allMembers=true. Running agents reload changes at ' +
        'their next idle boundary (or next start when opted out). Returns the created ' +
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
        'can read it back through any csuite surface; to rotate, set it again. Running agents ' +
        'reload it at their next idle boundary (or next start when opted out). Note the value you pass becomes part of ' +
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
        "Grant or revoke members' access to a secret. Running agents reload the env change " +
        'at their next idle boundary (or next start when opted out). Pass `add` and/or `remove` as arrays of member ' +
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
        `Listing \`/objectives/<id>\` works for members of that objective and for ` +
        `directors; those entries are owned by \`obj:<id>\` rather than by a member. ` +
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
        `Works under \`/objectives/<id>\` for members of that objective and for ` +
        `directors. Paths must not end in "/".`,
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
        `always includes the path, size, mime type, and either \`text\` or \`base64\`. ` +
        `Works under \`/objectives/<id>\` for members of that objective and for ` +
        `directors.`,
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
              `Absolute path to write. Allowed under ${home} (your home), anywhere ` +
              `if you hold members.manage, and under \`/objectives/<id>/\` if you are a ` +
              `member of that objective — an objective namespace is the right place ` +
              `for work-scoped files, and its entries are owned by \`obj:<id>\` ` +
              `rather than by you.`,
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
      name: 'fs_upload',
      description:
        `Stream a file from the runner's own disk into the csuite filesystem. ` +
        `Only the local and target paths cross the MCP bridge; file bytes flow from the ` +
        `runner directly to POST /fs/write and never enter an IPC frame or tool result. ` +
        `Relative local paths resolve from the runner cwd; absolute paths use the runner's ` +
        `filesystem. MIME is inferred from common extensions or defaults to ` +
        `application/octet-stream. Returns the resulting FsEntry.`,
      inputSchema: {
        type: 'object',
        properties: {
          localPath: { type: 'string', description: 'Path on the runner machine to upload.' },
          path: { type: 'string', description: 'Absolute target path in csuite.' },
          mimeType: { type: 'string', description: 'Optional MIME override.' },
          collide: {
            type: 'string',
            enum: ['error', 'suffix', 'overwrite'],
            description: "Collision behavior (default 'error').",
          },
        },
        required: ['localPath', 'path'],
      },
    },
    {
      name: 'fs_download',
      description:
        `Stream a csuite file onto the runner's own disk. Bytes flow directly from ` +
        `GET /fs/read/<path> into a same-directory temporary file and are published ` +
        `atomically; they never enter an IPC frame, tool result, or agent context. ` +
        `Refuses an existing destination unless overwrite=true.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute csuite file path to download.' },
          localPath: { type: 'string', description: 'Destination on the runner machine.' },
          overwrite: { type: 'boolean', description: 'Replace an existing file (default false).' },
        },
        required: ['path', 'localPath'],
      },
    },
    {
      name: 'fs_mkdir',
      description:
        `Create a directory. Pass recursive=true to auto-create missing parents. ` +
        `Your home is ${home}. Returns the directory's FsEntry. Works under ` +
        `\`/objectives/<id>/\` for members of that objective and for directors.`,
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
        `Both the source and destination must sit under a tree you own (or you must hold members.manage). ` +
        `Returns the FsEntry at the destination path. A destination under ` +
        `\`/objectives/<id>/\` works if you are a member of that objective, or hold members.manage.`,
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
        `private files from other slots never appear here. Files that live in objective ` +
        `namespaces (\`/objectives/<id>/...\`) are NOT in this list either; access there ` +
        `flows from membership, not grants. This tool itself is unaffected by the ` +
        `namespace defects noted on \`fs_ls\` and \`fs_read\` — it returns grant-backed ` +
        `entries correctly. Returns each file's FsEntry (path, size, mime, owner).`,
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
 * reuse of an objective permission. Under this design the permission IS
 * the authority — whoever holds it can rewrite what binds the team —
 * and "can direct the team's objectives" is not a comparable power.
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
            'text, and only new work is bound by the new text.',
        },
      },
      required: ['text', 'reason', 'disposition'],
    },
  });

  return tools;
}

function buildAuthorityTools(instructions: InstructionsResponse): Tool[] {
  const { permissions } = instructions;
  const canCreate = permissions.includes('objectives.create');
  const canCancel = permissions.includes('objectives.cancel');

  const tools: Tool[] = [];

  // objectives_create — requires objectives.create
  if (canCreate)
    tools.push({
      name: 'objectives_create',
      description:
        `Create and assign a new objective. You can direct work ` +
        `to any teammate — the assignee receives an immediate channel push with the title, ` +
        `outcome, and originator stamped as you. Write the \`outcome\` as the definition of ` +
        `done: SHORT and CHECKABLE, naming who verifies. A long outcome with many clauses ` +
        `costs the team real work to interpret — put background in \`body\` instead. ` +
        `Optionally include \`watchers\` (a list of names) to loop other teammates into the ` +
        `discussion thread from the start. Use \`roster\` for available assignees. Returns ` +
        `the new objective with its generated id.`,
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short, specific title for the objective. Max 200 characters.',
          },
          outcome: {
            type: 'string',
            description:
              'Required. The tangible result that defines "done" — what specifically must be true for this objective to be marked complete. Max 2048 characters.',
          },
          body: {
            type: 'string',
            description:
              'Optional longer context — constraints, scoping notes, links, reproductions. Max 4096 characters.',
          },
          assignee: {
            type: 'string',
            description: 'Name of the teammate who will execute this objective.',
          },
          watchers: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional list of teammate names to add as watchers on the objective thread from the start. Max 64.',
          },
          attachments: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Optional list of file paths to attach to the objective. Max 64. Each is mirrored into the objective's namespace at `/objectives/<id>/<basename>` so the file lives with the objective rather than in your home; every thread member (originator, assignee, and watchers) gets read/write access via the namespace ACL. Use `fs_write` to upload a file first.",
          },
        },
        required: ['title', 'outcome', 'assignee'],
      },
    });

  // objectives_cancel — originator always, or members with objectives.cancel
  const cancelScope = canCancel
    ? 'You can cancel any non-terminal objective on the team.'
    : 'You can cancel objectives you originated; the server refuses other objectives.';
  tools.push({
    name: 'objectives_cancel',
    description:
      `Terminally cancel an objective. Use this when work is no longer needed — priorities ` +
      `shifted, the problem went away, the assignee is overwhelmed, etc. Cancellation is ` +
      `terminal: a cancelled objective cannot be resumed (create a fresh one if you change ` +
      `your mind). ${cancelScope} Include a \`reason\` so the assignee and any watchers ` +
      `understand why. Returns the now-cancelled objective.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The objective id.' },
        reason: {
          type: 'string',
          description:
            'Optional but strongly recommended — explain why the objective is being cancelled.',
        },
      },
      required: ['id'],
    },
  });

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
        return await handleSend(args, brokerClient, instructions);
      case 'channels_list':
        return await handleChannelsList(brokerClient, instructions);
      case 'channels_post':
        return await handleChannelsPost(args, brokerClient, instructions);
      case 'recent':
        return await handleRecent(args, brokerClient, instructions);
      case 'context_control':
        return await handleContextControl(args, brokerClient, instructions);
      case 'objectives_list':
        return await handleObjectivesList(args, brokerClient, instructions);
      case 'objectives_view':
        return await handleObjectivesView(args, brokerClient);
      case 'objectives_update':
        return await handleObjectivesUpdate(args, brokerClient);
      case 'objectives_discuss':
        return await handleObjectivesDiscuss(args, brokerClient, instructions);
      case 'objectives_complete':
        return await handleObjectivesComplete(args, brokerClient);
      case 'objectives_create':
        return await handleObjectivesCreate(args, brokerClient, instructions);
      case 'process_document_get':
        return await handleProcessDocumentGet(brokerClient);
      case 'process_document_history':
        return await handleProcessDocumentHistory(brokerClient);
      case 'process_document_write':
        return await handleProcessDocumentWrite(args, brokerClient);
      case 'objectives_cancel':
        return await handleObjectivesCancel(args, brokerClient);
      case 'fs_ls':
        return await handleFsLs(args, brokerClient, instructions);
      case 'fs_stat':
        return await handleFsStat(args, brokerClient);
      case 'fs_read':
        return await handleFsRead(args, brokerClient);
      case 'fs_write':
        return await handleFsWrite(args, brokerClient);
      case 'fs_upload':
        return await handleFsUpload(args, brokerClient);
      case 'fs_download':
        return await handleFsDownload(args, brokerClient);
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
    const state =
      (presence?.authBlocked ?? 0) > 0
        ? `auth-blocked=${presence?.authBlocked ?? 0}; connected=${conn}`
        : conn > 0
          ? `connected=${conn}`
          : 'offline';
    const activity =
      presence?.activity === 'working' || presence?.activity === 'blocked'
        ? `reported ${presence.activity} ${activityWindow}`
        : `no report ${activityWindow} (idle, lapsed, or never reported)`;
    const permissions =
      t.permissions.length > 0
        ? ` permissions=${t.permissions.join(',')};`
        : ' permissions=baseline;';
    return `- ${t.name}${self} [${t.role.title}]${permissions} ${state}; activity=${activity}`;
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
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const to = typeof args.to === 'string' ? args.to : '';
  const body = typeof args.body === 'string' ? args.body : '';
  if (!to || !body) return errorResult('send: `to` and `body` are required');
  const levelResult = parseLevel(args.level);
  if (levelResult.error) return errorResult(`send: ${levelResult.error}`);
  const attachments = await resolveAttachmentPaths(
    args.attachments,
    brokerClient,
    instructions.name,
  );
  if ('error' in attachments) return errorResult(`send: ${attachments.error}`);
  let result: PushResult;
  try {
    result = await brokerClient.push({
      to,
      body,
      level: levelResult.level,
      ...(attachments.list.length > 0 ? { attachments: attachments.list } : {}),
    });
  } catch (err) {
    return errorResult(postUploadFailure('send', err, attachments.uploaded));
  }
  const attachmentSummary =
    attachments.list.length > 0 ? ` attachments=${attachments.list.length}` : '';
  return textResult(
    `delivered to ${to}: live=${result.delivery.live} ` +
      `targets=${result.delivery.targets} msg=${result.message.id}${attachmentSummary}`,
  );
}

function postUploadFailure(tool: string, err: unknown, uploaded: string[]): string {
  const retained = uploaded.length > 0 ? `; uploads retained: ${uploaded.join(', ')}` : '';
  return `${tool}: operation failed: ${err instanceof Error ? err.message : String(err)}${retained}`;
}

/**
 * Turn the agent's string[] of paths into the full Attachment
 * objects the broker expects. Resolves each via `fsStat`, reports
 * the first failure by path so the agent can fix the offender.
 */
async function resolveAttachmentPaths(
  raw: unknown,
  brokerClient: BrokerClient,
  localUploadMember?: string,
): Promise<{ list: Attachment[]; uploaded: string[] } | { error: string }> {
  if (raw === undefined || raw === null) return { list: [], uploaded: [] };
  if (!Array.isArray(raw)) {
    return { error: '`attachments` must be an array of paths' };
  }
  const list: Attachment[] = [];
  const uploaded: string[] = [];
  const failure = (message: string): { error: string } => ({
    error: message + (uploaded.length > 0 ? `; uploads retained: ${uploaded.join(', ')}` : ''),
  });
  for (const item of raw) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      if (!localUploadMember) {
        return failure('`attachments` local-file objects are not supported by this tool');
      }
      const spec = item as Record<string, unknown>;
      const localPath = typeof spec.localPath === 'string' ? spec.localPath : '';
      if (!localPath) return failure('local attachment requires `localPath`');
      const collide = typeof spec.collide === 'string' ? spec.collide : 'suffix';
      if (collide !== 'error' && collide !== 'suffix' && collide !== 'overwrite') {
        return failure(`local attachment has invalid collide strategy '${collide}'`);
      }
      const target =
        typeof spec.path === 'string' && spec.path.length > 0
          ? spec.path
          : `/${localUploadMember}/uploads/${basename(localPath)}`;
      try {
        const entry = await uploadLocalFile(brokerClient, {
          localPath,
          path: target,
          mimeType: typeof spec.mimeType === 'string' ? spec.mimeType : undefined,
          collision: collide,
        });
        if (entry.size === null || entry.mimeType === null) {
          return failure(`uploaded attachment is corrupt: ${entry.path}`);
        }
        uploaded.push(entry.path);
        list.push({
          path: entry.path,
          name: entry.name,
          size: entry.size,
          mimeType: entry.mimeType,
        });
        continue;
      } catch (err) {
        return failure(`local attachment upload failed for ${localPath}: ${String(err)}`);
      }
    }
    const p = item;
    if (typeof p !== 'string' || p.length === 0) {
      return failure('`attachments` entries must be csuite path strings or local-file objects');
    }
    try {
      const entry = await brokerClient.fsStat(p);
      if (!entry) return failure(`attachment not found: ${p}`);
      if (entry.kind !== 'file') return failure(`attachment is a directory: ${p}`);
      if (entry.size === null || entry.mimeType === null) {
        return failure(`attachment is corrupt: ${p}`);
      }
      list.push({
        path: entry.path,
        name: entry.name,
        size: entry.size,
        mimeType: entry.mimeType,
      });
    } catch (err) {
      return failure(`attachment lookup failed for ${p}: ${String(err)}`);
    }
  }
  return { list, uploaded };
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

async function handleContextControl(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const verb = args.verb;
  if (verb !== 'compact' && verb !== 'clear' && verb !== 'reload') {
    return errorResult('context_control: `verb` must be compact, clear, or reload');
  }
  const member =
    typeof args.member === 'string' && args.member.length > 0 ? args.member : instructions.name;
  const reason = typeof args.reason === 'string' ? args.reason : undefined;
  if (reason !== undefined && reason.length > 500) {
    return errorResult('context_control: `reason` must be 500 characters or fewer');
  }
  const response = await brokerClient.controlContext(member, {
    verb,
    ...(reason !== undefined ? { reason } : {}),
  });
  return textResult(
    `context ${verb} requested for ${response.target}: requestId=${response.requestId}, delivered=${response.delivered}; the context_control activity acknowledgement is authoritative`,
  );
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
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const slug = typeof args.channel === 'string' ? args.channel : '';
  const body = typeof args.body === 'string' ? args.body : '';
  if (!slug) return errorResult('channels_post: `channel` is required (the channel slug)');
  if (!body) return errorResult('channels_post: `body` is required');
  const levelResult = parseLevel(args.level);
  if (levelResult.error) return errorResult(`channels_post: ${levelResult.error}`);
  const attachments = await resolveAttachmentPaths(
    args.attachments,
    brokerClient,
    instructions.name,
  );
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
        postUploadFailure(
          'channels_post',
          `you are not a member of #${slug}. Ask a channel manager to add you, or use \`broadcast\` for the general channel.`,
          attachments.uploaded,
        ),
      );
    }
  } catch (err) {
    const ce = err as ClientError;
    if (ce?.name === 'ClientError' && ce.status === 404) {
      return errorResult(
        postUploadFailure(
          'channels_post',
          `no channel '${slug}'. Use \`channels_list\` to see available channels.`,
          attachments.uploaded,
        ),
      );
    }
    return errorResult(postUploadFailure('channels_post', err, attachments.uploaded));
  }

  let result: PushResult;
  try {
    result = await brokerClient.push({
      body,
      level: levelResult.level,
      data: { thread: `chan:${channelId}` },
      ...(attachments.list.length > 0 ? { attachments: attachments.list } : {}),
    });
  } catch (err) {
    return errorResult(postUploadFailure('channels_post', err, attachments.uploaded));
  }
  const attachmentSummary =
    attachments.list.length > 0 ? ` attachments=${attachments.list.length}` : '';
  return textResult(
    `posted to #${slug}: live=${result.delivery.live} ` +
      `targets=${result.delivery.targets} msg=${result.message.id}${attachmentSummary}`,
  );
}

// ── Objectives handlers ────────────────────────────────────────────

async function handleObjectivesList(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const filter = typeof args.status === 'string' ? args.status : undefined;
  if (filter !== undefined && !OBJECTIVE_LIST_FILTERS.includes(filter)) {
    return errorResult(
      `objectives_list: invalid status '${String(args.status)}'. Must be one of: ${OBJECTIVE_LIST_FILTERS.join(', ')}.`,
    );
  }
  const assignee =
    typeof args.assignee === 'string' && args.assignee.length > 0 ? args.assignee : undefined;

  // `related`, not `assignee` — this tool promises "objectives you have
  // a relationship with", and pinning `assignee` collapsed that to the
  // assignee-only view for a caller holding `objectives.create`,
  // hiding everything they originated or watch.
  //
  // `open` spans two statuses and the server's `status` takes one, so it
  // is applied here over the unfiltered relationship set.
  const serverStatus = filter && filter !== 'open' ? (filter as ObjectiveStatus) : undefined;
  const list = await brokerClient.listObjectives({
    related: instructions.name,
    ...(serverStatus ? { status: serverStatus } : {}),
  });

  let rows = list;
  if (filter === 'open') {
    rows = rows.filter((o) => OPEN_OBJECTIVE_STATUSES.includes(o.status));
  }
  // `assignee` is applied HERE rather than sent to the server, which
  // honours it on exactly one of three branches: it is silently dropped
  // whenever `related` is also present, and a caller without
  // `objectives.create` always gets the whole relationship union no
  // matter what they asked for. Sending it would return a superset with
  // nothing saying so. Narrowing the related set is also self-scoping by
  // construction — the result can only ever be a subset of what this
  // member could already see, so it cannot be used to fish.
  if (assignee) {
    rows = rows.filter((o) => o.assignee === assignee);
  }

  // The status word premodifies ("open objectives") and the assignee
  // clause postmodifies ("objectives … assigned to X"); joining them into
  // one prefix produced "no open assigned to X objectives for Y". When the
  // assignee IS the caller, "for Y assigned to Y" is redundant — the whole
  // point of the filter is that those are different questions, so the
  // phrase should say only the narrower one.
  const subject =
    assignee === undefined
      ? `objectives for ${instructions.name}`
      : assignee === instructions.name
        ? `objectives assigned to ${instructions.name}`
        : `objectives for ${instructions.name} assigned to ${assignee}`;
  const statusWord = filter === 'open' ? 'open' : filter;
  const phrase = statusWord ? `${statusWord} ${subject}` : subject;
  if (rows.length === 0) {
    return textResult(`no ${phrase}`);
  }
  const lines = rows.map((o) => {
    // `(you)` mirrors the web UI's own row treatment. Without it an agent
    // cannot tell work it owns from work it merely watches, which is the
    // whole reason assignee is rendered.
    const own = o.assignee === instructions.name ? ' (you)' : '';
    return (
      `- ${o.id} [${o.status}] ${o.title}\n` +
      `    assignee: ${o.assignee}${own}  originator: ${o.originator}\n` +
      `    outcome: ${o.outcome}\n` +
      `    updated: ${formatAgentTimestamp(o.updatedAt)} (${formatRelativeAge(o.updatedAt)})`
    );
  });
  return textResult(`${phrase}:\n${lines.join('\n')}`);
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
        '"scope_change" (forward-only)',
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

async function handleObjectivesView(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const id = typeof args.id === 'string' ? args.id : '';
  if (!id) return errorResult('objectives_view: `id` is required');
  const { objective, events } = await brokerClient.getObjective(id);
  const lines: string[] = [
    `${objective.id} [${objective.status}] ${objective.title}`,
    `assignee: ${objective.assignee}  originator: ${objective.originator}`,
    `outcome: ${objective.outcome}`,
    `created: ${formatAgentTimestamp(objective.createdAt)} (${formatRelativeAge(objective.createdAt)})`,
    `updated: ${formatAgentTimestamp(objective.updatedAt)} (${formatRelativeAge(objective.updatedAt)})`,
  ];
  if (objective.completedAt) {
    lines.push(
      `completed: ${formatAgentTimestamp(objective.completedAt)} (${formatRelativeAge(objective.completedAt)})`,
    );
  }
  if (objective.watchers.length > 0) {
    lines.push(`watchers: ${objective.watchers.join(', ')}`);
  }
  if (objective.body) lines.push(`body: ${objective.body}`);
  if (objective.blockReason) lines.push(`block reason: ${objective.blockReason}`);
  if (objective.result) lines.push(`result: ${objective.result}`);

  lines.push('events:');
  for (const ev of events) {
    const ts = formatAgentTimestamp(ev.ts);
    const age = formatRelativeAge(ev.ts);
    lines.push(`  ${ts} (${age}) ${ev.id} ${ev.actor} ${ev.kind} ${JSON.stringify(ev.payload)}`);
  }
  return textResult(lines.join('\n'));
}

async function handleObjectivesUpdate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const id = typeof args.id === 'string' ? args.id : '';
  if (!id) return errorResult('objectives_update: `id` is required');
  const statusArg = typeof args.status === 'string' ? args.status : undefined;
  if (statusArg !== undefined && statusArg !== 'active' && statusArg !== 'blocked') {
    return errorResult(
      `objectives_update: status must be 'active' or 'blocked' (use objectives_complete for 'done' and objectives_discuss for progress notes)`,
    );
  }
  const blockReason = typeof args.blockReason === 'string' ? args.blockReason : undefined;
  const assignee = typeof args.assignee === 'string' ? args.assignee : undefined;
  const note = typeof args.note === 'string' ? args.note : undefined;
  const names = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  const addWatchers = names(args.addWatchers);
  const removeWatchers = names(args.removeWatchers);
  if (
    statusArg === undefined &&
    blockReason === undefined &&
    assignee === undefined &&
    (addWatchers === undefined || addWatchers.length === 0) &&
    (removeWatchers === undefined || removeWatchers.length === 0)
  ) {
    return errorResult(
      'objectives_update: include at least one of status, blockReason, assignee, addWatchers, removeWatchers',
    );
  }
  const updated = await brokerClient.updateObjective(id, {
    ...(statusArg !== undefined ? { status: statusArg } : {}),
    ...(blockReason !== undefined ? { blockReason } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(addWatchers !== undefined && addWatchers.length > 0 ? { addWatchers } : {}),
    ...(removeWatchers !== undefined && removeWatchers.length > 0 ? { removeWatchers } : {}),
  });
  return textResult(
    `updated ${updated.id}: status=${updated.status} assignee=${updated.assignee}` +
      `${updated.blockReason ? ` blockReason="${updated.blockReason}"` : ''}` +
      `${updated.watchers.length > 0 ? ` watchers=${updated.watchers.join(',')}` : ''}`,
  );
}

async function handleObjectivesDiscuss(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  const id = typeof args.id === 'string' ? args.id : '';
  const body = typeof args.body === 'string' ? args.body : '';
  if (!id || !body) {
    return errorResult('objectives_discuss: both `id` and `body` are required');
  }
  const attachmentsResult = await resolveAttachmentPaths(
    args.attachments,
    brokerClient,
    instructions.name,
  );
  if ('error' in attachmentsResult) {
    return errorResult(`objectives_discuss: ${attachmentsResult.error}`);
  }
  let message: Message;
  try {
    message = await brokerClient.discussObjective(id, {
      body,
      ...(attachmentsResult.list.length > 0 ? { attachments: attachmentsResult.list } : {}),
    });
  } catch (err) {
    return errorResult(postUploadFailure('objectives_discuss', err, attachmentsResult.uploaded));
  }
  const attachmentNote =
    attachmentsResult.list.length > 0 ? ` attachments=${attachmentsResult.list.length}` : '';
  return textResult(
    `posted to objective ${id} thread: msg=${message.id}${attachmentNote} (fanned out to thread members)`,
  );
}

async function handleObjectivesComplete(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const id = typeof args.id === 'string' ? args.id : '';
  const result = typeof args.result === 'string' ? args.result : '';
  if (!id || !result) {
    return errorResult('objectives_complete: both `id` and `result` are required');
  }
  const updated = await brokerClient.completeObjective(id, result);
  return textResult(`completed ${updated.id}. Result recorded and originator notified.`);
}

// ── Permission-gated handlers (defensive re-checks) ───────────────────
// The server is authoritative on permissions — if a member somehow
// invokes one of these tools we'll get a 403 at the broker. But a
// fast local permission check gives a better error message and avoids
// a round trip. The tool list generation already prevents members
// without the permission from seeing these tools; the handler-level check
// defends against a stale MCP client or prompt injection that name-calls
// the tool.

async function handleObjectivesCreate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  instructions: InstructionsResponse,
): Promise<CallToolResult> {
  if (!instructions.permissions.includes('objectives.create')) {
    return errorResult('objectives_create: you do not have the required permission on this team');
  }
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const outcome = typeof args.outcome === 'string' ? args.outcome.trim() : '';
  const assignee = typeof args.assignee === 'string' ? args.assignee : '';
  if (!title) return errorResult('objectives_create: `title` is required');
  if (!outcome) return errorResult('objectives_create: `outcome` is required');
  if (!assignee) return errorResult('objectives_create: `assignee` is required');
  const body = typeof args.body === 'string' ? args.body : undefined;
  // Watchers: accept only an array of strings; silently filter out
  // anything else so a misshapen payload doesn't poison the request.
  let watchers: string[] | undefined;
  if (Array.isArray(args.watchers)) {
    watchers = args.watchers.filter((v): v is string => typeof v === 'string');
  }
  const attachmentsResult = await resolveAttachmentPaths(args.attachments, brokerClient);
  if ('error' in attachmentsResult) {
    return errorResult(`objectives_create: ${attachmentsResult.error}`);
  }
  const created = await brokerClient.createObjective({
    title,
    outcome,
    assignee,
    ...(body ? { body } : {}),
    ...(watchers && watchers.length > 0 ? { watchers } : {}),
    ...(attachmentsResult.list.length > 0 ? { attachments: attachmentsResult.list } : {}),
  });
  return textResult(
    `created ${created.id} assigned to ${created.assignee}: ${created.title}\n` +
      `outcome: ${created.outcome}\n` +
      (created.watchers.length > 0
        ? `watchers: ${created.watchers.join(', ')}`
        : 'watchers: (none)') +
      (created.attachments.length > 0
        ? `\nattachments: ${created.attachments.map((a) => a.path).join(', ')}`
        : ''),
  );
}

async function handleObjectivesCancel(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const id = typeof args.id === 'string' ? args.id : '';
  if (!id) return errorResult('objectives_cancel: `id` is required');
  const reason = typeof args.reason === 'string' ? args.reason : undefined;
  const updated = await brokerClient.cancelObjective(id, reason ? { reason } : {});
  return textResult(`cancelled ${updated.id}: ${updated.title}`);
}

// ── Team and member-management handlers ──────────────────────────

async function handleTeamGet(brokerClient: BrokerClient): Promise<CallToolResult> {
  const team = await brokerClient.getTeam();
  const lines = [
    `team: ${team.name}`,
    `context size: ${formatTextMetrics(team.context)}`,
    `context: ${team.context.length === 0 ? '(empty)' : team.context}`,
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
    ? (args.permissions.filter(
        (p) => typeof p === 'string',
      ) as import('csuite-sdk/types').Permission[])
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
    permissions?: import('csuite-sdk/types').Permission[];
  } = {};
  if (typeof args.title === 'string' || typeof args.description === 'string') {
    patch.role = {
      title: typeof args.title === 'string' ? args.title : '',
      description: typeof args.description === 'string' ? args.description : '',
    };
  }
  if (typeof args.instructions === 'string') patch.instructions = args.instructions;
  if (Array.isArray(args.permissions)) {
    patch.permissions = args.permissions.filter(
      (p) => typeof p === 'string',
    ) as import('csuite-sdk/types').Permission[];
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
      `allMembers=${updated.allMembers}. Metadata changes apply on each member's next runner start.`,
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
      'again to rotate. Running agents reload it at their next idle boundary.',
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
      `allMembers=${updated.allMembers}. Metadata changes apply on each member's next runner start.`,
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
      'reload it at their next idle boundary.',
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
      'Running agents reload the change at their next idle boundary.',
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
      'Running agents reload the change at their next idle boundary.',
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

async function handleFsUpload(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const localPath = typeof args.localPath === 'string' ? args.localPath : '';
  const path = typeof args.path === 'string' ? args.path : '';
  if (!localPath || !path) return errorResult('fs_upload: `localPath` and `path` are required');
  const mimeType = typeof args.mimeType === 'string' ? args.mimeType : undefined;
  const collideRaw = typeof args.collide === 'string' ? args.collide : 'error';
  if (collideRaw !== 'error' && collideRaw !== 'overwrite' && collideRaw !== 'suffix') {
    return errorResult(`fs_upload: invalid collide strategy '${collideRaw}'`);
  }
  try {
    const entry = await uploadLocalFile(brokerClient, {
      localPath,
      path,
      mimeType,
      collision: collideRaw,
    });
    return textResult(JSON.stringify(entry));
  } catch (err) {
    return errorResult(`fs_upload: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleFsDownload(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const path = typeof args.path === 'string' ? args.path : '';
  const localPath = typeof args.localPath === 'string' ? args.localPath : '';
  if (!path || !localPath) {
    return errorResult('fs_download: `path` and `localPath` are required');
  }
  try {
    const result = await downloadLocalFile(brokerClient, {
      path,
      localPath,
      overwrite: args.overwrite === true,
    });
    return textResult(`downloaded ${path} -> ${result.localPath}: size=${result.size}`);
  } catch (err) {
    return errorResult(`fs_download: ${err instanceof Error ? err.message : String(err)}`);
  }
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
 *     which happens in rapid objective lifecycle transitions)
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
 * objective event log to answer "how long ago was that?" at a glance
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
