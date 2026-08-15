/**
 * Session brackets on the agent timeline, and the capture accounting
 * they carry.
 *
 * `session_start` / `session_end` were stored from the beginning,
 * passed the timeline's own kind filter, and had no renderer at all —
 * `buildThread` silently skipped the kinds it did not know. The
 * consequence was not a missing decoration: `session_end.capture` is
 * the ONLY signal that a run's trace is incomplete, and it went to a
 * table nothing displayed.
 *
 * It cannot be recovered from the broker's side either. A dropped
 * event shrinks capture-health's denominator, so a member losing
 * events reads *healthier* — the runner's own count is the only
 * counter-evidence that exists.
 *
 * So these assert the rendered strings, not the thread builder alone,
 * and in both directions: a lossy run must say so, and a clean run
 * must not. A renderer that always warned would satisfy the first on
 * its own.
 */

import { cleanup, render, screen } from '@testing-library/preact';
import type { ActivityRow } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentTimeline, buildThread } from '../src/components/AgentTimeline.js';
import { memberActivityName, memberActivityRows } from '../src/lib/member-activity.js';

function row(id: number, event: ActivityRow['event']): ActivityRow {
  return { id, memberName: 'worker', event, createdAt: 1_700_000_000_000 };
}

const START = row(1, {
  kind: 'session_start',
  ts: 1_700_000_000_000,
  runner: 'claude',
  runnerVersion: '0.6.1',
});

const CLEAN_END = row(2, {
  kind: 'session_end',
  ts: 1_700_000_060_000,
  runner: 'claude',
  reason: 'agent-exited-0',
  exitCode: 0,
  durationMs: 60_000,
  capture: { enqueued: 40, uploaded: 40, dropped: 0 },
});

const LOSSY_END = row(3, {
  kind: 'session_end',
  ts: 1_700_000_060_000,
  runner: 'claude',
  reason: 'agent-exited-0',
  exitCode: 0,
  durationMs: 60_000,
  capture: { enqueued: 512, uploaded: 500, dropped: 12 },
});

const UNREPORTED_END = row(4, {
  kind: 'session_end',
  ts: 1_700_000_060_000,
  runner: 'codex',
  reason: 'agent-exited-0',
  exitCode: 0,
  durationMs: 60_000,
});

beforeEach(() => {
  memberActivityRows.value = [];
  memberActivityName.value = 'worker';
});

afterEach(() => {
  cleanup();
  memberActivityRows.value = [];
});

describe('thread mapping', () => {
  it('maps both brackets into renderable items instead of skipping them', () => {
    const thread = buildThread([START, CLEAN_END]);
    expect(thread.find((i) => i.variant === 'session-start')).toMatchObject({
      runner: 'claude',
      runnerVersion: '0.6.1',
    });
    expect(thread.find((i) => i.variant === 'session-end')).toMatchObject({
      runner: 'claude',
      reason: 'agent-exited-0',
      exitCode: 0,
      capture: { enqueued: 40, uploaded: 40, dropped: 0 },
    });
  });

  it('carries a missing capture block through as null, not as zero', () => {
    // "The runner did not report" and "the runner reported no loss"
    // are different facts, and collapsing them is how an incomplete
    // trace comes to look clean.
    const thread = buildThread([UNREPORTED_END]);
    expect(thread.find((i) => i.variant === 'session-end')).toMatchObject({ capture: null });
  });
});

describe('what a reader actually sees', () => {
  it('renders the session brackets at all', () => {
    memberActivityRows.value = [START, CLEAN_END];
    render(<AgentTimeline />);

    expect(screen.getByText(/session started/)).toBeTruthy();
    expect(screen.getByText(/session ended/)).toBeTruthy();
  });

  it('states in words that a run dropped events, and how many', () => {
    memberActivityRows.value = [START, LOSSY_END];
    render(<AgentTimeline />);

    // The count and the word both matter: a badge that only tinted the
    // row would be invisible to the reader this exists for.
    const warning = screen.getByText(/INCOMPLETE/);
    expect(warning).toBeTruthy();
    expect(warning.textContent).toContain('12');
    expect(warning.textContent).toContain('512');
  });

  it('does NOT warn on a run that captured everything', () => {
    // The positive control. Without it, a renderer that warned
    // unconditionally would pass the test above.
    memberActivityRows.value = [START, CLEAN_END];
    render(<AgentTimeline />);

    expect(screen.queryByText(/INCOMPLETE/)).toBeNull();
    expect(screen.getByText(/captured 40 events/)).toBeTruthy();
  });

  it('says capture was never reported rather than implying no loss', () => {
    memberActivityRows.value = [UNREPORTED_END];
    render(<AgentTimeline />);

    expect(screen.getByText(/capture not reported/)).toBeTruthy();
    expect(screen.queryByText(/INCOMPLETE/)).toBeNull();
    expect(screen.queryByText(/captured 0 events/)).toBeNull();
  });
});
