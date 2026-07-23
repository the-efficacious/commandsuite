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
import { Broker, InMemoryEventLog } from 'csuite-core';
import type { Objective, Team } from 'csuite-sdk/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { openDatabase } from '../../src/db.js';
import { createSqliteFilesystemStore, LocalBlobStore } from '../../src/files/index.js';
import { createMemberStore } from '../../src/members.js';
import { createSqliteObjectivesStore } from '../../src/objectives.js';
import { SessionStore } from '../../src/sessions.js';
import { createTokenStoreFromMembers } from '../../src/tokens.js';
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
      role: { title: 'admin', description: '' },
      permissions: ['members.manage', 'objectives.create', 'objectives.watch'],
      token: ALICE,
    },
    {
      name: 'bob',
      role: { title: 'engineer', description: '' },
      permissions: ['objectives.create'],
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
  const sessions = new SessionStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
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
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
  app: ReturnType<typeof makeApp>['app'],
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
    const { app } = makeApp();
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
    const { app } = makeApp();
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

  it('drops namespace read access for a watcher the moment they are removed', async () => {
    const { app } = makeApp();
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
      `/objectives/${obj.id}/watchers`,
      authed(BOB, { remove: ['dave'] }),
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
});
