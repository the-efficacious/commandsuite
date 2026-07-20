/**
 * Subset of the codex app-server v2 JSON-RPC protocol that csuite actually
 * uses. Mirrors `codex-rs/app-server-protocol/src/protocol/v2.rs` but
 * pulled in as raw types rather than imported — codex doesn't ship a
 * TS package for the protocol, only Rust + a generated TS mirror that
 * isn't published to npm.
 *
 * Wire format is newline-delimited JSON (see `transport/stdio.rs` in
 * codex). One JSON-RPC message per line.
 *
 * Method names match the wire-level strings codex expects (kebab/camel
 * mix is intentional and exactly matches the Rust `#[serde(rename)]`
 * tags on each variant).
 */
export const METHODS = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
} as const;

export const NOTIFICATIONS = {
  threadStarted: 'thread/started',
  threadStatusChanged: 'thread/status/changed',
  threadClosed: 'thread/closed',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  /**
   * Per-thread token accounting. Codex emits this after each turn's
   * model call(s) settle. The wire method is `thread/tokenUsage/updated`
   * (confirmed against the codex 0.142.5 app-server schema:
   * `ServerNotification` → `ThreadTokenUsageUpdatedNotification`). The
   * payload carries `{ threadId, turnId, tokenUsage: { last, total,
   * modelContextWindow } }` where `last`/`total` are `TokenUsageBreakdown`
   * — NOT an inlined/`usage`-nested count set. `last` is the most recent
   * request's breakdown (what a single turn's exchange should report);
   * `total` is the running thread cumulative. See `TokenUsageBreakdown`.
   */
  tokenUsageUpdated: 'thread/tokenUsage/updated',
  accountRateLimitsUpdated: 'account/rateLimits/updated',
  error: 'error',
  warning: 'warning',
} as const;

/**
 * Server-initiated requests we have to answer (the server is codex,
 * the client is us). All of these only fire if a thread is started
 * with `approval_policy != "never"` or with an MCP server whose
 * `default_tools_approval_mode != "never"`. We start threads with
 * `Never` everywhere, so these handlers exist as a defense-in-depth
 * fallback: if codex ever sends one anyway, we auto-respond with a
 * deny rather than letting the agent hang waiting for a reviewer
 * that doesn't exist.
 */
export const SERVER_REQUEST_METHODS = {
  commandExecutionRequestApproval: 'item/commandExecution/requestApproval',
  fileChangeRequestApproval: 'item/fileChange/requestApproval',
  permissionsRequestApproval: 'item/permissions/requestApproval',
  toolRequestUserInput: 'item/tool/requestUserInput',
  mcpServerElicitationRequest: 'mcpServer/elicitation/request',
} as const;

export interface InitializeParams {
  clientInfo: { name: string; version: string };
}

export interface InitializeResponse {
  /**
   * Codex returns various fields (server name/version, capabilities).
   * We don't introspect them — the response is just an acknowledgement
   * the server is alive and the protocol is the version we expect.
   */
  [key: string]: unknown;
}

/**
 * `thread/start` — open a fresh codex thread. Carries our composed
 * briefing as `developerInstructions`, pins the cwd, and forces
 * `approvalPolicy: "never"` + `sandbox: "workspace-write"` so headless
 * runs never block on a UI elicitation. See `protocol/v2.rs`
 * `ThreadStartParams`.
 */
export interface ThreadStartParams {
  cwd?: string;
  /**
   * Pre-message system prose. Codex stamps this into the model context
   * for every turn — analogous to claude-code's `--append-system-prompt`.
   */
  developerInstructions?: string;
  /** Optional override of the model name selected for the thread. */
  model?: string;
  /**
   * Approval policy. `never` enables headless operation.
   * Wire values are kebab-case (per `AskForApproval` in codex's
   * `protocol/v2.rs` with `#[serde(rename_all = "kebab-case")]`).
   */
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  /**
   * Sandbox mode. `workspace-write` is the headless default.
   * Wire values are kebab-case (per `SandboxMode` in codex's
   * `protocol/v2.rs` with `#[serde(rename_all = "kebab-case")]`).
   */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** When true, codex won't persist the thread to its rollout store. */
  ephemeral?: boolean;
  /**
   * Whether this thread is being started fresh (`startup`) or after a
   * `/clear` reset (`clear`). Default is `startup`. Don't confuse with
   * `SessionSource` (the per-process `--session-source` CLI arg);
   * `ThreadStartSource` is thread-level lifecycle, not process-level
   * provenance.
   */
  sessionStartSource?: 'startup' | 'clear';
}

export interface Thread {
  id: string;
  /**
   * Initial runtime status of the thread. Populated on both
   * `thread/start` responses and `thread/started` notifications. We
   * read this rather than waiting for a `thread/status/changed`
   * notification — codex only emits status-changed on transitions, not
   * on the initial steady state, so the cached status would otherwise
   * sit at `notLoaded` until the first turn fires (or forever, if the
   * agent is left idle).
   */
  status?: ThreadStatus;
  [key: string]: unknown;
}

export interface ThreadStartResponse {
  thread: Thread;
  [key: string]: unknown;
}

