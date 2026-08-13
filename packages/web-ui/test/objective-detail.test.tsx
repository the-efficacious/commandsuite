/**
 * ObjectiveDetail single-page render tests.
 *
 * Covers the redesign's load-bearing claims:
 *   - lifecycle events and discussion merge into ONE chronological
 *     stream (the audit's "one story, two tabs" complaint)
 *   - the result editor renders NEXT TO the outcome it must answer
 *   - blocking no longer demands a reason (the server made blockReason
 *     optional; the old UI still gated the button on non-empty input)
 *   - cancel commits on a second explicit verb, never the first click
 *   - a done objective pairs outcome with result, result wearing the
 *     assert bar
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { Client } from 'csuite-sdk/client';
import type { InstructionsResponse, Message, Objective, ObjectiveEvent } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetObjectiveDetailForTests,
  buildStream,
  describeEvent,
  ObjectiveDetail,
} from '../src/components/ObjectiveDetail.js';
import { __resetClientForTests, setClient } from '../src/lib/client.js';
import { instructions } from '../src/lib/instructions.js';
import {
  __resetMessagesForTests,
  messagesByThread,
  objectiveThreadKey,
} from '../src/lib/messages.js';
import { __resetObjectivesForTests } from '../src/lib/objectives.js';
import { roster } from '../src/lib/roster.js';

const originalFetch = globalThis.fetch;

const DIRECTOR_PACKET: InstructionsResponse = {
  name: 'director-1',
  role: { title: 'director', description: '' },
  permissions: ['members.manage', 'objectives.manage'],
  team: { name: 'demo-team', context: '', permissionPresets: {} },
  teammates: [
    { name: 'director-1', role: { title: 'director', description: '' }, permissions: [] },
    { name: 'engineer-1', role: { title: 'engineer', description: '' }, permissions: [] },
    { name: 'engineer-2', role: { title: 'engineer', description: '' }, permissions: [] },
  ],
  openObjectives: [],
  toolSources: [],
  processDocument: null,
  instructions: 'Lead the team.',
};

const ASSIGNEE_PACKET: InstructionsResponse = {
  ...DIRECTOR_PACKET,
  name: 'engineer-1',
  role: { title: 'engineer', description: '' },
  permissions: [],
};

const BASE: Objective = {
  id: 'obj-1',
  title: 'Fix the login redirect',
  body: 'Repro in #4821.',
  outcome: 'Authenticated users hitting /login land on /dashboard.',
  status: 'active',
  assignee: 'engineer-1',
  originator: 'director-1',
  watchers: ['engineer-2'],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  completedAt: null,
  result: null,
  blockReason: null,
  attachments: [],
};

function ev(
  partial: Partial<ObjectiveEvent> & { id: string; kind: ObjectiveEvent['kind'] },
): ObjectiveEvent {
  return {
    objectiveId: 'obj-1',
    ts: 1_700_000_000_000,
    actor: 'director-1',
    payload: {},
    ...partial,
  };
}

const ASSIGNED = ev({
  id: 'e1',
  kind: 'assigned',
  ts: 1_700_000_000_000,
  payload: {
    title: BASE.title,
    outcome: BASE.outcome,
    assignee: 'engineer-1',
    watchers: ['engineer-2'],
  },
});

function post(id: string, ts: number, from: string, body: string): Message {
  return { id, ts, to: null, from, title: null, body, level: 'info', data: {}, attachments: [] };
}

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

const calls: RecordedCall[] = [];

/**
 * Route the SDK client's fetches against fixture state. The Client
 * binds `globalThis.fetch` at construction, so the client is
 * (re)constructed here AFTER the stub replaces it.
 */
function stubFetch(state: { objective: Objective; events: ObjectiveEvent[] }): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });

    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    if (path === '/objectives' && method === 'GET') return json({ objectives: [state.objective] });
    if (path === '/objectives/obj-1' && method === 'GET')
      return json({ objective: state.objective, events: state.events });
    if (path === '/objectives/obj-1' && method === 'PATCH') {
      state.objective = {
        ...state.objective,
        ...(body.status ? { status: body.status } : {}),
        blockReason: body.blockReason ?? null,
        updatedAt: state.objective.updatedAt + 1000,
      };
      return json(state.objective);
    }
    if (path === '/objectives/obj-1/cancel' && method === 'POST') {
      state.objective = { ...state.objective, status: 'cancelled' };
      return json(state.objective);
    }
    if (path === '/objectives/obj-1/complete' && method === 'POST') {
      state.objective = {
        ...state.objective,
        status: 'done',
        result: body.result,
        completedAt: 1_700_000_020_000,
      };
      return json(state.objective);
    }
    return json({});
  }) as typeof fetch;
  setClient(new Client({ url: 'http://localhost', useCookies: true }));
}

