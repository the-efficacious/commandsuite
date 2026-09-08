import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../measure-briefing-capture.mjs');
const SERVER_DIST = resolve(import.meta.dirname, '../../apps/server/dist/run.js');

// The three operator-authored blocks the broker composes, verbatim.
// The registered literal appears in ALL THREE, so a probe that exempts
// only some of them reports a lower count rather than passing.
const LITERAL = 'Persimmon Labs';
const TEAM_CONTEXT = `Ship the widget for ${LITERAL}.`;
const ROLE_DESCRIPTION = `Writes code for ${LITERAL}.`;
const PERSONAL_INSTRUCTIONS = `Personal note about ${LITERAL}.`;
const MEMBER = 'probe-member';

const RESULT_KEYS = [
  'afterRegisteredLiteralCount',
  'beforeRegisteredLiteralCount',
  'briefingBlockSha256',
  'capturedBlockSha256',
  'hashesMatch',
  'member',
  'outsideBlockRedactionCoveredBy',
  'query',
  'rawExchangeId',
  'source',
];

let teamPath;
let activityPath;
let wirePath;
let exchangeId;

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  teamPath = join(dir, 'team.db');
  activityPath = join(dir, 'activity.db');
  wirePath = join(dir, 'request.json');

  const team = new DatabaseSync(teamPath);
  team.exec(`
    CREATE TABLE team (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      name        TEXT NOT NULL,
      context     TEXT NOT NULL DEFAULT '',
      updated_at  INTEGER NOT NULL,
      updated_by  TEXT
    );
    CREATE TABLE members (
      identity_id       TEXT NOT NULL UNIQUE,
      name              TEXT PRIMARY KEY,
      role_title        TEXT NOT NULL,
      role_description  TEXT NOT NULL DEFAULT '',
      instructions      TEXT NOT NULL DEFAULT '',
      raw_permissions   TEXT NOT NULL,
      totp_secret       TEXT,
      totp_last_counter INTEGER NOT NULL DEFAULT 0,
      insertion_order   INTEGER NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );`);
  team
    .prepare('INSERT INTO team (id, name, context, updated_at) VALUES (1, ?, ?, 0)')
    .run('Probe Team', TEAM_CONTEXT);
  team
    .prepare(
      `INSERT INTO members
         (identity_id, name, role_title, role_description, instructions,
          raw_permissions, insertion_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0)`,
    )
    .run('id-1', MEMBER, 'Builder', ROLE_DESCRIPTION, PERSONAL_INSTRUCTIONS, '["team.read"]');
  team.close();

  const body = JSON.stringify({
    model: 'claude-probe',
    system: [TEAM_CONTEXT, ROLE_DESCRIPTION, PERSONAL_INSTRUCTIONS].map((text) => ({
      type: 'text',
      text,
    })),
    messages: [],
  });
  writeFileSync(wirePath, body);

  const activity = new DatabaseSync(activityPath);
  activity.exec(`
    CREATE TABLE raw_blob (
      hash          TEXT PRIMARY KEY,
      bytes         BLOB NOT NULL,
      byte_length   INTEGER NOT NULL,
      stored_length INTEGER NOT NULL,
      first_seen_at INTEGER NOT NULL
    );
    CREATE TABLE raw_exchange (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      member_name  TEXT NOT NULL,
      kind         TEXT NOT NULL CHECK(kind IN ('request','response')),
      hash         TEXT NOT NULL,
      body_length  INTEGER NOT NULL,
      request_id   TEXT,
      prompt_id    TEXT,
      session_id   TEXT,
      query_source TEXT,
      agent_name   TEXT,
      model        TEXT,
      event_ts     INTEGER,
      received_at  INTEGER NOT NULL
    );`);
  const insertBlob = activity.prepare(
    'INSERT INTO raw_blob (hash, bytes, byte_length, stored_length, first_seen_at) VALUES (?, ?, ?, ?, 0)',
  );
  const insertExchange = activity.prepare(
    "INSERT INTO raw_exchange (member_name, kind, hash, body_length, received_at) VALUES (?, 'request', ?, ?, 0) RETURNING id",
  );
  const carrying = gzipSync(Buffer.from(body, 'utf8'));
  insertBlob.run('carrying', carrying, body.length, carrying.length);
  exchangeId = Number(insertExchange.get(MEMBER, 'carrying', body.length).id);

  // A LATER capture that does not carry the block. The probe scans
  // newest-first, so this row proves it selects on content rather than
  // taking whatever request happens to be most recent.
  const other = JSON.stringify({ model: 'claude-probe', system: 'unrelated', messages: [] });
  const otherBytes = gzipSync(Buffer.from(other, 'utf8'));
  insertBlob.run('other', otherBytes, other.length, otherBytes.length);
  insertExchange.get(MEMBER, 'other', other.length);
  activity.close();
});

describe('measure-briefing-capture probe', () => {
  it('links against the built server dist before it parses arguments', () => {
    expect(existsSync(SERVER_DIST), 'run `pnpm build` before the root suite').toBe(true);
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: measure-briefing-capture.mjs');
  });

  it('preserves every composed block of a supplied wire request', () => {
    const result = run(teamPath, activityPath, MEMBER, LITERAL, wirePath);
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed).sort()).toEqual(RESULT_KEYS);
    const expected = createHash('sha256').update(TEAM_CONTEXT).digest('hex');
    expect(parsed.briefingBlockSha256).toBe(expected);
    expect(parsed.capturedBlockSha256).toBe(expected);
    expect(parsed.hashesMatch).toBe(true);
    expect(parsed.beforeRegisteredLiteralCount).toBe(0);
    expect(parsed.afterRegisteredLiteralCount).toBe(3);
    expect(parsed.source).toBe(wirePath);
    expect(parsed.member).toBe(MEMBER);
    expect(parsed.rawExchangeId).toBe(null);
    expect(parsed.query).toBe(null);
  });

  it("selects the member's captured request that carries the block", () => {
    const result = run(teamPath, activityPath, MEMBER, LITERAL);
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed).sort()).toEqual(RESULT_KEYS);
    expect(parsed.source).toBe('activity-db');
    expect(parsed.rawExchangeId).toBe(exchangeId);
    expect(parsed.capturedBlockSha256).toBe(
      createHash('sha256').update(TEAM_CONTEXT).digest('hex'),
    );
    expect(parsed.hashesMatch).toBe(true);
    expect(parsed.beforeRegisteredLiteralCount).toBe(0);
    expect(parsed.afterRegisteredLiteralCount).toBe(3);
  });
});
