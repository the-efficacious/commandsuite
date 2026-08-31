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
  });
});
