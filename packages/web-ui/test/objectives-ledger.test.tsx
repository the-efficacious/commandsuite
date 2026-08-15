/**
 * ObjectivesPanel ledger render tests.
 *
 * Covers the grouping contract the redesign introduced:
 *   - live work (active + blocked) renders above the fold, blocked first
 *   - closed work stays collapsed behind the disclosure until asked for
 *   - the header counts live work only — done/cancelled never inflate it
 *   - the Mine filter scopes to the viewer's assignments
 *   - a live row wears the objective thread's unread count-badge
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { InstructionsResponse, Message, Objective } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetObjectivesPanelForTests,
  ObjectivesPanel,
} from '../src/components/ObjectivesPanel.js';
import { instructions } from '../src/lib/instructions.js';
import {
  __resetMessagesForTests,
  messagesByThread,
  objectiveThreadKey,
} from '../src/lib/messages.js';
import { __resetObjectivesForTests, objectives, objectivesLoaded } from '../src/lib/objectives.js';
import { __resetUnreadForTests } from '../src/lib/unread.js';

const VIEWER = 'director-1';

const PACKET: InstructionsResponse = {
  name: VIEWER,
  role: { title: 'director', description: '' },
  permissions: ['members.manage', 'objectives.create'],
  team: { name: 'demo-team', context: '', permissionPresets: {} },
  teammates: [
    { name: VIEWER, role: { title: 'director', description: '' }, permissions: [] },
    { name: 'engineer-1', role: { title: 'engineer', description: '' }, permissions: [] },
    { name: 'engineer-2', role: { title: 'engineer', description: '' }, permissions: [] },
  ],
  openObjectives: [],
  toolSources: [],
  processDocument: null,
  instructions: 'Lead the team.',
};

function obj(partial: Partial<Objective> & { id: string; title: string }): Objective {
  return {
    body: '',
    outcome: 'It works',
    status: 'active',
    assignee: 'engineer-1',
    originator: VIEWER,
    watchers: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    completedAt: null,
    result: null,
    blockReason: null,
    attachments: [],
    ...partial,
  };
}

// Live: one blocked (older activity) + two active; the blocked one
// must float to the top anyway. Closed: one done + one cancelled.
const BLOCKED = obj({
  id: 'obj-blocked',
  title: 'Rotate the API keys',
  status: 'blocked',
  blockReason: 'waiting on ops',
  assignee: 'engineer-2',
  updatedAt: 1_700_000_001_000,
});
const ACTIVE_OTHER = obj({
  id: 'obj-active',
  title: 'Fix the login redirect',
  assignee: 'engineer-1',
  updatedAt: 1_700_000_005_000,
});
const ACTIVE_MINE = obj({
  id: 'obj-mine',
  title: 'Review the release notes',
  assignee: VIEWER,
  updatedAt: 1_700_000_003_000,
});
const DONE = obj({
  id: 'obj-done',
  title: 'Ship the changelog',
  status: 'done',
  result: 'Shipped',
  completedAt: 1_700_000_006_000,
});
const CANCELLED = obj({
  id: 'obj-cancelled',
  title: 'Migrate the wiki',
  status: 'cancelled',
  updatedAt: 1_700_000_002_000,
});

function seed(list: Objective[]): void {
  objectives.value = list;
  objectivesLoaded.value = true;
}

beforeEach(() => {
  instructions.value = PACKET;
});

afterEach(() => {
  cleanup();
  instructions.value = null;
  __resetObjectivesForTests();
  __resetObjectivesPanelForTests();
  __resetMessagesForTests();
  __resetUnreadForTests();
});

describe('ObjectivesPanel ledger', () => {
  it('groups live above closed, blocked first, and counts live only', () => {
    seed([ACTIVE_OTHER, DONE, BLOCKED, CANCELLED, ACTIVE_MINE]);
    render(<ObjectivesPanel viewer={VIEWER} />);

    // Header asserts the live count — 3 live, 1 of them blocked. The
    // 2 closed records must not inflate it (the old header said
    // "5 on the board" here).
    expect(screen.getByText('3 live · 1 blocked')).toBeTruthy();

    // Live section order: blocked floats first despite older
    // activity, then actives by latest activity.
    const liveList = screen.getByLabelText('Live objectives');
    const titles = [...liveList.querySelectorAll('li')].map(
      (li) => li.querySelector('.truncate')?.textContent,
    );
    expect(titles).toEqual([
      'Rotate the API keys',
      'Fix the login redirect',
      'Review the release notes',
    ]);

    // Closed stays collapsed: the records exist behind the disclosure
    // but are not rendered until asked for.
    expect(screen.queryByText('Ship the changelog')).toBeNull();
    expect(screen.queryByText('Migrate the wiki')).toBeNull();
    expect(screen.getByText(/Closed — 1 done · 1 cancelled/)).toBeTruthy();
  });

  it('expands the closed ledger on demand', () => {
    seed([ACTIVE_OTHER, DONE, CANCELLED]);
    render(<ObjectivesPanel viewer={VIEWER} />);

    fireEvent.click(screen.getByText(/Closed — 1 done · 1 cancelled/));
    expect(screen.getByText('Ship the changelog')).toBeTruthy();
    expect(screen.getByText('Migrate the wiki')).toBeTruthy();
  });

  it('says All quiet when nothing is live', () => {
    seed([DONE, CANCELLED]);
    render(<ObjectivesPanel viewer={VIEWER} />);
    expect(screen.getByText('All quiet')).toBeTruthy();
  });

  it('scopes to the viewer with the Mine filter', () => {
    seed([ACTIVE_OTHER, ACTIVE_MINE, BLOCKED]);
    render(<ObjectivesPanel viewer={VIEWER} />);

    // Positive control before filtering: everyone's work is visible.
    expect(screen.getByText('Fix the login redirect')).toBeTruthy();

    fireEvent.click(screen.getByText('Mine'));
    expect(screen.getByText('Review the release notes')).toBeTruthy();
    expect(screen.queryByText('Fix the login redirect')).toBeNull();
    expect(screen.queryByText('Rotate the API keys')).toBeNull();
  });

  it('wears the thread unread count on a live row', () => {
    seed([ACTIVE_OTHER]);
    // Two posts from someone else, never marked read → 2 unread.
    // lastReadByThread stays empty (fresh session, nothing seeded).
    const post = (id: string, ts: number): Message => ({
      id,
      ts,
      to: null,
      from: 'engineer-1',
      title: null,
      body: 'progress note',
      level: 'info',
      data: {},
      attachments: [],
    });
    messagesByThread.value = new Map([
      [
        objectiveThreadKey(ACTIVE_OTHER.id),
        [post('m1', 1_700_000_010_000), post('m2', 1_700_000_011_000)],
      ],
    ]);
    const { container } = render(<ObjectivesPanel viewer={VIEWER} />);

    const badge = container.querySelector('.count-badge');
    expect(badge?.textContent).toBe('2');
    expect(badge?.getAttribute('title')).toBe('2 unread posts');
  });

  it('never badges the viewer with their own posts', () => {
    seed([ACTIVE_OTHER]);
    messagesByThread.value = new Map([
      [
        objectiveThreadKey(ACTIVE_OTHER.id),
        [
          {
            id: 'm1',
            ts: 1_700_000_010_000,
            to: null,
            from: VIEWER,
            title: null,
            body: 'my own note',
            level: 'info',
            data: {},
            attachments: [],
          },
        ],
      ],
    ]);
    const { container } = render(<ObjectivesPanel viewer={VIEWER} />);
    expect(container.querySelector('.count-badge')).toBeNull();
  });
});
