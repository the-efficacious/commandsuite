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

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Broker,
  createApp,
  createDiagnosticStore,
  createGenAiStore,
  createSqliteActivityStore,
  createTelemetryStore,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import type { Team } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createGenAiCorrelator } from '../src/genai-correlator.js';
import { createMemberStore } from '../src/members.js';
import { digestPathSync } from '../src/path-digest.js';
import { createRawBodyStore } from '../src/raw-body-store.js';
import { mockTeamStore } from './helpers/test-stores.js';

const TOKEN = 'csuite_test_member_secret';
const TEAM: Team = { name: 't', context: '', permissionPresets: {} };
const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

async function makeApp() {
  const db = openDatabase(':memory:');
  const activityDb = openDatabase(':memory:');
  const diagnostics = createDiagnosticStore(activityDb);
  const members = createMemberStore([
    { name: 'turner', role: { title: 'e', description: '' }, permissions: [], token: TOKEN },
  ]);
  const { app } = createApp({
    createGenAiCorrelator,
    broker: new Broker({ eventLog: new InMemoryEventLog(), now: () => 1, idFactory: () => 'm' }),
    members,
    tokens: await createTokenStoreFromMembers(db, members),
    sessions: new SqliteSessionStore(db),
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    logger: quiet,
    activityStore: createSqliteActivityStore(activityDb, quiet),
    telemetryStore: createTelemetryStore(activityDb, { logger: quiet }),
    genaiStore: createGenAiStore(activityDb, { logger: quiet }),
    // POST /members/:name/genai is gated on rawBodyStore, not just
    // genaiStore — the codex route content-addresses bodies before
    // mapping them. Omitting it made the route 404 and the codex
    // fixture fail for a reason unrelated to recovery placement.
    rawBodyStore: createRawBodyStore(activityDb, { logger: quiet }),
    diagnostics,
  });
  return { app, diagnostics, db, activityDb };
}

function post(app: Awaited<ReturnType<typeof makeApp>>['app'], path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function causes(d: Awaited<ReturnType<typeof makeApp>>['diagnostics']) {
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
    const { app, diagnostics } = await makeApp();
    diagnostics.emit.otlpGenaiIngestFailed('turner', 5);
    expect(causes(diagnostics)).toContain('otlp.genai_ingest_failed');

    const res = await post(app, '/otlp/v1/logs', BODY_ONLY_BATCH);

    expect(res.status).toBe(200);
    expect(causes(diagnostics)).toContain('otlp.genai_ingest_failed');
  });

  it('an empty metrics batch does NOT clear a metrics incident', async () => {
    const { app, diagnostics } = await makeApp();
    diagnostics.emit.otlpMetricsStoreFailed('turner', 1);

    await post(app, '/otlp/v1/metrics', { resourceMetrics: [] });

    expect(causes(diagnostics)).toContain('otlp.metrics_store_failed');
  });

  it('an empty activity batch does NOT clear an activity incident', async () => {
    const { app, diagnostics } = await makeApp();
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
    const { app, diagnostics, activityDb } = await makeApp();
    activityDb.exec('DROP TABLE IF EXISTS member_activity');
    activityDb.exec('CREATE TABLE member_activity (broken INTEGER)');

    await post(app, '/members/turner/activity', {
      events: [{ kind: 'session_start', ts: 1, runner: 'claude' }],
    });

    expect(causes(diagnostics)).toContain('activity.append_failed');
  });
});

/**
 * POSITIVE controls — the other direction.
 *
 * The four tests above are all negatives: they prove a recovery does
 * NOT fire when nothing succeeded. A recovery that never fires at all
 * passes every one of them, and the static census stays green because
 * the call text exists. Negatives prevent false healing; only
 * positives prevent permanent sickness.
 *
 * That is the rule I wrote into CONTRIBUTING.md this session — *every
 * suite of negatives needs one positive control* — and did not apply
 * to my own placement tests. Rune found it.
 *
 * Each drives a real failure, then the real successful operation, and
 * asserts the incident clears WHILE its history remains queryable.
 */