/**
 * `thread/resume` — reload a persisted thread from the rollout store
 * under `CODEX_HOME/sessions` and continue it. Codex rediscovers the
 * thread by scanning the sessions tree (verified against 0.144.3: a
 * fresh CODEX_HOME whose `sessions/` contains the rollout resumes
 * fine — no state DB carry-over needed). The override fields mirror
 * `thread/start`; absent fields keep the persisted thread's values.
 */
export interface ThreadResumeParams {
  threadId: string;
  cwd?: string;
  developerInstructions?: string;
  model?: string;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

export interface ThreadResumeResponse {
  thread: Thread;
  [key: string]: unknown;
}

export interface UserInputText {
  type: 'text';
  text: string;
}

export type UserInput = UserInputText;

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
}

export interface Turn {
  id: string;
  /**
   * Unix ms when the turn started. Present on the `turn/started` (and
   * `turn/completed`) payload's `turn` object. Confirmed against the
   * codex 0.130.0 schema (`Turn.startedAt`); read defensively.
   */
  startedAt?: number;
  /** Unix ms when the turn completed. Present on `turn/completed`. */
  completedAt?: number;
  /** Turn wall-clock duration in ms. Present on `turn/completed`. */
  durationMs?: number;
  /** completed | interrupted | failed | inProgress. */
  status?: string;
  [key: string]: unknown;
}

export interface TurnStartResponse {
  turn: Turn;
}

export interface TurnSteerParams {
  threadId: string;
  input: UserInput[];
  /**
   * Required precondition. Codex rejects the steer if it doesn't
   * match the active turn id at the moment of dispatch — the channel
   * sink retries once on mismatch by re-reading the latest
   * `turn/started` notification.
   */
  expectedTurnId: string;
}

export interface TurnSteerResponse {
  turnId: string;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

// ─── Notifications ────────────────────────────────────────────────

export interface ThreadStartedNotification {
  thread: Thread;
}

/**
 * Codex's idle/working/blocked state machine. Drives presence on our
 * side and decides whether channel events flush to `turn/start` (Idle)
 * or `turn/steer` (Active).
 */
export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags?: Array<'waitingOnApproval' | 'waitingOnUserInput'> };

export interface ThreadStatusChangedNotification {
  threadId: string;
  status: ThreadStatus;
}

export interface TurnStartedNotification {
  threadId: string;
  turn: Turn;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

export interface ItemStartedNotification {
  threadId: string;
  turnId: string;
  /** Unix ms when this item's lifecycle started. */
  startedAtMs?: number;
  item: { type: string; id?: string; [key: string]: unknown };
}

export interface ItemCompletedNotification {
  threadId: string;
  turnId: string;
  /** Unix ms when this item's lifecycle completed. */
  completedAtMs?: number;
  item: { type: string; id?: string; [key: string]: unknown };
}

export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

/**
 * A codex `TurnError` — the failure detail carried by `error`
 * notifications and by a completed `Turn.error`. The human-readable text
 * is `message`; `additionalDetails` and `codexErrorInfo` carry structured
 * extras. Read defensively.
 */
export interface TurnError {
  message?: string;
  additionalDetails?: string | null;
  [key: string]: unknown;
}

/**
 * `error` → `ErrorNotification`. Confirmed against the codex 0.130.0
 * app-server schema: the message lives under `error.message` (a
 * `TurnError`), NOT a top-level `message`, and the notification also
 * carries `threadId`, `turnId`, and `willRetry`. `message` is retained as
 * an optional top-level for tolerance of older builds that inlined it —
 * read `error.message` first, then fall back. (The prior
 * `{ message: string }` shape was wrong; the activity printer read a
 * top-level `message` that never exists on 0.130 and always printed
 * "(no message)".)
 */
export interface ErrorNotification {
  error?: TurnError;
  threadId?: string;
  turnId?: string;
  willRetry?: boolean;
  /** Legacy inlined message (older codex builds). */
  message?: string;
  [key: string]: unknown;
}

/**
 * A single token-count breakdown, as carried by codex's
 * `TokenUsageBreakdown` (confirmed against the 0.142.5 app-server
 * schema). On the wire all five fields are required camelCase integers;
 * we mark them optional and read defensively at the boundary, but the
 * spellings below are exact — codex does NOT ship snake_case variants of
 * these in the v2 protocol. Kept tolerant only so a partial/older
 * payload doesn't throw.
 */
export interface TokenUsage {
  /** Prompt tokens billed at full rate (not served from cache). */
  inputTokens?: number;
  /** Prompt tokens served from the model's prompt cache. */
  cachedInputTokens?: number;
  /** Completion tokens. Per OpenAI accounting this INCLUDES reasoning. */
  outputTokens?: number;
  /** Reasoning/thinking tokens — a subset of `outputTokens`. */
  reasoningOutputTokens?: number;
  /** Grand total the server reports (input + output). */
  totalTokens?: number;
}

/**
 * Codex's `ThreadTokenUsage`: `last` is the most recent request's
 * breakdown, `total` is the running thread cumulative. Both are required
 * on the wire; optional here for defensive parsing.
 */
export interface ThreadTokenUsage {
  last?: TokenUsage;
  total?: TokenUsage;
  /** Model context window size in tokens, when known. */
  modelContextWindow?: number | null;
}

/**
 * `thread/tokenUsage/updated` → `ThreadTokenUsageUpdatedNotification`.
 * The counts live under `tokenUsage.last` / `tokenUsage.total` — they are
 * NOT inlined on the body nor nested under a `usage` key (the prior guess
 * assumed `usage`). `threadId` and `turnId` are always present.
 */
export interface TokenUsageUpdatedNotification {
  threadId?: string;
  turnId?: string;
  tokenUsage?: ThreadTokenUsage;
  [key: string]: unknown;
}

// ─── Item payload shapes (item/completed `item` field) ─────────────
//
// Codex's `ThreadItem` enum (`app-server-protocol/src/protocol/v2/
// item.rs`) is `#[non_exhaustive]`; each variant carries a different
// payload beyond `type`/`id`. We document the fields the trace adapter
// reads here, but every one arrives as `unknown` on the wire so the
// adapter accesses them through defensive `strField`/`numField`/
// `arrField` helpers (mirroring the activity printer) rather than
// trusting these declarations.

/**
 * `commandExecution` — a shell command the agent ran. Field names are
 * exact per the schema (`ThreadItem` → commandExecution variant):
 * `command`, `aggregatedOutput` (the merged stdout+stderr; nullable),
 * `exitCode` (camelCase, nullable), `durationMs`, `cwd`, `status`.
 */
export interface CommandExecutionItem {
  type: 'commandExecution';
  id?: string;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  /** Merged stdout+stderr (schema: `aggregatedOutput`, nullable). */
  aggregatedOutput?: string | null;
  /** inProgress | completed | failed | declined. */
  status?: string;
}

/**
 * `mcpToolCall` — a tool dispatched through an MCP server. `error` is a
 * `{ message }` object (nullable), `result` is `{ content, ... }`
 * (nullable), `status` is inProgress | completed | failed.
 */
export interface McpToolCallItem {
  type: 'mcpToolCall';
  id?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown } | null;
  error?: { message?: string } | null;
  durationMs?: number | null;
  status?: string;
}

