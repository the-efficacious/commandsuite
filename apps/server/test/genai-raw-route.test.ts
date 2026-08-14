/**
 * `GET /members/:name/genai/:id/raw`.
 *
 * The content-addressed store exists so a trace can be checked against
 * what actually went over the wire, and nothing could read it:
 * `getBlob` had no caller outside capture-health's SQL, so every
 * inference carried sha256 columns pointing at bytes no client could
 * fetch.
 *
 * Two properties matter more than the happy path.
 *
 * **Ownership.** Blobs are deduped into one global content space, so a
 * hash-addressed route would let anyone holding a hash read another
 * member's bytes — dedup makes identical bodies across members ONE row,
 * which turns that from theoretical into routine. Going through the
 * inference keeps the ownership check in front of the bytes.
 *
 * **Three different absences.** No such inference, an inference with no
 * raw side captured, and a record that outlived its bytes are distinct
 * facts about capture coverage, and collapsing them would make an
 * operator unable to tell a retention effect from a capture gap.
 */

import {
  Broker,
  createApp,
  createGenAiStore,
  createTokenStoreFromMembers,
  type GenAiStore,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import type { Team } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseSyncInstance, openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { createRawBodyStore, type RawBodyStore } from '../src/raw-body-store.js';
import { silentLogger } from './helpers/logger.js';
import { mockTeamStore } from './helpers/test-stores.js';

const READER = 'csuite_reader_token';
const SELF = 'csuite_self_token';
const STRANGER = 'csuite_stranger_token';
const TEAM: Team = { name: 'demo', context: 'ctx', permissionPresets: {} };
const REQUEST_BYTES = '{"model":"claude-sonnet-4-6","messages":[]}';

let app: ReturnType<typeof createApp>['app'];
let genai: GenAiStore;
let raw: RawBodyStore;
let db: DatabaseSyncInstance;

function seedInference(
  member: string,
  ts: number,
  hashes: { req?: string; res?: string } = {},
): void {
  genai.append(member, {
    ts,
    operationName: 'chat',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    responseId: `msg_${member}_${ts}`,
    finishReasons: ['end_turn'],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    systemInstructions: [],
    inputMessages: [],
    outputMessages: [],
    querySource: 'repl_main_thread',
    agentName: null,
    requestBodyRef: null,
    ...(hashes.req !== undefined ? { requestSha256: hashes.req } : {}),
    ...(hashes.res !== undefined ? { responseSha256: hashes.res } : {}),
  });
}

/** Store bytes and return the id of an inference citing them. */
function seedWithBody(member: string, ts: number, body: string, kind: 'request' | 'response') {
  const { hash } = raw.appendBody({
    memberName: member,
    kind,
    bytes: Buffer.from(body),
    envelope: { eventTs: ts },
  });
  seedInference(member, ts, kind === 'request' ? { req: hash } : { res: hash });
  const row = genai.list({ memberName: member }).at(-1);
  return { id: row?.id ?? -1, hash };
}

beforeEach(async () => {
  db = openDatabase(':memory:');
  genai = createGenAiStore(db, { logger: silentLogger() });
  raw = createRawBodyStore(db, { logger: silentLogger() });
  const members = createMemberStore([
    {
      name: 'director',
      role: { title: 'director', description: '' },
      permissions: ['activity.read'],
      token: READER,
    },
    { name: 'worker', role: { title: 'eng', description: '' }, permissions: [], token: SELF },
    { name: 'other', role: { title: 'eng', description: '' }, permissions: [], token: STRANGER },
  ]);
  const created = createApp({
    broker: new Broker({ eventLog: new InMemoryEventLog() }),
    members,
    tokens: await createTokenStoreFromMembers(db, members),
    sessions: new SqliteSessionStore(db),
    teamStore: mockTeamStore(TEAM),
    genaiStore: genai,
    rawBodyStore: raw,
    version: '0.0.0',
    logger: silentLogger(),
  });
  app = created.app;
});

function authed(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } };
}

