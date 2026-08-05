/**
 * `useStickyBottom` — follow must re-engage when the consumer switches
 * lists.
 *
 * WHY THIS TEST DRIVES A STUBBED ELEMENT RATHER THAN A RENDERED
 * TRANSCRIPT. happy-dom has no layout engine: `scrollHeight` and
 * `clientHeight` are both `0` on every element. The hook's pinned test
 * is `scrollHeight - scrollTop - clientHeight < threshold`, which in
 * that environment reduces to `-scrollTop < 64` — **always true**. So a
 * component test here cannot reach the unpinned state at all, and would
 * pass against a hook that never re-pinned. Defining the three metrics
 * as real getters is what makes the failing state expressible.
 *
 * Measured, not assumed: a bare `div` in this environment reports
 * `scrollHeight = 0, clientHeight = 0` while `scrollTop` round-trips.
 */

import { act, render } from '@testing-library/preact';
import { useRef } from 'preact/hooks';
import { describe, expect, it } from 'vitest';
import { useStickyBottom } from '../src/lib/use-sticky-bottom.js';

/** A container with controllable scroll metrics. */
interface Metrics {
  scrollHeight: number;
  clientHeight: number;
}

function attachMetrics(el: HTMLElement, m: Metrics): void {
  Object.defineProperty(el, 'scrollHeight', { get: () => m.scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { get: () => m.clientHeight, configurable: true });
}

interface Seen {
  handle: ReturnType<typeof useStickyBottom> | null;
  el: HTMLDivElement | null;
}

/**
 * Let the hook's own `requestAnimationFrame` run.
 *
 * `scrollToBottom` sets a one-frame `programmatic` flag so its own
 * scroll event cannot disengage follow, and clears it on the next
 * frame. Until that frame runs, `onScroll` early-returns — so a test
 * that drives a scroll immediately after a pin is silently ignored and
 * measures nothing. Found by the first run of this file failing with
 * `isPinned` still true.
 */
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

interface ProbeProps {
  threadKey: string;
  metrics: Metrics;
  /** Receives the hook handle + the live element so the test can drive them. */
  onReady: (handle: ReturnType<typeof useStickyBottom>, el: HTMLDivElement | null) => void;
}

function Probe({ threadKey, metrics, onReady }: ProbeProps) {
  const handle = useStickyBottom({ resetKey: threadKey });
  const attached = useRef(false);
  const setEl = (el: HTMLDivElement | null): void => {
    handle.containerRef.current = el;
    if (el && !attached.current) {
      attached.current = true;
      attachMetrics(el, metrics);
    }
    onReady(handle, el);
  };
  return <div ref={setEl} onScroll={handle.onScroll} />;
}

describe('useStickyBottom across a list switch', () => {
  it('re-engages follow and returns to the bottom when resetKey changes', async () => {
    // A long thread: 5000px of content in a 500px viewport.
    const metrics: Metrics = { scrollHeight: 5000, clientHeight: 500 };
    // A holder rather than two `let`s: TypeScript narrows a `let`
    // assigned only inside a callback to `null` at every use site, so
    // `seen.handle?.isPinned` types as `never`. Object properties are not
    // narrowed that way.
    const seen: Seen = { handle: null, el: null };
    const onReady = (h: ReturnType<typeof useStickyBottom>, e: HTMLDivElement | null): void => {
      seen.handle = h;
      seen.el = e;
    };

    const { rerender } = render(<Probe threadKey="thread-a" metrics={metrics} onReady={onReady} />);

    // Baseline: the layout effect pinned us to the bottom.
    expect(seen.el).not.toBeNull();
    expect(seen.handle).not.toBeNull();
    expect(seen.el?.scrollTop).toBe(5000);

    // The viewer scrolls up to read history. 1200px from the bottom is
    // well past the 64px threshold, so follow disengages.
    await nextFrame();
    if (seen.el) seen.el.scrollTop = 3300;
    await act(async () => {
      seen.handle?.onScroll();
    });
    expect(seen.handle?.isPinned).toBe(false);

    // They switch to a different thread. The component re-renders with
    // a new key; it does NOT unmount, so every ref in the hook survives.
    rerender(<Probe threadKey="thread-b" metrics={metrics} onReady={onReady} />);

    // The claim: the new thread opens at its newest message, not at the
    // offset the previous thread left behind.
    expect(seen.el?.scrollTop).toBe(5000);
    expect(seen.handle?.isPinned).toBe(true);
  });

  it('leaves follow disengaged while the viewer stays on one list', async () => {
    // Positive control: the reset must be keyed to the switch, not fire
    // on every render. A hook that re-pinned unconditionally would pass
    // the test above and destroy the ability to read history at all.
    const metrics: Metrics = { scrollHeight: 5000, clientHeight: 500 };
    // A holder rather than two `let`s: TypeScript narrows a `let`
    // assigned only inside a callback to `null` at every use site, so
    // `seen.handle?.isPinned` types as `never`. Object properties are not
    // narrowed that way.
    const seen: Seen = { handle: null, el: null };
    const onReady = (h: ReturnType<typeof useStickyBottom>, e: HTMLDivElement | null): void => {
      seen.handle = h;
      seen.el = e;
    };

    const { rerender } = render(<Probe threadKey="thread-a" metrics={metrics} onReady={onReady} />);
    await nextFrame();
    if (seen.el) seen.el.scrollTop = 3300;
    await act(async () => {
      seen.handle?.onScroll();
    });
    expect(seen.handle?.isPinned).toBe(false);

    // Same thread, another render — an arrival, an edit, a status flip.
    rerender(<Probe threadKey="thread-a" metrics={metrics} onReady={onReady} />);

    expect(seen.handle?.isPinned).toBe(false);
    expect(seen.el?.scrollTop).toBe(3300);
  });
});
