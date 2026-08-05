/**
 * useStickyBottom — keep a scroll container pinned to the bottom edge
 * unless the user has manually scrolled up.
 *
 * Standard chat-app behavior: while the viewport is at (or within
 * `threshold` px of) the bottom, every render that grows the content
 * scrolls the user along so the latest item stays visible. Once the
 * user scrolls up by more than `threshold`, follow disengages — new
 * arrivals no longer yank the viewport — and a "jump to bottom"
 * affordance can be shown via `isPinned === false`. Returning to the
 * bottom by hand re-engages follow automatically.
 *
 * Three subtleties that naive implementations get wrong:
 *
 *   1. **Stale length deps.** Effects keyed on `messages.length` miss
 *      content updates that don't change array length (streaming
 *      messages growing in place, edits, status flips). This hook
 *      runs the pin-scroll on *every* consumer render — the scroll
 *      set is a no-op when already at the bottom, so it's safe and
 *      catches every kind of change.
 *
 *   2. **Late layout shift.** Avatars, markdown, embedded media all
 *      grow `scrollHeight` *after* the layout effect ran. A
 *      `ResizeObserver` on the scroll container catches that and
 *      re-scrolls (only while pinned).
 *
 *   3. **Programmatic-scroll feedback.** Setting `scrollTop` fires a
 *      `scroll` event. Without suppression, the handler would
 *      recompute `gap` from a transient mid-scroll position and
 *      possibly disengage follow. We mark the next scroll event as
 *      ours via a one-frame flag.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

export interface UseStickyBottomOptions {
  /** Treat a gap-from-bottom less than this many px as "pinned." */
  threshold?: number;
  /**
   * Opaque value identifying the list being scrolled. When it changes,
   * follow re-engages and the viewport snaps to the bottom of the new
   * content.
   *
   * WHY THIS IS NOT OPTIONAL IN PRACTICE. Consumers switch lists
   * without unmounting — `Transcript` re-renders with a new
   * `threadKey`, it does not remount — so every ref in this hook
   * survives the switch, including `pinnedRef`. A viewer who scrolled
   * up to read history in thread A leaves `pinnedRef` false; thread B
   * then renders with follow disengaged and the container keeps A's
   * `scrollTop` across the children swap, so B opens partway up, at an
   * offset bounded by A's content height.
   *
   * "The user chose to read history" is a fact about the list they
   * were reading. It must not outlive that list.
   *
   * Pass the same value you pass to `useWindowedList`'s `resetKey`.
   */
  resetKey?: unknown;
}

export interface StickyBottomHandle {
  /** Attach to the scrollable container element. */
  containerRef: { current: HTMLDivElement | null };
  /** Wire to the container's `onScroll` prop. */
  onScroll: () => void;
  /** True while the user is at (or near) the bottom. */
  isPinned: boolean;
  /** Programmatically scroll to bottom and re-engage follow. */
  jumpToBottom: () => void;
}

const DEFAULT_THRESHOLD_PX = 64;

export function useStickyBottom(options: UseStickyBottomOptions = {}): StickyBottomHandle {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD_PX;
  const containerRef = useRef<HTMLDivElement | null>(null);
  // pinnedRef and isPinned are kept in sync. The ref is read by
  // layout effects + observers (no re-render needed); the state is
  // read by JSX so the consumer can render the jump button.
  const pinnedRef = useRef(true);
  const [isPinned, setIsPinned] = useState(true);
  // Set by `scrollToBottom`, cleared on the next animation frame so
  // the resulting `scroll` event doesn't disengage follow.
  const programmaticRef = useRef(false);

  const setPinned = useCallback((next: boolean): void => {
    if (pinnedRef.current === next) return;
    pinnedRef.current = next;
    setIsPinned(next);
  }, []);

  const computePinned = useCallback((): boolean => {
    const el = containerRef.current;
    if (!el) return true;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    return gap < threshold;
  }, [threshold]);

  const scrollToBottom = useCallback((): void => {
    const el = containerRef.current;
    if (!el) return;
    programmaticRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      programmaticRef.current = false;
    });
  }, []);

  const onScroll = useCallback((): void => {
    if (programmaticRef.current) return;
    setPinned(computePinned());
  }, [computePinned, setPinned]);

  // Re-engage follow when the consumer switches lists. Evaluated
  // during render, before the layout effect below reads `pinnedRef`,
  // so the switch renders pinned rather than pinned-one-frame-late.
  // Mirrors `useWindowedList`'s reset-during-render for the same
  // reason: no frame of the previous context's state.
  // `setPinned` rather than assigning `pinnedRef` directly: it updates
  // the ref AND the state, and the state drives the jump-to-bottom
  // affordance. Setting only the ref would re-engage follow while
  // leaving the button rendered on a thread that is at its bottom.
  const lastResetKey = useRef<unknown>(options.resetKey);
  if (options.resetKey !== lastResetKey.current) {
    lastResetKey.current = options.resetKey;
    setPinned(true);
  }

  // Pre-paint scroll-pin: runs on every render of the consumer.
  // Setting `scrollTop` to the current bottom is a no-op when the
  // viewport is already there, so this is safe to do unconditionally
  // while pinned. Using useLayoutEffect (vs useEffect) avoids the
  // one-frame flicker where new content paints at the old scrollTop
  // before the browser paints the corrected scrollTop.
  useLayoutEffect(() => {
    if (!pinnedRef.current) return;
    scrollToBottom();
  });

  // Layout-shift catcher: late-loading avatars / markdown / images
  // grow scrollHeight after the layout effect fires. Re-scroll on
  // every observed resize while pinned.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) scrollToBottom();
      else setPinned(computePinned());
    });
    ro.observe(el);
    // Also observe the first child so growth of inner content
    // triggers the callback even when the container itself has a
    // fixed flex-basis height.
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [computePinned, scrollToBottom, setPinned]);

  const jumpToBottom = useCallback((): void => {
    setPinned(true);
    scrollToBottom();
  }, [scrollToBottom, setPinned]);

  return { containerRef, onScroll, isPinned, jumpToBottom };
}
