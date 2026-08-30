import {
  Broker,
  createApp,
  createSqliteObjectivesStore,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import { PATHS } from 'csuite-sdk/protocol';
import { TeamStatusResponseSchema } from 'csuite-sdk/schemas';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { silentLogger } from './helpers/logger.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN = 'csuite_test_admin_secret_token';
const BASELINE = 'csuite_test_baseline_secret_token';

async function fixture() {
  const eventLog = new InMemoryEventLog();
  const broker = new Broker({ eventLog, now: () => 2_001 });
  const members = createMemberStore([
    {
      name: 'admin',
      role: { title: 'lead', description: '' },
      permissions: ['members.manage'],
      token: ADMIN,
    },
    {
      name: 'builder',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: BASELINE,
    },
  ]);
  const db = openDatabase(':memory:');
  const objectives = createSqliteObjectivesStore(db);
  objectives.create({ title: 'work', outcome: 'done', assignee: 'builder' }, 'admin', 1_000);
  const sessions = new SqliteSessionStore(db);
  const tokens = await createTokenStoreFromMembers(db, members);
  const { app } = createApp({
    broker,
    members,
    objectives,
    sessions,
    tokens,
    teamStore: mockTeamStore({ name: 'demo', context: '' }),
    version: '1.0.0',
    logger: silentLogger(),
    now: () => 2_001,
  });
  return app;
}

describe('GET /team/status', () => {
  it('is members.manage-only and returns a schema-valid broker-composed stalled report', async () => {
    const app = await fixture();
    const denied = await app.request(PATHS.teamStatus, {
      headers: { Authorization: `Bearer ${BASELINE}` },
    });
    expect(denied.status).toBe(403);
    const response = await app.request(`${PATHS.teamStatus}?stalledMs=1000`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(response.status).toBe(200);
    const report = TeamStatusResponseSchema.parse(await response.json());
    expect(report.members.map((row) => row.member.name)).toEqual(['builder']);
    expect(report.members[0]?.activeObjectives[0]).toMatchObject({
      stalled: true,
      staleSignals: ['thread_post', 'pr_link', 'lifecycle'],
    });
  });

  it('rejects a non-positive stalledMs instead of silently treating it as unfiltered', async () => {
    const app = await fixture();
    const response = await app.request(`${PATHS.teamStatus}?stalledMs=0`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(response.status).toBe(400);
  });
});
