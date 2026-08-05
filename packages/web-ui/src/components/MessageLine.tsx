/**
 * One message in the transcript — the bench MSG SPEC: a 34px identity
 * tile column, then a head row (sender + time on a shared baseline)
 * with the body underneath. Person vs agent is carried by the tile;
 * the name colour is a quiet second signal (identity blue for people,
 * primary text for agents — never gold). Structure, not hue, is what
 * separates the name from the body.
 *
 * Two rendering modes:
 *
 *   1. **Header row** — the first message in a group. Tile + head +
 *      body. Gets breathing room above when there's a previous
 *      message, so groups read as blocks.
 *
 *   2. **Continuation row** — a follow-up from the same sender
 *      within a short window. Drops the tile and head (the redundant
 *      bits that make bursts noisy) but keeps a small timestamp in
 *      the tile gutter so per-row timing stays visible — a
 *      same-sender burst can span seconds or minutes and the reader
 *      shouldn't have to guess.
 *
 * Grouping rules (computed in `isContinuationOf`):
 *   - same `from` name
 *   - same `level` (an info message next to an `error` never groups)
 *   - no `title` on either message (titled messages are distinct)
 *   - the gap between `ts` values is ≤ 5 minutes
 *
 * The body runs through `renderMessageMarkdown` — full GFM via
 * `marked`, sanitized with `DOMPurify`, raw HTML left escaped — so the
 * result is safe for `dangerouslySetInnerHTML`.
 */

import type { Message } from 'csuite-sdk/types';
import { useEffect, useRef } from 'preact/hooks';
import { initials } from '../lib/initials.js';
import { renderMessageMarkdown } from '../lib/markdown.js';
import { selectedThreadMessageId } from '../lib/messages.js';
import { memberKind } from '../lib/roster.js';
import { senderTextClass } from '../lib/sender-color.js';
import { MessageAttachments } from './MessageAttachments.js';

/** 5 minutes — matches Slack's default "merge into a group" threshold. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export interface MessageLineProps {
  message: Message;
  viewer: string;
  /**
   * The message rendered just before this one in the same thread,
   * if any. When omitted the row always renders as a header — that's
   * the right default for the first message of any thread, and it
   * keeps the component usable outside a sequential transcript
   * (e.g. single-message previews).
   */
  previousMessage?: Message;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Should `msg` render as a continuation of `prev`, sharing its
 * header? Pure predicate — no rendering side effects.
 */
export function isContinuationOf(msg: Message, prev: Message): boolean {
  if (prev.from !== msg.from) return false;
  if (prev.from === null || msg.from === null) return false;
  if (prev.level !== msg.level) return false;
  if (prev.title !== null || msg.title !== null) return false;
  if (msg.ts - prev.ts > GROUP_WINDOW_MS) return false;
  // Backwards-in-time gap (e.g. out-of-order SSE reconnect backfill):
  // treat as distinct so the "grouped by time" intuition doesn't fib.
  if (msg.ts < prev.ts) return false;
  return true;
}

export function MessageLine({ message, previousMessage }: MessageLineProps) {
  const sender = message.from ?? '?';
  const kind = memberKind(sender);
  const colorClass = senderTextClass(kind);
  const body = renderMessageMarkdown(message.body);

  const isContinuation =
    previousMessage !== undefined && isContinuationOf(message, previousMessage);

  // When this message is the target of an inspector → thread jump,
  // mark it visually and scroll it into view. Clearing happens at the
  // thread level (Transcript drops the selection on thread switch).
  const isSelected = selectedThreadMessageId.value === message.id;
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isSelected]);
  const highlightStyle = isSelected
    ? ';background:var(--ef-surface-raised);box-shadow:-3px 0 0 var(--ef-assert-edge);border-radius:0 4px 4px 0;transition:background .2s,box-shadow .2s'
    : ';transition:background .2s,box-shadow .2s';

  // Bench MSG SPEC grid: 34px tile column + message column. The body
  // wraps within its own column so second-line text aligns with the
  // first. `max-w-[72ch]` caps line length near the 65–75ch
  // readability sweet spot; `min-w-0` is the grid/flex-child "don't
  // let long tokens blow out the parent" trick — without it a long
  // unbroken URL pushes the tile column off-screen.
  //
  // Continuation rows reuse the same grid so bodies line up; the tile
  // cell instead carries a small right-aligned timestamp, keeping
  // per-row timing visible through a burst.
  if (isContinuation) {
    return (
      <div
        ref={rowRef}
        style={`display:grid;grid-template-columns:34px 1fr;gap:0 12px;padding:1px 0${highlightStyle}`}
      >
        <span
          class="tabular-nums"
          style="color:var(--ef-text-faint);font-family:var(--ef-font-mono);font-size:10px;text-align:right;align-self:baseline;margin-top:4px"
        >
          {formatTs(message.ts)}
        </span>
        <div
          class="min-w-0 max-w-[72ch] break-words"
          style="color:var(--ef-text-secondary);font-family:var(--ef-font-body);font-size:var(--ef-text-small);line-height:1.55"
        >
          <span dangerouslySetInnerHTML={{ __html: body }} />
          <MessageAttachments attachments={message.attachments} />
        </div>
      </div>
    );
  }

  // Header row — first message of a group. Top margin between groups
  // for visual breathing room.
  const topMargin = previousMessage !== undefined ? 14 : 0;
  return (
    <div
      ref={rowRef}
      style={`display:grid;grid-template-columns:34px 1fr;gap:0 12px;padding:2px 0;margin-top:${topMargin}px${highlightStyle}`}
    >
      <span class="avatar" data-kind={kind ?? 'agent'} data-size="34" aria-hidden="true">
        {initials(sender)}
      </span>
      <div class="min-w-0 max-w-[72ch]">
        <div class="flex items-baseline flex-wrap" style="gap:8px;margin-bottom:2px">
          <span
            class={`${colorClass} font-display`}
            style="font-size:var(--ef-text-control);font-weight:var(--ef-weight-semibold);letter-spacing:-0.01em"
          >
            {sender}
          </span>
          {message.title && (
            <span style="font-family:var(--ef-font-mono);font-size:10.5px;letter-spacing:.08em;color:var(--ef-text-muted);text-transform:uppercase">
              [{message.title}]
            </span>
          )}
          <span
            class="tabular-nums"
            style="color:var(--ef-text-faint);font-family:var(--ef-font-mono);font-size:var(--ef-text-tag-xs)"
          >
            {formatTs(message.ts)}
          </span>
        </div>
        <div
          class="break-words"
          style="color:var(--ef-text-secondary);font-family:var(--ef-font-body);font-size:var(--ef-text-small);line-height:1.55"
        >
          <span dangerouslySetInnerHTML={{ __html: body }} />
          <MessageAttachments attachments={message.attachments} />
        </div>
      </div>
    </div>
  );
}
