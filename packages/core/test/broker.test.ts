import { MessageSchema } from 'csuite-sdk/schemas';
import type { Message } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import {
  Broker,
  InMemoryEventLog,
  InvalidRecipientError,
  PresenceIdentityError,
} from '../src/index.js';

function makeBroker(overrides: { idFactory?: () => string; now?: () => number } = {}) {
  const eventLog = new InMemoryEventLog();
  let tick = 0;
  let id = 0;
  const broker = new Broker({
    eventLog,
    now: overrides.now ?? (() => ++tick),
    idFactory: overrides.idFactory ?? (() => `msg-${++id}`),
  });
  return { broker, eventLog };
}

describe('Broker.register', () => {
  it('creates a new agent on first register', async () => {
    const { broker } = makeBroker();
    const reg = await broker.register('agent-1');
    expect(reg.name).toBe('agent-1');
    expect(reg.registeredAt).toBe(1);
    expect(broker.listPresences()).toHaveLength(1);
  });

  it('is idempotent for repeated registers (preserves createdAt)', async () => {
    const { broker } = makeBroker();
    const first = await broker.register('agent-1');
    const second = await broker.register('agent-1');
    expect(first.registeredAt).toBe(second.registeredAt);
    expect(broker.listPresences()).toHaveLength(1);
  });

  it('records role from the register context', async () => {
    const { broker } = makeBroker();
    await broker.register('build-bot', { role: { title: 'engineer', description: '' } });
    const agents = broker.listPresences();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.role?.title).toBe('engineer');
  });

  it('defaults role to null when no context is supplied', async () => {
    const { broker } = makeBroker();
    await broker.register('nameless');
    expect(broker.listPresences()[0]?.role).toBeNull();
  });

  it('allows the matching name to register idempotently', async () => {
    const { broker } = makeBroker();
    await broker.register('alice', {
      role: { title: 'director', description: '' },
      name: 'alice',
    });
    await broker.register('alice', {
      role: { title: 'director', description: '' },
      name: 'alice',
    });
    expect(broker.listPresences()).toHaveLength(1);
  });

  it('rejects register when agentId does not equal name', async () => {
    const { broker } = makeBroker();
    await expect(
      broker.register('alice', { role: { title: 'director', description: '' }, name: 'mallory' }),
    ).rejects.toBeInstanceOf(PresenceIdentityError);
  });

  it('skips the identity check when no name is supplied', async () => {
    const { broker } = makeBroker();
    await expect(broker.register('whoever')).resolves.toBeDefined();
  });
});

describe('Broker.seedMembers', () => {
  it('pre-populates the registry with every member', () => {
    const { broker } = makeBroker();
    broker.seedMembers([
      { name: 'director-1', role: { title: 'director', description: '' } },
      { name: 'engineer-1', role: { title: 'engineer', description: '' } },
      { name: 'engineer-2', role: { title: 'reviewer', description: '' } },
    ]);
    const presences = broker.listPresences();
    expect(presences.map((p) => p.name).sort()).toEqual(['director-1', 'engineer-1', 'engineer-2']);
    expect(presences.find((p) => p.name === 'director-1')?.role?.title).toBe('director');
    expect(presences.find((p) => p.name === 'engineer-2')?.role?.title).toBe('reviewer');
    expect(presences.every((p) => p.connected === 0)).toBe(true);
  });
});

describe('Broker.subscribe identity', () => {
  it('rejects subscribe when agentId does not equal name', async () => {
    const { broker } = makeBroker();
    expect(() => broker.subscribe('alice', () => {}, { name: 'mallory' })).toThrow(
      PresenceIdentityError,
    );
  });

  it('allows the matching name to subscribe', async () => {
    const { broker } = makeBroker();
    const received: Message[] = [];
    broker.subscribe(
      'alice',
      (m) => {
        received.push(m);
      },
      { name: 'alice' },
    );
    await broker.push({ to: 'alice', body: 'hi' }, { from: 'bob' });
    expect(received).toHaveLength(1);
  });
});