/**
 * `dynamicToolCall` — a namespaced non-MCP tool (the `item/tool/call`
 * request surface). Note: unlike `mcpToolCall`, this variant carries NO
 * `error`/`result` fields — output is `contentItems` (an array of
 * `{ type: 'inputText', text } | { type: 'inputImage', imageUrl }`) and
 * success/failure is signalled by `success` (bool, nullable) and
 * `status`.
 */
export interface DynamicToolCallItem {
  type: 'dynamicToolCall';
  id?: string;
  namespace?: string | null;
  tool?: string;
  arguments?: unknown;
  contentItems?: unknown[] | null;
  success?: boolean | null;
  durationMs?: number | null;
  /** inProgress | completed | failed. */
  status?: string;
}

/**
 * `webSearch` — a web search the agent issued. Carries `query` and an
 * `action` union (search | openPage | findInPage | other); there is NO
 * `results` field on the item.
 */
export interface WebSearchItem {
  type: 'webSearch';
  id?: string;
  query?: string;
  action?: unknown;
}

/**
 * `fileChange` — one or more file edits (apply_patch). Each change is a
 * `FileUpdateChange` with `path` (string), `kind`, and `diff`.
 */
export interface FileChangeItem {
  type: 'fileChange';
  id?: string;
  changes?: Array<{ path?: string; kind?: unknown; diff?: string; [key: string]: unknown }>;
  /** inProgress | completed | failed | declined. */
  status?: string;
}

/** `agentMessage` — user-visible assistant prose for the turn. */
export interface AgentMessageItem {
  type: 'agentMessage';
  id?: string;
  text?: string;
}

/**
 * `userMessage` — an input that opened (or steered) the turn. Confirmed
 * against the codex 0.130.0 schema: the payload is `content: UserInput[]`
 * (a union of `text | image | localImage | skill | mention`), NOT a flat
 * `text` field — the prompt prose is the concatenation of the `text`
 * entries. In csuite this is usually an injected ambient broker/channel
 * event (the `turn/start` · `turn/steer` input), not a human keystroke,
 * mirroring how the Claude side treats `UserPromptSubmit`. Fields read
 * defensively; `text` is tolerated as a fallback for other builds.
 */
export interface UserMessageItem {
  type: 'userMessage';
  id?: string;
  content?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
  /** Fallback flat text (not present on 0.130 — tolerated for drift). */
  text?: string;
}

/**
 * `reasoning` — the model's thinking. The schema carries two parallel
 * string arrays: `summary` (the user-visible summarized reasoning,
 * streamed via `item/reasoning/summaryTextDelta`) and `content` (the raw
 * reasoning, streamed via `item/reasoning/textDelta`). There is NO
 * single-string `summary` and NO `text` field on the completed item.
 */
export interface ReasoningItem {
  type: 'reasoning';
  id?: string;
  summary?: string[];
  content?: string[];
}
