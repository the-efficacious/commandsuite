/**
 * The behavioural half of the D44/D46 query-parameter grammar.
 *
 * Three properties, and each one is a different way the change could
 * have been shipped broken:
 *
 *  1. **Compatibility.** Every renamed parameter still answers under its
 *     retired spelling, with a byte-identical body, and says so in the
 *     response. A rename that silently ignores the old name looks
 *     exactly like a rename that honours it if you only assert a `200`,
 *     so every pair here compares the whole body — and each pair has a
 *     third request, without the cursor at all, whose body must DIFFER.
 *     Without that control, a route that ignored both spellings would
 *     satisfy the equality perfectly.
 *
 *  2. **Direction.** `/telemetry` walks oldest-first and `/activity`
 *     walks newest-first, so their cursors are `after_*` and `before_*`.
 *     Both loops are driven to exhaustion here and the exact page
 *     sequence is asserted. Under the shared `cursor_ts` name a client
 *     that reused one loop against the other endpoint fed the newest row
 *     into a forward walk and never terminated — a test that asserts
 *     only "the second page is not the first" would have passed against
 *     that, which is why the assertion is the whole sequence.
 *
 *  3. **Precedence.** When both spellings arrive, the current one wins —
 *     and the deprecation signal still fires, because the caller is
 *     still sending a name that is about to disappear.
 *
 * The static half — which names each route accepts at all — is
 * `packages/core/test/query-parameter-census.test.ts`.
 */

import {
  Broker,
  createApp,
  createGenAiStore,
  createSqliteActivityStore,
  createTelemetryStore,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import { DEPRECATED_QUERY_HEADER, DEPRECATION_HEADER, PATHS } from 'csuite-sdk/protocol';
import type { ActivityEvent, Team } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { kekFieldCipher } from '../src/kek.js';
import { createMemberStore, getKek, setKek } from '../src/members.js';
import { createSqliteNotificationsStore } from '../src/notifications/index.js';
import { recordingLogger } from './helpers/logger.js';
import { mockTeamStore } from './helpers/test-stores.js';

const TEAM: Team = { name: 'demo-team', context: '', permissionPresets: {} };
const ADMIN = 'csuite_test_grammar_admin';
const WORKER = 'csuite_test_grammar_worker';

/** Three rows per store, at three distinct timestamps, so a page walk has somewhere to go. */
const TS = [1_700_000_001_000, 1_700_000_002_000, 1_700_000_003_000] as const;

function activityEvent(ts: number, prompt: string): ActivityEvent {
  return { kind: 'user_prompt', ts, text: prompt };
}

function telemetryRecord(tsMs: number, name: string) {
  return {
    signal: 'log' as const,
    name,
    tsUnixNano: tsMs * 1_000_000,
    tsMs,
    attributes: {},
    resource: {},
    scope: null,
    payload: {},
  };
}

function inference(ts: number, responseId: string) {
  return {
    operationName: 'chat' as const,
    provider: 'anthropic' as const,
    model: 'claude-fable-5',
    responseId,
    finishReasons: ['end_turn'],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
    },
    systemInstructions: [],
    inputMessages: [],
    outputMessages: [],
    querySource: 'repl_main_thread',
    agentName: null,
    ts,
    requestBodyRef: null,
    requestSha256: null,
    responseSha256: null,
  };
}

async function makeApp() {
  const db = openDatabase(':memory:');
  const logger = recordingLogger().logger;
  const members = createMemberStore([
    {
      name: 'director',
      role: { title: 'director', description: '' },
      permissions: ['activity.read', 'members.manage', 'notifications.manage'],
      token: ADMIN,
    },
    {
      name: 'worker',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: WORKER,
    },
  ]);
  const activityStore = createSqliteActivityStore(db, logger);
  const telemetryStore = createTelemetryStore(db, { logger });
  const genaiStore = createGenAiStore(db, { logger });
  setKek(null);
  const notifications = createSqliteNotificationsStore(db, () => kekFieldCipher(getKek()));
  // A fixed clock: `GET /team/status` stamps `generatedAt`, and two
  // requests a millisecond apart are not the same body.
  const now = () => 1_700_000_009_000;
  const broker = new Broker({ eventLog: new InMemoryEventLog(), now });
  broker.seedMembers(members.members());
  const { app } = createApp({
    broker,
    now,
    members,
    tokens: await createTokenStoreFromMembers(db, members),
    sessions: new SqliteSessionStore(db),
    teamStore: mockTeamStore(TEAM),
    activityStore,
    telemetryStore,
    genaiStore,
    notifications,
    version: '0.0.0',
    logger,
  });

  activityStore.append(
    'worker',
    TS.map((ts, i) => activityEvent(ts, `prompt-${i + 1}`)),
  );
  telemetryStore.append(
    'worker',
    TS.map((ts, i) => telemetryRecord(ts, `event_${i + 1}`)),
  );
  for (const [i, ts] of TS.entries()) genaiStore.append('worker', inference(ts, `msg_${i + 1}`));

  const endpoint = notifications.create({
    slug: 'ci-alerts',
    targets: [{ channel: 'general' }],
    creator: 'director',
  });
  for (const [i, ts] of TS.entries()) {
    notifications.insertDelivery({
      endpointId: endpoint.id,
      endpointSlug: endpoint.slug,
      receivedAt: ts,
      status: 'delivered',
      body: `receipt-${i + 1}`,
      level: 'info',
    });
  }

  return { app, activityStore };
}

