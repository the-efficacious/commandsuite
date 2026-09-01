import { DatabaseSync } from 'node:sqlite';
import type { ClientIdentity, Message, MessageDispositionFrame } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import {
  Broker,
  InMemoryEventLog,
  InMemoryMessageDeliveryLedger,
  MESSAGE_DELIVERY_TTL_MS,
  type SqlDriver,
  SqliteMessageDeliveryLedger,
} from '../src/index.js';

const ACK_RUNNER: ClientIdentity = {
  kind: 'runner',
  runnerIdentity: {
    runner: 'stub',
    modelId: 'test',
    runnerVersion: 'test',
    runnerBuildSource: 'main',
    deliveryProtocol: 'disposition-v1',
  },
};

const LEGACY_RUNNER: ClientIdentity = {
  kind: 'runner',
  runnerIdentity: {
    runner: 'stub',
    modelId: 'test',
    runnerVersion: 'old',
    runnerBuildSource: 'main',
  },
};

const LIVENESS_RUNNER: ClientIdentity = {
  kind: 'runner',
  runnerIdentity: {
    ...ACK_RUNNER.runnerIdentity,
    livenessProtocol: 'runner-state-v1',
  },
};

function fixture() {
  let now = 1_000;
  let id = 0;
  const ledger = new InMemoryMessageDeliveryLedger();
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    deliveryLedger: ledger,
    now: () => now,
    idFactory: () => `message-${++id}`,
  });
  return { broker, ledger, setNow: (value: number) => (now = value) };
}

