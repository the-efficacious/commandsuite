/**
 * Shared rendering for broker channel events delivered to agents as
 * TEXT.
 *
 * The forwarder produces typed `ChannelEvent`s (content + flat string
 * meta). Runners whose agent framework takes ambient input as
 * user-visible text (codex `turn/steer`, the claude runner's SDK
 * streaming input) render each event into an unmistakable `<channel>`
 * tagged block so the model reads it as ambient team signal, not a
 * fresh operator request:
 *
 *   <channel kind="chat" from="director" thread="primary" ts="...">
 *   ...body...
 *   </channel>
 */

import type { ChannelEvent } from '../forwarder.js';

/**
 * Render a channel event into a single `<channel>` tagged block.
 * Highest-signal meta fields render first; any remaining meta keys
 * land as `key="value"` attributes so the agent can scan them.
 */
export function formatChannelEvent(event: ChannelEvent): string {
  const { content, meta } = event;

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