const { app } = await makeApp();

interface Answer {
  status: number;
  body: unknown;
  deprecation: string | null;
  replaced: string | null;
}

async function ask(path: string, token: string | null = ADMIN): Promise<Answer> {
  const res = await app.request(
    path,
    token === null ? {} : { headers: { Authorization: `Bearer ${token}` } },
  );
  const text = await res.text();
  return {
    status: res.status,
    body: res.headers.get('Content-Type')?.includes('json') ? JSON.parse(text) : text,
    deprecation: res.headers.get(DEPRECATION_HEADER),
    replaced: res.headers.get(DEPRECATED_QUERY_HEADER),
  };
}

/**
 * One renamed parameter (or pair), as three requests: the current
 * spelling, the retired one, and a control with the parameter absent.
 */
interface RenameCase {
  readonly what: string;
  /** Request using the names a caller should send today. */
  readonly current: string;
  /** The same request under the retired spelling. */
  readonly legacy: string;
  /**
   * The same request with the renamed parameter removed. Its body must
   * DIFFER from the other two — otherwise the parameter is being
   * ignored and the equality above proves nothing.
   */
  readonly without: string;
  /** Exact `X-CSuite-Deprecated-Query` value the retired request earns. */
  readonly replaced: string;
  readonly token?: string | null;
}

const ACTIVITY = '/members/worker/activity';
const TELEMETRY = '/members/worker/telemetry';
const GENAI = '/members/worker/genai';
const DELIVERIES = '/notifications/endpoints/ci-alerts/deliveries';

const CASES: RenameCase[] = [
  {
    what: 'the newest-first composite cursor on /members/:name/activity',
    current: `${ACTIVITY}?limit=1&before_ts=${TS[1]}&before_id=2`,
    legacy: `${ACTIVITY}?limit=1&cursor_ts=${TS[1]}&cursor_id=2`,
    without: `${ACTIVITY}?limit=1`,
    replaced: 'cursor_ts=before_ts, cursor_id=before_id',
  },
  {
    what: 'the oldest-first composite cursor on /members/:name/telemetry',
    current: `${TELEMETRY}?limit=1&after_ts=${TS[0]}&after_id=1`,
    legacy: `${TELEMETRY}?limit=1&cursor_ts=${TS[0]}&cursor_id=1`,
    without: `${TELEMETRY}?limit=1`,
    replaced: 'cursor_ts=after_ts, cursor_id=after_id',
  },
  {
    what: 'the oldest-first composite cursor on /members/:name/genai',
    current: `${GENAI}?view=summary&limit=1&after_ts=${TS[0]}&after_id=1`,
    legacy: `${GENAI}?view=summary&limit=1&cursor_ts=${TS[0]}&cursor_id=1`,
    without: `${GENAI}?view=summary&limit=1`,
    replaced: 'cursor_ts=after_ts, cursor_id=after_id',
  },
  {
    what: 'the scalar page bound on the delivery receipts',
    current: `${DELIVERIES}?before_ts=${TS[2]}`,
    legacy: `${DELIVERIES}?before=${TS[2]}`,
    without: DELIVERIES,
    replaced: 'before=before_ts',
  },
  {
    what: 'the staleness window on /team/status',
    current: `${PATHS.teamStatus}?stalled_ms=1000`,
    legacy: `${PATHS.teamStatus}?stalledMs=1000`,
    without: PATHS.teamStatus,
    replaced: 'stalledMs=stalled_ms',
  },
  {
    what: 'the browser client identity on /subscribe',
    current: '/subscribe?name=director&client_kind=runner&client_version=0.8.0',
    legacy: '/subscribe?name=director&clientKind=runner&clientVersion=0.8.0',
    // A valid browser identity is accepted by the pre-upgrade check and
    // falls through to a different status, so "absent" here is the
    // control that the parameter changed the answer at all.
    without: '/subscribe?name=director',
    replaced: 'clientKind=client_kind, clientVersion=client_version',
  },
  {
    what: 'the iframe parent origin on /setup/connect-platform',
    current: `/setup/connect-platform?code=ABCD1234&mode=iframe&parent_origin=${encodeURIComponent('https://platform.example')}`,
    legacy: `/setup/connect-platform?code=ABCD1234&mode=iframe&parentOrigin=${encodeURIComponent('https://platform.example')}`,
    without: '/setup/connect-platform?code=ABCD1234&mode=iframe',
    replaced: 'parentOrigin=parent_origin',
    token: null,
  },
];

