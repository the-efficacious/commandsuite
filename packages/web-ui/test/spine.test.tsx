/**
 * The human seat's UI — the Queue, the four acts, the Board, and the
 * interrupt whitelist — driven through a stubbed fetch + real SDK Client
 * so response validation runs end-to-end and every act's outbound
 * request is inspected on the wire.
 *
 * The two properties under test are §9's, asserted on rendered strings
 * and captured requests rather than handler returns:
 *
 *   VISITING IS NOT HANDLING — loading the queue makes a GET and no
 *   POST; opening an item advances nothing.
 *   THE ANNEX IS THE TRUTH — an item leaves only when its resolving
 *   event lands. The stub mutates its queue on the resolving POST, the
 *   way the server would, and the row then disappears on the reload.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { Client } from 'csuite-sdk/client';
import type {
  SpineAsk,
  SpineContract,
  SpineCuratorConfigResponse,
  SpineEvent,
  SpineQueue,
} from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetSpineBoardPanelForTests,
  SpineBoardPanel,
} from '../src/components/SpineBoardPanel.js';
import {
  __resetSpineQueuePanelForTests,
  SpineQueuePanel,
} from '../src/components/SpineQueuePanel.js';
import { __resetSpineWhitelistControlForTests } from '../src/components/SpineWhitelistControl.js';
import { __resetClientForTests, setClient } from '../src/lib/client.js';
import { __resetIdentityForTests, setIdentity } from '../src/lib/identity.js';
import { roster } from '../src/lib/roster.js';
import { __resetSpineForTests } from '../src/lib/spine.js';

const originalFetch = globalThis.fetch;

// ─── Fixtures ────────────────────────────────────────────────────────

function mkContract(overrides: Partial<SpineContract> = {}): SpineContract {
  return {
    id: 'ct_1',
    title: 'Ship the endpoint',
    state: 'active',
    stateRev: 2,
    version: 1,
    subject: 'repo:acme',
    revision: null,
    criteria: [{ id: 'c1', text: 'returns 200' }],
    assignee: 'scout',
    verifier: 'director-1',
    authority: 'director-1',
    constraints: [],
    createdBy: 'director-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    waitingOn: null,
    waitingFor: null,
    preemptedBy: null,
    result: null,
    reason: null,
    successor: null,
    stale: false,
    head: null,
    inFocus: false,
    ...overrides,
  };
}

function mkAsk(overrides: Partial<SpineAsk> = {}): SpineAsk {
  return {
    id: 'ask_1',
    authority: 'director-1',
    asker: 'scout',
    subject: 'repo:acme',
    contract: 'ct_1',
    question: 'ship on Friday?',
    context: 'the window is tight and cora is out',
    unblocks: 'the 0.6 release',
    state: 'open',
    resolvedBy: null,
    at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function mkEvent(): SpineEvent {
  return {
    seq: 9,
    id: 'evt_rule',
    kind: 'ruling',
    class: 'authoritative',
    subject: null,
    revision: null,
    actor: 'director-1',
    authoredBy: null,
    at: '2026-01-01T00:00:00.000Z',
    provenance: 'native',
    opId: 'op_x',
    cites: [],
    staplesTo: null,
    body: { ask: 'ask_1', decision: 'yes', reasoning: 'ok' },
    contract: null,
    stateRev: null,
  };
}

function mkCurator(whitelist: string[]): SpineCuratorConfigResponse {
  return {
    member: 'director-1',
    subscriptions: [],
    policy: {
      member: 'director-1',
      leaseTtlMs: 1_800_000,
      nudgeMinIntervalMs: 900_000,
      interruptWhitelist: whitelist as SpineCuratorConfigResponse['policy']['interruptWhitelist'],
      explicit: false,
      updatedBy: null,
      updatedAt: null,
    },
    capabilities: null,
  };
}

interface Captured {
  url: string;
  method: string;
  body: string | null;
}

/**
 * A stateful stub. The queue is a `let` so a test can make the server's
 * resolving event happen — the POST that dictates a ruling empties it,
 * exactly as the annex fold would, so the reload shows it gone.
 */
