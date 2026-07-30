/**
 * SDK response contract tests.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every `*ResponseSchema` in `csuite-sdk` is a CLAIM about what this server
 * emits. Nothing tested that claim. Every other server test reads
 * `res.json()` directly and asserts on fields, so the published schema and
 * the actual response could diverge silently and permanently — for any
 * endpoint — with the whole suite green.
 *
 * That is not hypothetical. `FsEntrySchema.owner` is `NameSchema`
 * (`/^[a-zA-Z0-9._-]+$/`) while objective namespaces are owned by
 * `obj:<id>`. The colon fails the pattern, so the SDK rejects its own
 * server's output for every `/objectives/<id>/…` path. `/fs/stat` returns
 * 200 with a correct entry; the SDK cannot parse it. It survived because it
 * is invisible to a test that reads JSON directly, and was found only when
 * an agent happened to try listing an objective namespace.
 *
 * These tests parse real responses through the published schemas, so the
 * contract is checked rather than assumed.
 *
 * WHAT THIS CATCHES, AND WHAT IT DOES NOT
 * ---------------------------------------
 * zod `.parse()` catches five divergence shapes:
 *   - pattern      — a string that fails a regex (the known instance)
 *   - type         — number where string was promised, etc.
 *   - optionality  — a required field the server stopped sending
 *   - nullability  — null where the schema says non-nullable
 *   - removed      — a field dropped from the response entirely
 *
 * It does NOT catch a sixth:
 *   - EXTRA FIELDS. No schema in `csuite-sdk` uses `.strict()`, and zod
 *     strips unknown keys by default. A server that starts emitting a field
 *     the schema has never heard of passes here silently. Catching that
 *     needs `.strict()` on the schemas, which is a published-contract change
 *     and is NOT in scope here.
 *
 * Coverage is per-endpoint and deliberately partial — see the table below.
 * An endpoint absent from it is UNCHECKED, not proven correct. Adding a case
 * is three lines; that is the point of the table.
 *
 * AND IT ONLY SEES HTTP RESPONSES
 * -------------------------------
 * This checks what the SERVER emits over HTTP. It cannot see a published
 * LIBRARY API emitting a value that fails its own schema, because no HTTP
 * response is involved.
 *
 * That gap is real and demonstrated, not hypothetical. `Broker.push` in
 * `csuite-core` takes the published `PushPayload` interface, whose `to` is
 * `string | null`, assigns it straight onto `Message.to`, and appends to the
 * event log without a runtime parse. So:
 *
 *   const b = new Broker({ eventLog: new InMemoryEventLog() });
 *   const r = await b.push({ to: 'chan:general', body: 'x' });
 *   MessageSchema.safeParse(r.message).success  // false
 *
 * `MessageSchema.to` is `NameSchema`; `'chan:general'` fails the regex. No
 * in-tree server path does this — the HTTP layer parses payloads and internal
 * callers pass names or null — but it is a value the published API permits
 * and emits. Found by @Rune by type/write-site tracing, which is the method
 * that reaches what a grep and a stored-data query both miss.
 *
 * Covering that needs a different mechanism: parsing the return values of
 * published library entry points, not HTTP responses. Out of scope here and
 * named so it is not mistaken for covered.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker, InMemoryEventLog } from 'csuite-core';
import {
  BriefingResponseSchema,
  FsEntryResponseSchema,
  FsListResponseSchema,
  GetObjectiveResponseSchema,
  HealthResponseSchema,
  ListChannelsResponseSchema,
  ListMembersResponseSchema,
  ListObjectivesResponseSchema,
  RosterResponseSchema,
} from 'csuite-sdk/schemas';
import type { Objective, Team } from 'csuite-sdk/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createSqliteChannelStore } from '../../src/channels.js';
import { openDatabase } from '../../src/db.js';
import { createSqliteFilesystemStore, LocalBlobStore } from '../../src/files/index.js';
import { createMemberStore } from '../../src/members.js';
import { createSqliteObjectivesStore } from '../../src/objectives.js';
import { SessionStore } from '../../src/sessions.js';
import { createTokenStoreFromMembers } from '../../src/tokens.js';
import { mockTeamStore } from '../helpers/test-stores.js';

const ALICE = 'csuite_contract_alice_secret';
const BOB = 'csuite_contract_bob_secret';

const TEAM: Team = { name: 'contract-team', context: '', permissionPresets: {} };

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp() {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: (() => {
      let n = 0;
      return () => `msg-${++n}`;
    })(),
  });
  const members = createMemberStore([
    {
      name: 'alice',
      role: { title: 'admin', description: 'runs the team' },
      permissions: ['members.manage', 'objectives.create', 'objectives.watch', 'activity.read'],
      token: ALICE,
    },
    {
      name: 'bob',
      role: { title: 'engineer', description: '' },
      permissions: ['objectives.create'],
      token: BOB,
    },
  ]);
  broker.seedMembers(members.members());
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
  const blobDir = mkdtempSync(join(tmpdir(), 'csuite-contract-'));
  tmpDirs.push(blobDir);
  const objectives = createSqliteObjectivesStore(db);
  const channels = createSqliteChannelStore(db);
  const files = createSqliteFilesystemStore({
    db,
    blobs: new LocalBlobStore(blobDir),
    objectiveAcl: {
      isMember(objectiveId, viewerName) {
        const obj = objectives.get(objectiveId);
        if (obj === null) return false;
        if (obj.originator === viewerName) return true;
        if (obj.assignee === viewerName) return true;
        return obj.watchers.includes(viewerName);
      },
    },
  });
  for (const m of members.members()) files.ensureHome(m.name);
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore(TEAM),
    objectives,
    channels,
    files,
    version: '0.0.0',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { app };
}

function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = method ?? (body !== undefined ? 'POST' : 'GET');
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

type App = ReturnType<typeof makeApp>['app'];

/**
 * Fetch a response and parse it through its published schema. Failure here
 * means the server and the SDK disagree about the wire — which is the only
 * thing this file is for.
 */
