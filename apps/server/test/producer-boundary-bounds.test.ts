/**
 * Producer-boundary bounds: two fields, two OPPOSITE policies, on purpose.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Both defects were the same shape — a server writing a value its own
 * published schema refuses to read — and they are fixed in opposite
 * directions. That inversion is the substance of this file. It is not an
 * inconsistency awaiting a tidy-up.
 *
 *   POST /fs/write   `mime`                 → REJECT (400), nothing persisted
 *   POST /enroll     `sourceUa`/`sourceIp`  → TRUNCATE (200), and say so
 *
 * THE RULE THAT DECIDES WHICH
 * ---------------------------
 * Reject when the value is a CLAIM ABOUT CONTENT. Truncate when it is a
 * LABEL THE USER DID NOT CHOOSE.
 *
 * `mime` is a claim the caller makes about the bytes they are uploading.
 * A truncated MIME type is not a shorter version of that claim — it is a
 * DIFFERENT, still well-formed claim the caller never made, silently
 * attached to their content. Refusing is recoverable; mislabeling stored
 * bytes is not.
 *
 * `sourceUa`/`sourceIp` are audit context the enrolling user never authored:
 * one comes from proxy headers, the other from whatever their client sends.
 * Rejecting would deny a legitimate device a login over a field its operator
 * cannot see, cannot edit, and did not write. A bounded prefix keeps the
 * audit trail useful; refusing destroys the enrollment to protect a label.
 *
 * READ THIS BEFORE MAKING THEM AGREE
 * ----------------------------------
 * Each half below asserts the OTHER half's opposite outcome deliberately, so
 * a consistency pass that collapses these into one rule cannot do so while
 * this file is green. If you are here because you wanted one policy: the
 * question is not "which is right" but "is this value a claim or a label".
 *
 * WHAT WAS MEASURED
 * -----------------
 * Both defects were reproduced against v0.3.1 before the fix, at the tag
 * (`apps/server/src/app.ts` and `packages/sdk/src/schemas.ts` are byte-
 * identical between `v0.3.1` and `origin/main@827ff2e`):
 *
 *   /fs/write?mime=<300 chars>  → 200, persisted; /fs/stat returned the
 *                                 same entry; FsEntrySchema.safeParse false
 *   /enroll with 600-char UA    → 200; /enroll/pending row failed
 *                                 PendingEnrollmentSchema with
 *                                 too_big maximum:512
 *
 * Neither is hypothetical, and neither was inferred from reading the code.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker, InMemoryEventLog } from 'csuite-core';
import { FsEntrySchema, PendingEnrollmentSchema } from 'csuite-sdk/schemas';
import type { FsEntry, PendingEnrollment, Team } from 'csuite-sdk/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { EnrollmentStore } from '../src/enrollments.js';
import { createSqliteFilesystemStore, LocalBlobStore } from '../src/files/index.js';
import { createMemberStore } from '../src/members.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN_TOKEN = 'csuite_bounds_admin_token';
const TEAM: Team = { name: 'bounds-team', context: '', permissionPresets: {} };

/**
 * The limits are read off the published schemas rather than written as
 * literals, for the same reason the server reads them: a second copy of the
 * number is how the producer and the consumer drifted apart originally. If
 * someone raises a schema cap, these tests follow it instead of going stale.
 */
const MIME_MAX = FsEntrySchema.shape.mimeType.unwrap().maxLength ?? 255;
const UA_MAX = PendingEnrollmentSchema.shape.sourceUa.unwrap().maxLength ?? 512;
const IP_MAX = PendingEnrollmentSchema.shape.sourceIp.unwrap().maxLength ?? 64;

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp() {
  const broker = new Broker({ eventLog: new InMemoryEventLog() });
  const members = createMemberStore([
    {
      name: 'alice',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      token: ADMIN_TOKEN,
    },
  ]);
  broker.seedMembers(members.members());
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
  const blobDir = mkdtempSync(join(tmpdir(), 'csuite-bounds-'));
  tmpDirs.push(blobDir);
  const files = createSqliteFilesystemStore({ db, blobs: new LocalBlobStore(blobDir) });
  for (const m of members.members()) files.ensureHome(m.name);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    enrollments: new EnrollmentStore(db),
    teamStore: mockTeamStore(TEAM),
    files,
    version: '0.0.0',
    logger,
  });
  return { app, logger };
}

const authed = { Authorization: `Bearer ${ADMIN_TOKEN}` };

function write(app: ReturnType<typeof makeApp>['app'], path: string, mime: string) {
  return app.request(
    `/fs/write?path=${encodeURIComponent(path)}&mime=${encodeURIComponent(mime)}`,
    { method: 'POST', headers: authed, body: 'payload-bytes' },
  );
}

