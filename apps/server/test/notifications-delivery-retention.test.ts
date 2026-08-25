/**
 * Delivery receipts are bounded.
 *
 * This table was the one with no ceiling and no prune, on a route an
 * unauthenticated caller can drive. The cap is enforced on insert, so
 * it needs no scheduler and no operator step. Pending references are
 * trimmed in the same transaction so queueing cannot turn the hard cap
 * back into "N plus every delivery received while a member is offline."
 */

import { DELIVERY_RETENTION_PER_ENDPOINT } from 'csuite-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { kekFieldCipher, testKek } from '../src/kek.js';
import { getKek, setKek } from '../src/members.js';
import { createSqliteNotificationsStore } from '../src/notifications/index.js';

beforeAll(() => setKek(testKek()));
afterAll(() => setKek(null));

function makeStore() {
  const db = openDatabase(':memory:');
  const store = createSqliteNotificationsStore(db, () => kekFieldCipher(getKek()));
  const endpoint = store.create({
    slug: 'ci-alerts',
    targets: [{ member: 'builder' }],
    creator: 'admin',
  });
  return { store, endpoint, db };
}

const insert = (
  store: ReturnType<typeof makeStore>['store'],
  endpointId: string,
  slug: string,
  i: number,
) =>
  store.insertDelivery({
    endpointId,
    endpointSlug: slug,
    receivedAt: 1_700_000_000_000 + i,
    status: 'rejected',
    body: `body-${i}`,
    level: 'info',
  });

describe('delivery retention', () => {
  it('keeps the newest N receipts per endpoint and drops the rest', async () => {
    const { store, endpoint, db } = makeStore();
    const overflow = 5;
    for (let i = 0; i < DELIVERY_RETENTION_PER_ENDPOINT + overflow; i++) {
      insert(store, endpoint.id, endpoint.slug, i);
    }
    // Counted in the table, not through `listDeliveries` — that read
    // clamps its own page size, which would hide the row count this
    // test exists to pin.
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM notification_deliveries WHERE endpoint_id = ?')
      .get(endpoint.id) as { n: number };
    expect(n).toBe(DELIVERY_RETENTION_PER_ENDPOINT);

    // Newest survive, oldest are gone.
    const kept = store.listDeliveries(endpoint.id, { limit: 5 });
    expect(kept[0]?.bodyPreview).toBe(`body-${DELIVERY_RETENTION_PER_ENDPOINT + overflow - 1}`);
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM notification_deliveries WHERE body = ?')
        .get('body-0') as { n: number },
    ).toEqual({ n: 0 });
  });

  it('removes pending references when their receipt ages out', async () => {
    const { store, endpoint, db } = makeStore();
    const queued = insert(store, endpoint.id, endpoint.slug, 0);
    store.insertPending({
      endpointId: endpoint.id,
      memberName: 'builder',
      reason: 'offline',
      deliveryIds: [queued.id],
      level: 'info',
      title: null,
      createdAt: 1_700_000_000_000,
      deadlineAt: 1_700_000_900_000,
    });
    for (let i = 1; i <= DELIVERY_RETENTION_PER_ENDPOINT + 5; i++) {
      insert(store, endpoint.id, endpoint.slug, i);
    }
    expect(store.getDeliveryRecord(queued.id)).toBeNull();
    expect(store.pendingForMember('builder')).toEqual([]);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries').get() as { n: number },
    ).toEqual({ n: DELIVERY_RETENTION_PER_ENDPOINT });
  });

  it('keeps surviving ids when a pending group crosses the retention boundary', async () => {
    const { store, endpoint } = makeStore();
    const oldest = insert(store, endpoint.id, endpoint.slug, 0);
    for (let i = 1; i < DELIVERY_RETENTION_PER_ENDPOINT - 1; i++) {
      insert(store, endpoint.id, endpoint.slug, i);
    }
    const recent = insert(store, endpoint.id, endpoint.slug, DELIVERY_RETENTION_PER_ENDPOINT - 1);
    store.insertPending({
      endpointId: endpoint.id,
      memberName: 'builder',
      reason: 'offline',
      deliveryIds: [oldest.id, recent.id],
      level: 'info',
      title: null,
      createdAt: 1_700_000_000_000,
      deadlineAt: 1_700_000_900_000,
    });

    insert(store, endpoint.id, endpoint.slug, DELIVERY_RETENTION_PER_ENDPOINT);

    expect(store.getDeliveryRecord(oldest.id)).toBeNull();
    expect(store.getDeliveryRecord(recent.id)).not.toBeNull();
    expect(store.pendingForMember('builder').map((row) => row.deliveryIds)).toEqual([[recent.id]]);
  });

  it('bounds each endpoint separately', async () => {
    const { store, endpoint } = makeStore();
    const other = store.create({
      slug: 'deploys',
      targets: [{ member: 'builder' }],
      creator: 'admin',
    });
    for (let i = 0; i < 10; i++) insert(store, other.id, other.slug, i);
    for (let i = 0; i < DELIVERY_RETENTION_PER_ENDPOINT + 5; i++) {
      insert(store, endpoint.id, endpoint.slug, i);
    }
    // A busy endpoint trimming itself must not touch a quiet one.
    expect(store.listDeliveries(other.id, { limit: 50 })).toHaveLength(10);
  });
});
