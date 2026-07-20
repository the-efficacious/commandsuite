/**
 * `csuite connect` happy-path tests.
 *
 * Mocks fetch with a tiny scripted broker so the command exercises
 * its full flow without standing up a real server: mint → poll
 * (one pending) → poll (approved). Asserts the bearer token lands
 * in an isolated `auth.json` rather than the operator's real one.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'csuite-connect-'));
});

afterEach(() => {
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

    // auth.json was written at 0o600 with the token.
    const saved = JSON.parse(readFileSync(authPath, 'utf8')) as {
      schema: number;
      entries: Array<{ url: string; token: string }>;
    };
    expect(saved.schema).toBe(1);
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0]?.url).toBe('http://test-broker:8717');
    expect(saved.entries[0]?.token).toBe('csuite_freshly_minted_token');

    // The banner (or its quiet form) reaches stdout.
    const allOut = stdoutLines.join('\n');
    expect(allOut).toContain('KQ4M-7P2H');
    expect(allOut).toContain('approved');
    expect(allOut).toContain('engineer-1');
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