describe('message disposition ledger', () => {
  it('tracks only the addressed member, not the sender auto-sync copy', async () => {
    const { broker, ledger } = fixture();
    const alice: Message[] = [];
    const bob: Message[] = [];
    broker.subscribe(
      'alice',
      (message) => {
        alice.push(message);
      },
      {
        name: 'alice',
        clientIdentity: { kind: 'browser', clientVersion: 'test' },
      },
    );
    broker.subscribe(
      'bob',
      (message) => {
        bob.push(message);
      },
      {
        name: 'bob',
        clientIdentity: ACK_RUNNER,
      },
    );

    const result = await broker.push({ to: 'bob', body: 'work' }, { from: 'alice' });

    expect(alice).toHaveLength(1);
    expect(bob).toHaveLength(1);
    expect(result.delivery.acknowledgement).toEqual({
      status: 'pending',
      pending: 1,
      unreported: 0,
    });
    expect(ledger.pending('bob', 1_000)).toHaveLength(1);
    expect(ledger.pending('alice', 1_000)).toHaveLength(0);
  });

  // #263, and clause (a) of obj-mtgdn97e-u. The defect was a delivery into a
  // socket that is dying but still present in the registry: the broker "delivered"
  // into it, the notification receipt said `delivered`, and the message died with
  // the socket. The receipt claimed a fact nothing had acknowledged.
  //
  // The property is not "the runner is gone" — that case was always honest. It is
  // the window where presence still shows the subscription: a push into a live,
  // ack-capable subscription that never settles must be `pending`, never `settled`,
  // because `settled` is the only input from which a receipt derives `delivered`.
  it('never reports settled for a message a live subscription did not acknowledge (#263)', async () => {
    const { broker, ledger } = fixture();
    const received: Message[] = [];
    const unsubscribe = broker.subscribe(
      'bob',
      (m) => {
        received.push(m);
      },
      {
        name: 'bob',
        clientIdentity: ACK_RUNNER,
      },
    );

    const pushed = await broker.push({ to: 'bob', body: 'work' }, { from: 'alice' });

    // The socket took the bytes — this is the window the defect lived in.
    expect(received).toHaveLength(1);

    // ...and the broker must still refuse to call it acknowledged. `settled` here
    // is what a receipt turns into `delivered`, so this assertion is the whole of
    // "never a lost delivered".
    expect(pushed.delivery.acknowledgement?.status).toBe('pending');
    expect(pushed.delivery.acknowledgement?.status).not.toBe('settled');
    expect(ledger.pending('bob', 1_000)).toHaveLength(1);

    // The runner dies mid-window without ever settling.
    unsubscribe();

    // Not lost: the row is still owed to bob rather than consumed by the dead socket.
    const stillPending = ledger.pending('bob', 1_000);
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0]?.message.id).toBe(pushed.message.id);

    // Release on reconnect: a successor subscription reports ready, and the
    // broker hands it the same message. Asserted on the successor's own inbox
    // rather than by calling a redelivery method — an earlier draft of this test
    // used `broker.redeliverPendingFor?.('bob')`, which does not exist, so the
    // optional call was a silent no-op and the line proved nothing.
    const redelivered: Message[] = [];
    broker.subscribe(
      'bob',
      (m) => {
        redelivered.push(m);
      },
      {
        name: 'bob',
        clientIdentity: LIVENESS_RUNNER,
        subscriptionId: 'sub-successor',
      },
    );
    await broker.runnerCondition(
      'bob',
      { kind: 'runner_condition', at: 1_001, state: 'ready' },
      { name: 'bob', clientIdentity: LIVENESS_RUNNER, subscriptionId: 'sub-successor' },
    );
    expect(redelivered.map((m) => m.id)).toContain(pushed.message.id);

    // And once it genuinely acts, the row settles — the honest end of the same
    // path. A liveness-advertising subscription must accept before it settles;
    // a terminal disposition on a pending row is refused, which is the lease
    // rule and not an artefact of this test.
    const successor = {
      name: 'bob',
      clientIdentity: LIVENESS_RUNNER,
      subscriptionId: 'sub-successor',
    } as const;
    const base = {
      kind: 'message_disposition',
      messageId: pushed.message.id,
    } as const;

    await expect(
      broker.disposition('bob', { ...base, at: 1_002, disposition: 'handled' }, successor),
    ).resolves.toBe(false);
    expect(ledger.pending('bob', 1_000)).toHaveLength(1);

    await expect(
      broker.disposition('bob', { ...base, at: 1_003, disposition: 'accepted' }, successor),
    ).resolves.toBe(true);
    await expect(
      broker.disposition('bob', { ...base, at: 1_004, disposition: 'handled' }, successor),
    ).resolves.toBe(true);
    expect(ledger.pending('bob', 1_000)).toHaveLength(0);
  });

  it('keeps deferred work pending and settles a later handled disposition', async () => {
    const { broker, ledger } = fixture();
    broker.subscribe('bob', () => {}, { name: 'bob', clientIdentity: ACK_RUNNER });
    const pushed = await broker.push({ to: 'bob', body: 'work' }, { from: 'alice' });
    const base = { kind: 'message_disposition', messageId: pushed.message.id, at: 1_001 } as const;

    await expect(
      broker.disposition(
        'bob',
        { ...base, disposition: 'deferred', reason: { code: 'degraded', detail: 'no model' } },
        { name: 'bob', clientIdentity: ACK_RUNNER },
      ),
    ).resolves.toBe(true);
    expect(ledger.pending('bob', 1_001)).toHaveLength(1);

    await expect(
      broker.disposition(
        'bob',
        { ...base, disposition: 'handled', at: 1_002 },
        {
          name: 'bob',
          clientIdentity: ACK_RUNNER,
        },
      ),
    ).resolves.toBe(true);
    expect(ledger.pending('bob', 1_002)).toHaveLength(0);
  });

  it('keeps authoritative settlement when an observational listener throws', async () => {
    const { broker, ledger } = fixture();
    broker.subscribe('bob', () => {}, { name: 'bob', clientIdentity: ACK_RUNNER });
    const pushed = await broker.push({ to: 'bob', body: 'work' }, { from: 'alice' });
    broker.onMessageDisposition(() => {
      throw new Error('observer failed');
    });

    await expect(
      broker.disposition(
        'bob',
        {
          kind: 'message_disposition',
          messageId: pushed.message.id,
          disposition: 'handled',
          at: 1_001,
        },
        { name: 'bob', clientIdentity: ACK_RUNNER },
      ),
    ).resolves.toBe(true);
    expect(ledger.pending('bob', 1_001)).toHaveLength(0);
  });

  it('marks legacy delivery unreported and rejects dispositions from non-runners', async () => {
    const { broker, ledger } = fixture();
    broker.subscribe('bob', () => {}, { name: 'bob', clientIdentity: LEGACY_RUNNER });
    const result = await broker.push({ to: 'bob', body: 'work' }, { from: 'alice' });
    expect(result.delivery.acknowledgement).toEqual({
      status: 'unreported',
      pending: 0,
      unreported: 1,
    });
    expect(ledger.pending('bob', 1_000)).toHaveLength(0);

    const frame: MessageDispositionFrame = {
      kind: 'message_disposition',
      messageId: result.message.id,
      disposition: 'handled',
      at: 1_001,
    };
    await expect(
      broker.disposition('bob', frame, {
        name: 'bob',
        clientIdentity: { kind: 'browser', clientVersion: 'test' },
      }),
    ).resolves.toBe(false);
  });

  it('releases an accepted lease on subscription close and refuses its stale completion', async () => {
    const { broker, ledger } = fixture();
    const context = {
      name: 'bob',
      clientIdentity: LIVENESS_RUNNER,
      subscriptionId: 'socket-1',
    } as const;
    const unsubscribe = broker.subscribe('bob', () => {}, context);
    const pushed = await broker.push({ to: 'bob', body: 'survive' }, { from: 'alice' });
    await expect(
      broker.disposition(
        'bob',
        {
          kind: 'message_disposition',
          messageId: pushed.message.id,
          disposition: 'accepted',
          at: 1_001,
        },
        context,
      ),
    ).resolves.toBe(true);
    expect(ledger.pending('bob', 1_002)).toEqual([]);

    unsubscribe();
    expect(ledger.pending('bob', 1_002)).toHaveLength(1);
    await expect(
      broker.disposition(
        'bob',
        {
          kind: 'message_disposition',
          messageId: pushed.message.id,
          disposition: 'handled',
          at: 1_003,
        },
        context,
      ),
    ).resolves.toBe(false);
  });

  it('redelivers a released lease when the same runner recovers to ready', async () => {
    const { broker } = fixture();
    const delivered: Message[] = [];
    const context = {
      name: 'bob',
      clientIdentity: LIVENESS_RUNNER,
      subscriptionId: 'socket-1',
    } as const;
    broker.subscribe(
      'bob',
      (message) => {
        delivered.push(message);
      },
      context,
    );
    await broker.runnerCondition(
      'bob',
      { kind: 'runner_condition', at: 1_000, state: 'ready' },
      context,
    );
    const pushed = await broker.push({ to: 'bob', body: 'recover me' }, { from: 'alice' });
    await broker.disposition(
      'bob',
      {
        kind: 'message_disposition',
        messageId: pushed.message.id,
        disposition: 'accepted',
        at: 1_001,
      },
      context,
    );
    await broker.runnerCondition(
      'bob',
      {
        kind: 'runner_condition',
        at: 1_002,
        state: 'degraded',
        reason: { code: 'model_unavailable', detail: 'configured model is unavailable' },
      },
      context,
    );
    expect(delivered).toHaveLength(1);
    await broker.runnerCondition(
      'bob',
      { kind: 'runner_condition', at: 1_003, state: 'ready' },
      context,
    );
    expect(delivered.map((message) => message.id)).toEqual([pushed.message.id, pushed.message.id]);
  });

  it('an open turn without evidence never projects working', async () => {
    const { broker } = fixture();
    const context = {
      name: 'bob',
      clientIdentity: LIVENESS_RUNNER,
      subscriptionId: 'socket-1',
    } as const;
    broker.subscribe('bob', () => {}, context);
    await broker.runnerCondition(
      'bob',
      { kind: 'runner_condition', at: 1_000, state: 'ready' },
      context,
    );
    expect(
      broker.runnerTurn(
        'bob',
        { kind: 'runner_turn', at: 1_001, turnId: 'turn-open', phase: 'started' },
        context,
      ),
    ).toBe(true);
    const presence = broker.listPresences('test').find((row) => row.name === 'bob');
    expect(presence?.executor).toMatchObject({
      state: 'ready',
      activeTurns: 1,
      lastActedAt: null,
    });
    expect(presence?.activity).not.toBe('working');
  });

  it('assigns a tracked message to only one capable runner subscription', async () => {
    const { broker } = fixture();
    const first: Message[] = [];
    const second: Message[] = [];
    const firstContext = {
      name: 'bob',
      clientIdentity: LIVENESS_RUNNER,
      subscriptionId: 'socket-1',
    } as const;
    const secondContext = {
      name: 'bob',
      clientIdentity: LIVENESS_RUNNER,
      subscriptionId: 'socket-2',
    } as const;
    broker.subscribe(
      'bob',
      (message) => {
        first.push(message);
      },
      firstContext,
    );
    broker.subscribe(
      'bob',
      (message) => {
        second.push(message);
      },
      secondContext,
    );
    await broker.runnerCondition(
      'bob',
      {
        kind: 'runner_condition',
        at: 1_000,
        state: 'degraded',
        reason: { code: 'model_unavailable', detail: 'configured model is unavailable' },
      },
      firstContext,
    );
    await broker.runnerCondition(
      'bob',
      { kind: 'runner_condition', at: 1_001, state: 'ready' },
      secondContext,
    );
    await broker.push({ to: 'bob', body: 'exactly once' }, { from: 'alice' });
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });

  it('reassigns a degraded subscription lease to another ready subscription', async () => {
    const { broker } = fixture();
    const first: Message[] = [];
    const second: Message[] = [];
    const firstContext = {
      name: 'bob',
      clientIdentity: LIVENESS_RUNNER,
      subscriptionId: 'socket-1',
    } as const;
    const secondContext = {
      name: 'bob',
      clientIdentity: LIVENESS_RUNNER,
      subscriptionId: 'socket-2',
    } as const;
    broker.subscribe('bob', (message) => void first.push(message), firstContext);
    broker.subscribe('bob', (message) => void second.push(message), secondContext);
    await broker.runnerCondition(
      'bob',
      { kind: 'runner_condition', at: 1_000, state: 'ready' },
      firstContext,
    );
    await broker.runnerCondition(
      'bob',
      { kind: 'runner_condition', at: 1_000, state: 'ready' },
      secondContext,
    );
    const pushed = await broker.push({ to: 'bob', body: 'move on degradation' }, { from: 'alice' });
    await broker.disposition(
      'bob',
      {
        kind: 'message_disposition',
        messageId: pushed.message.id,
        disposition: 'accepted',
        at: 1_001,
      },
      firstContext,
    );
    await broker.runnerCondition(
      'bob',
      {
        kind: 'runner_condition',
        at: 1_002,
        state: 'degraded',
        reason: { code: 'server_overloaded', detail: 'model service is overloaded' },
      },
      firstContext,
    );
    expect(first).toHaveLength(1);
    expect(second.map((message) => message.id)).toEqual([pushed.message.id]);
    expect(broker.listPresences('test')[0]?.executor?.state).toBe('ready');
  });

  it('releases leases at the degraded projection for frames, auth, and the backstop', async () => {
    const { broker, ledger, setNow } = fixture();
    const context = {
      name: 'bob',
      tokenId: 'token-1',
      clientIdentity: LIVENESS_RUNNER,
      subscriptionId: 'socket-1',
    } as const;
    broker.subscribe('bob', () => {}, context);
    await broker.runnerCondition(
      'bob',
      { kind: 'runner_condition', at: 1_000, state: 'ready' },
      context,
    );

    const accept = async (body: string, turnId: string) => {
      await broker.runnerCondition(
        'bob',
        { kind: 'runner_condition', at: 1_000, state: 'ready' },
        context,
      );
      const pushed = await broker.push({ to: 'bob', body }, { from: 'alice' });
      await broker.disposition(
        'bob',
        {
          kind: 'message_disposition',
          messageId: pushed.message.id,
          disposition: 'accepted',
          at: 1_001,
        },
        context,
      );
      broker.runnerTurn(
        'bob',
        { kind: 'runner_turn', at: 1_001, turnId, phase: 'started' },
        context,
      );
      return pushed.message.id;
    };

    await accept('condition', 'turn-1');
    await expect(
      broker.runnerCondition(
        'bob',
        {
          kind: 'runner_condition',
          at: 1_002,
          state: 'degraded',
          reason: { code: 'invalid_model', detail: 'configured model id is invalid' },
        },
        context,
      ),
    ).resolves.toBe(true);
    expect(ledger.pending('bob', 1_003)).toHaveLength(1);

    await accept('auth', 'turn-2');
    broker.blockTokens(['token-1']);
    expect(ledger.pending('bob', 1_003)).toHaveLength(2);

    await accept('backstop', 'turn-old');
    setNow(1_001 + Broker.OPEN_TURN_BACKSTOP_MS);
    const presence = broker.listPresences('test').find((row) => row.name === 'bob');
    expect(presence?.executor?.state).toBe('degraded');
    expect(presence?.activity).not.toBe('working');
    expect(ledger.pending('bob', 1_001 + Broker.OPEN_TURN_BACKSTOP_MS)).not.toHaveLength(0);
  });

  it('emits one ledger-exempt refusal fact for explicit refusal and expiry', async () => {
    const { broker, ledger, setNow } = fixture();
    const sender: Message[] = [];
    broker.subscribe(
      'alice',
      (message) => {
        sender.push(message);
      },
      {
        name: 'alice',
        clientIdentity: { kind: 'browser', clientVersion: 'test' },
      },
    );
    broker.subscribe('bob', () => {}, { name: 'bob', clientIdentity: ACK_RUNNER });

    const explicit = await broker.push({ to: 'bob', body: 'first' }, { from: 'alice' });
    await broker.disposition(
      'bob',
      {
        kind: 'message_disposition',
        messageId: explicit.message.id,
        disposition: 'refused',
        at: 1_001,
        reason: { code: 'operator_policy', detail: 'declined' },
      },
      { name: 'bob', clientIdentity: ACK_RUNNER },
    );
    expect(sender.filter((message) => message.data.kind === 'message_disposition')).toHaveLength(1);

    await broker.push({ to: 'bob', body: 'second' }, { from: 'alice' });
    setNow(1_000 + MESSAGE_DELIVERY_TTL_MS + 1);
    await expect(broker.sweepMessageDeliveries()).resolves.toBe(1);
    expect(sender.filter((message) => message.data.kind === 'message_disposition')).toHaveLength(2);
    expect(ledger.pending('alice', 1_000 + MESSAGE_DELIVERY_TTL_MS + 1)).toHaveLength(0);
    await expect(broker.sweepMessageDeliveries()).resolves.toBe(0);
  });
});