describe('recovery placement — positive controls', () => {
  it('a successful activity append clears the incident and keeps the history', async () => {
    const { app, diagnostics } = await makeApp();
    diagnostics.emit.activityAppendFailed('turner', 3);
    expect(causes(diagnostics)).toContain('activity.append_failed');

    const res = await post(app, '/members/turner/activity', {
      events: [{ kind: 'session_start', ts: 1, runner: 'claude' }],
    });

    expect(res.status).toBe(201);
    expect(causes(diagnostics)).not.toContain('activity.append_failed');
    // Criterion 4: healthy NOW, Monday still queryable.
    const hist = diagnostics.query({ member: 'turner', from: 0, to: Date.now() + 60_000 });
    expect(hist.count).toBeGreaterThan(0);
  });

  it('a successful metrics store clears the metrics incident', async () => {
    const { app, diagnostics } = await makeApp();
    diagnostics.emit.otlpMetricsStoreFailed('turner', 1);

    const res = await post(app, '/otlp/v1/metrics', {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.token.usage',
                  sum: {
                    dataPoints: [
                      { timeUnixNano: '1700000000000000000', asInt: '5', attributes: [] },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(causes(diagnostics)).not.toContain('otlp.metrics_store_failed');
  });

  it('a successful telemetry log store clears the logs incident', async () => {
    const { app, diagnostics } = await makeApp();
    diagnostics.emit.otlpLogsStoreFailed('turner', 1);

    // A plain (non-api-body) log record goes to the telemetry store.
    const res = await post(app, '/otlp/v1/logs', {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1700000000000000000',
                  attributes: [{ key: 'event.name', value: { stringValue: 'user_prompt' } }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(causes(diagnostics)).not.toContain('otlp.logs_store_failed');
  });
});

/**
 * Correlator recovery families, driven through the real `ingest()`.
 *
 * `createGenAiCorrelator` IS the production unit — driving its ingest
 * with real telemetry records exercises the same code path the OTLP
 * route does, not a stand-in.
 */
describe('correlator recovery — positive controls', () => {
  function bodyRecord(kind: 'api_request_body' | 'api_response_body', bodyRef: string) {
    // The real `TelemetryRecord` shape the OTLP route produces. My
    // first attempt invented `{ eventName, ts }`, which the correlator
    // ignored entirely — so the test drove nothing and both positive
    // controls failed for a reason unrelated to the property.
    return {
      signal: 'log' as const,
      name: kind,
      tsUnixNano: 1_700_000_000_000_000_000,
      attributes: { body_ref: bodyRef, model: 'claude-x' },
      resource: {},
      scope: null,
    };
  }

  it('a readable body_ref clears the unreadable incident', () => {
    const db = openDatabase(':memory:');
    const diagnostics = createDiagnosticStore(db);
    diagnostics.emit.correlatorBodyRefUnreadable(
      'turner',
      digestPathSync('/gone.json'),
      new Error('x'),
    );
    expect(diagnostics.unresolved('turner').map((u) => u.cause)).toContain(
      'correlator.body_ref_unreadable',
    );

    const file = join(tmpdir(), `csuite-recovery-${process.pid}.json`);
    writeFileSync(file, '{"model":"claude-x"}');
    const corr = createGenAiCorrelator({
      memberName: 'turner',
      diagnostics: diagnostics.emit,
      readBodyRef: (p) => readFileSync(p),
    });

    corr.ingest([bodyRecord('api_request_body', file) as never]);

    expect(diagnostics.unresolved('turner').map((u) => u.cause)).not.toContain(
      'correlator.body_ref_unreadable',
    );
    // History survives the recovery.
    expect(diagnostics.query({ member: 'turner', from: 0, to: Date.now() + 1000 }).count).toBe(1);
    rmSync(file, { force: true });
    db.close();
  });

  it('a successful raw capture clears the raw-capture incident', () => {
    const db = openDatabase(':memory:');
    const diagnostics = createDiagnosticStore(db);
    const rawStore = createRawBodyStore(db, { logger: quiet });
    diagnostics.emit.correlatorRawCaptureFailed('turner', new Error('x'));
    expect(diagnostics.unresolved('turner').map((u) => u.cause)).toContain(
      'correlator.raw_capture_failed',
    );

    const file = join(tmpdir(), `csuite-recovery2-${process.pid}.json`);
    writeFileSync(file, '{"model":"claude-x"}');
    const corr = createGenAiCorrelator({
      memberName: 'turner',
      diagnostics: diagnostics.emit,
      rawStore,
      readBodyRef: (p) => readFileSync(p),
      unlinkAfterCapture: false,
    });

    corr.ingest([bodyRecord('api_request_body', file) as never]);

    expect(diagnostics.unresolved('turner').map((u) => u.cause)).not.toContain(
      'correlator.raw_capture_failed',
    );
    rmSync(file, { force: true });
    db.close();
  });
});

/**
 * The last three recovery families, driven through their real routes.
 *
 * These were briefly left as "named residuals". They are not
 * irreducible uncertainty — they are executable production paths with
 * existing harnesses, so naming them was coverage work deferred, not a
 * limit disclosed. Each has distinct success preconditions and can
 * independently become unreachable while the reference census stays
 * green.
 */
function claudeCallBatch() {
  // A full request/response pair, so the correlator emits an inference
  // and `genaiStore.append` actually runs. A body-only batch (above)
  // deliberately does not.
  const attrs = (eventName: string, values: Record<string, string>) => [
    { key: 'event.name', value: { stringValue: `claude_code.${eventName}` } },
    ...Object.entries(values).map(([key, value]) => ({ key, value: { stringValue: value } })),
  ];
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: '1700000000000000000',
                attributes: attrs('api_request_body', {
                  body: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
                  model: 'claude-opus-4-6',
                }),
              },
              {
                timeUnixNano: '1700000001000000000',
                attributes: attrs('api_request', {
                  request_id: 'req_1',
                  model: 'claude-opus-4-6',
                }),
              },
              {
                timeUnixNano: '1700000002000000000',
                attributes: attrs('api_response_body', {
                  body: JSON.stringify({ id: 'msg_1', content: [], usage: {} }),
                  request_id: 'req_1',
                }),
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('recovery placement — the remaining families', () => {
  it('a batch that DOES produce an inference clears the genai incident', async () => {
    const { app, diagnostics } = await makeApp();
    diagnostics.emit.otlpGenaiIngestFailed('turner', 5);
    expect(causes(diagnostics)).toContain('otlp.genai_ingest_failed');

    const res = await post(app, '/otlp/v1/logs', claudeCallBatch());

    expect(res.status).toBe(200);
    expect(causes(diagnostics)).not.toContain('otlp.genai_ingest_failed');
    // History survives the recovery.
    expect(
      diagnostics.query({ member: 'turner', from: 0, to: Date.now() + 60_000 }).count,
    ).toBeGreaterThan(0);
  });

  it('an accepted codex bundle clears the codex incident', async () => {
    const { app, diagnostics } = await makeApp();
    diagnostics.emit.codexGenaiIngestEntryFailed('turner');
    expect(causes(diagnostics)).toContain('codex.genai_ingest_entry_failed');

    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
    const res = await post(app, '/members/turner/genai', {
      inferences: [
        {
          requestBase64: b64({ model: 'gpt-5.5', input: [] }),
          responseBase64: b64({ response_id: 'resp_1', output_items: [] }),
          model: 'gpt-5.5',
          responseId: 'resp_1',
          threadId: 'thread-1',
          querySource: 'codex_main_thread',
          ts: 1_700_000_000_000,
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(causes(diagnostics)).not.toContain('codex.genai_ingest_entry_failed');
  });
});
