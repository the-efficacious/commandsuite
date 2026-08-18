/**
 * `/fs/read` response headers.
 *
 * The stored `mimeType` is a claim by whoever uploaded the file, and
 * this route serves bytes from the same origin as the web UI. Reflecting
 * that claim as `Content-Type` with `inline` disposition made every
 * member home a place to park script that runs as whoever opens it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Broker,
  createApp,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import type { Team } from 'csuite-sdk/types';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createSqliteFilesystemStore, LocalBlobStore } from '../src/files/index.js';
import { createMemberStore } from '../src/members.js';
import { silentLogger } from './helpers/logger.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ALICE = 'csuite_test_alice_secret';
const TEAM: Team = { name: 'files-team', context: '', permissionPresets: {} };
const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function makeApp() {
  const db = openDatabase(':memory:');
  const broker = new Broker({ eventLog: new InMemoryEventLog() });
  const members = createMemberStore([
    { name: 'alice', role: { title: 'eng', description: '' }, permissions: [], token: ALICE },
  ]);
  broker.seedMembers(members.members());
  const blobDir = mkdtempSync(join(tmpdir(), 'csuite-fsread-'));
  tmpDirs.push(blobDir);
  const files = createSqliteFilesystemStore({ db, blobs: new LocalBlobStore(blobDir) });
  for (const m of members.members()) files.ensureHome(m.name);
  const { app } = createApp({
    broker,
    members,
    tokens: await createTokenStoreFromMembers(db, members),
    sessions: new SqliteSessionStore(db),
    teamStore: mockTeamStore(TEAM),
    files,
    version: '0.0.0',
    logger: silentLogger(),
  });
  return app;
}

async function upload(
  app: Awaited<ReturnType<typeof makeApp>>,
  path: string,
  mime: string,
  body: string,
): Promise<void> {
  const res = await app.request(
    `/fs/write?path=${encodeURIComponent(path)}&mime=${encodeURIComponent(mime)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${ALICE}` }, body },
  );
  expect(res.status).toBe(200);
}

async function read(app: Awaited<ReturnType<typeof makeApp>>, path: string): Promise<Response> {
  return app.request(`/fs/read${path}`, { headers: { Authorization: `Bearer ${ALICE}` } });
}

describe('/fs/read headers', () => {
  it('serves an uploaded HTML document as a download, sandboxed, unsniffable', async () => {
    const app = await makeApp();
    await upload(app, '/alice/pwn.html', 'text/html', '<script>alert(document.domain)</script>');
    const res = await read(app, '/alice/pwn.html');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    // The bytes are still the bytes — this route is a file read, not a
    // sanitizer. What changed is how a browser is told to treat them.
    expect(await res.text()).toBe('<script>alert(document.domain)</script>');
  });

  it('treats SVG as a document, not as an image', async () => {
    // An SVG opened directly executes its own script on this origin.
    // It renders in the UI's `<img>` either way — disposition does not
    // apply to subresource loads.
    const app = await makeApp();
    await upload(app, '/alice/x.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const res = await read(app, '/alice/x.svg');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('keeps raster images inline for the previews', async () => {
    const app = await makeApp();
    await upload(app, '/alice/photo.png', 'image/png', 'not-really-a-png');
    const res = await read(app, '/alice/photo.png');
    expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('keeps PDFs inline and unsandboxed so the preview iframe works', async () => {
    const app = await makeApp();
    await upload(app, '/alice/doc.pdf', 'application/pdf', '%PDF-1.4');
    const res = await read(app, '/alice/doc.pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(res.headers.get('content-security-policy')).not.toContain('sandbox');
  });

  it('downloads anything it does not recognize', async () => {
    const app = await makeApp();
    await upload(app, '/alice/notes.txt', 'text/plain', 'hello');
    expect((await read(app, '/alice/notes.txt')).headers.get('content-disposition')).toMatch(
      /^attachment;/,
    );
  });

  it('is not fooled by parameters or case on the declared type', async () => {
    const app = await makeApp();
    await upload(app, '/alice/tricky.html', 'TEXT/HTML; charset=utf-8', '<script>1</script>');
    const res = await read(app, '/alice/tricky.html');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
  });
});
