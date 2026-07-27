/**
 * `csuite connect` happy-path tests.
 *
 * Mocks fetch with a tiny scripted broker so the command exercises
 * its full flow without standing up a real server: mint → poll
 * (one pending) → poll (approved). Asserts the bearer token lands
 * in an isolated `auth.json` rather than the operator's real one.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findAuthEntry } from '../../src/commands/auth-config.js';
import { runConnectCommand, UsageError } from '../../src/commands/connect.js';

interface ScriptedResponse {
  status: number;
  body: unknown;
}

function buildFetch(scripts: Map<string, ScriptedResponse[]>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname;
    const queue = scripts.get(path);
    if (!queue || queue.length === 0) {
      throw new Error(`unscripted fetch to ${path} (method ${init?.method ?? 'GET'})`);
    }
    const next = queue.shift();
    if (!next) {
      throw new Error(`fetch queue drained for ${path}`);
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

/**
 * The scripted broker for a successful enrollment: mint, one pending poll,
 * then approval handing back `token`.
 */
function approvingBroker(token: string, userCode: string): Map<string, ScriptedResponse[]> {
  const scripts = new Map<string, ScriptedResponse[]>();
  scripts.set('/enroll', [
    {
      status: 200,
      body: {
        deviceCode: `csuite-dc_${'D'.repeat(43)}`,
        userCode,
        verificationUri: '/enroll',
        verificationUriComplete: `/enroll?code=${userCode}`,
        expiresIn: 300,
        interval: 1,
      },
    },
  ]);
  scripts.set('/enroll/poll', [
    { status: 400, body: { error: 'authorization_pending' } },
    {
      status: 200,
      body: {
        token,
        tokenId: '99999999-8888-7777-6666-555555555555',
        member: {
          name: 'engineer-2',
          role: { title: 'engineer', description: '' },
          permissions: [],
        },
      },
    },
  ]);
  return scripts;
}

let sandbox: string;
let originalCwd: string;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'csuite-connect-')));
  originalCwd = process.cwd();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(sandbox, { recursive: true, force: true });
});

