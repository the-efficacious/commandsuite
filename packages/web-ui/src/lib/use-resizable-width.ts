/**
 * useResizableWidth — pointer-driven drag-to-resize for a panel.
 *
 * Returns the current width (px) plus a `startResize` handler the
 * consumer wires to a grab-handle element's `pointerdown`. Persists
 * width to localStorage by `storageKey` so the user's choice survives
 * reloads, and re-clamps on viewport resize so a stored 800px width
 * doesn't eat the chat when the user opens the page on a narrower
 * screen.
 *
 * Drag direction: `edge: 'left'` means the handle sits on the left
 * edge of a right-anchored panel — dragging left widens (because the
 * panel is grabbing space from its left neighbor). `'right'` is the
 * mirror for a left-anchored panel.
 *
 * Body cursor + user-select are forced to `col-resize` / `none` while
 * dragging so the cursor doesn't flicker over child elements with
 * their own cursor styles, and a stray drag past a text node doesn't
 * paint a selection.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export interface UseResizableWidthOptions {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  /**
   * Hard ceiling on width. The hook re-clamps on viewport resize so
   * a stored width above the new max gets pulled back in. Pass a
   * function for viewport-relative caps (e.g. `() => Math.min(720,
   * window.innerWidth - 480)` to leave at least 480px for the chat).
   */
  maxWidth: number | (() => number);
  edge: 'left' | 'right';
}

export interface ResizableWidthHandle {
  width: number;
  isResizing: boolean;
  startResize: (event: PointerEvent) => void;
  /** Adjust the width by `delta` px and persist. Used by keyboard arrows. */
  nudge: (delta: number) => void;
  /** Current resolved max — exposed so consumers can publish aria-valuemax. */
  maxResolved: number;
}

function clamp(n: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function readStored(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* quota / privacy mode — silent */
  }
}

export function useResizableWidth(options: UseResizableWidthOptions): ResizableWidthHandle {
  const { storageKey, defaultWidth, minWidth, maxWidth, edge } = options;
  const resolveMax = useCallback(
    (): number => (typeof maxWidth === 'function' ? maxWidth() : maxWidth),
    [maxWidth],
  );

  const [width, setWidth] = useState<number>(() => {
    const stored = readStored(storageKey);
    const initial = stored ?? defaultWidth;
    // First clamp uses a best-effort max — if the function reads
    // `window.innerWidth` it'll work in the browser; SSR-safe paths
    // would fall back to `defaultWidth` here.
    if (typeof window === 'undefined') return defaultWidth;
    return clamp(initial, minWidth, resolveMax());
  });
  const [isResizing, setIsResizing] = useState(false);
  const dragStartRef = useRef<{ pointerX: number; startWidth: number } | null>(null);

  const startResize = useCallback(
    (event: PointerEvent) => {
      event.preventDefault();
      dragStartRef.current = { pointerX: event.clientX, startWidth: width };
      setIsResizing(true);
    },
    [width],
  );

  // Pointermove / pointerup live on `window` so the drag continues
  // even when the cursor leaves the small handle element. Listeners
  // are mounted only while resizing.
  useEffect(() => {
    if (!isResizing) return;
    const onMove = (e: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const dx = e.clientX - start.pointerX;
      // For a right-anchored panel with handle on the LEFT edge,
      // dragging left (negative dx) should widen the panel.
      const next = clamp(start.startWidth + (edge === 'left' ? -dx : dx), minWidth, resolveMax());
      setWidth(next);
    };
    const onEnd = () => {
      const final = dragStartRef.current;
      dragStartRef.current = null;
      setIsResizing(false);
      // Persist the final width — read it from state via a
      // functional update so we capture the latest value.
      setWidth((w) => {
        writeStored(storageKey, w);
        void final;
        return w;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
  }, [isResizing, edge, minWidth, resolveMax, storageKey]);

  // Force the document-level cursor + suppress text selection while
  // dragging so the experience stays smooth across child elements.
  useEffect(() => {
    if (!isResizing) return;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [isResizing]);

  // Re-clamp on viewport resize. A user who stored 800px on a wide
  // monitor and reopens the page on a 1100px screen should get
  // pulled back to a sane width rather than eating the entire row.
  useEffect(() => {
    const onResize = () => {
      setWidth((w) => clamp(w, minWidth, resolveMax()));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [minWidth, resolveMax]);

  const nudge = useCallback(
    (delta: number) => {
      setWidth((w) => {
        const next = clamp(w + delta, minWidth, resolveMax());
        writeStored(storageKey, next);
        return next;
      });
    },
    [minWidth, resolveMax, storageKey],
  );

  return { width, isResizing, startResize, nudge, maxResolved: resolveMax() };
}