describe('serving the source bytes', () => {
  it('returns the request bytes byte-exact, with the hash that addresses them', async () => {
    const { id, hash } = seedWithBody('worker', 1_000, REQUEST_BYTES, 'request');

    const resp = await app.request(`/members/worker/genai/${id}/raw`, authed(SELF));

    expect(resp.status).toBe(200);
    expect(resp.headers.get('X-CSuite-Body-Sha256')).toBe(hash);
    // Byte-exact, not re-encoded: the point of this layer is fidelity
    // with respect to what was stored.
    expect(Buffer.from(await resp.arrayBuffer()).toString()).toBe(REQUEST_BYTES);
  });

  it('serves the response side when asked for it', async () => {
    const { id } = seedWithBody('worker', 1_000, '{"stop_reason":"end_turn"}', 'response');

    const resp = await app.request(`/members/worker/genai/${id}/raw?kind=response`, authed(SELF));

    expect(resp.status).toBe(200);
    expect(Buffer.from(await resp.arrayBuffer()).toString()).toBe('{"stop_reason":"end_turn"}');
  });

  it('rejects a kind that is neither request nor response', async () => {
    const { id } = seedWithBody('worker', 1_000, REQUEST_BYTES, 'request');
    const resp = await app.request(`/members/worker/genai/${id}/raw?kind=both`, authed(SELF));
    expect(resp.status).toBe(400);
  });
});

describe('the three absences are distinguishable', () => {
  it('404s an inference that does not exist', async () => {
    const resp = await app.request('/members/worker/genai/9999/raw', authed(SELF));
    expect(resp.status).toBe(404);
  });

  it('404s an inference whose raw side was never captured, with a different reason', async () => {
    seedInference('worker', 1_000);
    const id = genai.list({ memberName: 'worker' })[0]?.id ?? -1;

    const resp = await app.request(`/members/worker/genai/${id}/raw`, authed(SELF));

    expect(resp.status).toBe(404);
    // Not the same message as an absent record: "no such inference"
    // and "that inference has no request body" are different facts
    // about coverage.
    expect(((await resp.json()) as { error: string }).error).toContain('no raw request captured');
  });

  it('410s a record that outlived its bytes', async () => {
    const { id, hash } = seedWithBody('worker', 1_000, REQUEST_BYTES, 'request');
    // The bytes go while the citation remains. Reachable two ways in
    // production — a blob collected by an older retention pass, or one
    // whose stored bytes fail their own hash check on read, which
    // `getBlob` reports as null rather than serving corrupt content.
    db.prepare('DELETE FROM raw_blob WHERE hash = ?').run(hash);

    // Assert the induced state actually took, before reading the
    // verdict: a fixture that never reached the branch is
    // indistinguishable from one that passed.
    expect(raw.getBlob(hash)).toBeNull();

    const resp = await app.request(`/members/worker/genai/${id}/raw`, authed(SELF));

    expect(resp.status).toBe(410);
  });
});

describe('ownership', () => {
  it('a member reads their own bytes', async () => {
    const { id } = seedWithBody('worker', 1_000, REQUEST_BYTES, 'request');
    const resp = await app.request(`/members/worker/genai/${id}/raw`, authed(SELF));
    expect(resp.status).toBe(200);
  });

  it('activity.read reads anyone', async () => {
    const { id } = seedWithBody('worker', 1_000, REQUEST_BYTES, 'request');
    const resp = await app.request(`/members/worker/genai/${id}/raw`, authed(READER));
    expect(resp.status).toBe(200);
  });

  it("refuses another member's bytes without activity.read", async () => {
    const { id } = seedWithBody('worker', 1_000, REQUEST_BYTES, 'request');
    const resp = await app.request(`/members/worker/genai/${id}/raw`, authed(STRANGER));
    expect(resp.status).toBe(403);
  });

  it('DEDUPED bytes stay behind their owner, not the content hash', async () => {
    // The crossing this route's shape exists to prevent. Two members
    // send byte-identical bodies, so the store holds ONE blob; the
    // stranger owns an inference citing that exact hash. Reading their
    // own is fine, reading the other member's record is not — even
    // though both resolve to the same bytes.
    const mine = seedWithBody('worker', 1_000, REQUEST_BYTES, 'request');
    const theirs = seedWithBody('other', 1_000, REQUEST_BYTES, 'request');
    expect(theirs.hash).toBe(mine.hash);

    const own = await app.request(`/members/other/genai/${theirs.id}/raw`, authed(STRANGER));
    expect(own.status).toBe(200);

    const crossing = await app.request(`/members/worker/genai/${mine.id}/raw`, authed(STRANGER));
    expect(crossing.status).toBe(403);
  });

  it('404s an id belonging to another member rather than confirming it exists', async () => {
    // The reader may read anyone, so the name in the path is what
    // scopes the record; a mismatched pair must not resolve.
    const theirs = seedWithBody('other', 1_000, REQUEST_BYTES, 'request');
    const resp = await app.request(`/members/worker/genai/${theirs.id}/raw`, authed(READER));
    expect(resp.status).toBe(404);
  });
});