async function expectMatchesContract(
  app: App,
  path: string,
  init: RequestInit,
  schema: { parse: (v: unknown) => unknown },
): Promise<void> {
  const res = await app.request(path, init);
  expect(res.status, `${path} did not 200`).toBe(200);
  const body: unknown = await res.json();
  // `.parse` throws a ZodError naming the offending path, so a failure
  // points at the diverging field rather than just "contract broken".
  expect(
    () => schema.parse(body),
    `${path} response does not match its published schema`,
  ).not.toThrow();
}

/** Seed one objective with a mirrored attachment, returning its id. */
async function seedObjectiveWithFile(app: App): Promise<Objective> {
  // `/fs/write` takes the path and mime as query params with the file
  // bytes as the raw body — not a JSON envelope.
  const write = await app.request(
    `/fs/write?path=${encodeURIComponent('/bob/spec.txt')}&mime=${encodeURIComponent('text/plain')}`,
    { method: 'POST', headers: { Authorization: `Bearer ${BOB}` }, body: 'spec' },
  );
  expect(write.status, 'fixture upload failed').toBe(200);
  const created = await app.request(
    '/objectives',
    authed(BOB, {
      title: 'Contract fixture',
      outcome: 'schemas match',
      body: '',
      assignee: 'alice',
      attachments: [{ path: '/bob/spec.txt', name: 'spec.txt', size: 4, mimeType: 'text/plain' }],
    }),
  );
  expect(created.status).toBe(200);
  return (await created.json()) as Objective;
}

// ─── Covered endpoints ───────────────────────────────────────────────
//
// Each case binds one endpoint to the schema the SDK publishes for it.
// Anything not listed here is UNCHECKED.

