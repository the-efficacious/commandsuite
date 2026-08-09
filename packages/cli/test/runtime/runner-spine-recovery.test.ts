/**
 * The runner's half of recovery, and its half of the floor signals.
 *
 * WHAT IS BEING PROVEN, in one sentence: the runner triggers recovery
 * and composes none of it. Every string a member reads after a
 * compaction comes off the server's `orient` response through
 * `renderOrientPack` — the same renderer the `orient` tool uses — so
 * the pack a member gets does not depend on which door they came
 * through.
 *
 * ADDITIVE. The objectives re-brief is untouched by this phase, and
 * the test that matters most here is the one asserting BOTH fire, on
 * the same trigger, independently. The moment one suppresses the other
 * the cut-over stops being a deletion and becomes a migration.
 *
 * The fake bridge is a raw UDS socket speaking the IPC frame protocol
 * — the same seam `runner-rebrief.test.ts` uses, deliberately, so the
 * two paths are observed through one instrument.
 */

import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelEvent } from '../../src/runtime/forwarder.js';
import type { RunnerHandle } from '../../src/runtime/runner.js';
import { startRunner } from '../../src/runtime/runner.js';
import { renderOrientPack } from '../../src/runtime/tools.js';
import {
  FAKE_BROKER_NAME,
  FAKE_BROKER_TOKEN,
  type FakeBroker,
  fakeBrokerObjectives,
  fakeBrokerSpine,
  startFakeBroker,
} from './fake-broker.js';

/** A pack with something in it — an empty one renders past almost any bug. */
const PACK = {
  member: FAKE_BROKER_NAME,
  at: '2026-08-09T09:00:00.000Z',
  cursor: 42,
  contracts: [
    {
      bindings: ['assignee'],
      contract: 'evt_contract_1',
      title: 'Restore search indexing',
      state: 'active',
      stateRev: 3,
      criteria: [
        {
          criterion: 'c1',
          text: 'search results include documents created in the last hour',
          decision: 'unmet',
          revision: {
            id: 'rev_1',
            subject: 'repo:acme',
            value: 'sha-a',
            how: 'observed',
            source: 'integration:github',
            at: '2026-08-09T08:00:00.000Z',
          },
          event: 'evt_verdict_1',
          waivedBy: null,
          atBoundRevision: true,
        },
      ],
      subject: {
        id: 'repo:acme',
        type: 'repo',
        parent: null,
        registeredBy: 'lea',
        at: '2026-08-09T07:00:00.000Z',
      },
      revision: {
        id: 'rev_1',
        subject: 'repo:acme',
        value: 'sha-a',
        how: 'observed',
        source: 'integration:github',
        at: '2026-08-09T08:00:00.000Z',
      },
      stale: false,
      head: null,
      rulings: [],
    },
  ],
  asksForMe: [],
  myOpenAsks: [],
};

const EMPTY_PACK = {
  member: FAKE_BROKER_NAME,
  at: '2026-08-09T09:00:00.000Z',
  cursor: 7,
  contracts: [],
  asksForMe: [],
  myOpenAsks: [],
};

interface ReceivedFrame {
  kind: string;
  id?: number;
}

async function connectFakeBridge(
  socketPath: string,
): Promise<{ socket: Socket; received: ReceivedFrame[] }> {
  const socket = connect({ path: socketPath });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const received: ReceivedFrame[] = [];
  createInterface({ input: socket, crlfDelay: Infinity }).on('line', (line) => {
    try {
      received.push(JSON.parse(line) as ReceivedFrame);
    } catch {
      /* runner only writes JSON frames */
    }
  });
  return { socket, received };
}

