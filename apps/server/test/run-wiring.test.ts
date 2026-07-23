/**
 * `runServer` member-mutation regression.
 *
 * The original test pinned the legacy `persistMembers` 501 gate: the
 * `csuite serve` CLI used to drop `configPath` from the runServer
 * options bag, which silently disabled the persistence callback and
 * caused every mutation endpoint to short-circuit with 501. That gate
 * is gone now — `MemberStore` mutations land transactionally in
 * SQLite at the call site.
 *
 * What stays worth pinning: a fresh `runServer({db: seeded.db})` boot
 * accepts `POST /members` and writes the new row through the
 * DB-backed store. If a future refactor accidentally short-circuits
 * mutations again, this test catches it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultHttpsConfig } from '../src/members.js';
import { type RunningServer, runServer } from '../src/run.js';
import { seedStores } from './helpers/test-stores.js';

const ADMIN_TOKEN = 'csuite_run_wiring_test_admin_token';

const TEAM = {
  name: 'demo-team',
  context: '',
};

const dirsToClean: string[] = [];
const serversToStop: RunningServer[] = [];

afterEach(async () => {
  for (const s of serversToStop.splice(0)) {
    await s.stop();
  }
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'csuite-run-wiring-'));
  dirsToClean.push(dir);
  return dir;
}

function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function bootHttp(): Promise<RunningServer> {
  const seeded = seedStores({
    team: TEAM,
    members: [
      {
        name: 'alice',
        role: { title: 'admin', description: '' },
        rawPermissions: ['members.manage'],
        permissions: ['members.manage'],
        token: ADMIN_TOKEN,
      },
    ],
  });
  const running = await runServer({
    db: seeded.db,
    https: { ...defaultHttpsConfig(), mode: 'off' },
    webPush: null,
    port: 0,
    host: '127.0.0.1',
    publicRoot: null,
    logger: silentLogger(),
  });
  serversToStop.push(running);
  return running;
}

async function postMember(running: RunningServer, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${running.port}/members`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('runServer member mutation', () => {
  it('200s POST /members and writes through to the DB-backed store', async () => {
    const running = await bootHttp();
    const res = await postMember(running, {
      name: 'newbie',
      role: { title: 'engineer', description: '' },
      permissions: [],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; member: { name: string } };
    expect(body.token).toMatch(/^csuite_/);
    expect(body.member.name).toBe('newbie');

    // Read it back through GET /members to confirm it's in the store.
    const list = await fetch(`http://127.0.0.1:${running.port}/members`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { members: Array<{ name: string }> };
    const names = listed.members.map((m) => m.name);
    expect(names).toContain('newbie');
  });
});

// `tmpDir` is no longer used by the boot path but kept around for any
// future test that wants a scratch dir for cert/file paths.
void tmpDir;
