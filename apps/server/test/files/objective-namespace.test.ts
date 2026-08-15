/**
 * End-to-end tests for the `/objectives/<id>/...` filesystem
 * namespace.
 *
 * Wires the FS store + objectives store + Hono routes through a real
 * in-memory SQLite + temp blob root so attachment mirroring,
 * membership-based ACL, and watcher-removal grant cleanup all
 * exercise together.
 *
 * What we're trying to prove here:
 *   1. Creating an objective with attachments mirrors the file into
 *      `/objectives/<id>/<basename>` and updates the objective's
 *      attachments to point at the namespace path. The originator's
 *      home copy stays put (so deletes from the home don't break the
 *      objective).
 *   2. Members of the objective (originator, assignee, watchers) can
 *      read AND write under the namespace. Non-members 403.
 *   3. Removing a watcher revokes their `obj:<id>` grants on legacy
 *      pointer attachments — the (b) bug fix.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Broker,
  createApp,
  createSqliteObjectivesStore,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import { FsEntryResponseSchema, FsEntrySchema } from 'csuite-sdk/schemas';
import type { Objective, Team } from 'csuite-sdk/types';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createSqliteFilesystemStore, LocalBlobStore } from '../../src/files/index.js';
import { createMemberStore } from '../../src/members.js';
import { silentLogger } from '../helpers/logger.js';
import { mockTeamStore } from '../helpers/test-stores.js';

const ALICE = 'csuite_test_alice_secret';
const BOB = 'csuite_test_bob_secret';
const CAROL = 'csuite_test_carol_secret';
const DAVE = 'csuite_test_dave_secret';

const TEAM: Team = {
  name: 'obj-fs-team',
  context: '',
  permissionPresets: {},
};

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

async function makeApp() {
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
      role: { title: 'team lead', description: '' },
      permissions: [
        'members.manage',
        'objectives.create',
        'objectives.cancel',
        'objectives.reassign',
        'objectives.watch',
      ],
      token: ALICE,
    },
    {
      name: 'bob',
      role: { title: 'engineer', description: '' },
      permissions: [
        'objectives.create',
        'objectives.cancel',
        'objectives.reassign',
        'objectives.watch',
      ],
      token: BOB,
    },
    {
      name: 'carol',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: CAROL,
    },
    {
      name: 'dave',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: DAVE,
    },
  ]);
  broker.seedMembers(members.members());
  const db = openDatabase(':memory:');
  const sessions = new SqliteSessionStore(db);
  const tokens = await createTokenStoreFromMembers(db, members);
  const blobDir = mkdtempSync(join(tmpdir(), 'csuite-objfs-'));
  tmpDirs.push(blobDir);
  const blobs = new LocalBlobStore(blobDir);
  const objectives = createSqliteObjectivesStore(db);
  const files = createSqliteFilesystemStore({
    db,
    blobs,
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
  for (const m of members.members()) {
    files.ensureHome(m.name);
  }
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore(TEAM),
    objectives,
    files,
    version: '0.0.0',
    logger: silentLogger(),
  });
  return { app, files, objectives };
}

function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  init.method = method ?? (body !== undefined ? 'POST' : 'GET');
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

async function uploadToHome(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  token: string,
  path: string,
  body: string,
): Promise<void> {
  const res = await app.request(
    `/fs/write?path=${encodeURIComponent(path)}&mime=${encodeURIComponent('text/plain')}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body,
    },
  );
  expect(res.status).toBe(200);
}

describe('/objectives/<id>/ namespace', () => {
  it('mirrors create-time attachments into the namespace and points the objective there', async () => {
    const { app } = await makeApp();
    // Bob uploads a spec to his home, then creates an objective with it.
    await uploadToHome(app, BOB, '/bob/specs/payment.md', '# Payment service\n');
    const res = await app.request(
      '/objectives',
      authed(BOB, {
        title: 'Ship payment service',
        outcome: 'PR merged',
        body: '',
        assignee: 'carol',
        attachments: [
          { path: '/bob/specs/payment.md', name: 'payment.md', size: 1, mimeType: 'text/plain' },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const obj = (await res.json()) as Objective;
    expect(obj.attachments).toHaveLength(1);
    // The objective's attachment now lives in the namespace.
    expect(obj.attachments[0]?.path).toBe(`/objectives/${obj.id}/payment.md`);
    // Bob's home copy is untouched — the original is still readable from there.
    const fromHome = await app.request(
      `/fs/stat?path=${encodeURIComponent('/bob/specs/payment.md')}`,
      authed(BOB),
    );
    expect(fromHome.status).toBe(200);
  });

  it('lets every objective member read AND write under the namespace, and 403s non-members', async () => {
    const { app } = await makeApp();
    await uploadToHome(app, BOB, '/bob/notes.txt', 'context');
    const createRes = await app.request(
      '/objectives',
      authed(BOB, {
        title: 'Investigate flake',
        outcome: 'root cause + fix',
        body: '',
        assignee: 'carol',
        watchers: ['alice'],
        attachments: [
          { path: '/bob/notes.txt', name: 'notes.txt', size: 1, mimeType: 'text/plain' },
        ],
      }),
    );
    const obj = (await createRes.json()) as Objective;
    const namespacePath = `/objectives/${obj.id}/notes.txt`;

    // Originator (bob), assignee (carol), watcher (alice — also admin),
    // each can read.
    for (const tok of [BOB, CAROL, ALICE]) {
      const r = await app.request(
        `/fs/stat?path=${encodeURIComponent(namespacePath)}`,
        authed(tok),
      );
      expect(r.status).toBe(200);
    }
    // Non-member dave gets 403.
    const denied = await app.request(
      `/fs/stat?path=${encodeURIComponent(namespacePath)}`,
      authed(DAVE),
    );
    expect(denied.status).toBe(403);

    // Carol (assignee) can write a follow-up file into the namespace.
    const writeRes = await app.request(
      `/fs/write?path=${encodeURIComponent(`/objectives/${obj.id}/findings.md`)}&mime=${encodeURIComponent('text/markdown')}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${CAROL}` },
        body: '# findings',
      },
    );
    expect(writeRes.status).toBe(200);

    // Dave still can't write into the namespace.
    const writeDenied = await app.request(
      `/fs/write?path=${encodeURIComponent(`/objectives/${obj.id}/sneaky.md`)}&mime=${encodeURIComponent('text/markdown')}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${DAVE}` },
        body: 'should fail',
      },
    );
    expect(writeDenied.status).toBe(403);
  });

  it('reports canWrite from the server rule, where owner-equality would say no', async () => {
    // The gate this replaces: `entry.owner === viewer`. For a namespace
    // entry the owner is `obj:<id>`, so that inference is false for
    // EVERY member including the assignee — which is why the web UI hid
    // Delete on files its viewer was entitled to remove.
    const { app } = await makeApp();
    await uploadToHome(app, BOB, '/bob/spec.md', 'spec');
    const createRes = await app.request(
      '/objectives',
      authed(BOB, {
        title: 'Capability on entries',
        outcome: 'delivered',
        body: '',
        assignee: 'carol',
        watchers: ['dave'],
        attachments: [
          { path: '/bob/spec.md', name: 'spec.md', size: 1, mimeType: 'text/markdown' },
        ],
      }),
    );
    const obj = (await createRes.json()) as Objective;
    const nsPath = `/objectives/${obj.id}/spec.md`;

    // carol is the assignee and NOT an admin.
    const res = await app.request(`/fs/stat?path=${encodeURIComponent(nsPath)}`, authed(CAROL));
    expect(res.status).toBe(200);
    const { entry } = (await res.json()) as { entry: { owner: string; canWrite?: boolean } };

    expect(entry.owner, 'namespace entries are owned by the objective').toBe(`obj:${obj.id}`);
    expect(entry.owner === 'carol', 'the old inference would deny her').toBe(false);
    expect(entry.canWrite, 'the server rule permits her — canWrite must say so').toBe(true);

    // dave is a watcher: also a member, also not the owner.
    const daveRes = await app.request(`/fs/stat?path=${encodeURIComponent(nsPath)}`, authed(DAVE));
    const daveEntry = (await daveRes.json()) as { entry: { canWrite?: boolean } };
    expect(daveEntry.entry.canWrite, 'watchers are objective members').toBe(true);

    const bobHome = await app.request(
      `/fs/stat?path=${encodeURIComponent('/bob/spec.md')}`,
      authed(BOB),
    );
    const bobEntry = (await bobHome.json()) as { entry: { canWrite?: boolean } };
    expect(bobEntry.entry.canWrite, 'bob owns his own home file').toBe(true);
  });

  it('reports canWrite=false for a read grant — canRead honours grants, canWrite does not', async () => {
    // The DENYING direction, and it has to be committed: without it the
    // suite passes against a server reporting canWrite:true for every
    // entry, which would render a Delete button whose request then 403s.
    //
    // A grant is the sharpest case, because it is the one asymmetry in
    // the rule — canRead() consults hasGrant, canWrite() deliberately
    // does not. So the viewer can see the entry at all, and still must
    // not be told they may change it.
    const { app, files } = await makeApp();
    await uploadToHome(app, BOB, '/bob/spec.md', 'spec');
    files.grant('/bob/spec.md', 'dave', 'test-grant');

    const res = await app.request(
      `/fs/stat?path=${encodeURIComponent('/bob/spec.md')}`,
      authed(DAVE),
    );
    expect(res.status, 'the grant lets dave READ the entry').toBe(200);
    const { entry } = (await res.json()) as { entry: { canWrite?: boolean } };
    expect(entry.canWrite, 'a read grant must never confer write').toBe(false);

    // Carol has no grant, so a wrong canWrite could not hide behind a 403.
    const carol = await app.request(
      `/fs/stat?path=${encodeURIComponent('/bob/spec.md')}`,
      authed(CAROL),
    );
    expect(carol.status).toBe(403);
  });

  it('drops namespace read access for a watcher the moment they are removed', async () => {
    const { app } = await makeApp();
    // Set up an objective with dave as a watcher, plus an attachment
    // mirrored into the namespace.
    await uploadToHome(app, BOB, '/bob/draft.md', 'draft');
    const create = await app.request(
      '/objectives',
      authed(BOB, {
        title: 'Watcher-revoke check',
        outcome: 'verified',
        body: '',
        assignee: 'carol',
        watchers: ['dave'],
        attachments: [
          { path: '/bob/draft.md', name: 'draft.md', size: 1, mimeType: 'text/markdown' },
        ],
      }),
    );
    const obj = (await create.json()) as Objective;
    const namespacePath = `/objectives/${obj.id}/draft.md`;

    // Dave is a watcher → can read the namespace file.
    const beforeRemove = await app.request(
      `/fs/stat?path=${encodeURIComponent(namespacePath)}`,
      authed(DAVE),
    );
    expect(beforeRemove.status).toBe(200);

    // Remove dave from watchers.
    const watchers = await app.request(
      `/objectives/${obj.id}`,
      authed(BOB, { removeWatchers: ['dave'] }, 'PATCH'),
    );
    expect(watchers.status).toBe(200);

    // Access should drop immediately — the namespace ACL consults
    // live membership, no grant cleanup needed.
    const afterRemove = await app.request(
      `/fs/stat?path=${encodeURIComponent(namespacePath)}`,
      authed(DAVE),
    );
    expect(afterRemove.status).toBe(403);
  });

  it('lets an objective member LIST the namespace, not just stat paths inside it', async () => {
    // `list` gated on `members.manage || ownsPath` while stat/read/
    // listShared all gated on `canRead`. A namespace is owned by
    // `obj:<id>` and by no member, so the ownership test refused every
    // member of the objective — including its assignee. Directors got
    // through only via `members.manage`, which is why this read as a
    // permissions problem rather than a missing branch.
    const { app } = await makeApp();
    await uploadToHome(app, BOB, '/bob/notes.txt', 'context');
    const createRes = await app.request(
      '/objectives',
      authed(BOB, {
        title: 'Investigate flake',
        outcome: 'root cause + fix',
        body: '',
        assignee: 'carol',
        watchers: [],
        attachments: [
          { path: '/bob/notes.txt', name: 'notes.txt', size: 1, mimeType: 'text/plain' },
        ],
      }),
    );
    const obj = (await createRes.json()) as Objective;
    const nsPath = `/objectives/${obj.id}`;

    // carol is the assignee and holds no elevated permission.
    const listed = await app.request(`/fs/ls?path=${encodeURIComponent(nsPath)}`, authed(CAROL));
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { entries: Array<{ name: string; owner: string }> };
    expect(body.entries.map((e) => e.name)).toContain('notes.txt');

    // ...and the entries carry the objective owner, which is the value
    // the response schema used to reject.
    expect(body.entries[0]?.owner).toBe(`obj:${obj.id}`);

    // A non-member is still refused — the fix widens who may list, not
    // whether listing is gated at all.
    const denied = await app.request(`/fs/ls?path=${encodeURIComponent(nsPath)}`, authed(DAVE));
    expect(denied.status).toBe(403);
  });

  it('parses a namespace entry through the published FsEntry schema', async () => {
    // The defect was client-side: the server responded correctly and
    // the SDK threw parsing that successful response, because
    // `FsEntrySchema.owner` was `NameSchema` and `obj:<id>` contains a
    // colon. Parsing the real response body here is what makes this a
    // contract test rather than a shape assertion.
    const { app } = await makeApp();
    await uploadToHome(app, BOB, '/bob/notes.txt', 'context');
    const createRes = await app.request(
      '/objectives',
      authed(BOB, {
        title: 'Investigate flake',
        outcome: 'root cause + fix',
        body: '',
        assignee: 'carol',
        watchers: [],
        attachments: [
          { path: '/bob/notes.txt', name: 'notes.txt', size: 1, mimeType: 'text/plain' },
        ],
      }),
    );
    const obj = (await createRes.json()) as Objective;

    const stat = await app.request(
      `/fs/stat?path=${encodeURIComponent(`/objectives/${obj.id}/notes.txt`)}`,
      authed(CAROL),
    );
    expect(stat.status).toBe(200);
    // The route returns `{ entry }`, so parse the envelope the SDK
    // client actually parses rather than a shape I assumed.
    const parsed = FsEntryResponseSchema.safeParse(await stat.json());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.entry.owner).toBe(`obj:${obj.id}`);
  });

  it('still rejects an owner that is neither a member name nor an objective', async () => {
    // Widening is not the same as removing. A control that must hold in
    // both worlds, so the two assertions above mean something.
    expect(FsEntrySchema.shape.owner.safeParse('chan:general').success).toBe(false);
    expect(FsEntrySchema.shape.owner.safeParse('obj:has spaces').success).toBe(false);
    expect(FsEntrySchema.shape.owner.safeParse('Cora').success).toBe(true);
    expect(FsEntrySchema.shape.owner.safeParse('obj:obj-ms7vlmdb-15').success).toBe(true);
  });
});