describe('csuite connect', () => {
  it('completes a happy-path enrollment and writes the token to auth.json', async () => {
    const authPath = join(sandbox, 'auth.json');
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const scripts = new Map<string, ScriptedResponse[]>();
    scripts.set('/enroll', [
      {
        status: 200,
        body: {
          deviceCode: `csuite-dc_${'A'.repeat(43)}`,
          userCode: 'KQ4M-7P2H',
          verificationUri: '/enroll',
          verificationUriComplete: '/enroll?code=KQ4M-7P2H',
          expiresIn: 300,
          // Speed up the test — 1-second interval still hits the
          // poll path normally; we provide enough scripted responses
          // for two iterations.
          interval: 1,
        },
      },
    ]);
    scripts.set('/enroll/poll', [
      { status: 400, body: { error: 'authorization_pending' } },
      {
        status: 200,
        body: {
          token: 'csuite_freshly_minted_token',
          tokenId: '11111111-2222-3333-4444-555555555555',
          member: {
            name: 'engineer-1',
            role: { title: 'engineer', description: '' },
            permissions: [],
          },
        },
      },
    ]);

    const fetchImpl = buildFetch(scripts);
    const result = await runConnectCommand(
      {
        url: 'http://test-broker:8717',
        authConfigPath: authPath,
        fetch: fetchImpl,
        // Test clock: any monotonic source works since we override
        // `interval=1` and the real timeout is bounded by sleep().
      },
      (line) => stdoutLines.push(line),
      (line) => stderrLines.push(line),
    );

    expect(result.token).toBe('csuite_freshly_minted_token');
    expect(result.tokenId).toBe('11111111-2222-3333-4444-555555555555');
    expect(result.member.name).toBe('engineer-1');

    // auth.json was written at 0o600 with the token, scoped to the cwd the
    // enrollment ran in (schema 2 — the global store with per-entry scope).
    const saved = JSON.parse(readFileSync(authPath, 'utf8')) as {
      schema: number;
      entries: Array<{ url: string; workspace: string | null; token: string }>;
    };
    expect(saved.schema).toBe(2);
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0]?.url).toBe('http://test-broker:8717');
    expect(saved.entries[0]?.token).toBe('csuite_freshly_minted_token');
    expect(saved.entries[0]?.workspace).toBe(realpathSync(process.cwd()));

    // The banner (or its quiet form) reaches stdout.
    const allOut = stdoutLines.join('\n');
    expect(allOut).toContain('KQ4M-7P2H');
    expect(allOut).toContain('approved');
    expect(allOut).toContain('engineer-1');
  }, 10_000);

  it('keeps the freshly minted token when a legacy store covers the same cwd', async () => {
    // The upgrade path: a project still holds `.csuite/auth.json` from
    // before the store went global. `connect` saves the new token scoped to
    // cwd and then folds the legacy store in — and the legacy store's
    // implicit workspace IS that same cwd, so both writes land on one
    // (url, workspace) key. The migration must not win.
    const workspace = join(sandbox, 'project');
    mkdirSync(join(workspace, '.csuite'), { recursive: true });
    writeFileSync(
      join(workspace, '.csuite', 'auth.json'),
      JSON.stringify({
        schema: 1,
        entries: [{ url: 'http://test-broker:8717', token: 'csuite_stale_token', savedAt: 1000 }],
      }),
    );
    const authPath = join(sandbox, 'global', 'auth.json');
    const stdoutLines: string[] = [];

    process.chdir(workspace);
    const result = await runConnectCommand(
      {
        url: 'http://test-broker:8717',
        authConfigPath: authPath,
        fetch: buildFetch(approvingBroker('csuite_freshly_minted_token', 'ZZ9X-1Q4T')),
      },
      (line) => stdoutLines.push(line),
      () => {},
    );

    expect(result.token).toBe('csuite_freshly_minted_token');
    // What a later command actually resolves from this directory — the
    // assertion the bug would have failed.
    expect(
      findAuthEntry('http://test-broker:8717', { cwd: workspace, path: authPath })?.token,
    ).toBe('csuite_freshly_minted_token');
    // And the operator is told the legacy file is superseded, not migrated.
    const allOut = stdoutLines.join('\n');
    expect(allOut).toContain('superseded');
    expect(allOut).not.toContain('csuite_stale_token');
  }, 10_000);

  it('surfaces RFC 8628 access_denied as a UsageError', async () => {
    const scripts = new Map<string, ScriptedResponse[]>();
    scripts.set('/enroll', [
      {
        status: 200,
        body: {
          deviceCode: `csuite-dc_${'B'.repeat(43)}`,
          userCode: 'AAAA-BBBB',
          verificationUri: '/enroll',
          verificationUriComplete: '/enroll?code=AAAA-BBBB',
          expiresIn: 300,
          interval: 1,
        },
      },
    ]);
    scripts.set('/enroll/poll', [
      {
        status: 400,
        body: { error: 'access_denied', errorDescription: 'unrecognized device' },
      },
    ]);

    await expect(
      runConnectCommand(
        {
          url: 'http://test-broker:8717',
          authConfigPath: join(sandbox, 'auth.json'),
          fetch: buildFetch(scripts),
          quiet: true,
        },
        () => {},
        () => {},
      ),
    ).rejects.toBeInstanceOf(UsageError);
  }, 5_000);

  it('surfaces expired_token as a UsageError', async () => {
    const scripts = new Map<string, ScriptedResponse[]>();
    scripts.set('/enroll', [
      {
        status: 200,
        body: {
          deviceCode: `csuite-dc_${'C'.repeat(43)}`,
          userCode: 'CCCC-DDDD',
          verificationUri: '/enroll',
          verificationUriComplete: '/enroll?code=CCCC-DDDD',
          expiresIn: 300,
          interval: 1,
        },
      },
    ]);
    scripts.set('/enroll/poll', [{ status: 400, body: { error: 'expired_token' } }]);

    await expect(
      runConnectCommand(
        {
          url: 'http://test-broker:8717',
          authConfigPath: join(sandbox, 'auth.json'),
          fetch: buildFetch(scripts),
          quiet: true,
        },
        () => {},
        () => {},
      ),
    ).rejects.toBeInstanceOf(UsageError);
  }, 5_000);
});
