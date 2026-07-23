/**
 * Agent activity endpoint tests.
 *
 * Covers the full permission matrix and query surface for
 * `POST /users/:name/activity` and
 * `GET /users/:name/activity`:
 *
 *   POST: only the slot itself may upload. Directors reading
 *         someone else's activity is fine; directors WRITING
 *         someone else's activity is not.
 *   GET:  the slot itself OR any director. Non-director reading
 *         another slot's activity is 403.
 *
 *   Range filters: from/to bounds, kind filter (single + array).
 *
 * The in-process EventEmitter-based SSE stream is NOT exercised
 * here — it requires holding the connection open, which the Hono
 * test app.request() interface doesn't quite support cleanly.
 * We rely on the store-level subscribe() tests for that behavior
 * and let an integration test at the runner level cover the
 * full stream path.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import { MEMBER_PATHS } from 'csuite-sdk/protocol';
import type { ActivityEvent, ListActivityResponse, Team } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createSqliteActivityStore } from '../src/member-activity.js';
import { createMemberStore } from '../src/members.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const CMD_TOKEN = 'csuite_test_director';
const ASSIGNEE_TOKEN = 'csuite_test_assignee';
const OTHER_TOKEN = 'csuite_test_other';

const TEAM: Team = {
  name: 'demo-team',
  context: 'End-to-end ownership.',
  permissionPresets: {},
};

function makeApp() {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: () => 'msg-fixed',
  });
  const members = createMemberStore([
    {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage', 'activity.read'],
      token: CMD_TOKEN,
    },
    {
      name: 'engineer-1',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: ASSIGNEE_TOKEN,
    },
    {
      name: 'engineer-2',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: OTHER_TOKEN,
    },
  ]);
  const db = openDatabase(':memory:');
  const activityStore = createSqliteActivityStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions: new SessionStore(db),
    activityStore,
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  });
  return { app, activityStore, db, tokens };
}

function bearer(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } };
}

function post(token: string, body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

function sampleEvent(
  ts: number,
  kind: 'llm_exchange' | 'tool_action' = 'llm_exchange',
): ActivityEvent {
  if (kind === 'llm_exchange') {
    return {
      kind: 'llm_exchange',
      ts,
      duration: 123,
      entry: {
        kind: 'anthropic_messages',
        startedAt: ts,
        endedAt: ts + 123,
        request: {
          model: 'claude-sonnet-4-6',
          maxTokens: 1024,
          temperature: null,
          system: null,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          tools: null,
        },
        response: {
          stopReason: 'end_turn',
          stopSequence: null,
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }],
          usage: {
            inputTokens: 5,
            outputTokens: 2,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
          },
          status: 200,
        },
      },
    };
  }
  return {
    kind: 'tool_action',
    ts,
    agent: 'claude',
    source: 'claude_hook',
    toolName: 'Bash',
    input: { command: 'ls' },
    result: 'file.txt',
    isError: false,
    durationMs: 10,
  };
}

describe('POST /users/:name/activity', () => {
  let app: ReturnType<typeof makeApp>['app'];

  beforeEach(() => {
    app = makeApp().app;
  });

  it('accepts events from the slot itself and returns the count', async () => {
    const res = await app.request(
      MEMBER_PATHS.activity('engineer-1'),
      post(ASSIGNEE_TOKEN, { events: [sampleEvent(1_700_000_000_000)] }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { accepted: number };
    expect(body.accepted).toBe(1);
  });

  it('rejects uploads targeting another slot (even from a director)', async () => {
    const res = await app.request(
      MEMBER_PATHS.activity('engineer-1'),
      post(CMD_TOKEN, { events: [sampleEvent(1_700_000_000_000)] }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects uploads from an unrelated teammate', async () => {
    const res = await app.request(
      MEMBER_PATHS.activity('engineer-1'),
      post(OTHER_TOKEN, { events: [sampleEvent(1_700_000_000_000)] }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects malformed event payloads', async () => {
    const res = await app.request(
      MEMBER_PATHS.activity('engineer-1'),
      post(ASSIGNEE_TOKEN, { events: [{ kind: 'bogus', ts: 1 }] }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects empty event lists (schema requires at least one)', async () => {
    const res = await app.request(
      MEMBER_PATHS.activity('engineer-1'),
      post(ASSIGNEE_TOKEN, { events: [] }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /users/:name/activity', () => {
  let app: ReturnType<typeof makeApp>['app'];
  let activityStore: ReturnType<typeof makeApp>['activityStore'];

  beforeEach(() => {
    const fixture = makeApp();
    app = fixture.app;
    activityStore = fixture.activityStore;

    // Seed three events at different timestamps + kinds.
    activityStore.append('engineer-1', [
      sampleEvent(1_000, 'llm_exchange'),
      sampleEvent(2_000, 'tool_action'),
      sampleEvent(3_000, 'llm_exchange'),
    ]);
  });

  it('returns all events for the slot itself', async () => {
    const res = await app.request(MEMBER_PATHS.activity('engineer-1'), bearer(ASSIGNEE_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListActivityResponse;
    expect(body.activity).toHaveLength(3);
  });

  it('returns all events to a director reading another slot', async () => {
    const res = await app.request(MEMBER_PATHS.activity('engineer-1'), bearer(CMD_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListActivityResponse;
    expect(body.activity).toHaveLength(3);
  });

  it('rejects a non-director reading another slot', async () => {
    const res = await app.request(MEMBER_PATHS.activity('engineer-1'), bearer(OTHER_TOKEN));
    expect(res.status).toBe(403);
  });

  it('filters by ts range', async () => {
    const res = await app.request(
      `${MEMBER_PATHS.activity('engineer-1')}?from=1500&to=2500`,
      bearer(ASSIGNEE_TOKEN),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListActivityResponse;
    expect(body.activity).toHaveLength(1);
    expect(body.activity[0]?.event.ts).toBe(2_000);
  });

  it('filters by single kind', async () => {
    const res = await app.request(
      `${MEMBER_PATHS.activity('engineer-1')}?kind=llm_exchange`,
      bearer(ASSIGNEE_TOKEN),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListActivityResponse;
    expect(body.activity).toHaveLength(2);
    for (const row of body.activity) {
      expect(row.event.kind).toBe('llm_exchange');
    }
  });

  it('filters by multiple kinds (?kind=llm_exchange&kind=tool_action)', async () => {
    const res = await app.request(
      `${MEMBER_PATHS.activity('engineer-1')}?kind=llm_exchange&kind=tool_action`,
      bearer(ASSIGNEE_TOKEN),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListActivityResponse;
    expect(body.activity).toHaveLength(3);
  });

  it('rejects an unknown kind', async () => {
    const res = await app.request(
      `${MEMBER_PATHS.activity('engineer-1')}?kind=nope`,
      bearer(ASSIGNEE_TOKEN),
    );
    expect(res.status).toBe(400);
  });

  it('honors limit and returns newest-first', async () => {
    const res = await app.request(
      `${MEMBER_PATHS.activity('engineer-1')}?limit=2`,
      bearer(ASSIGNEE_TOKEN),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListActivityResponse;
    expect(body.activity).toHaveLength(2);
    // Newest first.
    expect(body.activity[0]?.event.ts).toBe(3_000);
    expect(body.activity[1]?.event.ts).toBe(2_000);
  });

  it('returns empty list for an unknown name (no 404)', async () => {
    // We don't gate GET on name existence — an unknown slot
    // just has no rows. 403 would leak whether the slot exists;
    // empty list is the correct shape.
    const res = await app.request(MEMBER_PATHS.activity('UNKNOWN'), bearer(CMD_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListActivityResponse;
    expect(body.activity).toHaveLength(0);
  });
});

describe('agent activity store directly', () => {
  it('subscribe fires synchronously on append', () => {
    const db = openDatabase(':memory:');
    const store = createSqliteActivityStore(db);
    const received: number[] = [];
    const unsubscribe = store.subscribe('engineer-1', (row) => {
      received.push(row.event.ts);
    });
    store.append('engineer-1', [sampleEvent(1_000), sampleEvent(2_000)]);
    expect(received).toEqual([1_000, 2_000]);
    unsubscribe();
    store.append('engineer-1', [sampleEvent(3_000)]);
    // No more calls after unsubscribe.
    expect(received).toEqual([1_000, 2_000]);
  });

  it('subscribe is keyed per name', () => {
    const db = openDatabase(':memory:');
    const store = createSqliteActivityStore(db);
    const alphaRows: number[] = [];
    const bravoRows: number[] = [];
    store.subscribe('engineer-1', (row) => alphaRows.push(row.event.ts));
    store.subscribe('engineer-2', (row) => bravoRows.push(row.event.ts));
    store.append('engineer-1', [sampleEvent(1)]);
    store.append('engineer-2', [sampleEvent(2)]);
    expect(alphaRows).toEqual([1]);
    expect(bravoRows).toEqual([2]);
  });

  it('skips a malformed persisted row instead of fabricating a placeholder', () => {
    const db = openDatabase(':memory:');
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = createSqliteActivityStore(db, log);

    // A real, valid row alongside a corrupt one persisted out-of-band
    // (event_json that no longer validates against ActivityEventSchema).
    store.append('engineer-1', [sampleEvent(1_000)]);
    db.prepare(
      `INSERT INTO member_activity (member_name, ts, kind, event_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('engineer-1', 2_000, 'opaque_http', '{"kind":"opaque_http","ts":2000}', Date.now());

    const rows = store.list({ memberName: 'engineer-1' });
    // Only the real event survives; the corrupt row is omitted, never
    // rendered as a synthetic HTTP/placeholder event.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.kind).toBe('llm_exchange');
    // `opaque_http` is no longer a valid ActivityEvent kind, so the
    // corrupt row could only surface as a fabricated placeholder — the
    // length + kind assertions above prove it did not.
    // And the skip is logged, not silent.
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