describe('SDK response contract', () => {
  it('GET /healthz matches HealthResponseSchema', async () => {
    const { app } = makeApp();
    await expectMatchesContract(app, '/healthz', {}, HealthResponseSchema);
  });

  it('GET /briefing matches BriefingResponseSchema', async () => {
    const { app } = makeApp();
    await expectMatchesContract(app, '/briefing', authed(ALICE), BriefingResponseSchema);
  });

  it('GET /roster matches RosterResponseSchema', async () => {
    const { app } = makeApp();
    await expectMatchesContract(app, '/roster', authed(ALICE), RosterResponseSchema);
  });

  it('GET /members matches ListMembersResponseSchema', async () => {
    const { app } = makeApp();
    await expectMatchesContract(app, '/members', authed(ALICE), ListMembersResponseSchema);
  });

  it('GET /channels matches ListChannelsResponseSchema', async () => {
    const { app } = makeApp();
    await expectMatchesContract(app, '/channels', authed(ALICE), ListChannelsResponseSchema);
  });

  it('GET /objectives matches ListObjectivesResponseSchema', async () => {
    const { app } = makeApp();
    await seedObjectiveWithFile(app);
    await expectMatchesContract(app, '/objectives', authed(ALICE), ListObjectivesResponseSchema);
  });

  it('GET /objectives/:id matches GetObjectiveResponseSchema', async () => {
    const { app } = makeApp();
    const obj = await seedObjectiveWithFile(app);
    await expectMatchesContract(
      app,
      `/objectives/${obj.id}`,
      authed(ALICE),
      GetObjectiveResponseSchema,
    );
  });

  it('GET /fs/ls on a member home matches FsListResponseSchema', async () => {
    const { app } = makeApp();
    await seedObjectiveWithFile(app);
    await expectMatchesContract(
      app,
      `/fs/ls?path=${encodeURIComponent('/bob')}`,
      authed(BOB),
      FsListResponseSchema,
    );
  });

  it('GET /fs/stat on a member-home file matches FsEntryResponseSchema', async () => {
    const { app } = makeApp();
    await seedObjectiveWithFile(app);
    await expectMatchesContract(
      app,
      `/fs/stat?path=${encodeURIComponent('/bob/spec.txt')}`,
      authed(BOB),
      FsEntryResponseSchema,
    );
  });

  // ─── The known instance — currently DIVERGENT, deliberately ────────
  //
  // `it.fails` asserts this test does NOT pass. That is not a way of
  // ignoring it: it pins a live, known divergence so the suite stays
  // honest AND green, and it is self-correcting. The moment someone
  // widens `FsEntrySchema.owner`, the body starts passing, `it.fails`
  // starts FAILING, and whoever landed the fix is told to convert this
  // to a plain `it()`. A skip would have gone quiet instead.
  //
  // The divergence: `/fs/stat` returns 200 with a correct entry whose
  // `owner` is `obj:<id>`. `FsEntrySchema.owner` is `NameSchema`, which
  // rejects the colon — so the SDK cannot parse a response its own
  // server just produced. Every other test on this path asserts
  // `res.status === 200` and passes, which is how it survived.
  //
  // The fix is proposed and NOT applied: it widens a schema in a
  // published package, which is AndrewJon's call (obj-ms7bqy3n-d).
  //
  // Verified coupling — this fails for the RIGHT reason, not
  // incidentally: applying the proposed widening turns the whole file
  // 10/10 green, and reverting it returns to 9/10 with only this case
  // divergent. Nothing else in the file moves either way.
  it.fails('GET /fs/stat on an OBJECTIVE NAMESPACE path matches FsEntryResponseSchema', async () => {
    const { app } = makeApp();
    const obj = await seedObjectiveWithFile(app);
    await expectMatchesContract(
      app,
      `/fs/stat?path=${encodeURIComponent(`/objectives/${obj.id}/spec.txt`)}`,
      authed(ALICE),
      FsEntryResponseSchema,
    );
  });
});
