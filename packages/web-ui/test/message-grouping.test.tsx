/**
 * Tests for consecutive-same-sender message grouping.
 *
 * Two layers:
 *
 *   1. `isContinuationOf` — pure predicate. Exhaustive matrix of the
 *      grouping rules: same-sender, same-level, no-titles,
 *      within-window, forward-in-time.
 *
 *   2. `<MessageLine />` render — verifies that headers and
 *      continuations produce visually-distinct DOM (header shows
 *      timestamp + sender; continuation hides both), and that
 *      header-with-previous gets the margin-top breathing class
 *      while the first message of a thread does not.
 */

import { render } from '@testing-library/preact';
import type { Message } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { isContinuationOf, MessageLine } from '../src/components/MessageLine.js';

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id ?? 'm1',
    ts: 1_700_000_000_000,
    to: null,
    from: 'przy-1',
    title: null,
    body: 'hello',
    level: 'info',
    data: {},
    attachments: [],
    ...overrides,
  };
}

describe('isContinuationOf', () => {
  it('groups consecutive messages from the same sender within 5 minutes', () => {
    const prev = msg({ id: 'a', ts: 1_700_000_000_000 });
    const next = msg({ id: 'b', ts: 1_700_000_000_000 + 60_000 });
    expect(isContinuationOf(next, prev)).toBe(true);
  });

  it('does not group when the sender changes', () => {
    const prev = msg({ id: 'a', from: 'przy-1' });
    const next = msg({ id: 'b', from: 'test-agent-1' });
    expect(isContinuationOf(next, prev)).toBe(false);
  });

  it('does not group when the level changes', () => {
    const prev = msg({ id: 'a', level: 'info' });
    const next = msg({ id: 'b', level: 'warning' });
    expect(isContinuationOf(next, prev)).toBe(false);
  });

  it('does not group when either message has a title', () => {
    const prev = msg({ id: 'a', title: 'deploy' });
    const next = msg({ id: 'b', title: null });
    expect(isContinuationOf(next, prev)).toBe(false);

    const prev2 = msg({ id: 'a', title: null });
    const next2 = msg({ id: 'b', title: 'status' });
    expect(isContinuationOf(next2, prev2)).toBe(false);
  });

  it('does not group when the time gap exceeds 5 minutes', () => {
    const prev = msg({ id: 'a', ts: 1_700_000_000_000 });
    const next = msg({ id: 'b', ts: 1_700_000_000_000 + 6 * 60_000 });
    expect(isContinuationOf(next, prev)).toBe(false);
  });

  it('groups messages exactly at the 5-minute boundary', () => {
    const prev = msg({ id: 'a', ts: 1_700_000_000_000 });
    const next = msg({ id: 'b', ts: 1_700_000_000_000 + 5 * 60_000 });
    expect(isContinuationOf(next, prev)).toBe(true);
  });

  it('does not group backwards-in-time messages (out-of-order reconnect backfill)', () => {
    const prev = msg({ id: 'a', ts: 1_700_000_000_000 + 60_000 });
    const next = msg({ id: 'b', ts: 1_700_000_000_000 });
    expect(isContinuationOf(next, prev)).toBe(false);
  });

  it('does not group when either sender is null (system messages)', () => {
    const prev = msg({ id: 'a', from: null });
    const next = msg({ id: 'b', from: null });
    expect(isContinuationOf(next, prev)).toBe(false);
  });
});

