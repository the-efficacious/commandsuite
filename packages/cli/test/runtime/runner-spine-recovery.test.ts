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
 * THE ONLY RECOVERY PATH, as of the cut-over. It ran beside the
 * objectives `context_refresh` re-brief for a phase — with a test here
 * asserting BOTH fired on one trigger, independently — and that
 * re-brief has now gone with the subsystem it composed from. What
 * survives is the assertion that NO `context_refresh` is delivered at
 * all: a runner still emitting one would mean the deletion missed a
 * path, and the agent would be reading a plate composed from a store
 * that no longer exists.
 *
 * The fake bridge is a raw UDS socket speaking the IPC frame protocol.
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
      inFocus: false,
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
/** The runner's spine-recovery cooldown clock, so the window is drivable. */
const clock = { ms: 1_700_000_000_000 };

beforeEach(() => {
  fakeBrokerSpine.orient = PACK;
  fakeBrokerSpine.signals.length = 0;
  fakeBrokerSpine.absent = false;
  fakeBrokerSpine.absentSignals = false;
  delivered = [];
  clock.ms = 1_700_000_000_000;
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
  fakeBrokerSpine.signals.length = 0;
  fakeBrokerSpine.absent = false;
  fakeBrokerSpine.absentSignals = false;
});

async function startWithSink(): Promise<void> {
  broker = await startFakeBroker();
  runner = await startRunner({
    url: broker.url,
    token: FAKE_BROKER_TOKEN,
    log: () => {},
    noTrace: true,
    now: () => clock.ms,
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
    // …and NOTHING composes a `context_refresh` any more. The re-brief
    // was the runner recomposing an open-objectives plate and pushing
    // it; it went with the subsystem. A runner still emitting one
    // would mean the deletion missed a path.
    expect(delivered.filter(isRebrief)).toHaveLength(0);
  });

  it('honours its own cooldown, and OPENS again when it expires', async () => {
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

    // THE POSITIVE CONTROL, and it needs the injected clock: a
    // suppression test on its own passes against a cooldown that never
    // reopens, which is a runner that recovers exactly once per
    // process and then goes quiet forever. Sleeping cannot establish
    // this — it can only ever prove the negative half.
    clock.ms += 11_000;
    const third = await connectFakeBridge((runner as RunnerHandle).socketPath);
    sendFrame(third.socket, { kind: 'mcp_request', id: 3, method: 'tools/list' });
    await waitFor(() => delivered.filter(isRecovery).length === 2);
    expect(delivered.filter(isRecovery)).toHaveLength(2);
    third.socket.destroy();
  });

  it('recovers against a broker with an annex and NO curator', async () => {
    // The configuration that a single shared availability flag broke,
    // and it is not hypothetical — this repo's own server suite
    // constructs it. Signals 404 (pure ceiling, no curator wired);
    // orient answers 200 (the annex is right there). One flag meant
    // the ceiling's 404 permanently disabled the floor's recovery, and
    // it was a race besides: whether recovery worked at all depended
    // on which 404 landed first.
    fakeBrokerSpine.absentSignals = true;
    await startWithSink();
    const bridge = await connectFakeBridge((runner as RunnerHandle).socketPath);
    socket = bridge.socket;

    // Trigger 1: the fresh bridge's first tools/list. The
    // bridge_connect signal 404s on the way past.
    sendFrame(socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    await waitFor(() => delivered.some(isRecovery));
    expect(delivered.filter(isRecovery)).toHaveLength(1);
    expect(fakeBrokerSpine.signals, 'the signal endpoint really is 404ing').toHaveLength(0);

    // Trigger 2: a second session attach, after the signal 404 has
    // definitely landed (the first trigger's bridge_connect and
    // bridge_disconnect both went to it). This is the arm that failed
    // — the recovery injector had been switched off by somebody
    // else's endpoint, so the FIRST recovery worked and every one
    // after it silently did not.
    clock.ms += 11_000;
    const second = await connectFakeBridge((runner as RunnerHandle).socketPath);
    sendFrame(second.socket, { kind: 'mcp_request', id: 2, method: 'tools/list' });
    await waitFor(() => delivered.filter(isRecovery).length === 2);
    expect(delivered.filter(isRecovery)).toHaveLength(2);
    expect(delivered.filter(isRecovery).at(-1)?.content).toContain('evt_contract_1');
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
