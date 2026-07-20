/**
 * useWindowedList — render only a trailing slice of a long list.
 *
 * Feeds in this app (chat transcript, activity timeline) keep their
 * full history in signals but only the tail is worth painting: a DM
 * with thousands of messages doesn't need thousands of DOM nodes when
 * the viewport shows ~30. This hook tracks how many trailing items to
 * render and grows that window one page at a time.
 *
 * Why a window instead of true virtualization: the feeds already have
 * bespoke scroll machinery (`useStickyBottom`, `data-scroll-anchor`
 * preservation, inspector→message `scrollIntoView`). A generic
 * virtual-list would need to own the scroll container and fight all
 * of it. A trailing window needs no height measurement and leaves the
 * existing scroll behavior completely intact — the consumer renders
 * `items.slice(-visibleCount)` and nothing else changes.
 *
 * `resetKey` collapses the window back to one page when the consumer
 * switches context (a new thread, a new agent). The reset runs during
 * render — the standard derived-state pattern — so there's no
 * one-frame flash of the previous context's oversized window.
 */

import { useCallback, useRef, useState } from 'preact/hooks';

/** Trailing items rendered on first paint / after a context switch. */
const DEFAULT_PAGE_SIZE = 80;

export interface UseWindowedListOptions {
  /** Items revealed per page, on first paint and per `showMore()`. */
  pageSize?: number;
  /**
   * Opaque value identifying the current context. When it changes,
   * the window snaps back to one page. Pass the thread key, agent
   * name, etc. — anything that means "this is now a different list."
   */
  resetKey?: unknown;
}

export interface WindowedList {
  /** How many trailing items to render — already clamped to `total`. */
  visibleCount: number;
  /** True when the window hides older items the consumer holds. */
  hasHidden: boolean;
  /** Grow the window by one page. */
  showMore: () => void;
}

export function useWindowedList(total: number, options: UseWindowedListOptions = {}): WindowedList {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const resetKey = options.resetKey;

  const [count, setCount] = useState(pageSize);

  // Reset-on-context-switch, evaluated during render. Calling the
  // setter during render is the supported Preact pattern for this —
  // it discards the in-progress output and re-renders synchronously,
  // so the consumer never paints the stale window even for one frame.
  const lastKey = useRef<unknown>(resetKey);
  if (resetKey !== lastKey.current) {
    lastKey.current = resetKey;
    setCount(pageSize);
  }

  const showMore = useCallback(() => {
    setCount((c) => c + pageSize);
  }, [pageSize]);

  return {
    visibleCount: Math.min(count, total),
    hasHidden: total > count,
    showMore,
  };
}
