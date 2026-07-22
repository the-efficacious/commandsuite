/**
 * Phase 7 push tests — VAPID, store CRUD, policy, endpoints, dispatch
 * with web-push mocked.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import type { Message, Team } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { dispatchPush } from '../src/push/dispatch.js';
import { shouldPush } from '../src/push/policy.js';
import { PushSubscriptionStore } from '../src/push/store.js';
import { generateVapidKeys } from '../src/push/vapid.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

// Mock web-push sendNotification so no real network traffic happens.
//
// `vi.mock` is hoisted above top-level `const`s, so we use
// `vi.hoisted()` to stage the spy + the fake class before the mock
// factory runs. Production code imports via `import webpush from
// 'web-push'` (default, CJS interop), so the mock returns both a
// `default` binding and top-level named exports — tests can destructure
// either shape.
const mocks = vi.hoisted(() => {
  const sendNotification = vi.fn();
  class MockWebPushError extends Error {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    endpoint: string;
    constructor(
      message: string,
      statusCode: number,
      headers: Record<string, string>,
      body: string,
      endpoint: string,
    ) {
      super(message);
      this.name = 'WebPushError';
      this.statusCode = statusCode;
      this.headers = headers;
      this.body = body;
      this.endpoint = endpoint;
    }
  }
  const namespace = {
    sendNotification,
    generateVAPIDKeys: () => ({
      publicKey: `BK${'A'.repeat(85)}`,
      privateKey: 'A'.repeat(43),
    }),
    setVapidDetails: vi.fn(),
    WebPushError: MockWebPushError,
  };
  return { sendNotification, MockWebPushError, namespace };
});

vi.mock('web-push', () => ({
  default: mocks.namespace,
  ...mocks.namespace,
}));

const sendNotification = mocks.sendNotification;
const MockWebPushError = mocks.MockWebPushError;

const OP_TOKEN = 'csuite_push_test_operator_token';
const BOT_TOKEN = 'csuite_push_test_bot_token';

const TEAM: Team = {
  name: 'demo-team',
  context: '',
  permissionPresets: {},
};

beforeEach(() => {
  sendNotification.mockReset();
});

function noopLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function mkMsg(overrides: Partial<Message>): Message {
  return {
    id: 'msg-1',
    ts: 1,
    to: null,
    from: 'director-1',
    title: null,
    body: 'hi',
    level: 'info',
    data: {},
    attachments: [],
    ...overrides,
  };
}

// ─── VAPID ──────────────────────────────────────────────────────────

describe('generateVapidKeys', () => {
  it('returns a WebPushConfig shape with the subject default', () => {
    const keys = generateVapidKeys();
    expect(keys.vapidPublicKey).toMatch(/^BK/);
    expect(keys.vapidPrivateKey).toBeTruthy();
    expect(keys.vapidSubject).toBe('mailto:admin@csuite.local');
  });

  it('honors a custom subject', () => {
    const keys = generateVapidKeys('https://example.com');
    expect(keys.vapidSubject).toBe('https://example.com');
  });
});

// ─── PushSubscriptionStore ──────────────────────────────────────────

describe('PushSubscriptionStore', () => {
  it('upserts a subscription and lists it by slot', () => {
    const store = new PushSubscriptionStore(openDatabase(':memory:'));
    const row = store.upsert({
      memberName: 'director-1',
      endpoint: 'https://fcm.example/abc',
      p256dh: 'pk-data',
      auth: 'auth-data',
      userAgent: 'test-ua',
    });
    expect(row.id).toBeGreaterThan(0);
    expect(store.listForMember('director-1')).toHaveLength(1);
  });

  it('idempotently replaces on duplicate endpoint', () => {
    const store = new PushSubscriptionStore(openDatabase(':memory:'));
    store.upsert({
      memberName: 'director-1',
      endpoint: 'https://fcm.example/same',
      p256dh: 'v1',
      auth: 'v1',
      userAgent: null,
    });
    store.upsert({
      memberName: 'director-1',
      endpoint: 'https://fcm.example/same',
      p256dh: 'v2',
      auth: 'v2',
      userAgent: null,
    });
    const subs = store.listForMember('director-1');
    expect(subs).toHaveLength(1);
    expect(subs[0]?.p256dh).toBe('v2');
  });

  it('deleteForUser scopes by name', () => {
    const store = new PushSubscriptionStore(openDatabase(':memory:'));
    const row = store.upsert({
      memberName: 'director-1',
      endpoint: 'https://fcm.example/only',
      p256dh: 'x',
      auth: 'x',
      userAgent: null,
    });
    // Try to delete as a different slot — should not remove the row.
    store.deleteForMember(row.id, 'build-bot');
    expect(store.listForMember('director-1')).toHaveLength(1);

    store.deleteForMember(row.id, 'director-1');
    expect(store.listForMember('director-1')).toHaveLength(0);
  });

  it('markSuccess and markError update timestamps', () => {
    const store = new PushSubscriptionStore(openDatabase(':memory:'), { now: () => 1234 });
    const row = store.upsert({
      memberName: 'director-1',
      endpoint: 'https://fcm.example/err',
      p256dh: 'x',
      auth: 'x',
      userAgent: null,
    });
    store.markSuccess(row.id);
    const afterSuccess = store.listForMember('director-1')[0];
    expect(afterSuccess?.lastSuccessAt).toBe(1234);

    store.markError(row.id, 429);
    const afterErr = store.listForMember('director-1')[0];
    expect(afterErr?.lastErrorCode).toBe(429);
  });
});

// ─── shouldPush policy ──────────────────────────────────────────────

describe('shouldPush', () => {
  it('rejects self-echo', () => {
    const msg = mkMsg({ from: 'director-1', to: 'director-1' });
    expect(shouldPush({ message: msg, recipient: 'director-1', recipientIsLive: false })).toBe(
      false,
    );
  });

  it('rejects when recipient has a live SSE tab', () => {
    const msg = mkMsg({ from: 'build-bot', to: 'director-1' });
    expect(shouldPush({ message: msg, recipient: 'director-1', recipientIsLive: true })).toBe(
      false,
    );
  });

  it('accepts direct DMs when offline', () => {
    const msg = mkMsg({ from: 'build-bot', to: 'director-1' });
    expect(shouldPush({ message: msg, recipient: 'director-1', recipientIsLive: false })).toBe(
      true,
    );
  });

  it('accepts high-severity broadcasts', () => {
    const msg = mkMsg({ from: 'build-bot', to: null, level: 'warning' });
    expect(shouldPush({ message: msg, recipient: 'director-1', recipientIsLive: false })).toBe(
      true,
    );
  });

  it('accepts info broadcasts that mention the recipient', () => {
    const msg = mkMsg({
      from: 'build-bot',
      to: null,
      body: 'hey @director-1 can you look at this',
    });
    expect(shouldPush({ message: msg, recipient: 'director-1', recipientIsLive: false })).toBe(
      true,
    );
  });

  it('rejects info broadcasts with no mention', () => {
    const msg = mkMsg({ from: 'build-bot', to: null, body: 'status update' });
    expect(shouldPush({ message: msg, recipient: 'director-1', recipientIsLive: false })).toBe(
      false,
    );
  });

  it('rejects DMs addressed to someone else', () => {
    const msg = mkMsg({ from: 'director-1', to: 'other-bot' });
    expect(shouldPush({ message: msg, recipient: 'director-1', recipientIsLive: false })).toBe(
      false,
    );
  });
});

// ─── dispatch with mocked web-push ──────────────────────────────────

describe('dispatchPush', () => {
  it('sends to subscribers for recipients approved by policy', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const db = openDatabase(':memory:');
    const store = new PushSubscriptionStore(db);
    const members = createMemberStore([
      {
        name: 'director-1',
        role: { title: 'director', description: '' },
        permissions: ['members.manage'],
        token: OP_TOKEN,
      },
      {
        name: 'build-bot',
        role: { title: 'engineer', description: '' },
        permissions: [],
        token: BOT_TOKEN,
      },
    ]);
    store.upsert({
      memberName: 'director-1',
      endpoint: 'https://fcm.example/actual',
      p256dh: 'x',
      auth: 'x',
      userAgent: null,
    });

    const msg = mkMsg({ from: 'build-bot', to: 'director-1', body: 'hey' });
    await dispatchPush(msg, {
      sessions: store,
      members,
      logger: noopLogger(),
      isLive: () => false,
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const after = store.listForMember('director-1');
    expect(after[0]?.lastSuccessAt).toBeGreaterThan(0);
  });

  it('deletes dead subscriptions on 410 Gone', async () => {
    sendNotification.mockRejectedValue(
      new MockWebPushError('gone', 410, {}, 'body', 'https://fcm.example/actual'),
    );
    const store = new PushSubscriptionStore(openDatabase(':memory:'));
    const members = createMemberStore([
      {
        name: 'director-1',
        role: { title: 'director', description: '' },
        permissions: ['members.manage'],
        token: OP_TOKEN,
      },
      {
        name: 'build-bot',
        role: { title: 'engineer', description: '' },
        permissions: [],
        token: BOT_TOKEN,
      },
    ]);
    store.upsert({
      memberName: 'director-1',
      endpoint: 'https://fcm.example/actual',
      p256dh: 'x',
      auth: 'x',
      userAgent: null,
    });

    const msg = mkMsg({ from: 'build-bot', to: 'director-1' });
    await dispatchPush(msg, {
      sessions: store,
      members,
      logger: noopLogger(),
      isLive: () => false,
    });

    expect(store.listForMember('director-1')).toHaveLength(0);
  });

  it('marks subscription with last_error_code on non-terminal failures', async () => {
    sendNotification.mockRejectedValue(
      new MockWebPushError('too many', 429, {}, 'body', 'https://fcm.example/actual'),
    );
    const store = new PushSubscriptionStore(openDatabase(':memory:'));
    const members = createMemberStore([
      {
        name: 'director-1',
        role: { title: 'director', description: '' },
        permissions: ['members.manage'],
        token: OP_TOKEN,
      },
      {
        name: 'build-bot',
        role: { title: 'engineer', description: '' },
        permissions: [],
        token: BOT_TOKEN,
      },
    ]);
    store.upsert({
      memberName: 'director-1',
      endpoint: 'https://fcm.example/actual',
      p256dh: 'x',
      auth: 'x',
      userAgent: null,
    });

    await dispatchPush(mkMsg({ from: 'build-bot', to: 'director-1' }), {
      sessions: store,
      members,
      logger: noopLogger(),
      isLive: () => false,
    });

    const sub = store.listForMember('director-1')[0];
    expect(sub?.lastErrorCode).toBe(429);
  });

  it('skips recipients with live SSE tabs (no redundant buzz)', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const store = new PushSubscriptionStore(openDatabase(':memory:'));
    const members = createMemberStore([
      {
        name: 'director-1',
        role: { title: 'director', description: '' },
        permissions: ['members.manage'],
        token: OP_TOKEN,
      },
      {
        name: 'build-bot',
        role: { title: 'engineer', description: '' },
        permissions: [],
        token: BOT_TOKEN,
      },
    ]);
    store.upsert({
      memberName: 'director-1',
      endpoint: 'https://fcm.example/actual',
      p256dh: 'x',
      auth: 'x',
      userAgent: null,
    });

    await dispatchPush(mkMsg({ from: 'build-bot', to: 'director-1' }), {
      sessions: store,
      members,
      logger: noopLogger(),
      isLive: (cs) => cs === 'director-1',
    });

    expect(sendNotification).not.toHaveBeenCalled();
  });
});

// ─── HTTP endpoints ─────────────────────────────────────────────────

describe('push HTTP endpoints', () => {
  function makeApp(withPush: boolean) {
    const broker = new Broker({
      eventLog: new InMemoryEventLog(),
      now: () => 1_700_000_000_000,
      idFactory: () => 'msg-fixed',
    });
    const members = createMemberStore([
      {
        name: 'director-1',
        role: { title: 'director', description: '' },
        permissions: ['members.manage'],
        token: OP_TOKEN,
      },
      {
        name: 'build-bot',
        role: { title: 'engineer', description: '' },
        permissions: [],
        token: BOT_TOKEN,
      },
    ]);
    const db = openDatabase(':memory:');
    const sessions = new SessionStore(db);
    const tokens = createTokenStoreFromMembers(db, members);
    const pushStore = new PushSubscriptionStore(db);
    const { app } = createApp({
      broker,
      members,
      tokens,
      sessions,
      teamStore: mockTeamStore(TEAM),

      version: '0.0.0',
      logger: noopLogger(),
      ...(withPush ? { pushStore, vapidPublicKey: `BK${'A'.repeat(85)}` } : {}),
    });
    return { app, pushStore, members };
  }

  it('GET /push/vapid-public-key returns the key anonymously when push is enabled', async () => {
    const { app } = makeApp(true);
    const res = await app.request('/push/vapid-public-key');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publicKey: string };
    expect(body.publicKey).toMatch(/^BK/);
  });

  it('/push/vapid-public-key is absent (falls through to SPA 404) when push disabled', async () => {
    const { app } = makeApp(false);
    const res = await app.request('/push/vapid-public-key');
    // Without push config, the route isn't registered. No SPA public
    // root in this test setup either, so it's a plain 404 from Hono.
    expect(res.status).toBe(404);
  });

  it('POST /push/subscriptions registers a subscription for the authed slot', async () => {
    const { app, pushStore } = makeApp(true);
    const res = await app.request('/push/subscriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        endpoint: 'https://fcm.example/e1',
        keys: { p256dh: 'pk', auth: 'au' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; endpoint: string };
    expect(body.id).toBeGreaterThan(0);
    expect(pushStore.listForMember('director-1')).toHaveLength(1);
  });

  it('POST /push/subscriptions rejects unauthenticated callers', async () => {
    const { app } = makeApp(true);
    const res = await app.request('/push/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://fcm.example/e1',
        keys: { p256dh: 'pk', auth: 'au' },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /push/subscriptions rejects invalid payloads', async () => {
    const { app } = makeApp(true);
    const res = await app.request('/push/subscriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ endpoint: 'not-a-url', keys: { p256dh: '', auth: '' } }),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /push/subscriptions/:id scoped by authed slot', async () => {
    const { app, pushStore } = makeApp(true);
    const row = pushStore.upsert({
      memberName: 'director-1',
      endpoint: 'https://fcm.example/toDel',
      p256dh: 'x',
      auth: 'x',
      userAgent: null,
    });

    // build-bot can't delete director-1's subscription.
    const wrongRes = await app.request(`/push/subscriptions/${row.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${BOT_TOKEN}` },
    });
    expect(wrongRes.status).toBe(204);
    expect(pushStore.listForMember('director-1')).toHaveLength(1);

    // director-1 can.
    const rightRes = await app.request(`/push/subscriptions/${row.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${OP_TOKEN}` },
    });
    expect(rightRes.status).toBe(204);
    expect(pushStore.listForMember('director-1')).toHaveLength(0);
  });
});