function sendFrame(socket: Socket, frame: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(frame)}\n`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for condition');
}

const isRecovery = (e: ChannelEvent): boolean => e.meta.kind === 'spine_recovery';
const isRebrief = (e: ChannelEvent): boolean => e.meta.kind === 'context_refresh';

let broker: FakeBroker | null = null;
let runner: RunnerHandle | null = null;
let socket: Socket | null = null;
let delivered: ChannelEvent[] = [];

beforeEach(() => {
  fakeBrokerSpine.orient = PACK;
  fakeBrokerSpine.signals.length = 0;
  fakeBrokerSpine.absent = false;
  fakeBrokerObjectives.length = 0;
  delivered = [];
});

afterEach(async () => {
  socket?.destroy();
  socket = null;
  if (runner) {
    await runner.shutdown('test-teardown');
    await runner.waitClosed;
    runner = null;
  }
  await broker?.close();
  broker = null;
  fakeBrokerObjectives.length = 0;
  fakeBrokerSpine.signals.length = 0;
  fakeBrokerSpine.absent = false;
});

async function startWithSink(): Promise<void> {
  broker = await startFakeBroker();
  runner = await startRunner({
    url: broker.url,
    token: FAKE_BROKER_TOKEN,
    log: () => {},
    noTrace: true,
    channelSink: {
      deliver: async (event) => {
        delivered.push(event);
      },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────

describe('spine recovery on the session-attach trigger', () => {
  it('injects the pack VERBATIM — the same string the orient tool renders', async () => {
    await startWithSink();
    const bridge = await connectFakeBridge((runner as RunnerHandle).socketPath);
    socket = bridge.socket;
    sendFrame(socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    await waitFor(() => delivered.some(isRecovery));

    const recovery = delivered.find(isRecovery);
    // Byte-for-byte against the shared renderer. Asserting on
    // substrings would pass against a runner that composed its own
    // summary and happened to mention the contract id, which is the
    // exact thing this phase must not do.
    expect(recovery?.content).toBe(renderOrientPack(PACK as never, FAKE_BROKER_NAME));
    // And the strings a member must actually see, named explicitly, so
    // a renderer that silently dropped a section fails here too.
    expect(recovery?.content).toContain('evt_contract_1');
    expect(recovery?.content).toContain('Restore search indexing');
    expect(recovery?.content).toContain('annex cursor 42');
    expect(recovery?.content).toContain(
      'search results include documents created in the last hour',
    );
    expect(recovery?.meta.from).toBe('csuite');
    expect(recovery?.meta.reason).toBe('session-start');
    expect(recovery?.meta.ts_ms).toMatch(/^\d+$/);
  });

  it('delivers the pack to a member with an EMPTY plate', async () => {
    // The empty-plate skip is a documented defect of the old re-brief
    // path: a member with nothing open got no recovery injection at
    // all on compaction. The pack replaces that gate, and "you are
    // bound to nothing right now" is a real answer.
    fakeBrokerSpine.orient = EMPTY_PACK;
    await startWithSink();
    const bridge = await connectFakeBridge((runner as RunnerHandle).socketPath);
    socket = bridge.socket;
    sendFrame(socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    await waitFor(() => delivered.some(isRecovery));

    const recovery = delivered.find(isRecovery);
    expect(recovery?.content).toContain('No contracts bind you right now');
    expect(recovery?.content).toContain('annex cursor 7');
    // The old path stayed silent on exactly this input — asserted here
    // so the two behaviours are visibly different in one file.
    expect(delivered.filter(isRebrief)).toHaveLength(0);
  });

  it('fires alongside the objectives re-brief, independently', async () => {
    fakeBrokerObjectives.push({
      id: 'obj-77',
      title: 'Restore search indexing',
      body: '',
      outcome: 'Search results include documents created in the last hour.',
      status: 'active',
      assignee: FAKE_BROKER_NAME,
      originator: 'director-1',
      watchers: [],
      createdAt: 1,
      updatedAt: 1,
      completedAt: null,
      result: null,
      blockReason: null,
      attachments: [],
    });
    await startWithSink();
    const bridge = await connectFakeBridge((runner as RunnerHandle).socketPath);
    socket = bridge.socket;
    sendFrame(socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    await waitFor(() => delivered.some(isRecovery) && delivered.some(isRebrief));

    // BOTH, on one trigger. Until the cut-over deletes the first, a
    // change that made either suppress the other would be a silent
    // regression in the guarantee.
    expect(delivered.filter(isRecovery)).toHaveLength(1);
    expect(delivered.filter(isRebrief)).toHaveLength(1);
    // And they are different objects: the re-brief is composed from the
    // objectives snapshot, the recovery from the annex.
    expect(delivered.find(isRebrief)?.content).toContain('obj-77');
    expect(delivered.find(isRecovery)?.content).not.toContain('obj-77');
  });

  it('honours its own cooldown on a second attach', async () => {
    await startWithSink();
    const first = await connectFakeBridge((runner as RunnerHandle).socketPath);
    socket = first.socket;
    sendFrame(socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    await waitFor(() => delivered.some(isRecovery));

    // A second bridge is a second session attach, inside the 10s
    // window. One recovery, not two.
    const second = await connectFakeBridge((runner as RunnerHandle).socketPath);
    sendFrame(second.socket, { kind: 'mcp_request', id: 2, method: 'tools/list' });
    await waitFor(() => second.received.some((f) => f.kind === 'mcp_response' && f.id === 2));
    await new Promise((r) => setTimeout(r, 150));
    expect(delivered.filter(isRecovery)).toHaveLength(1);
    second.socket.destroy();
  });

  it('degrades silently against a broker with no spine', async () => {
    fakeBrokerSpine.absent = true;
    await startWithSink();
    const bridge = await connectFakeBridge((runner as RunnerHandle).socketPath);
    socket = bridge.socket;
    sendFrame(socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    await waitFor(() => bridge.received.some((f) => f.kind === 'mcp_response' && f.id === 1));
    await new Promise((r) => setTimeout(r, 200));
    // No recovery, no crash, no unhandled rejection — and the session
    // is still perfectly usable, which is what a 404 here means.
    expect(delivered.filter(isRecovery)).toHaveLength(0);
  });
});

describe('floor signals from the runner', () => {
  it('reports the bridge bracket, which used to be a local log line only', async () => {
    await startWithSink();
    const bridge = await connectFakeBridge((runner as RunnerHandle).socketPath);
    socket = bridge.socket;
    await waitFor(() => fakeBrokerSpine.signals.some((s) => s.body.signal === 'bridge_connect'));

    socket.destroy();
    socket = null;
    await waitFor(() => fakeBrokerSpine.signals.some((s) => s.body.signal === 'bridge_disconnect'));

    const reported = fakeBrokerSpine.signals.map((s) => s.body.signal);
    expect(reported).toContain('bridge_connect');
    expect(reported).toContain('bridge_disconnect');
    // Self-only on the wire, not merely on the server: the runner must
    // address its OWN member, or the server's self-check is the only
    // thing standing between a bug and a cross-member report.
    for (const signal of fakeBrokerSpine.signals) {
      expect(signal.member).toBe(FAKE_BROKER_NAME);
    }
  });

  it('stops reporting after a 404 rather than retrying every trigger', async () => {
    fakeBrokerSpine.absent = true;
    await startWithSink();
    const bridge = await connectFakeBridge((runner as RunnerHandle).socketPath);
    socket = bridge.socket;
    sendFrame(socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    await waitFor(() => bridge.received.some((f) => f.kind === 'mcp_response' && f.id === 1));
    await new Promise((r) => setTimeout(r, 200));
    // The 404 arm records nothing, so the count here is only about the
    // absence of a crash. The positive control is the test above,
    // which proves the same path DOES report against a live spine.
    expect(fakeBrokerSpine.signals).toHaveLength(0);
  });
});