function stubSpine(opts: {
  queue?: SpineQueue;
  contracts?: SpineContract[];
  focusSet?: SpineContract[];
  curator?: SpineCuratorConfigResponse;
}): { captured: Captured[]; setQueue: (q: SpineQueue) => void } {
  const captured: Captured[] = [];
  let queue = opts.queue ?? {
    member: 'director-1',
    at: '2026-01-01T00:00:00.000Z',
    asks: [],
    waitingOn: [],
  };
  const contracts = opts.contracts ?? [];
  const focusSet = opts.focusSet ?? [];
  const curator = opts.curator ?? mkCurator(['ask', 'proceeding']);
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? init.body : null;
    captured.push({ url, method, body });
    if (method === 'GET' && url.includes('/spine/queue')) return json({ queue });
    if (method === 'GET' && url.includes('/spine/curator')) return json(curator);
    if (method === 'PUT' && url.includes('/spine/curator')) return json(curator);
    // The team focus set — `?focus=true` — before the member-scoped list,
    // since both match `/spine/contracts`.
    if (method === 'GET' && url.includes('/spine/contracts') && url.includes('focus=true')) {
      return json({ contracts: focusSet });
    }
    if (method === 'GET' && url.includes('/spine/contracts')) return json({ contracts });
    if (method === 'POST' && url.includes('/spine/events')) {
      return json({ event: mkEvent(), contract: null, replayed: false }, 201);
    }
    return json({ error: 'no stub route' }, 500);
  }) as typeof fetch;
  setClient(new Client({ url: 'http://localhost', useCookies: true }));
  return { captured, setQueue: (q) => (queue = q) };
}

beforeEach(() => {
  __resetClientForTests();
  __resetIdentityForTests();
  __resetSpineForTests();
  __resetSpineQueuePanelForTests();
  __resetSpineBoardPanelForTests();
  __resetSpineWhitelistControlForTests();
  roster.value = {
    teammates: [
      { name: 'director-1', role: { title: 'director', description: '' }, permissions: [] },
      { name: 'cora', role: { title: 'engineer', description: '' }, permissions: [] },
      { name: 'scout', role: { title: 'engineer', description: '' }, permissions: [] },
    ],
    connected: [],
  };
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  roster.value = null;
});

const queueWithAsk: SpineQueue = {
  member: 'director-1',
  at: '2026-01-01T00:00:00.000Z',
  asks: [{ ask: mkAsk(), contract: mkContract() }],
  waitingOn: [],
};

// ─── The queue renders each ask verbatim ─────────────────────────────

describe('SpineQueuePanel — content', () => {
  it('renders question, context and unblocks verbatim', async () => {
    stubSpine({ queue: queueWithAsk });
    render(<SpineQueuePanel viewer="director-1" />);
    expect(await screen.findByText('ship on Friday?')).toBeTruthy();
    expect(screen.getByText('the window is tight and cora is out')).toBeTruthy();
    expect(screen.getByText('the 0.6 release')).toBeTruthy();
  });

  it('loading the queue makes a GET and NEVER a POST — visiting is not handling', async () => {
    const { captured } = stubSpine({ queue: queueWithAsk });
    render(<SpineQueuePanel viewer="director-1" />);
    await screen.findByText('ship on Friday?');
    expect(captured.some((c) => c.method === 'GET' && c.url.includes('/spine/queue'))).toBe(true);
    // The load reads the RECEIPT-NEUTRAL queue, never orient, and writes
    // nothing at all.
    expect(captured.some((c) => c.url.includes('/spine/orient'))).toBe(false);
    expect(captured.some((c) => c.method === 'POST')).toBe(false);
  });
});

// ─── The four acts ───────────────────────────────────────────────────

