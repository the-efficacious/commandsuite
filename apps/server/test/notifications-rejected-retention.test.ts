/**
 * What a failed webhook delivery leaves behind.
 *
 * `/hooks/:slug` is unauthenticated by design — the signature is the
 * gate — so everyone who fails that gate is by definition someone we
 * have not authenticated. Keeping their body verbatim turned the
 * rejection receipt into a write primitive: 256 KB a request, 120
 * requests a minute per endpoint, nothing pruning it.
 */

import { createHmac } from 'node:crypto';
import {
  Broker,
  createApp,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import type { NotificationDelivery, NotificationEndpoint } from 'csuite-sdk/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { kekFieldCipher, testKek } from '../src/kek.js';
import { createMemberStore, getKek, setKek } from '../src/members.js';
import { createSqliteNotificationsStore } from '../src/notifications/index.js';
import { recordingLogger } from './helpers/logger.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN = 'csuite_test_admin_notif';
const SECRET = 'hook-signing-secret';

beforeAll(() => setKek(testKek()));
afterAll(() => setKek(null));

async function makeApp() {
  const broker = new Broker({ eventLog: new InMemoryEventLog() });
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
      token: 'csuite_test_builder_notif',
    },
  ]);
  broker.seedMembers(members.members());
  const db = openDatabase(':memory:');
  const created = createApp({
    broker,
    members,
    tokens: await createTokenStoreFromMembers(db, members),
    sessions: new SqliteSessionStore(db),
    teamStore: mockTeamStore({ name: 'demo-team', context: '', permissionPresets: {} }),
    notifications: createSqliteNotificationsStore(db, () => kekFieldCipher(getKek())),
    version: '0.0.0',
    logger: recordingLogger().logger,
  });
  return { app: created.app };
}

function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = method ?? (body !== undefined ? 'POST' : 'GET');
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

const sign = (body: string): string =>
  `sha256=${createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex')}`;

async function createEndpoint(app: Awaited<ReturnType<typeof makeApp>>['app']) {
  const resp = await app.request(
    '/notifications/endpoints',
    authed(ADMIN, {
      slug: 'ci-alerts',
      targets: [{ member: 'builder' }],
      auth: { kind: 'hmac-sha256' },
    }),
  );
  expect(resp.status).toBe(201);
  const endpoint = (await resp.json()) as NotificationEndpoint;
  expect(
    (
      await app.request(
        `/notifications/endpoints/${endpoint.slug}/secret`,
        authed(ADMIN, { secret: SECRET }, 'PUT'),
      )
    ).status,
  ).toBe(200);
  return endpoint;
}

async function deliveries(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
): Promise<NotificationDelivery[]> {
  const res = await app.request('/notifications/endpoints/ci-alerts/deliveries', authed(ADMIN));
  expect(res.status).toBe(200);
  return ((await res.json()) as { deliveries: NotificationDelivery[] }).deliveries;
}

describe('rejected hook deliveries', () => {
  it('records that it happened without keeping the payload', async () => {
    const { app } = await makeApp();
    await createEndpoint(app);

    const payload = JSON.stringify({ exfiltrate: 'x'.repeat(2000) });
    const res = await app.request('/hooks/ci-alerts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64),
      },
      body: payload,
    });
    expect(res.status).toBe(401);

    const [record] = await deliveries(app);
    expect(record?.status).toBe('rejected');
    // The receipt still says what happened and when…
    expect(record?.statusReason).toMatch(/signature mismatch/);
    // …and carries a digest, so two rejections are still comparable and
    // a signing mismatch is still diagnosable.
    expect(record?.bodyPreview).toMatch(
      /^\[unverified payload not retained — \d+ bytes, sha256:[0-9a-f]{64}\]$/,
    );
    // …but not one byte of what they sent.
    expect(record?.bodyPreview).not.toContain('exfiltrate');
    expect(record?.bodyPreview.length).toBeLessThan(200);
  });

  it('still keeps the body of a delivery that verified', async () => {
    const { app } = await makeApp();
    await createEndpoint(app);
    const payload = JSON.stringify({ action: 'opened' });
    const res = await app.request('/hooks/ci-alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(payload) },
      body: payload,
    });
    expect(res.status).toBe(202);
    const [record] = await deliveries(app);
    expect(record?.status).not.toBe('rejected');
    expect(record?.bodyPreview).toContain('opened');
  });

  it('refuses to replay one', async () => {
    // Replaying an unverified payload would push an anonymous caller's
    // content to the team under the endpoint's name — the ingress check
    // routed around via the admin surface.
    const { app } = await makeApp();
    await createEndpoint(app);
    await app.request('/hooks/ci-alerts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64),
      },
      body: '{"a":1}',
    });
    const [record] = await deliveries(app);
    expect(record).toBeDefined();
    const replay = await app.request(
      `/notifications/deliveries/${record?.id}/replay`,
      authed(ADMIN, {}),
    );
    expect(replay.status).toBe(400);
    expect(JSON.stringify(await replay.json())).toMatch(/cannot be replayed/);
  });
});