beforeEach(() => {
  __resetClientForTests();
  roster.value = {
    teammates: DIRECTOR_PACKET.teammates,
    connected: [],
  };
  calls.length = 0;
});

afterEach(() => {
  cleanup();
  instructions.value = null;
  roster.value = null;
  __resetObjectiveDetailForTests();
  __resetObjectivesForTests();
  __resetMessagesForTests();
  __resetClientForTests();
  globalThis.fetch = originalFetch;
});

describe('describeEvent', () => {
  it('humanizes lifecycle events — never raw JSON', () => {
    expect(describeEvent(ASSIGNED)).toBe('assigned to engineer-1 · watching: engineer-2');
    expect(
      describeEvent(ev({ id: 'x', kind: 'blocked', payload: { reason: 'waiting on ops' } })),
    ).toBe('blocked — waiting on ops');
    expect(describeEvent(ev({ id: 'x', kind: 'blocked', payload: { reason: null } }))).toBe(
      'blocked',
    );
    expect(
      describeEvent(
        ev({
          id: 'x',
          kind: 'reassigned',
          payload: { from: 'engineer-1', to: 'engineer-2', note: 'vacation' },
        }),
      ),
    ).toBe('reassigned engineer-1 → engineer-2 — vacation');
    expect(
      describeEvent(
        ev({
          id: 'x',
          kind: 'watcher_added',
          payload: { name: 'engineer-1', reason: 'reassigned-from' },
        }),
      ),
    ).toBe('engineer-1 stays on as watcher');
  });
});

describe('buildStream', () => {
  it('merges ascending with events winning ties, and breaks message groups on interleaved events', () => {
    const events = [
      ASSIGNED,
      ev({ id: 'e2', kind: 'blocked', ts: 2000, payload: { reason: 'keys' } }),
    ];
    const messages = [
      post('m1', 1_700_000_000_000, 'engineer-1', 'on it'), // ties with ASSIGNED
      post('m2', 2500, 'engineer-1', 'follow-up'),
    ];
    const stream = buildStream(events, messages);
    expect(stream.map((s) => (s.kind === 'event' ? s.event.id : s.message.id))).toEqual([
      'e2',
      'm2',
      'e1',
      'm1',
    ]);
    // m2 directly follows the blocked event, not m1 — no continuation.
    const m2 = stream.find((s) => s.kind === 'message' && s.message.id === 'm2');
    expect(m2 && m2.kind === 'message' ? m2.previous : 'missing').toBeUndefined();
  });
});

