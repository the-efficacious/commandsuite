/**
 * One message in the transcript.
 *
 * Two rendering modes:
 *
 *   1. **Header row** — the first message in a group. Full layout:
 *      `[HH:MM] SENDER: inline-markdown-body`. Gets a small top
 *      margin when there's a previous message, so groups breathe.
 *
 *   2. **Continuation row** — a follow-up from the same sender
 *      within a short window. Hides the sender (that's the
 *      redundant bit that makes bursts noisy) but keeps the
 *      timestamp so per-row timing stays visible — a same-sender
 *      burst can span seconds or minutes and the reader shouldn't
 *      have to guess. Timestamps render in the same font-mono
 *      gutter as the header so the HH:MM column lines up vertically.
 *
 * Grouping rules (computed in `isContinuationOf`):
 *   - same `from` name
 *   - same `level` (an info message next to an `error` never groups)
 *   - no `title` on either message (titled messages are distinct)
 *   - the gap between `ts` values is ≤ 5 minutes
 *
 * Sender name is colored by `senderTextClass` — green for the viewer,
 * coyote tan for every teammate — so "me vs them" is obvious at a
 * glance. The body runs through `renderInlineMarkdown`, which escapes
 * HTML before applying any formatting — safe for
 * `dangerouslySetInnerHTML`.
 */

import type { Message } from 'csuite-sdk/types';
import { useEffect, useRef } from 'preact/hooks';
import { renderInlineMarkdown } from '../lib/markdown.js';
import { selectedThreadMessageId } from '../lib/messages.js';
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

export function MessageLine({ message, viewer, previousMessage }: MessageLineProps) {
  const sender = message.from ?? '?';
  const colorClass = senderTextClass(sender, viewer);
  const body = renderInlineMarkdown(message.body);

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
    ? ';background:var(--ice);box-shadow:-3px 0 0 var(--steel);border-radius:0 4px 4px 0;transition:background .2s,box-shadow .2s'
    : ';transition:background .2s,box-shadow .2s';

  // Two-column row: a fixed timestamp gutter on the left and the
  // message column on the right. Putting the body in its own flex
  // child means long messages wrap *within* that column instead of
  // flowing back to the container's left edge, so second-line text
  // naturally aligns with the first line. Continuation and header
  // rows use the exact same gutter width so timestamps line up
  // vertically across a burst.
  //
  // `max-w-[72ch]` on the body column caps line length at roughly
  // the 65–75ch readability sweet spot. The gutter sits outside that
  // cap, so the full row can still be wider than 72ch on desktop.
  //
  // `min-w-0` on the body column is the flex-child "don't let long
  // tokens blow out the parent" trick — without it, a very long
  // unbroken URL or codeblock pushes the gutter off-screen.
  // Below the `sm` breakpoint the timestamp collapses into an inline
  // prefix on the body (`hh:mm ·`) instead of its own gutter column —
  // on a 320px viewport the gutter was eating ~40px and crushing the
  // body to <140px. At sm+ (≥640px) the two-column gutter is restored.
  if (isContinuation) {
    return (
      <div
        ref={rowRef}
        class="sm:flex sm:gap-3"
        style={`padding:2px 0;line-height:1.55;font-family:var(--f-sans);font-size:14.5px${highlightStyle}`}
      >
        <span
          class="hidden sm:inline flex-shrink-0 tabular-nums"
          style="color:var(--muted);font-family:var(--f-mono);font-size:11.5px;margin-top:3px"
        >
          {formatTs(message.ts)}
        </span>
        <div class="flex-1 min-w-0 max-w-[72ch] break-words" style="color:var(--ink)">
          <span
            class="sm:hidden tabular-nums"
            style="color:var(--muted);font-family:var(--f-mono);font-size:11px;margin-right:8px"
          >
            {formatTs(message.ts)}
          </span>
          <span dangerouslySetInnerHTML={{ __html: body }} />
          <MessageAttachments attachments={message.attachments} />
        </div>
      </div>
    );
  }

  // Header row — first message of a group. Top margin between groups
  // for visual breathing room.
  const topMargin = previousMessage !== undefined ? 12 : 0;
  return (
    <div
      ref={rowRef}
      class="sm:flex sm:gap-3"
      style={`padding:2px 0;margin-top:${topMargin}px;line-height:1.55;font-family:var(--f-sans);font-size:14.5px${highlightStyle}`}
    >
      <span
        class="hidden sm:inline flex-shrink-0 tabular-nums"
        style="color:var(--muted);font-family:var(--f-mono);font-size:11.5px;margin-top:3px"
      >
        {formatTs(message.ts)}
      </span>
      <div class="flex-1 min-w-0 max-w-[72ch] break-words" style="color:var(--ink)">
        <span
          class="sm:hidden tabular-nums"
          style="color:var(--muted);font-family:var(--f-mono);font-size:11px;margin-right:8px"
        >
          {formatTs(message.ts)}
        </span>
        <span
          class={`${colorClass} font-display`}
          style="font-weight:700;letter-spacing:-0.01em;margin-right:8px"
        >
          {sender}
        </span>
        {message.title && (
          <span style="font-family:var(--f-mono);font-size:10.5px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase;margin-right:8px">
            [{message.title}]
          </span>
        )}
        <span dangerouslySetInnerHTML={{ __html: body }} />
        <MessageAttachments attachments={message.attachments} />
      </div>
    </div>
  );
}