describe('Broker.push channel-scoped fanout', () => {
  it('with explicit recipients delivers only to those members + sender', async () => {
    const { broker } = makeBroker();
    for (const name of ['alice', 'bob', 'carol', 'dave']) {
      await broker.register(name, {
        role: { title: 'engineer', description: '' },
        name,
      });
    }
    const inboxes = new Map<string, Message[]>();
    for (const name of ['alice', 'bob', 'carol', 'dave']) {
      inboxes.set(name, []);
      broker.subscribe(
        name,
        (m) => {
          inboxes.get(name)?.push(m);
        },
        { name },
      );
    }

    // Channel members are alice + bob; carol and dave are NOT in the
    // channel and must not see the message.
    const result = await broker.push(
      { body: 'channel ping' },
      { from: 'alice', recipients: ['alice', 'bob'] },
    );

    // targets reports the explicit recipient set (sender included
    // for multi-device sync but not counted toward addressee size).
    expect(result.delivery.targets).toBe(2);
    expect(result.delivery.live).toBe(2);
    expect(inboxes.get('alice')).toHaveLength(1);
    expect(inboxes.get('bob')).toHaveLength(1);
    expect(inboxes.get('carol')).toHaveLength(0);
    expect(inboxes.get('dave')).toHaveLength(0);
  });

  it('with empty recipients still delivers to the sender (multi-device)', async () => {
    const { broker } = makeBroker();
    await broker.register('alice', {
      role: { title: 'engineer', description: '' },
      name: 'alice',
    });
    const inbox: Message[] = [];
    broker.subscribe(
      'alice',
      (m) => {
        inbox.push(m);
      },
      { name: 'alice' },
    );
    const result = await broker.push({ body: 'lone message' }, { from: 'alice', recipients: [] });
    // No explicit recipients but the sender still sees their own
    // message via sender-fanout. Targets is 0 because the recipient
    // list is empty.
    expect(result.delivery.targets).toBe(0);
    expect(inbox).toHaveLength(1);
  });

  it('skips offline channel members silently', async () => {
    const { broker } = makeBroker();
    await broker.register('alice', {
      role: { title: 'engineer', description: '' },
      name: 'alice',
    });
    // bob is "in the channel" but not registered/online.
    const inbox: Message[] = [];
    broker.subscribe(
      'alice',
      (m) => {
        inbox.push(m);
      },
      { name: 'alice' },
    );
    const result = await broker.push(
      { body: 'half-offline' },
      { from: 'alice', recipients: ['alice', 'bob'] },
    );
    // Targets reports the channel-recipient count regardless of who's
    // actually online; live counts only delivered subscribers.
    expect(result.delivery.targets).toBe(2);
    expect(result.delivery.live).toBe(1);
  });
});

describe('Broker.push DM sender-fanout', () => {
  it("delivers a DM to the sender's own agent when both are registered", async () => {
    const { broker } = makeBroker();
    await broker.register('alice', {
      role: { title: 'director', description: '' },
      name: 'alice',
    });
    await broker.register('build-bot', {
      role: { title: 'engineer', description: '' },
      name: 'build-bot',
    });

    const aliceReceived: Message[] = [];
    const botReceived: Message[] = [];
    broker.subscribe(
      'alice',
      (m) => {
        aliceReceived.push(m);
      },
      { name: 'alice' },
    );
    broker.subscribe(
      'build-bot',
      (m) => {
        botReceived.push(m);
      },
      { name: 'build-bot' },
    );

    const result = await broker.push({ to: 'build-bot', body: 'status?' }, { from: 'alice' });

    // Primary target is still build-bot; alice's copy is sender-fanout
    // for multi-device consistency.
    expect(result.delivery.targets).toBe(1);
    expect(result.delivery.live).toBe(2);
    expect(botReceived).toHaveLength(1);
    expect(aliceReceived).toHaveLength(1);
    expect(aliceReceived[0]?.to).toBe('build-bot');
    expect(aliceReceived[0]?.from).toBe('alice');
  });

  it('does not double-deliver when the sender talks to themselves', async () => {
    const { broker } = makeBroker();
    await broker.register('alice', {
      role: { title: 'director', description: '' },
      name: 'alice',
    });
    const received: Message[] = [];
    broker.subscribe(
      'alice',
      (m) => {
        received.push(m);
      },
      { name: 'alice' },
    );

    const result = await broker.push({ to: 'alice', body: 'note-to-self' }, { from: 'alice' });

    expect(result.delivery.targets).toBe(1);
    expect(result.delivery.live).toBe(1);
    expect(received).toHaveLength(1);
  });

  it('is a no-op when the sender has no registered agent', async () => {
    const { broker } = makeBroker();
    await broker.register('build-bot', {
      role: { title: 'engineer', description: '' },
      name: 'build-bot',
    });
    const received: Message[] = [];
    broker.subscribe(
      'build-bot',
      (m) => {
        received.push(m);
      },
      { name: 'build-bot' },
    );

    const result = await broker.push({ to: 'build-bot', body: 'hello' }, { from: 'alice' });
    expect(result.delivery.targets).toBe(1);
    expect(result.delivery.live).toBe(1);
    expect(received).toHaveLength(1);
  });
});