describe('SqliteMessageDeliveryLedger', () => {
  it('retains pending delivery across a database reopen and expires it once', () => {
    const db = new DatabaseSync(':memory:') as unknown as SqlDriver;
    const first = new SqliteMessageDeliveryLedger(db);
    const message: Message = {
      id: 'durable-1',
      ts: 1_000,
      to: 'bob',
      from: 'alice',
      title: null,
      body: 'survive restart',
      level: 'info',
      data: {},
      attachments: [],
    };
    first.track(message, 'bob', 1_000);
    first.noteSent(message.id, 'bob', 1_001);

    const reopened = new SqliteMessageDeliveryLedger(db);
    expect(reopened.pending('bob', 1_002)).toEqual([
      expect.objectContaining({ message, recipient: 'bob', attempts: 1, firstSentAt: 1_001 }),
    ]);
    expect(reopened.expire(1_000 + MESSAGE_DELIVERY_TTL_MS + 1)).toEqual([
      expect.objectContaining({ message, recipient: 'bob', sender: 'alice' }),
    ]);
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM message_deliveries').get() as { count: number })
        .count,
    ).toBe(0);
    expect(reopened.expire(1_000 + MESSAGE_DELIVERY_TTL_MS + 2)).toEqual([]);
  });

  it('serves expiry from the state/expires index rather than scanning the table', () => {
    const db = new DatabaseSync(':memory:') as unknown as SqlDriver;
    new SqliteMessageDeliveryLedger(db);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT message_json FROM message_deliveries
         WHERE state = 'pending' AND expires_at <= ?`,
      )
      .all(1_000) as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes('message_deliveries_expiry_idx'))).toBe(true);
    expect(plan.some((row) => /^SCAN message_deliveries$/.test(row.detail))).toBe(false);
    const purgePlan = db
      .prepare(
        `EXPLAIN QUERY PLAN DELETE FROM message_deliveries
         WHERE state IN ('acted', 'handled', 'refused', 'unreported') AND expires_at <= ?`,
      )
      .all(1_000) as Array<{ detail: string }>;
    expect(purgePlan.some((row) => row.detail.includes('message_deliveries_expiry_idx'))).toBe(
      true,
    );
    expect(purgePlan.some((row) => /^SCAN message_deliveries$/.test(row.detail))).toBe(false);
  });
});