describe('deprecated query parameter spellings', () => {
  it.each(CASES)('$what answers identically under both spellings', async (c) => {
    const current = await ask(c.current, c.token);
    const legacy = await ask(c.legacy, c.token);

    // The whole body, not a field of it: a compatibility shim that
    // dropped one row would satisfy any weaker comparison.
    expect(legacy.status).toBe(current.status);
    expect(legacy.body).toEqual(current.body);
  });

  it.each(CASES)('$what marks the retired spelling and only that one', async (c) => {
    const current = await ask(c.current, c.token);
    const legacy = await ask(c.legacy, c.token);

    expect(legacy.deprecation).toBe('true');
    expect(legacy.replaced).toBe(c.replaced);
    // Positive control in the other direction: a header that is always
    // set says nothing about which caller needs to change.
    expect(current.deprecation).toBeNull();
    expect(current.replaced).toBeNull();
  });

  it.each(CASES)('$what actually changes the answer (control)', async (c) => {
    const current = await ask(c.current, c.token);
    const without = await ask(c.without, c.token);

    // If these matched, the route would be ignoring the parameter under
    // BOTH spellings and every assertion above would still pass.
    expect(without.body).not.toEqual(current.body);
    expect(without.deprecation).toBeNull();
  });

  it('prefers the current spelling when a caller sends both', async () => {
    const currentOnly = await ask(`${ACTIVITY}?limit=1&before_ts=${TS[1]}&before_id=2`);
    // Same current cursor, plus a retired one pointing somewhere else.
    const both = await ask(
      `${ACTIVITY}?limit=1&before_ts=${TS[1]}&before_id=2&cursor_ts=${TS[2]}&cursor_id=3`,
    );

    expect(both.body).toEqual(currentOnly.body);
    // Still stale: the caller is sending a name that is about to go.
    expect(both.deprecation).toBe('true');
  });
});

describe('cursor direction', () => {
  /** Walk a paged endpoint to exhaustion, collecting one page at a time. */
  async function walk(
    path: string,
    rowsOf: (body: unknown) => Array<{ id: number; ts: number }>,
    cursorNames: readonly [string, string],
  ): Promise<number[][]> {
    const pages: number[][] = [];
    let cursor: { id: number; ts: number } | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const qs = new URLSearchParams({ limit: '1' });
      if (cursor) {
        qs.set(cursorNames[0], String(cursor.ts));
        qs.set(cursorNames[1], String(cursor.id));
      }
      const answer = await ask(`${path}?${qs}`);
      const rows = rowsOf(answer.body);
      if (rows.length === 0) return pages;
      pages.push(rows.map((r) => r.id));
      cursor = rows[rows.length - 1];
    }
    throw new Error(`paging ${path} did not terminate within 10 pages`);
  }

  it('pages /members/:name/activity backward to exhaustion', async () => {
    const pages = await walk(
      ACTIVITY,
      (body) =>
        (body as { activity: Array<{ id: number; event: { ts: number } }> }).activity.map((r) => ({
          id: r.id,
          ts: r.event.ts,
        })),
      ['before_ts', 'before_id'],
    );
    // Newest first, one row per page, then the walk ends. The whole
    // sequence — a loop that stalled or repeated a row shows up here and
    // nowhere else.
    expect(pages).toEqual([[3], [2], [1]]);
  });

  it('pages /members/:name/telemetry forward to exhaustion', async () => {
    const pages = await walk(
      TELEMETRY,
      (body) =>
        (body as { telemetry: Array<{ id: number; tsMs: number }> }).telemetry.map((r) => ({
          id: r.id,
          ts: r.tsMs,
        })),
      ['after_ts', 'after_id'],
    );
    // Oldest first — the opposite order, which is the whole reason the
    // two endpoints no longer share a parameter name.
    expect(pages).toEqual([[1], [2], [3]]);
  });

  it('refuses the opposite endpoint’s cursor name rather than paging wrongly', async () => {
    // The defect in one line: `before_*` on the forward walk is not a
    // cursor this endpoint knows, so it reads from the start of the
    // range forever. It must be inert, not silently accepted.
    const forwardWithBackwardName = await ask(
      `${TELEMETRY}?limit=1&before_ts=${TS[0]}&before_id=1`,
    );
    const unpaged = await ask(`${TELEMETRY}?limit=1`);
    expect(forwardWithBackwardName.body).toEqual(unpaged.body);
    expect(forwardWithBackwardName.deprecation).toBeNull();
  });
});
