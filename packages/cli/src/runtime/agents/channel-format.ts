/**
 * Shared rendering for broker channel events delivered to agents that
 * consume them as TEXT rather than as MCP notifications.
 *
 * The forwarder produces `{content, meta}` params for the
 * `notifications/claude/channel` method. Runners whose agent framework
 * takes ambient input as user-visible text (codex `turn/steer`, the
 * claude runner's SDK streaming input) render those params into an
 * unmistakable `<channel>` tagged block so the model reads them as
 * ambient team signal, not a fresh operator request:
 *
 *   <channel kind="chat" from="director" thread="primary" ts="...">
 *   ...body...
 *   </channel>
 */

/**
 * Render the channel-notification params (content + meta) into a single
 * `<channel>` tagged block. Highest-signal meta fields render first;
 * any remaining meta keys land as `key="value"` attributes so the agent
 * can scan them. Returns `null` for params that don't look like a
 * channel event.
 */
export function formatChannelEvent(params: Record<string, unknown> | undefined): string | null {
  if (!params || typeof params !== 'object') return null;
  const content = typeof params.content === 'string' ? params.content : '';
  const metaRaw = params.meta;
  const meta: Record<string, string> =
    metaRaw && typeof metaRaw === 'object' && !Array.isArray(metaRaw)
      ? (metaRaw as Record<string, string>)
      : {};

  const ordered: Array<[string, string | undefined]> = [
    ['kind', meta.kind],
    ['from', meta.from],
    ['thread', meta.thread],
    ['title', meta.title],
    ['target', meta.target],
    ['level', meta.level],
    ['ts', meta.ts],
    ['msg_id', meta.msg_id],
  ];
  const seen = new Set<string>();
  const attrs: string[] = [];
  for (const [k, v] of ordered) {
    seen.add(k);
    if (typeof v === 'string' && v.length > 0) {
      attrs.push(`${k}=${attrEscape(v)}`);
    }
  }
  for (const [k, v] of Object.entries(meta)) {
    if (seen.has(k)) continue;
    if (typeof v === 'string' && v.length > 0) {
      attrs.push(`${k}=${attrEscape(v)}`);
    }
  }
  const open = attrs.length > 0 ? `<channel ${attrs.join(' ')}>` : '<channel>';
  return `${open}\n${content}\n</channel>`;
}

function attrEscape(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}
