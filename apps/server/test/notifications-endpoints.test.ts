/**
 * External Notifications endpoint tests — registry CRUD gating,
 * profile lifecycle (including the in-use delete guard), ingress
 * verification (HMAC fail-closed, dedupe, filters, templates), and
 * the delivery policy (offline queue + wake flush, busy wait + idle
 * flush, critical punch-through, debounce coalescing, TTL expiry,
 * max-wait force delivery, replay).
 */

import { createHmac } from 'node:crypto';
import { Broker, InMemoryEventLog } from 'csuite-core';
import type { Message, NotificationEndpoint } from 'csuite-sdk/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createSqliteChannelStore } from '../src/channels.js';
import { openDatabase } from '../src/db.js';
import { testKek } from '../src/kek.js';
import { createMemberStore, setKek } from '../src/members.js';
import { createSqliteNotificationsStore } from '../src/notifications/index.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN = 'csuite_test_admin_notif';
const BUILDER = 'csuite_test_builder_notif';
const OUTSIDER = 'csuite_test_outsider_notif';
const SECRET = 'hook-signing-secret';

const noopLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeApp() {
  let clock = 1_700_000_000_000;
  const advance = (ms: number) => {
    clock += ms;
  };
  const now = () => clock;
  let n = 0;
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now,
    idFactory: () => `msg-${++n}`,
  });
  const members = createMemberStore([
    {
      name: 'admin',
      role: { title: 'director', description: '' },
      permissions: ['notifications.manage', 'members.manage'],
      token: ADMIN,
    },
    {
      name: 'builder',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: BUILDER,
    },
    {
      name: 'outsider',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: OUTSIDER,
    },
  ]);
  broker.seedMembers(members.members());
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
  const notifications = createSqliteNotificationsStore(db);
  const channels = createSqliteChannelStore(db);
  const created = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore({
      name: 'demo-team',
      context: '',
      permissionPresets: {},
    }),
    notifications,
    channels,
    version: '0.0.0',
    logger: noopLog,
    now,
  });
  const dispatcher = created.notificationDispatcher;
  if (!dispatcher) throw new Error('dispatcher not created');
  return { app: created.app, broker, notifications, channels, dispatcher, advance, now };
}

