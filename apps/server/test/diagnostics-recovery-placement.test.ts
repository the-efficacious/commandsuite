/**
 * Recovery must correspond to the operation whose failure created it.
 *
 * The static census guard proves a recovery method has a production
 * call site. It cannot prove the call sits in the branch that means
 * SUCCESS — and a recovery in the wrong branch clears an incident
 * without the operation having run, which is false health reported as
 * agent truth.
 *
 * Rune found exactly that: `otlpGenaiIngested` fired after a loop that
 * ran zero times. A body-only or correlation-pending batch yields no
 * inferences, attempts no append, and cleared the incident anyway. The
 * reference guard stayed green throughout.
 *
 * These drive the REAL routes and assert the branch, not the call.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import type { Team } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createDiagnosticStore } from '../src/diagnostics.js';
import { createGenAiStore } from '../src/genai-store.js';
import { createSqliteActivityStore } from '../src/member-activity.js';
import { createMemberStore } from '../src/members.js';
import { SessionStore } from '../src/sessions.js';
import { createTelemetryStore } from '../src/telemetry-store.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const TOKEN = 'csuite_test_member_secret';
const TEAM: Team = { name: 't', context: '', permissionPresets: {} };
const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeApp() {
  const db = openDatabase(':memory:');
  const activityDb = openDatabase(':memory:');
  const diagnostics = createDiagnosticStore(activityDb);
  const members = createMemberStore([
    { name: 'turner', role: { title: 'e', description: '' }, permissions: [], token: TOKEN },
  ]);
  const { app } = createApp({
    broker: new Broker({ eventLog: new InMemoryEventLog(), now: () => 1, idFactory: () => 'm' }),
    members,
    tokens: createTokenStoreFromMembers(db, members),
    sessions: new SessionStore(db),
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    logger: quiet,
    activityStore: createSqliteActivityStore(activityDb, quiet),
    telemetryStore: createTelemetryStore(activityDb, { logger: quiet }),
    genaiStore: createGenAiStore(activityDb, { logger: quiet }),
    diagnostics,
  });
  return { app, diagnostics, db, activityDb };
}

function post(app: ReturnType<typeof makeApp>['app'], path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function causes(d: ReturnType<typeof makeApp>['diagnostics']) {
  return d.unresolved('turner').map((u) => u.cause);
}

/** A syntactically valid OTLP batch that produces NO gen_ai inferences. */
const BODY_ONLY_BATCH = {
  resourceLogs: [
    {
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: '1700000000000000000',
              attributes: [
                { key: 'event.name', value: { stringValue: 'api_request_body' } },
                { key: 'body', value: { stringValue: '{"model":"m"}' } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe('recovery placement', () => {
  it('a batch that produces no inference does NOT clear a genai incident', async () => {
    // Rune's exact case. The correlator holds the body waiting for its
    // pair, so the append loop runs zero times — and the incident must
    // survive, because nothing succeeded.
    const { app, diagnostics } = makeApp();
    diagnostics.emit.otlpGenaiIngestFailed('turner', 5);
    expect(causes(diagnostics)).toContain('otlp.genai_ingest_failed');

    const res = await post(app, '/otlp/v1/logs', BODY_ONLY_BATCH);

    expect(res.status).toBe(200);
    expect(causes(diagnostics)).toContain('otlp.genai_ingest_failed');
  });

  it('an empty metrics batch does NOT clear a metrics incident', async () => {
    const { app, diagnostics } = makeApp();
    diagnostics.emit.otlpMetricsStoreFailed('turner', 1);

    await post(app, '/otlp/v1/metrics', { resourceMetrics: [] });

    expect(causes(diagnostics)).toContain('otlp.metrics_store_failed');
  });

  it('an empty activity batch does NOT clear an activity incident', async () => {
    const { app, diagnostics } = makeApp();
    diagnostics.emit.activityAppendFailed('turner', 3);

    await post(app, '/members/turner/activity', { events: [] });

    expect(causes(diagnostics)).toContain('activity.append_failed');
  });

  it('a FAILING activity append records an incident and does not clear it', async () => {
    // The empty-batch case above covers "success branch, nothing
    // written". It does NOT cover a recovery mistakenly placed in the
    // FAILURE branch, because an empty batch succeeds and never
    // reaches it — a mutation moving the call there left that test
    // green. This drives the failure path itself.
    const { app, diagnostics, activityDb } = makeApp();
    activityDb.exec('DROP TABLE IF EXISTS member_activity');
    activityDb.exec('CREATE TABLE member_activity (broken INTEGER)');

    await post(app, '/members/turner/activity', {
      events: [{ kind: 'session_start', ts: 1, runner: 'claude' }],
    });

    expect(causes(diagnostics)).toContain('activity.append_failed');
  });
});
