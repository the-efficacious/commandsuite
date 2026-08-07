/**
 * The `context_control` row on the agent timeline.
 *
 * This file exists because of a specific house failure: a capture
 * health warning once shipped with seven passing tests on the function
 * that computed it, and deleting the badge from both screens that
 * rendered it left all seven green. The helper was proven; the thing a
 * person had to actually see was not.
 *
 * So this asserts the strings a reader must be able to read — the
 * verb, the outcome, who asked, and the framework's reason — against
 * the rendered component, not just the thread builder. The outcome in
 * particular must be TEXT: `applied` and `declined` cannot be
 * distinguishable only to someone who can tell two greys apart.
 */

import { cleanup, render, screen } from '@testing-library/preact';
import type { ActivityRow } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentTimeline, buildThread } from '../src/components/AgentTimeline.js';
import { memberActivityName, memberActivityRows } from '../src/lib/member-activity.js';

function row(id: number, event: ActivityRow['event']): ActivityRow {
  return { id, memberName: 'worker', event, createdAt: 1_700_000_000_000 };
}

const APPLIED = row(1, {
  kind: 'context_control',
  ts: 1_700_000_000_000,
  requestId: 'req-1',
  verb: 'compact',
  outcome: 'applied',
  requestedBy: 'director',
  tokens: { before: 25_920, after: 2_091 },
});

const DECLINED = row(2, {
  kind: 'context_control',
  ts: 1_700_000_000_100,
  requestId: 'req-2',
  verb: 'compact',
  outcome: 'declined',
  requestedBy: 'director',
  detail: 'Not enough messages to compact.',
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
  it('maps a context_control row into a renderable item, tokens and all', () => {
    const thread = buildThread([APPLIED]);
    const item = thread.find((i) => i.variant === 'context-control');
    expect(item).toMatchObject({
      variant: 'context-control',
      verb: 'compact',
      outcome: 'applied',
      requestedBy: 'director',
      tokens: { before: 25_920, after: 2_091 },
      detail: null,
    });
  });

  it('carries the decline reason through rather than dropping it', () => {
    const thread = buildThread([DECLINED]);
    expect(thread.find((i) => i.variant === 'context-control')).toMatchObject({
      outcome: 'declined',
      detail: 'Not enough messages to compact.',
      tokens: null,
    });
  });
});

describe('what a reader actually sees', () => {
  it('renders the verb, the outcome, the requester and the token delta', () => {
    memberActivityRows.value = [APPLIED];
    render(<AgentTimeline />);

    expect(screen.getByText(/context compact/)).toBeTruthy();
    // The outcome is rendered as a word. If this ever starts failing
    // because the outcome moved into a colour or an icon alone, that
    // is the regression, not the test.
    expect(screen.getByText('applied')).toBeTruthy();
    expect(screen.getByText(/by director/)).toBeTruthy();
    expect(screen.getByText(/25,920 → 2,091 tokens/)).toBeTruthy();
  });

  it('renders a decline with its reason verbatim', () => {
    memberActivityRows.value = [DECLINED];
    render(<AgentTimeline />);

    expect(screen.getByText('declined')).toBeTruthy();
    // The reason is the entire reason a decline is actionable.
    expect(screen.getByText('Not enough messages to compact.')).toBeTruthy();
  });

  it('renders a clear, and shows no token delta for it', () => {
    memberActivityRows.value = [
      row(3, {
        kind: 'context_control',
        ts: 1_700_000_000_000,
        requestId: 'req-3',
        verb: 'clear',
        outcome: 'applied',
        requestedBy: 'cora',
      }),
    ];
    render(<AgentTimeline />);

    expect(screen.getByText(/context clear/)).toBeTruthy();
    // A clear drops everything by construction, so a before/after
    // reading would be meaningless rather than merely absent.
    expect(screen.queryByText(/tokens/)).toBeNull();
  });

  it('renders `unsupported` distinctly from `declined`', () => {
    memberActivityRows.value = [
      row(4, {
        kind: 'context_control',
        ts: 1_700_000_000_000,
        requestId: 'req-4',
        verb: 'compact',
        outcome: 'unsupported',
        requestedBy: 'director',
        detail: 'the codex runner has no compaction operation',
      }),
    ];
    render(<AgentTimeline />);

    expect(screen.getByText('unsupported')).toBeTruthy();
    expect(screen.queryByText('declined')).toBeNull();
  });
});