function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = method ?? (body !== undefined ? 'POST' : 'GET');
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`;
}

function hookPost(body: string, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  };
}

/** Subscribe a capture array to a member's live stream. */
function capture(broker: Broker, name: string): { messages: Message[]; unsubscribe: () => void } {
  const messages: Message[] = [];
  const unsubscribe = broker.subscribe(name, (m) => {
    messages.push(m);
  });
  return { messages, unsubscribe };
}

/** Flush queueMicrotask + fire-and-forget dispatch promises. */
const settle = () => new Promise((r) => setTimeout(r, 10));

beforeAll(() => {
  setKek(testKek());
});

afterAll(() => {
  setKek(null);
});

type Ctx = ReturnType<typeof makeApp>;

async function createEndpoint(
  ctx: Ctx,
  overrides: Record<string, unknown> = {},
): Promise<NotificationEndpoint> {
  const resp = await ctx.app.request(
    '/notifications/endpoints',
    authed(ADMIN, {
      slug: 'ci-alerts',
      targets: [{ member: 'builder' }],
      auth: { kind: 'hmac-sha256' },
      ...overrides,
    }),
  );
  expect(resp.status).toBe(201);
  const endpoint = (await resp.json()) as NotificationEndpoint;
  const secretResp = await ctx.app.request(
    `/notifications/endpoints/${endpoint.slug}/secret`,
    authed(ADMIN, { secret: SECRET }, 'PUT'),
  );
  expect(secretResp.status).toBe(200);
  return endpoint;
}

describe('registry CRUD + gating', () => {
  it('create requires notifications.manage; slug conflicts 409', async () => {
    const ctx = makeApp();
    const denied = await ctx.app.request(
      '/notifications/endpoints',
      authed(BUILDER, { slug: 'x', targets: [{ member: 'builder' }] }),
    );
    expect(denied.status).toBe(403);

    await createEndpoint(ctx);
    const dupe = await ctx.app.request(
      '/notifications/endpoints',
      authed(ADMIN, { slug: 'ci-alerts', targets: [{ member: 'builder' }] }),
    );
    expect(dupe.status).toBe(409);
  });

  it('rejects unknown members, unknown channels, unknown profiles', async () => {
    const ctx = makeApp();
    const badMember = await ctx.app.request(
      '/notifications/endpoints',
      authed(ADMIN, { slug: 'a', targets: [{ member: 'ghost' }] }),
    );
    expect(badMember.status).toBe(400);
    const badChannel = await ctx.app.request(
      '/notifications/endpoints',
      authed(ADMIN, { slug: 'b', targets: [{ channel: 'nope' }] }),
    );
    expect(badChannel.status).toBe(400);
    const badProfile = await ctx.app.request(
      '/notifications/endpoints',
      authed(ADMIN, { slug: 'c', targets: [{ member: 'builder' }], authProfile: 'ghost' }),
    );
    expect(badProfile.status).toBe(400);
  });

  it('non-manage members see only endpoints targeting them', async () => {
    const ctx = makeApp();
    await createEndpoint(ctx);
    const asBuilder = await ctx.app.request('/notifications/endpoints', authed(BUILDER));
    const builderList = (await asBuilder.json()) as { endpoints: NotificationEndpoint[] };
    expect(builderList.endpoints.map((e) => e.slug)).toEqual(['ci-alerts']);

    const asOutsider = await ctx.app.request('/notifications/endpoints', authed(OUTSIDER));
    const outsiderList = (await asOutsider.json()) as { endpoints: NotificationEndpoint[] };
    expect(outsiderList.endpoints).toEqual([]);

    const detailDenied = await ctx.app.request(
      '/notifications/endpoints/ci-alerts',
      authed(OUTSIDER),
    );
    expect(detailDenied.status).toBe(403);
  });

  it('profiles: shared auth, in-use delete guard, rotation point', async () => {
    const ctx = makeApp();
    const profile = await ctx.app.request(
      '/notifications/profiles',
      authed(ADMIN, { slug: 'gh-org', auth: { kind: 'hmac-sha256' } }),
    );
    expect(profile.status).toBe(201);
    await ctx.app.request(
      '/notifications/profiles/gh-org/secret',
      authed(ADMIN, { secret: SECRET }, 'PUT'),
    );

    const endpoint = await ctx.app.request(
      '/notifications/endpoints',
      authed(ADMIN, { slug: 'repo-a', targets: [{ member: 'builder' }], authProfile: 'gh-org' }),
    );
    expect(endpoint.status).toBe(201);

    // Referenced profile can't be deleted.
    const del = await ctx.app.request(
      '/notifications/profiles/gh-org',
      authed(ADMIN, undefined, 'DELETE'),
    );
    expect(del.status).toBe(409);

    // The endpoint verifies against the profile's secret with no
    // inline secret of its own.
    const body = '{"ping":true}';
    const accepted = await ctx.app.request(
      '/hooks/repo-a',
      hookPost(body, { 'X-Hub-Signature-256': sign(body) }),
    );
    expect(accepted.status).toBe(202);
  });
});

describe('ingress verification', () => {
  it('404 unknown slug, 409 disabled, 413 oversized', async () => {
    const ctx = makeApp();
    expect((await ctx.app.request('/hooks/ghost', hookPost('{}'))).status).toBe(404);

    await createEndpoint(ctx, { enabled: false });
    expect((await ctx.app.request('/hooks/ci-alerts', hookPost('{}'))).status).toBe(409);

    const ctx2 = makeApp();
    await createEndpoint(ctx2);
    const huge = 'x'.repeat(256 * 1024 + 1);
    expect(
      (
        await ctx2.app.request(
          '/hooks/ci-alerts',
          hookPost(huge, { 'X-Hub-Signature-256': sign(huge) }),
        )
      ).status,
    ).toBe(413);
  });

  it('fails closed without a secret and rejects bad signatures — with receipts', async () => {
    const ctx = makeApp();
    const resp = await ctx.app.request(
      '/notifications/endpoints',
      authed(ADMIN, { slug: 'no-secret', targets: [{ member: 'builder' }] }),
    );
    expect(resp.status).toBe(201);
    const rejected = await ctx.app.request('/hooks/no-secret', hookPost('{}'));
    expect(rejected.status).toBe(401);
    // Terse response, detailed receipt.
    expect(await rejected.json()).toEqual({ error: 'unauthorized' });

    await createEndpoint(ctx);
    const badSig = await ctx.app.request(
      '/hooks/ci-alerts',
      hookPost('{"a":1}', { 'X-Hub-Signature-256': sign('{"a":2}') }),
    );
    expect(badSig.status).toBe(401);

    const receipts = await ctx.app.request(
      '/notifications/endpoints/ci-alerts/deliveries',
      authed(ADMIN),
    );
    const { deliveries } = (await receipts.json()) as {
      deliveries: Array<{ status: string; statusReason: string | null }>;
    };
    expect(deliveries[0]?.status).toBe('rejected');
    expect(deliveries[0]?.statusReason).toContain('signature mismatch');
  });

  it('delivers a verified request as a wrapped DM with hook:<slug> provenance', async () => {
    const ctx = makeApp();
    await createEndpoint(ctx, {
      template: 'CI {{payload.state}} on {{payload.branch}}',
      level: 'warning',
    });
    const { messages } = capture(ctx.broker, 'builder');
    const body = '{"state":"failed","branch":"main"}';
    const accepted = await ctx.app.request(
      '/hooks/ci-alerts',
      hookPost(body, { 'X-Hub-Signature-256': sign(body) }),
    );
    expect(accepted.status).toBe(202);
    const ack = (await accepted.json()) as { id: string; status: string };
    expect(ack.status).toBe('delivered');

    expect(messages).toHaveLength(1);
    const message = messages[0] as Message;
    expect(message.from).toBe('hook:ci-alerts');
    expect(message.to).toBe('builder');
    expect(message.level).toBe('warning');
    expect(message.data.kind).toBe('external_notification');
    expect(message.body).toContain('External notification from endpoint "ci-alerts"');
    expect(message.body).toContain('CI failed on main');
    expect(message.body).toContain('<external_content');
  });

  it('dedupes provider retries on the configured header', async () => {
    const ctx = makeApp();
    await createEndpoint(ctx, { dedupeHeader: 'x-github-delivery' });
    const { messages } = capture(ctx.broker, 'builder');
    const body = '{"n":1}';
    const post = () =>
      ctx.app.request(
        '/hooks/ci-alerts',
        hookPost(body, { 'X-Hub-Signature-256': sign(body), 'X-GitHub-Delivery': 'uuid-1' }),
      );
    const first = (await (await post()).json()) as { id: string; status: string };
    const second = (await (await post()).json()) as { id: string; status: string };
    expect(first.status).toBe('delivered');
    expect(second.status).toBe('duplicate');
    expect(second.id).toBe(first.id);
    expect(messages).toHaveLength(1);
  });

  it('drop-filters non-matching payloads', async () => {
    const ctx = makeApp();
    await createEndpoint(ctx, {
      filters: [{ path: 'branch', op: 'eq', value: 'main' }],
    });
    const { messages } = capture(ctx.broker, 'builder');
    const offBranch = '{"branch":"feature-x"}';
    const filtered = await ctx.app.request(
      '/hooks/ci-alerts',
      hookPost(offBranch, { 'X-Hub-Signature-256': sign(offBranch) }),
    );
    expect(((await filtered.json()) as { status: string }).status).toBe('filtered');
    expect(messages).toHaveLength(0);
  });

  it('routes channel targets to channel members with a chan: thread tag', async () => {
    const ctx = makeApp();
    const channel = ctx.channels.create({ slug: 'ops', creator: 'admin' });
    ctx.channels.addMember({ channelId: channel.id, memberName: 'builder' });
    const resp = await ctx.app.request(
      '/notifications/endpoints',
      authed(ADMIN, {
        slug: 'ops-feed',
        targets: [{ channel: 'ops' }],
        auth: { kind: 'hmac-sha256' },
      }),
    );
    expect(resp.status).toBe(201);
    await ctx.app.request(
      '/notifications/endpoints/ops-feed/secret',
      authed(ADMIN, { secret: SECRET }, 'PUT'),
    );

    const builder = capture(ctx.broker, 'builder');
    const outsider = capture(ctx.broker, 'outsider');
    const body = '{"msg":"deploy done"}';
    const hookResp = await ctx.app.request(
      '/hooks/ops-feed',
      hookPost(body, { 'X-Hub-Signature-256': sign(body) }),
    );
    expect(hookResp.status).toBe(202);
    expect(builder.messages).toHaveLength(1);
    expect(builder.messages[0]?.data.thread).toBe(`chan:${channel.id}`);
    expect(outsider.messages).toHaveLength(0);
  });

  it('rejects malformed query overrides', async () => {
    const ctx = makeApp();
    await createEndpoint(ctx);
    const body = '{}';
    const bad = await ctx.app.request(
      '/hooks/ci-alerts?if_busy=sometimes',
      hookPost(body, { 'X-Hub-Signature-256': sign(body) }),
    );
    expect(bad.status).toBe(400);
  });
});

describe('delivery policy', () => {
  it('offline + default policy drops with an honest receipt', async () => {
    const ctx = makeApp();
    await createEndpoint(ctx);
    const body = '{"n":1}';
    const resp = await ctx.app.request(
      '/hooks/ci-alerts',
      hookPost(body, { 'X-Hub-Signature-256': sign(body) }),
    );
    const ack = (await resp.json()) as { status: string };
    expect(ack.status).toBe('dropped');
  });

  it('offline + queue holds until wake, then delivers with a staleness note', async () => {
    const ctx = makeApp();
    await createEndpoint(ctx, { policy: { ifOffline: 'queue' } });
    const body1 = '{"n":1}';
    const body2 = '{"n":2}';
    for (const body of [body1, body2]) {
      const resp = await ctx.app.request(
        '/hooks/ci-alerts',
        hookPost(body, { 'X-Hub-Signature-256': sign(body) }),
      );
      expect(((await resp.json()) as { status: string }).status).toBe('pending');
    }

    ctx.advance(10 * 60_000); // 10 minutes offline
    const { messages } = capture(ctx.broker, 'builder');
    await ctx.dispatcher.onWake('builder');

    // One coalesced message per endpoint, not one per held delivery.
    expect(messages).toHaveLength(1);
    const message = messages[0] as Message;
    expect(message.body).toContain('queued 10m while you were offline');
    expect(message.body).toContain('2 deliveries coalesced');

    const receipts = await ctx.app.request(
      '/notifications/endpoints/ci-alerts/deliveries',
      authed(ADMIN),
    );
    const { deliveries } = (await receipts.json()) as {
      deliveries: Array<{ status: string; messageIds: string[] }>;
    };
    expect(deliveries.map((d) => d.status).sort()).toEqual(['coalesced', 'delivered']);
    for (const d of deliveries) expect(d.messageIds.length).toBeGreaterThan(0);
  });

  it('queued deliveries expire past the TTL', async () => {
    const ctx = makeApp();
    await createEndpoint(ctx, { policy: { ifOffline: 'queue', queueTtlMs: 60_000 } });
    const body = '{"n":1}';
    await ctx.app.request(
      '/hooks/ci-alerts',
      hookPost(body, { 'X-Hub-Signature-256': sign(body) }),
    );

    ctx.advance(61_000);
    await ctx.dispatcher.sweep();

    const receipts = await ctx.app.request(
      '/notifications/endpoints/ci-alerts/deliveries',
      authed(ADMIN),
    );
    const { deliveries } = (await receipts.json()) as {
      deliveries: Array<{ status: string; statusReason: string | null }>;
    };
    expect(deliveries[0]?.status).toBe('expired');
    expect(deliveries[0]?.statusReason).toContain('TTL lapsed');
  });

  it('busy + wait holds until idle; critical punches through', async () => {
    const ctx = makeApp();
    await createEndpoint(ctx, { policy: { ifBusy: 'wait' } });
    const { messages } = capture(ctx.broker, 'builder');

    // Builder reports working (bearer → runner plane).
    const report = await ctx.app.request(
      '/presence/activity',
      authed(BUILDER, { state: 'working' }),
    );
    expect(report.status).toBe(204);

    const body = '{"n":1}';
    const held = await ctx.app.request(
      '/hooks/ci-alerts',
      hookPost(body, { 'X-Hub-Signature-256': sign(body) }),
    );
    expect(((await held.json()) as { status: string }).status).toBe('pending');
    expect(messages).toHaveLength(0);

    // Critical bypasses the wait.
    const critBody = '{"sev":"prod-down"}';
    const critical = await ctx.app.request(
      '/hooks/ci-alerts?level=critical',
      hookPost(critBody, { 'X-Hub-Signature-256': sign(critBody) }),
    );
    expect(((await critical.json()) as { status: string }).status).toBe('delivered');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.level).toBe('critical');

    // Turn ends — idle report flushes the held delivery. Advance the
    // clock first so the staleness note clears its 5s noise floor.
    ctx.advance(60_000);
    await ctx.app.request('/presence/activity', authed(BUILDER, { state: 'idle' }));
    await settle();
    expect(messages).toHaveLength(2);
    expect(messages[1]?.body).toContain('while you were mid-task');
  });

  it('starved busy-waits force-deliver after maxWaitMs', async () => {
    const ctx = makeApp();
    await createEndpoint(ctx, { policy: { ifBusy: 'wait', maxWaitMs: 30_000 } });
    const { messages } = capture(ctx.broker, 'builder');
    await ctx.app.request('/presence/activity', authed(BUILDER, { state: 'working' }));

    const body = '{"n":1}';
    await ctx.app.request(
      '/hooks/ci-alerts',
      hookPost(body, { 'X-Hub-Signature-256': sign(body) }),
    );
    expect(messages).toHaveLength(0);

    ctx.advance(31_000);
    await ctx.dispatcher.sweep();
    expect(messages).toHaveLength(1);
  });

  it('debounce coalesces a burst into one message', async () => {
    const ctx = makeApp();
    // Window far beyond the test; debounceMax=3 forces the flush.
    await createEndpoint(ctx, { policy: { debounceMs: 60_000, debounceMax: 3 } });
    const { messages } = capture(ctx.broker, 'builder');

    for (const n of [1, 2, 3]) {
      const body = `{"n":${n}}`;
      await ctx.app.request(
        '/hooks/ci-alerts',
        hookPost(body, { 'X-Hub-Signature-256': sign(body) }),
      );
    }
    await settle();

    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain('3 deliveries coalesced');
    expect(messages[0]?.data.coalesced).toBe(3);
  });

  it('replay re-runs a stored delivery through the pipeline', async () => {
    const ctx = makeApp();
    await createEndpoint(ctx, { template: 'run {{payload.n}}' });
    const { messages } = capture(ctx.broker, 'builder');
    const body = '{"n":42}';
    const resp = await ctx.app.request(
      '/hooks/ci-alerts',
      hookPost(body, { 'X-Hub-Signature-256': sign(body) }),
    );
    const original = (await resp.json()) as { id: string };

    const replayed = await ctx.app.request(
      `/notifications/deliveries/${original.id}/replay`,
      authed(ADMIN, undefined, 'POST'),
    );
    expect(replayed.status).toBe(200);
    const { delivery } = (await replayed.json()) as {
      delivery: { status: string; replayOf: string };
    };
    expect(delivery.replayOf).toBe(original.id);
    expect(delivery.status).toBe('delivered');
    expect(messages).toHaveLength(2);
    expect(messages[1]?.body).toContain('run 42');
  });

  it('rate-limits an endpoint flood without recording receipts', async () => {
    const ctx = makeApp();
    await createEndpoint(ctx);
    const body = '{}';
    const headers = { 'X-Hub-Signature-256': sign(body) };
    let limited = 0;
    for (let i = 0; i < 125; i++) {
      const resp = await ctx.app.request('/hooks/ci-alerts', hookPost(body, headers));
      if (resp.status === 429) limited += 1;
    }
    expect(limited).toBe(5);
    const receipts = await ctx.app.request(
      '/notifications/endpoints/ci-alerts/deliveries?limit=500',
      authed(ADMIN, undefined, 'GET'),
    );
    const { deliveries } = (await receipts.json()) as { deliveries: unknown[] };
    // 120 accepted receipts, zero for the rate-limited tail.
    expect(deliveries.length).toBe(120);
  });
});
