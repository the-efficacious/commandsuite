/**
 * Model-id and tool-name display helpers, shared across the trace
 * surfaces (AgentTimeline, TracePanel, GenAiBlocks). Kept in a lib
 * module (no JSX) so component files can share them without import
 * cycles.
 */

const PRETTY_MODELS: Record<string, string> = {
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'gpt-5-codex': 'GPT-5 Codex',
  'gpt-5': 'GPT-5',
};

/**
 * Format a raw model id into a short display label — provider prefix
 * stripped, family/version prettified (`claude-opus-4-8` → `Opus 4.8`,
 * `gpt-5-codex` → `GPT-5 Codex`). An unknown id is returned unchanged.
 */
export function prettyModel(id: string): string {
  // Strip a leading `provider/` segment (e.g. `anthropic/claude-...`)
  // before the lookup; unknown ids fall through to the raw string.
  const bare = id.slice(id.lastIndexOf('/') + 1);
  return PRETTY_MODELS[bare] ?? id;
}

/**
 * Human label for a genai record's `querySource` thread attribution —
 * which interleaved lane of the member's work made the call. Used on
 * call rows in the timeline and TracePanel so subagent/sidecar calls
 * read as what they are instead of raw attribute strings.
 */
export function describeQuerySource(
  querySource: string | null | undefined,
  agentName?: string | null,
): string {
  if (querySource === null || querySource === undefined) return 'model call';
  if (querySource === 'repl_main_thread' || querySource === 'codex_main_thread') {
    return 'main thread';
  }
  const claudeAgent = /^agent:(?:builtin:)?(.+)$/.exec(querySource);
  if (claudeAgent?.[1]) return `subagent · ${agentName ?? claudeAgent[1]}`;
  const codexAgent = /^codex_subagent:(.+)$/.exec(querySource);
  if (codexAgent?.[1]) return `subagent · ${codexAgent[1]}`;
  if (querySource === 'web_search_tool') return 'web search';
  if (querySource === 'web_fetch_apply') return 'web fetch';
  if (querySource === 'away_summary') return 'away summary';
  return querySource;
}

/**
 * Split an MCP tool name into its server + tool parts. Anthropic names
 * MCP tools `mcp__<server>__<tool>` — we render the server muted and
 * the tool bold. A plain tool name (`Bash`, `Read`, `Edit`) has no
 * server and renders bare.
 */
export function parseToolName(name: string): { server: string | null; tool: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m?.[1] && m[2]) return { server: m[1], tool: m[2] };
  return { server: null, tool: name };
}
