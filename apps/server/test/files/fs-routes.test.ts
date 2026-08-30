/**
 * End-to-end tests for the `/fs/*` HTTP surface.
 *
 * Each test wires a fresh in-memory SQLite + temp blob root through
 * `createApp` so permission rules + wire encoding + path resolution
 * all exercise together. No mocks inside the server — the only
 * external dependency is the ephemeral disk under `filesRoot`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Broker,
  createApp,
  createSqliteChannelStore,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import type { FsEntry, Team } from 'csuite-sdk/types';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db.js';
import { createSqliteFilesystemStore, LocalBlobStore } from '../../src/files/index.js';
import { createMemberStore } from '../../src/members.js';
import { silentLogger } from '../helpers/logger.js';
import { mockTeamStore } from '../helpers/test-stores.js';

const ALICE_TOKEN = 'csuite_test_alice_secret';
const BOB_TOKEN = 'csuite_test_bob_secret';
const CAROL_TOKEN = 'csuite_test_carol_secret';
const DIRECTOR_TOKEN = 'csuite_test_director_secret';

const TEAM: Team = {
  name: 'files-team',
  context: '',
  permissionPresets: {},
};

const WORKER_ROLE = { title: 'worker', description: '' };

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
    idFactory: () => 'msg-fixed',
  });
  const members = createMemberStore([
    { name: 'alice', role: WORKER_ROLE, permissions: ['channels.manage'], token: ALICE_TOKEN },
    { name: 'bob', role: WORKER_ROLE, permissions: [], token: BOB_TOKEN },
    { name: 'carol', role: WORKER_ROLE, permissions: [], token: CAROL_TOKEN },
    {
      name: 'diana',
      role: WORKER_ROLE,
      permissions: ['members.manage'],
      token: DIRECTOR_TOKEN,
    },
  ]);
  // Pre-seed the broker with every member so targeted pushes don't 404
  // on `broker.hasMember`.
  broker.seedMembers(members.members());
  const db = openDatabase(':memory:');
  const sessions = new SqliteSessionStore(db);
  const tokens = await createTokenStoreFromMembers(db, members);
  const blobDir = mkdtempSync(join(tmpdir(), 'csuite-fsroute-'));
  tmpDirs.push(blobDir);
  const blobs = new LocalBlobStore(blobDir);
  const files = createSqliteFilesystemStore({ db, blobs });
  const channels = createSqliteChannelStore(db);
  for (const m of members.members()) {
    files.ensureHome(m.name);
  }
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore(TEAM),
    files,
    channels,
    version: '0.0.0',
    logger: silentLogger(),
  });
  return { app, files };
}

function authed(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
  };
}

async function writeFile(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  token: string,
  path: string,
  mime: string,
  body: string | Buffer,
  collide = 'error',
): Promise<{ status: number; data: { entry: FsEntry; renamed: boolean } | { error: string } }> {
  const res = await app.request(
    `/fs/write?path=${encodeURIComponent(path)}&mime=${encodeURIComponent(mime)}&collide=${collide}`,
    {
      method: 'POST',
      headers: authed(token),
      body: typeof body === 'string' ? body : new Uint8Array(body),
    },
  );
  return { status: res.status, data: await res.json() };
}

describe('/fs/write', () => {
  it("uploads a file into the caller's home", async () => {
    const { app } = await makeApp();
    const { status, data } = await writeFile(
      app,
      ALICE_TOKEN,
      '/alice/uploads/hello.txt',
      'text/plain',
      'hello world',
    );
    expect(status).toBe(200);
    const ok = data as { entry: FsEntry; renamed: boolean };
    expect(ok.entry.path).toBe('/alice/uploads/hello.txt');
    expect(ok.entry.size).toBe('hello world'.length);
    expect(ok.entry.mimeType).toBe('text/plain');
    expect(ok.renamed).toBe(false);
  });

  it("refuses writes into someone else's home", async () => {
    const { app } = await makeApp();
    const { status, data } = await writeFile(
      app,
      BOB_TOKEN,
      '/alice/hack.txt',
      'text/plain',
      'hack',
    );
    expect(status).toBe(403);
    expect((data as { error: string }).error).toMatch(/cannot write/);
  });

  it('suffix strategy produces a non-colliding path', async () => {
    const { app } = await makeApp();
    await writeFile(app, ALICE_TOKEN, '/alice/dup.txt', 'text/plain', 'v1');
    const second = await writeFile(
      app,
      ALICE_TOKEN,
      '/alice/dup.txt',
      'text/plain',
      'v2',
      'suffix',
    );
    expect(second.status).toBe(200);
    const ok = second.data as { entry: FsEntry; renamed: boolean };
    expect(ok.entry.path).toBe('/alice/dup-1.txt');
    expect(ok.renamed).toBe(true);
  });
});

describe('/fs/read/*', () => {
  it('streams the file body back with content-type + disposition', async () => {
    const { app } = await makeApp();
    await writeFile(
      app,
      ALICE_TOKEN,
      '/alice/img.png',
      'image/png',
      Buffer.from([137, 80, 78, 71]),
    );
    const res = await app.request('/fs/read/alice/img.png', {
      headers: authed(ALICE_TOKEN),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Disposition')).toContain('img.png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual([137, 80, 78, 71]);
  });

  it('returns 403 when the caller lacks read access', async () => {
    const { app } = await makeApp();
    await writeFile(app, ALICE_TOKEN, '/alice/secret.txt', 'text/plain', 'secret');
    const res = await app.request('/fs/read/alice/secret.txt', { headers: authed(BOB_TOKEN) });
    expect(res.status).toBe(403);
  });

  it('serves files to directors regardless of owner', async () => {
    const { app } = await makeApp();
    await writeFile(app, ALICE_TOKEN, '/alice/vault.txt', 'text/plain', 'vault');
    const res = await app.request('/fs/read/alice/vault.txt', {
      headers: authed(DIRECTOR_TOKEN),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('vault');
  });
});

describe('/fs/ls', () => {
  it('lists the caller home', async () => {
    const { app } = await makeApp();
    await writeFile(app, ALICE_TOKEN, '/alice/a.txt', 'text/plain', 'a');
    await writeFile(app, ALICE_TOKEN, '/alice/b.txt', 'text/plain', 'b');
    const res = await app.request('/fs/ls?path=%2Falice', { headers: authed(ALICE_TOKEN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: FsEntry[] };
    expect(body.entries.map((e) => e.name).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it("refuses to list another slot's home", async () => {
    const { app } = await makeApp();
    await writeFile(app, ALICE_TOKEN, '/alice/a.txt', 'text/plain', 'a');
    const res = await app.request('/fs/ls?path=%2Falice', { headers: authed(BOB_TOKEN) });
    expect(res.status).toBe(403);
  });

  it('distinguishes readable nonempty, readable empty, unreadable, and nonexistent roots', async () => {
    const { app } = await makeApp();
    await writeFile(app, ALICE_TOKEN, '/alice/a.txt', 'text/plain', 'a');

    const nonempty = await app.request('/fs/ls?path=%2Falice', { headers: authed(ALICE_TOKEN) });
    expect(nonempty.status).toBe(200);
    expect(((await nonempty.json()) as { entries: FsEntry[] }).entries).toHaveLength(1);

    const empty = await app.request('/fs/ls?path=%2Fbob', { headers: authed(BOB_TOKEN) });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ entries: [] });

    const unreadable = await app.request('/fs/ls?path=%2Falice', { headers: authed(BOB_TOKEN) });
    expect(unreadable.status).toBe(403);

    const nonexistent = await app.request('/fs/ls?path=%2Fnobody', { headers: authed(BOB_TOKEN) });
    expect(nonexistent.status).toBe(404);
  });

  it('does not disclose existence below an unreadable namespace boundary', async () => {
    const { app } = await makeApp();
    await writeFile(app, ALICE_TOKEN, '/alice/existing/file.txt', 'text/plain', 'secret');
    for (const path of ['/alice/existing', '/alice/not-there']) {
      const res = await app.request(`/fs/ls?path=${encodeURIComponent(path)}`, {
        headers: authed(BOB_TOKEN),
      });
      expect(res.status).toBe(403);
    }
  });

  it('lists root as per-owner homes (director sees everyone)', async () => {
    const { app } = await makeApp();
    const res = await app.request('/fs/ls?path=%2F', { headers: authed(DIRECTOR_TOKEN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: FsEntry[] };
    expect(body.entries.map((e) => e.name).sort()).toEqual(['alice', 'bob', 'carol', 'diana']);
  });
});

describe('/fs/mkdir + /fs/rm + /fs/mv', () => {
  it('mkdir creates a directory and rm removes it', async () => {
    const { app } = await makeApp();
    const mk = await app.request('/fs/mkdir', {
      method: 'POST',
      headers: { ...authed(ALICE_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/alice/subdir', recursive: false }),
    });
    expect(mk.status).toBe(200);

    const rm = await app.request('/fs/rm?path=%2Falice%2Fsubdir', {
      method: 'DELETE',
      headers: authed(ALICE_TOKEN),
    });
    expect(rm.status).toBe(204);
  });

  it('mv renames a file', async () => {
    const { app } = await makeApp();
    await writeFile(app, ALICE_TOKEN, '/alice/first.txt', 'text/plain', 'x');
    const res = await app.request('/fs/mv', {
      method: 'POST',
      headers: { ...authed(ALICE_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '/alice/first.txt', to: '/alice/second.txt' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entry: FsEntry };
    expect(body.entry.path).toBe('/alice/second.txt');
  });
});

describe('/push with attachments', () => {
  it('validates attachments exist and grants recipients read access', async () => {
    const { app, files } = await makeApp();
    await writeFile(app, ALICE_TOKEN, '/alice/share.txt', 'text/plain', 'for bob');

    const pushRes = await app.request('/push', {
      method: 'POST',
      headers: { ...authed(ALICE_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'bob',
        body: 'here is the file',
        attachments: [
          { path: '/alice/share.txt', name: 'share.txt', size: 7, mimeType: 'text/plain' },
        ],
      }),
    });
    expect(pushRes.status).toBe(200);
    const pushBody = (await pushRes.json()) as {
      message: { id: string; attachments: unknown[] };
    };
    expect(pushBody.message.attachments).toHaveLength(1);

    // Bob should now be able to read the file via his grant.
    const readRes = await app.request('/fs/read/alice/share.txt', {
      headers: authed(BOB_TOKEN),
    });
    expect(readRes.status).toBe(200);
    expect(await readRes.text()).toBe('for bob');

    // The grant is persisted in the store under the message id.
    expect(files.hasGrant('/alice/share.txt', 'bob')).toBe(true);
  });

  it('grants a private-channel attachment only to channel members', async () => {
    const { app, files } = await makeApp();
    await writeFile(app, ALICE_TOKEN, '/alice/private.txt', 'text/plain', 'channel only');

    const created = await app.request('/channels', {
      method: 'POST',
      headers: { ...authed(ALICE_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'private-room' }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const added = await app.request('/channels/private-room/members', {
      method: 'POST',
      headers: { ...authed(ALICE_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ member: 'bob' }),
    });
    expect(added.status).toBeLessThan(300);

    const pushed = await app.request('/push', {
      method: 'POST',
      headers: { ...authed(ALICE_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: 'private attachment',
        data: { thread: `chan:${id}` },
        attachments: [
          { path: '/alice/private.txt', name: 'private.txt', size: 12, mimeType: 'text/plain' },
        ],
      }),
    });
    expect(pushed.status).toBe(200);

    expect(
      (
        await app.request('/fs/read/alice/private.txt', {
          headers: authed(BOB_TOKEN),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request('/fs/read/alice/private.txt', {
          headers: authed(CAROL_TOKEN),
        })
      ).status,
    ).toBe(403);
    expect(files.hasGrant('/alice/private.txt', 'bob')).toBe(true);
    expect(files.hasGrant('/alice/private.txt', 'carol')).toBe(false);
  });

  it('rejects attachments on paths the sender cannot access', async () => {
    const { app } = await makeApp();
    await writeFile(app, ALICE_TOKEN, '/alice/secret.txt', 'text/plain', 'nope');
    const pushRes = await app.request('/push', {
      method: 'POST',
      headers: { ...authed(BOB_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: 'attempting to exfil',
        attachments: [
          { path: '/alice/secret.txt', name: 'secret.txt', size: 4, mimeType: 'text/plain' },
        ],
      }),
    });
    expect(pushRes.status).toBe(403);
  });

  it('rejects attachments that do not exist', async () => {
    const { app } = await makeApp();
    const pushRes = await app.request('/push', {
      method: 'POST',
      headers: { ...authed(ALICE_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: 'ghost attachment',
        attachments: [
          { path: '/alice/missing.txt', name: 'missing.txt', size: 1, mimeType: 'text/plain' },
        ],
      }),
    });
    expect(pushRes.status).toBe(400);
  });
});
