/**
 * Tests for `csuite serve` option construction.
 *
 * Regression for the seam-class bug where `serve.ts` constructed a
 * `runServer` options bag without `configPath` (and other TeamConfig
 * fields), causing every member-mutation endpoint — including the
 * "create new member" branch of `/enroll/approve` that the web UI
 * hits during enrollment approval — to short-circuit with 501.
 *
 * The unit checks here pin the option-construction contract; an
 * end-to-end integration check lives in the server suite at
 * `apps/server/test/serve-wiring.test.ts` and asserts the wired
 * options actually produce a working server.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServeRunOptions, runServeCommand } from '../../src/commands/serve.js';

async function pickFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const HTTPS = {
  mode: 'off' as const,
  bindHttp: 8717,
  bindHttps: 7443,
  redirectHttpToHttps: true,
  hsts: 'auto' as const,
  selfSigned: { lanIp: null, validityDays: 365, regenerateIfExpiringWithin: 30 },
  custom: { certPath: null, keyPath: null },
};

function baseConfig(overrides: Partial<Parameters<typeof buildServeRunOptions>[0]['config']> = {}) {
  return {
    dbPath: null,
    activityDbPath: null,
    filesRoot: null,
    https: HTTPS,
    webPush: null,
    jwt: null,
    files: null,
    ...overrides,
  };
}

describe('buildServeRunOptions — translates ServerConfig to runServer options', () => {
  it('forwards configPath verbatim (used by VAPID auto-gen write-back)', () => {
    const opts = buildServeRunOptions({
      config: baseConfig(),
      configPath: '/tmp/whatever/csuite.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect(opts.configPath).toBe('/tmp/whatever/csuite.json');
  });

  it('derives configDir from configPath', () => {
    const opts = buildServeRunOptions({
      config: baseConfig(),
      configPath: '/etc/csuite/team.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect(opts.configDir).toBe('/etc/csuite');
  });

  it('forwards https when present, omits when null', () => {
    const wired = buildServeRunOptions({
      config: baseConfig({ https: { ...HTTPS, mode: 'self-signed' } }),
      configPath: '/x/csuite.json',
      port: 8717,
      host: '0.0.0.0',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect(wired.https?.mode).toBe('self-signed');

    const omitted = buildServeRunOptions({
      config: baseConfig({ https: null }),
      configPath: '/x/csuite.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect('https' in omitted).toBe(false);
  });

  it('forwards webPush only when present (absence signals "let runServer decide")', () => {
    const omitted = buildServeRunOptions({
      config: baseConfig({ webPush: null }),
      configPath: '/x/csuite.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect('webPush' in omitted).toBe(false);

    const wired = buildServeRunOptions({
      config: baseConfig({
        webPush: {
          vapidPublicKey: 'pub',
          vapidPrivateKey: 'priv',
          vapidSubject: 'mailto:x@y',
        },
      }),
      configPath: '/x/csuite.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect(wired.webPush?.vapidPublicKey).toBe('pub');
  });

  it('forwards jwt only when present', () => {
    const omitted = buildServeRunOptions({
      config: baseConfig({ jwt: null }),
      configPath: '/x/csuite.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect('jwt' in omitted).toBe(false);

    const wired = buildServeRunOptions({
      config: baseConfig({
        jwt: {
          issuer: 'https://issuer.test',
          jwksUrl: 'https://issuer.test/.well-known/jwks.json',
          audience: 'team:demo',
        },
      }),
      configPath: '/x/csuite.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect(wired.jwt?.issuer).toBe('https://issuer.test');
  });

  it('forwards filesRoot + maxFileSize from config.files when present', () => {
    const opts = buildServeRunOptions({
      config: baseConfig({
        files: { root: '/var/csuite/files', maxFileSize: 12345 },
      }),
      configPath: '/x/csuite.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect(opts.filesRoot).toBe('/var/csuite/files');
    expect(opts.maxFileSize).toBe(12345);
  });

  it('omits filesRoot + maxFileSize when files is null', () => {
    const opts = buildServeRunOptions({
      config: baseConfig({ files: null }),
      configPath: '/x/csuite.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect('filesRoot' in opts).toBe(false);
    expect('maxFileSize' in opts).toBe(false);
  });

  it('passes through port, host, dbPath, onListen', () => {
    const onListen = () => {};
    const opts = buildServeRunOptions({
      config: baseConfig(),
      configPath: '/x/csuite.json',
      port: 9001,
      host: '0.0.0.0',
      dbPath: '/tmp/csuite.db',
      onListen,
    });
    expect(opts.port).toBe(9001);
    expect(opts.host).toBe('0.0.0.0');
    expect(opts.dbPath).toBe('/tmp/csuite.db');
    expect(opts.onListen).toBe(onListen);
  });
});

// ─── end-to-end: runServeCommand → real server → POST /members ────

const dirsToClean: string[] = [];

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpServeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'csuite-serve-e2e-'));
  dirsToClean.push(dir);
  return dir;
}

const ADMIN_TOKEN = 'csuite_serve_e2e_admin_token';

function seedConfig(dir: string): string {
  const configPath = join(dir, 'csuite.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      team: {
        name: 'demo',
        context: '',
        permissionPresets: {},
      },
      members: [
        {
          name: 'alice',
          role: { title: 'admin', description: '' },
          permissions: ['members.manage'],
          // Real plaintext token — `loadTeamConfigFromFile` accepts
          // the `token` field on first load and replaces it with
          // `tokenHash` on disk, so we can authenticate live.
          token: ADMIN_TOKEN,
        },
      ],
    }),
  );
  return configPath;
}

// TODO(db-migration): rewrite this regression for the DB-backed model.
// The original test pinned the persistMembers 501 gate, which doesn't
// exist anymore. The replacement should seed a SQLite DB, point
// runServeCommand at it, and assert the live POST /members write
// lands in the DB rather than relying on the JSON file.
describe.skip('runServeCommand → live server (regression for the published-CLI bug)', () => {
  it('boots and accepts POST /members — fails 501 before the configPath fix', async () => {
    const dir = tmpServeDir();
    const configPath = seedConfig(dir);
    const port = await pickFreePort();
    const running = await runServeCommand(
      {
        configPath,
        port,
        host: '127.0.0.1',
        dbPath: ':memory:',
      },
      () => {},
    );
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/members`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'newbie',
          role: { title: 'engineer', description: '' },
          permissions: [],
        }),
      });
      // The bug shipped: this used to return 501 "member creation is
      // not available (persistMembers missing)". After the fix:
      // serve.ts threads configPath → runServer wires persistMembers
      // → POST /members works.
      expect(res.status).toBe(200);
    } finally {
      await running.stop();
    }
  }, 15_000);
});
