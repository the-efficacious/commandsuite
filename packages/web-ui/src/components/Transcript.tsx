/**
 * Transcript — scrolling message list for the current thread.
 *
 * Reads from the `messagesByThread` signal and the `view`
 * signal; both drive re-renders on change. Auto-scrolls to bottom
 * when a new message arrives AND the user is already near the bottom
 * — lets the user read history without being yanked back.
 *
 * Only the trailing window of the thread is painted (see
 * `useWindowedList`) — a large DM would otherwise mount thousands of
 * `MessageLine`s, each running inline-markdown rendering, on every
 * open. The "load older" bar at the top first reveals more of what's
 * already in memory, then pages older history from the server via
 * `thread-history`. The thread's first page is fetched on open by
 * `hydrateThread`, since the live backfill is not thread-scoped.
 */

import { useEffect } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import { isInspectorOpen, toggleInspector } from '../lib/inspector.js';
import {
  dmOther,
  messagesByThread,
  PRIMARY_THREAD,
  selectThreadMessage,
  threadMessages,
} from '../lib/messages.js';
import {
  hydrateThread,
  loadOlderThreadMessages,
  threadHistoryState,
} from '../lib/thread-history.js';
import { useStickyBottom } from '../lib/use-sticky-bottom.js';
import { useWindowedList } from '../lib/use-windowed-list.js';
import { selectAgentDetail, view } from '../lib/view.js';
import { ChevronsDown, PanelRight } from './icons/index.js';
import { MessageLine } from './MessageLine.js';

export interface TranscriptProps {
  viewer: string;
}