function enroll(app: ReturnType<typeof makeApp>['app'], headers: Record<string, string>) {
  return app.request('/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ labelHint: 'device' }),
  });
}

async function pendingRows(app: ReturnType<typeof makeApp>['app']): Promise<PendingEnrollment[]> {
  const res = await app.request('/enroll/pending', { headers: authed });
  expect(res.status).toBe(200);
  return ((await res.json()) as { enrollments: PendingEnrollment[] }).enrollments;
}

// ---------------------------------------------------------------------------
// CLAIM ABOUT CONTENT → REJECT
// ---------------------------------------------------------------------------

describe('POST /fs/write — an out-of-bounds `mime` is REFUSED, never truncated', () => {
  it('refuses a mime the SDK could not parse back, and persists nothing', async () => {
    const { app } = makeApp();
    const longMime = `text/${'x'.repeat(MIME_MAX - 4)}`;
    expect(longMime.length).toBeGreaterThan(MIME_MAX);

    const res = await write(app, '/alice/doc.txt', longMime);
    expect(res.status).toBe(400);

    // "before persistence" is the load-bearing half of the outcome. A 400
    // that still wrote the row would satisfy the status assertion and none
    // of the intent, so the absence is observed on the stored filesystem
    // and not inferred from the response code.
    const stat = await app.request(`/fs/stat?path=${encodeURIComponent('/alice/doc.txt')}`, {
      headers: authed,
    });
    expect(stat.status, 'the refused write must not have created an entry').toBe(404);

    // Positive control, same app and same path. A 404 also happens when the
    // path is wrong, the token is wrong, or the harness never wired a home —
    // in which case the assertion above proves nothing. Showing that THIS
    // path does accept a write establishes the 404 came from the refusal.
    expect((await write(app, '/alice/doc.txt', 'text/plain')).status).toBe(200);
    const control = await app.request(`/fs/stat?path=${encodeURIComponent('/alice/doc.txt')}`, {
      headers: authed,
    });
    expect(control.status, 'the path itself is writable — the 404 was the refusal').toBe(200);
  });

  it('does NOT store a truncated mime — the shortened claim was never made', async () => {
    const { app } = makeApp();
    // The failure this guards against is a "fix" that clamps to the limit:
    // the write would succeed, the schema would parse, every other
    // assertion here would pass, and the file would be stored under a
    // content type its uploader never sent.
    await write(app, '/alice/doc.txt', `text/${'x'.repeat(MIME_MAX)}`);

    const stat = await app.request(`/fs/stat?path=${encodeURIComponent('/alice/doc.txt')}`, {
      headers: authed,
    });
    expect(stat.status).toBe(404);
    if (stat.status === 200) {
      const { entry } = (await stat.json()) as { entry: FsEntry };
      expect(entry.mimeType, 'must not have been silently clamped to fit').toBeNull();
    }
  });

  it('accepts a mime exactly at the limit, and refuses one character past it', async () => {
    const { app } = makeApp();
    // Without both sides, an over-strict bound (rejecting everything, or
    // off-by-one at the boundary) would pass the rejection tests above
    // while breaking ordinary uploads.
    const atLimit = `text/${'x'.repeat(MIME_MAX - 5)}`;
    expect(atLimit.length).toBe(MIME_MAX);
    expect((await write(app, '/alice/at-limit.txt', atLimit)).status).toBe(200);
    expect((await write(app, '/alice/over.txt', `${atLimit}x`)).status).toBe(400);
  });

  it('still accepts an ordinary mime', async () => {
    const { app } = makeApp();
    const res = await write(app, '/alice/plain.txt', 'text/plain');
    expect(res.status).toBe(200);
    const { entry } = (await res.json()) as { entry: FsEntry };
    expect(entry.mimeType).toBe('text/plain');
    expect(FsEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('DELIBERATELY diverges from /enroll, which truncates instead of refusing', async () => {
    // This assertion is the opposite of the policy asserted directly above,
    // and it is correct. `mime` is a claim about content; a User-Agent is a
    // label the enrolling user did not choose. See this file's header before
    // reconciling them — making these two agree is the regression, not the
    // cleanup.
    const { app } = makeApp();

    expect(
      (await write(app, '/alice/x.txt', `text/${'x'.repeat(MIME_MAX)}`)).status,
      'oversize mime → refused',
    ).toBe(400);

    expect(
      (await enroll(app, { 'User-Agent': 'M'.repeat(UA_MAX + 100) })).status,
      'oversize User-Agent → accepted, not refused',
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// LABEL THE USER DID NOT CHOOSE → TRUNCATE, AND RECORD IT
// ---------------------------------------------------------------------------

describe('POST /enroll — source labels are TRUNCATED to schema bounds, never refused', () => {
  it('accepts an oversize User-Agent and stores a row the SDK can parse', async () => {
    const { app } = makeApp();
    expect((await enroll(app, { 'User-Agent': 'M'.repeat(UA_MAX + 88) })).status).toBe(200);

    const rows = await pendingRows(app);
    expect(rows).toHaveLength(1);

    // The whole point: the published schema accepts what the server wrote.
    // Parsing the row is the assertion the original defect failed.
    const parsed = PendingEnrollmentSchema.safeParse(rows[0]);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(rows[0]?.sourceUa?.length).toBe(UA_MAX);
  });

  it('marks the stored value as cut, so it is distinguishable from a real one at the limit', async () => {
    const { app } = makeApp();
    await enroll(app, { 'User-Agent': 'M'.repeat(UA_MAX + 1) });

    const [row] = await pendingRows(app);
    // Without the marker, a truncated label and a genuine label that happens
    // to be exactly at the limit are byte-identical in shape, and a director
    // reading /enroll/pending cannot tell that anything was dropped.
    expect(row?.sourceUa?.endsWith('…'), 'truncation must be visible in the value').toBe(true);
    expect(row?.sourceUa?.length, 'the marker lives inside the bound, not past it').toBe(UA_MAX);
  });

  it('records the truncation with the field and the original length', async () => {
    const { app, logger } = makeApp();
    await enroll(app, { 'User-Agent': 'M'.repeat(900) });

    // Truncation that nobody can observe is silent data loss. The stored
    // value says THAT it was cut; the log says by how much.
    expect(logger.warn).toHaveBeenCalledWith(
      'enrollment source label truncated',
      expect.objectContaining({ field: 'sourceUa', originalLength: 900, max: UA_MAX }),
    );
  });

  it('bounds sourceIp from a spoofable forwarding header too', async () => {
    const { app, logger } = makeApp();
    // sourceIp is header-derived: `X-Real-IP` is returned verbatim by
    // ipKey(), so it is unbounded from outside exactly like the UA.
    await enroll(app, { 'X-Real-IP': '9'.repeat(IP_MAX + 40) });

    const [row] = await pendingRows(app);
    expect(row?.sourceIp?.length).toBe(IP_MAX);
    expect(row?.sourceIp?.endsWith('…')).toBe(true);
    expect(PendingEnrollmentSchema.safeParse(row).success).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'enrollment source label truncated',
      expect.objectContaining({ field: 'sourceIp', originalLength: IP_MAX + 40 }),
    );
  });

  it('leaves an in-bounds label byte-identical', async () => {
    const { app, logger } = makeApp();
    const ua = 'csuite-cli/0.3.1 (linux; x64)';
    await enroll(app, { 'User-Agent': ua });

    const [row] = await pendingRows(app);
    expect(row?.sourceUa).toBe(ua);
    expect(logger.warn).not.toHaveBeenCalledWith(
      'enrollment source label truncated',
      expect.anything(),
    );
  });

  it('truncates the STORED ip without merging rate-limit buckets', async () => {
    const { app } = makeApp();
    // The bound is applied to the recorded label only, never to the
    // rate-limit key. Two distinct clients sharing a long forwarded prefix
    // must stay in separate buckets — otherwise one client could exhaust
    // the mint limit for every other client behind the same proxy chain.
    const prefix = '7'.repeat(IP_MAX + 20);
    for (let i = 0; i < 11; i++) {
      await enroll(app, { 'X-Real-IP': `${prefix}-a` });
    }
    // The 11th request from client A is over ENROLL_MINT_MAX (10).
    expect((await enroll(app, { 'X-Real-IP': `${prefix}-a` })).status).toBe(429);

    // Client B shares the truncated prefix but is a different client.
    expect(
      (await enroll(app, { 'X-Real-IP': `${prefix}-b` })).status,
      'a distinct client sharing the truncated prefix must not inherit the limit',
    ).toBe(200);
  });

  it('DELIBERATELY diverges from /fs/write, which refuses instead of truncating', async () => {
    // Mirror of the cross-reference in the /fs/write block. Both directions
    // are stated so the inversion is visible from whichever half a future
    // reader opens first.
    const { app } = makeApp();

    expect(
      (await enroll(app, { 'User-Agent': 'M'.repeat(UA_MAX + 5) })).status,
      'oversize User-Agent → truncated and accepted',
    ).toBe(200);
    expect((await pendingRows(app))[0]?.sourceUa?.length).toBe(UA_MAX);

    expect(
      (await write(app, '/alice/y.txt', `text/${'x'.repeat(MIME_MAX)}`)).status,
      'oversize mime → refused, and NOT truncated to fit',
    ).toBe(400);
  });
});