describe('SpineQueuePanel — the four acts', () => {
  it('dictate a ruling: posts a ruling, and the item leaves on the reload', async () => {
    const stub = stubSpine({ queue: queueWithAsk });
    render(<SpineQueuePanel viewer="director-1" />);
    await screen.findByText('ship on Friday?');

    fireEvent.click(screen.getByRole('button', { name: 'Rule' }));
    fireEvent.input(screen.getByPlaceholderText('Decision'), { target: { value: 'yes, Friday' } });
    fireEvent.input(screen.getByPlaceholderText('Reasoning'), {
      target: { value: 'window holds' },
    });
    // The resolving event: the server would mark the ask ruled, so the
    // stub empties the queue the reload will fetch.
    stub.setQueue({
      member: 'director-1',
      at: '2026-01-01T00:00:00.000Z',
      asks: [],
      waitingOn: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dictate ruling' }));

    const post = await waitFor(() => {
      const p = stub.captured.find((c) => c.method === 'POST' && c.url.includes('/spine/events'));
      expect(p).toBeTruthy();
      return p as Captured;
    });
    const sent = JSON.parse(post.body as string);
    expect(sent.kind).toBe('ruling');
    expect(sent.body).toMatchObject({
      ask: 'ask_1',
      decision: 'yes, Friday',
      reasoning: 'window holds',
    });
    expect(typeof sent.opId).toBe('string');
    // The item left because its resolving event landed, not on open.
    await waitFor(() => expect(screen.queryByText('ship on Friday?')).toBeNull());
  });

  it('defer: posts an ask_action defer carrying the contract stateRev', async () => {
    const stub = stubSpine({ queue: queueWithAsk });
    render(<SpineQueuePanel viewer="director-1" />);
    await screen.findByText('ship on Friday?');
    fireEvent.click(screen.getByRole('button', { name: 'Defer' }));
    fireEvent.input(screen.getByPlaceholderText('Reason'), { target: { value: 'after CI' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm defer' }));
    const post = await waitFor(() => {
      const p = stub.captured.find((c) => c.method === 'POST');
      expect(p).toBeTruthy();
      return p as Captured;
    });
    const sent = JSON.parse(post.body as string);
    expect(sent.kind).toBe('ask_action');
    expect(sent.body).toMatchObject({ ask: 'ask_1', action: 'defer', reason: 'after CI' });
    // Contract-bound ask → the precondition rides along, from the queue.
    expect(sent.expectedStateRev).toBe(2);
  });

  it('decline: posts an ask_action decline with the reason', async () => {
    const stub = stubSpine({ queue: queueWithAsk });
    render(<SpineQueuePanel viewer="director-1" />);
    await screen.findByText('ship on Friday?');
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    fireEvent.input(screen.getByPlaceholderText('Reason'), { target: { value: 'ask product' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm decline' }));
    const post = await waitFor(() => {
      const p = stub.captured.find((c) => c.method === 'POST');
      expect(p).toBeTruthy();
      return p as Captured;
    });
    const sent = JSON.parse(post.body as string);
    expect(sent.body).toMatchObject({ ask: 'ask_1', action: 'decline', reason: 'ask product' });
  });

  it('redirect: posts an ask_action redirect to the chosen member', async () => {
    const stub = stubSpine({ queue: queueWithAsk });
    render(<SpineQueuePanel viewer="director-1" />);
    await screen.findByText('ship on Friday?');
    fireEvent.click(screen.getByRole('button', { name: 'Redirect' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'cora' } });
    fireEvent.input(screen.getByPlaceholderText('Reason'), { target: { value: 'cora owns it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm redirect' }));
    const post = await waitFor(() => {
      const p = stub.captured.find((c) => c.method === 'POST');
      expect(p).toBeTruthy();
      return p as Captured;
    });
    const sent = JSON.parse(post.body as string);
    expect(sent.body).toMatchObject({
      ask: 'ask_1',
      action: 'redirect',
      redirectTo: 'cora',
      reason: 'cora owns it',
    });
  });

  it('offers no act buttons when the viewer is not the ask’s authority', async () => {
    const notMine: SpineQueue = {
      member: 'director-1',
      at: '2026-01-01T00:00:00.000Z',
      asks: [{ ask: mkAsk({ authority: 'someone-else' }), contract: mkContract() }],
      waitingOn: [],
    };
    stubSpine({ queue: notMine });
    render(<SpineQueuePanel viewer="director-1" />);
    await screen.findByText('ship on Friday?');
    expect(screen.queryByRole('button', { name: 'Rule' })).toBeNull();
  });
});

// ─── The Board ───────────────────────────────────────────────────────

describe('SpineBoardPanel — lanes and roles, status pulled from state', () => {
  const contracts: SpineContract[] = [
    mkContract({ id: 'ct_a', title: 'Active one', state: 'active' }),
    mkContract({ id: 'ct_w', title: 'Waiting one', state: 'waiting_on', waitingOn: 'director-1' }),
    mkContract({ id: 'ct_p', title: 'Parked one', state: 'parked' }),
    mkContract({ id: 'ct_d', title: 'Done one', state: 'done' }),
  ];

  it('renders lifecycle lanes and filters done/cancelled by default', async () => {
    stubSpine({ contracts });
    render(<SpineBoardPanel viewer="director-1" />);
    expect(await screen.findByText('Active one')).toBeTruthy();
    expect(screen.getByText('Waiting one')).toBeTruthy();
    expect(screen.getByText('Parked one')).toBeTruthy();
    // Terminal is filtered out until asked for.
    expect(screen.queryByText('Done one')).toBeNull();

    fireEvent.click(screen.getByLabelText(/show done/i));
    expect(await screen.findByText('Done one')).toBeTruthy();
  });

  it('has NO status-text input anywhere — status is pulled, never typed', async () => {
    stubSpine({ contracts });
    const { container } = render(<SpineBoardPanel viewer="director-1" />);
    await screen.findByText('Active one');
    // Broad on purpose. A bare `<input>` renders as text, and so do
    // `type=search` and a contenteditable div — all of which a narrow
    // `input[type=text]` check waves through. The board's only legit
    // controls are the lane/role/queue buttons and the show-done
    // checkbox, so anything a member could TYPE STATUS into must count
    // zero. Add one such field and this guard dies.
    expect(
      container.querySelectorAll(
        'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, [contenteditable]',
      ).length,
      'the board never asks anyone to type status',
    ).toBe(0);
  });

  it('groups by relationship when asked', async () => {
    stubSpine({ contracts });
    render(<SpineBoardPanel viewer="director-1" />);
    await screen.findByText('Active one');
    fireEvent.click(screen.getByRole('button', { name: 'Relationships' }));
    expect(await screen.findByText(/Mine to rule on/i)).toBeTruthy();
    expect(screen.getByText(/Mine to verify/i)).toBeTruthy();
  });

  it('marks an in-focus contract wherever it is drawn', async () => {
    stubSpine({
      contracts: [mkContract({ id: 'ct_a', title: 'Active one', state: 'active', inFocus: true })],
    });
    render(<SpineBoardPanel viewer="director-1" />);
    await screen.findByText('Active one');
    // The focus badge rides beside the title in the lanes view.
    expect(screen.getByText('focus')).toBeTruthy();
  });
});

describe('SpineBoardPanel — the focus set (D9), finding 8', () => {
  it('shows the whole team focus set to a spine.focus holder, not just their own', async () => {
    // The allocator holds spine.focus. Their own board is one contract;
    // the team focus set is a DIFFERENT, larger one — the whole-plate view.
    setIdentity({
      member: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['spine.focus'],
    });
    stubSpine({
      contracts: [mkContract({ id: 'ct_mine', title: 'My own thing', inFocus: false })],
      focusSet: [
        mkContract({ id: 'ct_x', title: 'Someone elses lit work', assignee: 'scout', inFocus: true }),
        mkContract({ id: 'ct_y', title: 'Another lit one', assignee: 'cora', inFocus: true }),
      ],
    });
    render(<SpineBoardPanel viewer="director-1" />);
    await screen.findByText('My own thing');
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    // The team's lit plate — contracts the allocator does not own.
    expect(await screen.findByText('Someone elses lit work')).toBeTruthy();
    expect(screen.getByText('Another lit one')).toBeTruthy();
    expect(screen.getByText(/whole team/i)).toBeTruthy();
  });

  it('shows a non-holder only their OWN in-focus contracts, never the team set', async () => {
    // No spine.focus — the focus view is the in-focus filter over the
    // viewer's own plate, and it must not fetch or show the team set.
    setIdentity({
      member: 'scout',
      role: { title: 'engineer', description: '' },
      permissions: [],
    });
    const { captured } = stubSpine({
      contracts: [
        mkContract({ id: 'ct_lit', title: 'My lit one', inFocus: true }),
        mkContract({ id: 'ct_dark', title: 'My dark one', inFocus: false }),
      ],
      focusSet: [mkContract({ id: 'ct_secret', title: 'Team lit work', inFocus: true })],
    });
    render(<SpineBoardPanel viewer="scout" />);
    await screen.findByText('My lit one');
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    // Their own in-focus contract shows; their out-of-focus one does not;
    // and the team set was never fetched.
    expect(await screen.findByText('My lit one')).toBeTruthy();
    expect(screen.queryByText('My dark one')).toBeNull();
    expect(screen.queryByText('Team lit work')).toBeNull();
    expect(
      captured.some((c) => c.url.includes('focus=true')),
      'a non-holder must not request the team focus set',
    ).toBe(false);
  });
});

// ─── The interrupt whitelist ─────────────────────────────────────────

describe('SpineWhitelistControl — the phone gate', () => {
  it('reflects the current whitelist and writes a new set on toggle', async () => {
    // Rendered inside the queue panel, which is where it lives.
    const { captured } = stubSpine({
      queue: { member: 'director-1', at: '2026-01-01T00:00:00.000Z', asks: [], waitingOn: [] },
      curator: mkCurator(['ask', 'proceeding']),
    });
    render(<SpineQueuePanel viewer="director-1" />);
    const askBox = (await screen.findByText(/A blocking ask names me/i))
      .closest('label')
      ?.querySelector('input') as HTMLInputElement;
    expect(askBox.checked).toBe(true);

    // Turning off `ask` writes the whole remaining set back.
    fireEvent.click(askBox);
    const put = await waitFor(() => {
      const p = captured.find((c) => c.method === 'PUT' && c.url.includes('/spine/curator'));
      expect(p).toBeTruthy();
      return p as Captured;
    });
    const sent = JSON.parse(put.body as string);
    expect(sent.policy.interruptWhitelist).toEqual(['proceeding']);
  });
});