export function Transcript({ viewer }: TranscriptProps) {
  // Subscribe to both signals by reading them in the render body.
  const v = view.value;
  const _map = messagesByThread.value;
  void _map;
  const b = briefing.value;
  const isDirector = b?.permissions.includes('members.manage') ?? false;

  const threadKey = v.kind === 'thread' ? v.key : null;
  const messages = threadKey ? threadMessages(threadKey) : [];
  const dmCounterpart = threadKey !== null ? dmOther(threadKey) : null;
  const showDmHeader =
    dmCounterpart !== null && dmCounterpart !== 'self' && dmCounterpart !== viewer;

  // Sticky-to-bottom: the hook re-pins on every render of this
  // component, which fires on any signal mutation that touches
  // messages or the view — covering arrivals, edits, status flips,
  // and thread switches uniformly.
  const { containerRef, onScroll, isPinned, jumpToBottom } = useStickyBottom();

  // Trailing render window. `resetKey` collapses it back to one page
  // when the viewer switches threads, so a long DM doesn't re-mount
  // its whole backlog. `previousMessage` for grouping is still taken
  // from the *full* array so a continuation row that straddles the
  // window boundary keeps its grouping.
  const win = useWindowedList(messages.length, { resetKey: threadKey });
  const windowStart = messages.length - win.visibleCount;
  const windowed = messages.slice(windowStart);

  // Paging state for the "load older" bar: more in memory, or more on
  // the server, or neither (bar hidden).
  const hist = threadKey !== null ? threadHistoryState(threadKey) : null;
  const canLoadOlder = win.hasHidden || (hist !== null && !hist.exhausted);

  // Reveal older messages without the viewport jumping. Prepending
  // content above the fold shifts everything down by the new content's
  // height; capture the scroll metrics first and restore the same
  // relative position once the new rows have painted.
  const onLoadOlder = async (): Promise<void> => {
    const el = containerRef.current;
    const before = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    if (win.hasHidden) {
      win.showMore();
    } else if (threadKey !== null) {
      await loadOlderThreadMessages(viewer, threadKey);
    }
    if (el && before) {
      requestAnimationFrame(() => {
        el.scrollTop = before.top + (el.scrollHeight - before.height);
      });
    }
  };

  // Drop any inspector → thread selection when navigating away from
  // the thread it was anchored to. The selected message id is opaque
  // across threads, so leaving it set would highlight nothing
  // visible and confuse a return visit.
  useEffect(() => {
    selectThreadMessage(null);
  }, [threadKey]);

  // Fetch the thread's own first page on open. The live backfill is a
  // global recent-window, so a quiet DM can be entirely absent from
  // it; `hydrateThread` is idempotent (guarded by a `hydrated` flag).
  useEffect(() => {
    if (threadKey !== null) void hydrateThread(viewer, threadKey);
  }, [threadKey, viewer]);

  if (v.kind !== 'thread' || threadKey === null) return null;

  return (
    <div class="flex-1 flex flex-col min-h-0">
      {/* DM header — only for direct-message threads with another
          user (not primary, not obj:<id>, not self). Shows the
          counterpart name and, for directors, a link to that user's
          detail page. */}
      {showDmHeader && dmCounterpart && (
        <div
          class="flex items-center justify-between flex-shrink-0"
          style="background:var(--ice);border-bottom:1px solid var(--rule);padding:10px max(0.75rem,env(safe-area-inset-right)) 10px max(0.75rem,env(safe-area-inset-left));gap:10px"
        >
          <div class="eyebrow flex-1 min-w-0 truncate">
            DM with <span style="color:var(--ink)">{dmCounterpart}</span>
          </div>
          {isDirector && (
            <button
              type="button"
              onClick={() => selectAgentDetail(dmCounterpart)}
              class="eyebrow text-link"
              style="padding:4px 8px"
            >
              → VIEW AGENT
            </button>
          )}
          {/* Inspector toggle — visible only at narrow widths where the
              inspector is an overlay; CSS hides it at ≥1100. */}
          <button
            type="button"
            onClick={toggleInspector}
            class="inspector-toggle items-center justify-center"
            aria-label={
              isInspectorOpen.value ? 'Close activity inspector' : 'Open activity inspector'
            }
            aria-pressed={isInspectorOpen.value}
            title="Activity inspector"
            style={`width:32px;height:32px;background:${isInspectorOpen.value ? 'var(--paper)' : 'transparent'};border:1px solid ${isInspectorOpen.value ? 'var(--rule)' : 'transparent'};color:${isInspectorOpen.value ? 'var(--steel)' : 'var(--graphite)'};border-radius:var(--r-sm);cursor:pointer;flex-shrink:0`}
          >
            <PanelRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      <div class="flex-1 min-h-0" style="position:relative">
        <div
          ref={containerRef}
          onScroll={onScroll}
          aria-live="polite"
          aria-atomic="false"
          class="overflow-y-auto"
          style="position:absolute;inset:0;background:var(--paper);padding:18px max(0.75rem,env(safe-area-inset-right)) 18px max(0.75rem,env(safe-area-inset-left));-webkit-overflow-scrolling:touch;overscroll-behavior:none;touch-action:manipulation"
        >
          {messages.length === 0 ? (
            <EmptyState threadKey={threadKey} />
          ) : (
            <>
              {canLoadOlder && (
                <div class="flex justify-center" style="padding:2px 0 10px">
                  <button
                    type="button"
                    onClick={() => void onLoadOlder()}
                    disabled={hist?.loading ?? false}
                    class="btn btn-ghost btn-sm"
                  >
                    {hist?.loading ? 'Loading…' : '↑ Load older messages'}
                  </button>
                </div>
              )}
              {windowed.map((m, i) => {
                const prev = messages[windowStart + i - 1];
                return (
                  <MessageLine
                    key={m.id}
                    message={m}
                    viewer={viewer}
                    {...(prev ? { previousMessage: prev } : {})}
                  />
                );
              })}
            </>
          )}
        </div>
        {!isPinned && messages.length > 0 && (
          <button
            type="button"
            onClick={jumpToBottom}
            aria-label="Jump to latest message"
            title="Jump to latest"
            style="position:absolute;right:14px;bottom:14px;width:36px;height:36px;border-radius:9999px;background:var(--paper);border:1px solid var(--rule);color:var(--ink);box-shadow:0 4px 12px rgba(0,0,0,0.12);cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:2"
          >
            <ChevronsDown size={18} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Empty-state copy varies by thread type so new users aren't left
 * staring at "net is quiet" on a DM they just opened and wondering
 * if the app is broken. `min-h-full` pins the message to the vertical
 * center of the scroll region so the first arrival doesn't push it
 * offscreen before the user can read it.
 */
function EmptyState({ threadKey }: { threadKey: string }) {
  if (threadKey === PRIMARY_THREAD) {
    return (
      <div class="min-h-full flex items-center justify-center">
        <div class="empty" style="border:none;background:transparent;padding:24px">
          <p>◇ Net is quiet</p>
        </div>
      </div>
    );
  }
  const other = dmOther(threadKey);
  if (other !== null && other !== 'self') {
    return (
      <div class="min-h-full flex items-center justify-center" style="padding:0 16px">
        <div class="empty" style="border:none;background:transparent;padding:24px">
          <p>
            ◇ No messages yet with <span style="color:var(--steel);font-weight:600">@{other}</span>{' '}
            — send one below to start
          </p>
        </div>
      </div>
    );
  }
  return (
    <div class="min-h-full flex items-center justify-center">
      <div class="empty" style="border:none;background:transparent;padding:24px">
        <p>◇ No messages yet</p>
      </div>
    </div>
  );
}