describe('<MessageLine /> rendering modes', () => {
  it('renders a full header when there is no previous message (first of thread)', () => {
    const { container } = render(
      <MessageLine message={msg({ id: 'a', body: 'first' })} viewer="me" />,
    );
    expect(container.textContent).toMatch(/przy-1/);
    expect(container.textContent).toMatch(/first/);
    // Timestamp element — any HH:MM format. Just check for a digit pair.
    expect(container.textContent).toMatch(/\d\d:\d\d/);
    // No top margin on the first message of a thread.
    expect(container.firstElementChild?.className).not.toMatch(/\bmt-3\b/);
  });

  it('renders a continuation (timestamp kept, sender hidden) when previous is same sender within window', () => {
    const prev = msg({ id: 'a', ts: 1_700_000_000_000, body: 'first' });
    const next = msg({ id: 'b', ts: 1_700_000_000_000 + 60_000, body: 'second' });
    const { container } = render(<MessageLine message={next} viewer="me" previousMessage={prev} />);
    // Body is still rendered.
    expect(container.textContent).toMatch(/second/);
    // Sender is NOT rendered (that's the redundancy we're collapsing).
    expect(container.textContent).not.toMatch(/przy-1/);
    // Timestamp IS rendered — per-row timing is load-bearing info.
    expect(container.textContent).toMatch(/\d\d:\d\d/);
    // No top margin (continuations stay tight).
    expect(container.firstElementChild?.className).not.toMatch(/\bmt-3\b/);
  });

  it('continuation timestamp reflects the continuation message, not the header', () => {
    // Burst across a visible time gap — the continuation should show
    // its own HH:MM so readers see when each line actually landed.
    const prev = msg({
      id: 'a',
      // 12:00:00 local — but tests run in whatever timezone the CI is
      // in, so we compute both timestamps from a known base and only
      // assert on the relative minute value.
      ts: new Date(2024, 0, 1, 12, 0, 0).getTime(),
      body: 'starting',
    });
    const next = msg({
      id: 'b',
      ts: new Date(2024, 0, 1, 12, 3, 0).getTime(),
      body: 'still going',
    });
    const { container } = render(<MessageLine message={next} viewer="me" previousMessage={prev} />);
    // The continuation row's timestamp is 12:03, not 12:00.
    expect(container.textContent).toMatch(/12:03/);
    expect(container.textContent).not.toMatch(/12:00/);
  });

  it('renders a new header (with top margin) when previous exists but is a different sender', () => {
    const prev = msg({ id: 'a', from: 'przy-1', body: 'first' });
    const next = msg({ id: 'b', from: 'test-agent-1', body: 'second' });
    const { container } = render(<MessageLine message={next} viewer="me" previousMessage={prev} />);
    // New sender shown.
    expect(container.textContent).toMatch(/test-agent-1/);
    expect(container.textContent).not.toMatch(/przy-1/);
    // Top margin applied after an earlier one (inline style, not class).
    const styleAttr = container.firstElementChild?.getAttribute('style') ?? '';
    expect(styleAttr).toMatch(/margin-top:\s*12px/);
  });

  it('renders a new header when the time gap is too large even with same sender', () => {
    const prev = msg({ id: 'a', ts: 1_700_000_000_000, body: 'first' });
    const next = msg({ id: 'b', ts: 1_700_000_000_000 + 10 * 60_000, body: 'second' });
    const { container } = render(<MessageLine message={next} viewer="me" previousMessage={prev} />);
    // Header re-rendered.
    expect(container.textContent).toMatch(/przy-1/);
    expect(container.textContent).toMatch(/\d\d:\d\d/);
  });

  it('renders a header for titled messages even inside a same-sender burst', () => {
    const prev = msg({ id: 'a', body: 'first' });
    const next = msg({ id: 'b', body: 'second', title: 'status' });
    const { container } = render(<MessageLine message={next} viewer="me" previousMessage={prev} />);
    expect(container.textContent).toMatch(/\[status\]/);
    expect(container.textContent).toMatch(/przy-1/);
  });

  it('renders a header for non-info levels even inside a same-sender burst', () => {
    const prev = msg({ id: 'a', level: 'info' });
    const next = msg({ id: 'b', level: 'warning', body: 'heads up' });
    const { container } = render(<MessageLine message={next} viewer="me" previousMessage={prev} />);
    expect(container.textContent).toMatch(/przy-1/);
    expect(container.textContent).toMatch(/heads up/);
  });
});