describe('ObjectiveDetail', () => {
  it('renders one merged chronological stream of events and posts', async () => {
    instructions.value = DIRECTOR_PACKET;
    const events = [
      ASSIGNED,
      ev({
        id: 'e2',
        kind: 'blocked',
        ts: 1_700_000_002_000,
        actor: 'engineer-1',
        payload: { reason: 'waiting on ops' },
      }),
    ];
    stubFetch({ objective: { ...BASE, status: 'blocked', blockReason: 'waiting on ops' }, events });
    messagesByThread.value = new Map([
      [
        objectiveThreadKey('obj-1'),
        [post('m1', 1_700_000_001_000, 'engineer-1', 'repro found in the session store')],
      ],
    ]);

    const { container } = render(<ObjectiveDetail id="obj-1" viewer="director-1" />);
    await waitFor(() => screen.getByText('assigned to engineer-1 · watching: engineer-2'));

    const text = container.textContent ?? '';
    const iAssigned = text.indexOf('assigned to engineer-1');
    const iPost = text.indexOf('repro found in the session store');
    const iBlocked = text.indexOf('blocked — waiting on ops');
    expect(iAssigned).toBeGreaterThan(-1);
    expect(iPost).toBeGreaterThan(iAssigned);
    expect(iBlocked).toBeGreaterThan(iPost);
  });

  it('blocks without demanding a reason', async () => {
    instructions.value = DIRECTOR_PACKET;
    stubFetch({ objective: { ...BASE }, events: [ASSIGNED] });

    render(<ObjectiveDetail id="obj-1" viewer="director-1" />);
    await waitFor(() => screen.getByText('Block…'));
    fireEvent.click(screen.getByText('Block…'));

    const commit = screen.getByText('Mark blocked').closest('button');
    expect(commit?.disabled).toBe(false);
    fireEvent.click(commit as HTMLButtonElement);

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.path === '/objectives/obj-1');
      expect(patch?.body).toEqual({ status: 'blocked' });
    });
  });

  it('sends the reason when one is given', async () => {
    instructions.value = DIRECTOR_PACKET;
    stubFetch({ objective: { ...BASE }, events: [ASSIGNED] });

    render(<ObjectiveDetail id="obj-1" viewer="director-1" />);
    await waitFor(() => screen.getByText('Block…'));
    fireEvent.click(screen.getByText('Block…'));
    fireEvent.input(screen.getByPlaceholderText('what is it waiting on? (optional)'), {
      target: { value: 'waiting on ops' },
    });
    fireEvent.click(screen.getByText('Mark blocked'));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.path === '/objectives/obj-1');
      expect(patch?.body).toEqual({ status: 'blocked', blockReason: 'waiting on ops' });
    });
  });

  it('opens the result editor beside the outcome it answers', async () => {
    instructions.value = ASSIGNEE_PACKET;
    stubFetch({ objective: { ...BASE }, events: [ASSIGNED] });

    render(<ObjectiveDetail id="obj-1" viewer="engineer-1" />);
    await waitFor(() => screen.getByText('● Complete…'));
    fireEvent.click(screen.getByText('● Complete…'));

    // The juxtaposition: outcome text and result editor visible at once.
    expect(screen.getByText(BASE.outcome)).toBeTruthy();
    const editor = screen.getByPlaceholderText(
      'what was delivered, and how it meets the outcome (required)',
    );
    expect(editor).toBeTruthy();

    // Result stays required — the commit verb gates on it.
    const commit = screen.getByText('● Mark complete').closest('button');
    expect(commit?.disabled).toBe(true);
    fireEvent.input(editor, { target: { value: 'Redirect fixed; e2e added.' } });
    expect(commit?.disabled).toBe(false);
    fireEvent.click(commit as HTMLButtonElement);
    await waitFor(() => {
      const done = calls.find(
        (c) => c.method === 'POST' && c.path === '/objectives/obj-1/complete',
      );
      expect(done?.body).toEqual({ result: 'Redirect fixed; e2e added.' });
    });
  });

  it('cancels only on the second, explicit verb', async () => {
    instructions.value = DIRECTOR_PACKET;
    stubFetch({ objective: { ...BASE }, events: [ASSIGNED] });

    render(<ObjectiveDetail id="obj-1" viewer="director-1" />);
    await waitFor(() => screen.getByText('◇ Cancel…'));

    // First click only opens the form — nothing is cancelled.
    fireEvent.click(screen.getByText('◇ Cancel…'));
    expect(calls.some((c) => c.path.endsWith('/cancel'))).toBe(false);

    // Belay closes it — still nothing cancelled.
    fireEvent.click(screen.getByText('Belay'));
    expect(screen.queryByText('◇ Cancel objective')).toBeNull();
    expect(calls.some((c) => c.path.endsWith('/cancel'))).toBe(false);

    // Positive control: the explicit verb does fire the request.
    fireEvent.click(screen.getByText('◇ Cancel…'));
    fireEvent.click(screen.getByText('◇ Cancel objective'));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/cancel'))).toBe(true);
    });
  });

  it('pairs outcome with the asserted result once done', async () => {
    instructions.value = DIRECTOR_PACKET;
    const done: Objective = {
      ...BASE,
      status: 'done',
      result: 'Redirect fixed; regression test added.',
      completedAt: 1_700_000_020_000,
    };
    const events = [
      ASSIGNED,
      ev({
        id: 'e3',
        kind: 'completed',
        ts: 1_700_000_020_000,
        actor: 'engineer-1',
        payload: { result: done.result },
      }),
    ];
    stubFetch({ objective: done, events });

    const { container } = render(<ObjectiveDetail id="obj-1" viewer="director-1" />);
    await waitFor(() => screen.getByText('Redirect fixed; regression test added.'));

    // Outcome and result render together; the result card carries the
    // gold assert bar — the page's one verified-claim mark.
    expect(screen.getByText(BASE.outcome)).toBeTruthy();
    const resultCard = screen
      .getByText('Redirect fixed; regression test added.')
      .closest('section');
    expect(resultCard?.getAttribute('style')).toContain('--ef-assert');

    // The stream narrates completion instead of dumping payload JSON.
    expect(screen.getByText(/completed — result recorded/)).toBeTruthy();
    expect((container.textContent ?? '').includes('{"result"')).toBe(false);
  });
});