describe('Broker.push stamping', () => {
  it('stamps `from` from the push context, never from the payload', async () => {
    const { broker } = makeBroker();
    await broker.register('agent-1');

    // The payload has no way to supply `from` at the type level, but
    // even if a runtime adapter accidentally passed one in via `data`,
    // the broker must ignore it — only the context value wins.
    const result = await broker.push(
      { to: 'agent-1', body: 'hi', data: { from: 'spoofed' } },
      { from: 'alice' },
    );

    expect(result.message.from).toBe('alice');
    expect(result.message.data).toEqual({ from: 'spoofed' }); // data passed through untouched
  });

  it('stamps `from: null` when no context is supplied', async () => {
    const { broker } = makeBroker();
    await broker.register('agent-1');
    const result = await broker.push({ to: 'agent-1', body: 'hi' });
    expect(result.message.from).toBeNull();
  });
});

describe('Broker.push targeted', () => {
  it('delivers to every subscriber of the target agent and writes event log', async () => {
    const { broker, eventLog } = makeBroker();
    await broker.register('agent-1');
    const received: Message[] = [];
    broker.subscribe('agent-1', (msg) => {
      received.push(msg);
    });

    const result = await broker.push({ to: 'agent-1', body: 'hello' });

    expect(result.delivery.live).toBe(1);
    expect(result.delivery.targets).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toBe('hello');
    expect(received[0]?.to).toBe('agent-1');
    expect(await eventLog.tail()).toHaveLength(1);
  });

  it('returns targets: 0 when the target agent is unknown', async () => {
    const { broker } = makeBroker();
    const result = await broker.push({ to: 'ghost', body: 'hi' });
    expect(result.delivery.live).toBe(0);
    expect(result.delivery.targets).toBe(0);
  });

  it('fans out to multiple subscribers of the same agent', async () => {
    const { broker } = makeBroker();
    await broker.register('agent-1');
    const a: Message[] = [];
    const b: Message[] = [];
    broker.subscribe('agent-1', (m) => {
      a.push(m);
    });
    broker.subscribe('agent-1', (m) => {
      b.push(m);
    });

    const result = await broker.push({ to: 'agent-1', body: 'hi' });
    expect(result.delivery.live).toBe(2);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('isolates a throwing subscriber from other subscribers on the same agent', async () => {
    const warn = vi.fn();
    const eventLog = new InMemoryEventLog();
    const broker = new Broker({
      eventLog,
      now: () => 1,
      idFactory: () => 'msg-1',
      logger: { warn, error: () => {} },
    });
    await broker.register('agent-1');
    const good: Message[] = [];
    broker.subscribe('agent-1', () => {
      throw new Error('boom');
    });
    broker.subscribe('agent-1', (m) => {
      good.push(m);
    });

    const result = await broker.push({ to: 'agent-1', body: 'hi' });
    expect(good).toHaveLength(1);
    expect(result.delivery.live).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('Broker.push broadcast', () => {
  it('delivers to every registered agent when agentId is omitted', async () => {
    const { broker } = makeBroker();
    await broker.register('a1');
    await broker.register('a2');
    const r1: Message[] = [];
    const r2: Message[] = [];
    broker.subscribe('a1', (m) => {
      r1.push(m);
    });
    broker.subscribe('a2', (m) => {
      r2.push(m);
    });

    const result = await broker.push({ body: 'broadcast' });
    expect(result.delivery.targets).toBe(2);
    expect(result.delivery.live).toBe(2);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });

  it('broadcast to empty registry reports zeros', async () => {
    const { broker } = makeBroker();
    const result = await broker.push({ body: 'hello void' });
    expect(result.delivery.targets).toBe(0);
    expect(result.delivery.live).toBe(0);
  });
});

describe('Broker fanout concurrency', () => {
  it('delivers to slow subscribers in parallel — one stuck callback does not block others', async () => {
    const { broker } = makeBroker();
    await broker.register('a1');
    await broker.register('a2');
    await broker.register('a3');

    let a1Resolved = false;
    let a2Resolved = false;
    let a3Resolved = false;
    let releaseA1: () => void = () => {};

    broker.subscribe('a1', async () => {
      await new Promise<void>((resolve) => {
        releaseA1 = resolve;
      });
      a1Resolved = true;
    });
    broker.subscribe('a2', async () => {
      a2Resolved = true;
    });
    broker.subscribe('a3', async () => {
      a3Resolved = true;
    });

    const pushPromise = broker.push({ body: 'broadcast' });

    // Give the microtask queue a chance to run a2 + a3 in parallel
    // with the stuck a1. Under the pre-2026-04-16 serial fanout,
    // a2 and a3 would be blocked behind a1 until releaseA1 fires.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(a2Resolved).toBe(true);
    expect(a3Resolved).toBe(true);
    expect(a1Resolved).toBe(false);

    // Release a1 and let the push complete.
    releaseA1();
    const result = await pushPromise;
    expect(a1Resolved).toBe(true);
    expect(result.delivery.live).toBe(3);
  });

  it('a throwing subscriber does not abort fanout to others', async () => {
    const { broker } = makeBroker();
    await broker.register('a1');
    await broker.register('a2');

    broker.subscribe('a1', () => {
      throw new Error('boom');
    });
    const received: Message[] = [];
    broker.subscribe('a2', (m) => {
      received.push(m);
    });

    const result = await broker.push({ body: 'hi' });
    // sse count is 1 (a2) because a1's subscriber threw.
    expect(result.delivery.live).toBe(1);
    expect(received).toHaveLength(1);
  });

  it('honors fanoutConcurrency=1 for reproducible serial delivery', async () => {
    const eventLog = new InMemoryEventLog();
    const broker = new Broker({
      eventLog,
      now: (() => {
        let t = 0;
        return () => ++t;
      })(),
      idFactory: (() => {
        let id = 0;
        return () => `msg-${++id}`;
      })(),
      fanoutConcurrency: 1,
    });
    await broker.register('a1');
    await broker.register('a2');
    await broker.register('a3');

    const order: string[] = [];
    broker.subscribe('a1', async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('a1');
    });
    broker.subscribe('a2', async () => {
      order.push('a2');
    });
    broker.subscribe('a3', async () => {
      order.push('a3');
    });

    await broker.push({ body: 'serial' });
    expect(order).toEqual(['a1', 'a2', 'a3']);
  });
});

describe('Broker.subscribe', () => {
  it('auto-registers the agent if not previously known', async () => {
    const { broker } = makeBroker();
    broker.subscribe('autoreg', () => {});
    expect(broker.hasMember('autoreg')).toBe(true);
  });

  it('unsubscribe stops further deliveries', async () => {
    const { broker } = makeBroker();
    await broker.register('agent-1');
    const received: Message[] = [];
    const unsub = broker.subscribe('agent-1', (m) => {
      received.push(m);
    });
    await broker.push({ to: 'agent-1', body: 'first' });
    unsub();
    await broker.push({ to: 'agent-1', body: 'second' });
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toBe('first');
  });

  it('listPresences reports the live subscriber count in `connected`', async () => {
    const { broker } = makeBroker();
    await broker.register('agent-1');
    expect(broker.listPresences()[0]?.connected).toBe(0);
    const unsub = broker.subscribe('agent-1', () => {});
    expect(broker.listPresences()[0]?.connected).toBe(1);
    unsub();
    expect(broker.listPresences()[0]?.connected).toBe(0);
  });
});

describe('InMemoryEventLog.query', () => {
  function msg(overrides: Partial<Message> & { id: string; ts: number }): Message {
    return {
      to: null,
      from: null,
      title: null,
      body: 'msg',
      level: 'info',
      data: {},
      attachments: [],
      ...overrides,
    };
  }

  it('returns broadcasts + DMs involving the viewer', async () => {
    const log = new InMemoryEventLog();
    await log.append(msg({ id: 'bcast', ts: 1 }));
    await log.append(msg({ id: 'dm-to-alice', ts: 2, to: 'alice', from: 'bob' }));
    await log.append(msg({ id: 'dm-from-alice', ts: 3, to: 'bob', from: 'alice' }));
    await log.append(msg({ id: 'other-dm', ts: 4, to: 'carol', from: 'bob' }));

    const result = await log.query({ viewer: 'alice' });
    const ids = result.map((m) => m.id);
    expect(ids).toContain('bcast');
    expect(ids).toContain('dm-to-alice');
    expect(ids).toContain('dm-from-alice');
    expect(ids).not.toContain('other-dm');
  });

  it('narrows to DMs with a specific other when `with` is set', async () => {
    const log = new InMemoryEventLog();
    await log.append(msg({ id: 'bcast', ts: 1 }));
    await log.append(msg({ id: 'dm-alice-bob', ts: 2, to: 'bob', from: 'alice' }));
    await log.append(msg({ id: 'dm-bob-alice', ts: 3, to: 'alice', from: 'bob' }));
    await log.append(msg({ id: 'dm-alice-carol', ts: 4, to: 'carol', from: 'alice' }));

    const result = await log.query({ viewer: 'alice', with: 'bob' });
    const ids = result.map((m) => m.id);
    expect(ids).toEqual(['dm-bob-alice', 'dm-alice-bob']);
    expect(ids).not.toContain('bcast');
    expect(ids).not.toContain('dm-alice-carol');
  });

  it('respects limit and before for pagination', async () => {
    const log = new InMemoryEventLog();
    for (let i = 1; i <= 10; i++) {
      await log.append(msg({ id: `m${i}`, ts: i }));
    }
    const page1 = await log.query({ viewer: 'alice', limit: 3 });
    expect(page1.map((m) => m.id)).toEqual(['m10', 'm9', 'm8']);

    const page2 = await log.query({ viewer: 'alice', limit: 3, before: 8 });
    expect(page2.map((m) => m.id)).toEqual(['m7', 'm6', 'm5']);
  });
});

describe('InMemoryEventLog', () => {
  it('append + tail round-trip', async () => {
    const log = new InMemoryEventLog();
    const m1: Message = {
      id: 'a',
      ts: 1,
      to: 'x',
      from: null,
      title: null,
      body: 'a',
      level: 'info',
      data: {},
      attachments: [],
    };
    const m2: Message = { ...m1, id: 'b', ts: 2, body: 'b' };
    await log.append(m1);
    await log.append(m2);
    const out = await log.tail();
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe('a');
    expect(out[1]?.id).toBe('b');
  });

  it('tail honours since and limit', async () => {
    const log = new InMemoryEventLog();
    for (let i = 0; i < 5; i++) {
      await log.append({
        id: `m${i}`,
        ts: i,
        to: null,
        from: null,
        title: null,
        body: `msg ${i}`,
        level: 'info',
        data: {},
        attachments: [],
      });
    }
    const sinceOut = await log.tail({ since: 3 });
    expect(sinceOut.map((m) => m.id)).toEqual(['m3', 'm4']);

    const limitOut = await log.tail({ limit: 2 });
    expect(limitOut.map((m) => m.id)).toEqual(['m3', 'm4']);
  });
});

describe('Broker.push recipient validation', () => {
  // The defect these cover, stated once: `push` copied `payload.to`
  // into `message.to` unvalidated, so a library caller could make the
  // broker emit a `Message` that `csuite-sdk`'s own `MessageSchema`
  // rejects — one shipped artifact disagreeing with another. Confirmed
  // live against the fetched 0.2.0 tarballs before it was fixed here:
  // `push({to: 'chan:general'})` emitted `to: 'chan:general'` and
  // `MessageSchema.safeParse` returned `invalid_format` at path `to`.
  //
  // `chan:` is the value that found it and it is worth saying why it is
  // NOT a legitimate recipient, because it looks like one. It is a
  // THREAD prefix (`CHANNEL_THREAD_PREFIX`, event-log.ts) that travels
  // in `data.thread`; channel sends leave `to` unset and pass the
  // member list in `PushContext.recipients`. The live broker log agreed
  // — 959 events, eight distinct `to` values, all member names or null,
  // zero the schema would reject. Nothing in the system produces a
  // `chan:` recipient; it is reachable only through this entry point.

  it('rejects a `to` that MessageSchema would reject', async () => {
    const { broker } = makeBroker();
    await broker.register('agent-1');
    await expect(broker.push({ to: 'chan:general', body: 'hi' })).rejects.toThrow(
      InvalidRecipientError,
    );
  });

  // The general form, and the one that keeps holding after someone
  // edits either artifact: whatever `push` emits, the published schema
  // must accept. A test naming only `chan:` would pass again the moment
  // a different bad prefix appeared.
  it('emits nothing MessageSchema rejects, across the hostile set', async () => {
    const hostile = [
      'chan:general', // the thread prefix that found the defect
      'obj:abc123', // objective namespace prefix — same shape
      'agent 1', // space
      'agent/1', // path separator
      'a'.repeat(129), // over NameSchema's 128
      '', // empty
      'ünïcode', // outside the allowed class
      '*', // wildcard, in case anyone reads it as one
    ];

    for (const to of hostile) {
      const { broker } = makeBroker();
      await broker.register('agent-1');
      let emitted: Message | null = null;
      try {
        emitted = (await broker.push({ to, body: 'hi' })).message;
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidRecipientError);
        continue;
      }
      // If it did emit, the schema must accept it — a widened
      // NameSchema is a legitimate future, an unparseable emission is
      // not.
      const parsed = MessageSchema.safeParse(emitted);
      expect(parsed.success, `emitted an unparseable to: ${JSON.stringify(to)}`).toBe(true);
    }
  });

  it('does not append the rejected message to the event log', async () => {
    const { broker, eventLog } = makeBroker();
    await broker.register('agent-1');
    await expect(broker.push({ to: 'chan:general', body: 'hi' })).rejects.toThrow();
    // Validating after the append would still reject the send while
    // leaving the rejected row durably in the log — the exact artifact
    // this change exists to stop writing.
    expect(await eventLog.query({})).toHaveLength(0);
  });

  it('does not deliver a `to: ""` send to the whole team', async () => {
    // THE EMPTY STRING IS THE SERIOUS CASE and it is not the one that
    // found the bug. Measured on the pre-change broker: `to: 'chan:general'`
    // is truthy, so it took the targeted path, missed the registry
    // lookup and reached nobody — annoying, not dangerous. `to: ''` is
    // falsy, so `payload.to ?? null` let it through to the
    // `registry.allStates()` branch and delivered a message addressed
    // to one recipient to all three registered members (`targets: 3`).
    //
    // That is a disclosure bug, not a validation one, and it is why
    // this entry point rejects rather than coercing: "unparseable name,
    // treat it as null" IS the empty-string path, generalised. An
    // unset variable interpolated into `to` is a normal way to arrive
    // here, and a deliberate broadcast is already spelled by omitting
    // the field.
    const { broker } = makeBroker();
    const seen: string[] = [];
    for (const name of ['alice', 'bob', 'carol']) {
      await broker.register(name);
      broker.subscribe(name, async () => {
        seen.push(name);
      });
    }

    await expect(
      broker.push({ to: '', body: 'meant for one person' }, { from: 'alice' }),
    ).rejects.toThrow(InvalidRecipientError);

    expect(seen).toEqual([]);
  });

  it('still accepts every shape a real caller uses', async () => {
    const { broker } = makeBroker();
    await broker.register('agent-1');

    // A member name.
    expect((await broker.push({ to: 'agent-1', body: 'dm' })).message.to).toBe('agent-1');
    // Omitted — broadcast.
    expect((await broker.push({ body: 'broadcast' })).message.to).toBeNull();
    // Explicit null — same thing.
    expect((await broker.push({ to: null, body: 'broadcast' })).message.to).toBeNull();
    // A channel send: no `to`, thread in data, recipients in context.
    const channel = await broker.push(
      { body: 'in channel', data: { thread: 'chan:general' } },
      { from: 'agent-1', recipients: ['agent-1'] },
    );
    expect(channel.message.to).toBeNull();
    expect(channel.message.data).toEqual({ thread: 'chan:general' });
    expect(MessageSchema.safeParse(channel.message).success).toBe(true);
  });

  it('names the channel convention in the error, since that is the caller who hits it', async () => {
    const { broker } = makeBroker();
    const err = await broker.push({ to: 'chan:general', body: 'hi' }).catch((e) => e);
    expect(err.message).toContain('data.thread');
    expect(err.to).toBe('chan:general');
  });
});
