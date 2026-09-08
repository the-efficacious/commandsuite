/**
 * `auth_state` on the agent timeline — the row that explains a feed
 * that went quiet.
 *
 * The kind was emitted by the runner, accepted by the broker and
 * switched ON in the timeline's own default filter, and `buildThread`
 * had no case for it: every `auth_state` row fell through and drew
 * nothing. Two facts died there. A runner blocked on a 401 retains
 * its activity instead of shipping it, so the feed stops for a reason
 * that has nothing to do with the agent. And the retention queue is
 * bounded, so `evictedEvents` counts activity that is gone for good —
 * the same class of loss as `session_end.capture.dropped`, which the
 * session-brackets suite exists to make visible.
 *
 * So these assert the mapped item in full, and the rendered strings
 * in both directions: an eviction must say so with its count, and a
 * block that cost nothing must not warn. A renderer that always
 * warned would satisfy the first on its own.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { ActivityRow } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetAgentTimelineForTests,
  AgentTimeline,
  buildThread,
} from '../src/components/AgentTimeline.js';
import { memberActivityName, memberActivityRows } from '../src/lib/member-activity.js';

function row(id: number, event: ActivityRow['event']): ActivityRow {
  return { id, memberName: 'worker', event, createdAt: 1_700_000_000_000 };
}

const BLOCKED = row(1, {
  kind: 'auth_state',
  ts: 1_700_000_000_000,
  state: 'blocked',
  status: 401,
  queuedEvents: 7,
  queuedBytes: 2_048,
  evictedEvents: 0,
  evictedBytes: 0,
});

const LOSSY_RECOVERY = row(2, {
  kind: 'auth_state',
  ts: 1_700_000_060_000,
  state: 'recovered',
  status: 401,
  queuedEvents: 31,
  queuedBytes: 9_216,
  evictedEvents: 24,
  evictedBytes: 65_536,
});

const CLEAN_RECOVERY = row(3, {
  kind: 'auth_state',
  ts: 1_700_000_060_000,
  state: 'recovered',
  status: 401,
  queuedEvents: 12,
  queuedBytes: 4_096,
  evictedEvents: 0,
  evictedBytes: 0,
});

beforeEach(() => {
  __resetAgentTimelineForTests();
  memberActivityRows.value = [];
  memberActivityName.value = 'worker';
});

afterEach(() => {
  cleanup();
  memberActivityRows.value = [];
});

describe('thread mapping', () => {
  it('maps every auth_state row into a renderable item, counts and all', () => {
    const items = buildThread([BLOCKED, LOSSY_RECOVERY]).filter((i) => i.variant === 'auth-state');

    // Exact, not partial: a mapping that carried the state but
    // dropped the counts is the defect this closes, and a
    // `toMatchObject` on `{ state }` would wave it through.
    expect(items).toEqual([
      {
        key: 'r1-auth',
        variant: 'auth-state',
        ts: 1_700_000_000_000,
        state: 'blocked',
        queuedEvents: 7,
        evictedEvents: 0,
      },
      {
        key: 'r2-auth',
        variant: 'auth-state',
        ts: 1_700_000_060_000,
        state: 'recovered',
        queuedEvents: 31,
        evictedEvents: 24,
      },
    ]);
  });
});

describe('what a reader actually sees', () => {
  it('renders both ends of the block', () => {
    memberActivityRows.value = [BLOCKED, CLEAN_RECOVERY];
    render(<AgentTimeline />);

    expect(screen.getByText(/authentication blocked/)).toBeTruthy();
    expect(screen.getByText(/authentication recovered/)).toBeTruthy();
  });

  it('states in words that events were evicted while blocked, and how many', () => {
    memberActivityRows.value = [BLOCKED, LOSSY_RECOVERY];
    render(<AgentTimeline />);

    // The count and the word both matter: a row that only tinted
    // itself would be invisible to the reader this exists for.
    const warning = screen.getByText(/INCOMPLETE/);
    expect(warning.textContent).toContain('24');
  });

  it('does NOT warn when the block cost nothing', () => {
    // The positive control. Without it, a renderer that warned
    // unconditionally would pass the test above.
    memberActivityRows.value = [BLOCKED, CLEAN_RECOVERY];
    render(<AgentTimeline />);

    expect(screen.queryByText(/INCOMPLETE/)).toBeNull();
    expect(document.body.textContent ?? '').toContain('12 events retained');
  });

  it('is toggleable from the chip bar like every other rendered kind', () => {
    memberActivityRows.value = [BLOCKED];
    render(<AgentTimeline />);

    const chip = screen.getByRole('button', { name: 'auth' });
    fireEvent.click(chip);
    expect(screen.queryByText(/authentication blocked/)).toBeNull();

    fireEvent.click(chip);
    expect(screen.getByText(/authentication blocked/)).toBeTruthy();
  });
});
