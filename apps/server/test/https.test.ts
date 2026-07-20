/**
 * Phase 2 HTTPS surface: cert generation, persistence, hot reload,
 * and an end-to-end HTTP/2 boot test that actually TLS-handshakes
 * against a live runServer() instance.
 */

import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect as http2Connect } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker, InMemoryEventLog } from 'csuite-core';
import type { Team } from 'csuite-sdk/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { certExpiryMs, generateSelfSignedCert } from '../src/https/cert.js';
import { createHttp2ServerFactory } from '../src/https/server.js';
import { HttpsConfigError, loadCustomCert, loadOrGenerateSelfSigned } from '../src/https/store.js';
import { createMemberStore } from '../src/members.js';
import { type RunningServer, runServer } from '../src/run.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore, seedStores } from './helpers/test-stores.js';

const OP_TOKEN = 'csuite_https_test_operator_token';

const TEAM: Team = {
  name: 'demo-team',
  directive: 'Verify the HTTPS surface.',
  context: '',
  permissionPresets: {},
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
  const dir = mkdtempSync(join(tmpdir(), 'csuite-https-test-'));
  dirsToClean.push(dir);
  return dir;
}

// ─── cert.ts — generator + expiry parser ────────────────────────────

describe('generateSelfSignedCert', () => {
  it('produces a valid x509 cert with the expected default SANs', async () => {
    const { cert, key } = await generateSelfSignedCert();
    expect(cert).toContain('-----BEGIN CERTIFICATE-----');
    expect(key).toContain('-----BEGIN');
    const parsed = new X509Certificate(cert);
    // The subjectAltName string is comma-joined, format varies slightly
    // between Node versions. Just check that all three loopback entries
    // are present.
    expect(parsed.subjectAltName).toMatch(/localhost/);
    expect(parsed.subjectAltName).toMatch(/127\.0\.0\.1/);
  });

  it('adds a LAN IP SAN when requested', async () => {
    const { cert } = await generateSelfSignedCert({ lanIp: '192.168.100.55' });
    const parsed = new X509Certificate(cert);
    expect(parsed.subjectAltName).toMatch(/192\.168\.100\.55/);
  });

  it('honours a short validity window', async () => {
    const { cert } = await generateSelfSignedCert({ validityDays: 7 });
    const parsed = new X509Certificate(cert);
    const notAfter = Date.parse(parsed.validTo);
    const notBefore = Date.parse(parsed.validFrom);
    const days = Math.round((notAfter - notBefore) / (24 * 60 * 60 * 1000));
    expect(days).toBeGreaterThanOrEqual(6);
    expect(days).toBeLessThanOrEqual(8);
  });

  it('certExpiryMs parses a valid cert and returns null for garbage', async () => {
    const { cert } = await generateSelfSignedCert();
    expect(certExpiryMs(cert)).toBeGreaterThan(Date.now());
    expect(certExpiryMs('not a pem')).toBeNull();
  });
});

// ─── store.ts — persistence + regeneration ──────────────────────────

describe('loadOrGenerateSelfSigned', () => {
  it('creates a cert on first call and reuses it on the second', async () => {
    const configDir = tmpDir();
    const first = await loadOrGenerateSelfSigned({
      configDir,
      validityDays: 365,
      regenerateIfExpiringWithin: 30,
    });
    expect(first.source).toBe('self-signed:fresh');
    expect(first.certPath).toContain('certs/server.crt');
    // File was written with restrictive mode.
    const mode = statSync(first.certPath as string).mode & 0o777;
    expect(mode).toBe(0o600);
    const keyMode = statSync(first.keyPath as string).mode & 0o777;
    expect(keyMode).toBe(0o600);

    const second = await loadOrGenerateSelfSigned({
      configDir,
      validityDays: 365,
      regenerateIfExpiringWithin: 30,
    });
    expect(second.source).toBe('self-signed:reused');
    expect(second.cert).toBe(first.cert);
  });

  it('regenerates when the existing cert is near expiry', async () => {
    const configDir = tmpDir();
    // Generate a cert valid only 5 days, then ask for a 30-day
    // renewal window — should regen.
    const first = await loadOrGenerateSelfSigned({
      configDir,
      validityDays: 5,
      regenerateIfExpiringWithin: 30,
    });
    expect(first.source).toBe('self-signed:fresh');

    const second = await loadOrGenerateSelfSigned({
      configDir,
      validityDays: 365,
      regenerateIfExpiringWithin: 30,
    });
    expect(second.source).toBe('self-signed:fresh');
    expect(second.cert).not.toBe(first.cert);
  });

  it('regenerates when the existing cert file is unparsable', async () => {
    const configDir = tmpDir();
    const first = await loadOrGenerateSelfSigned({
      configDir,
      validityDays: 365,
      regenerateIfExpiringWithin: 30,
    });
    // Corrupt the cert file.
    writeFileSync(first.certPath as string, 'not a real pem');
    const second = await loadOrGenerateSelfSigned({
      configDir,
      validityDays: 365,
      regenerateIfExpiringWithin: 30,
    });
    expect(second.source).toBe('self-signed:fresh');
    expect(second.cert).not.toBe('not a real pem');
  });
});

describe('loadCustomCert', () => {
  it('reads a user-supplied cert + key', async () => {
    const dir = tmpDir();
    const { cert, key } = await generateSelfSignedCert();
    const certPath = join(dir, 'my.crt');
    const keyPath = join(dir, 'my.key');
    writeFileSync(certPath, cert);
    writeFileSync(keyPath, key);
    const loaded = loadCustomCert({ certPath, keyPath });
    expect(loaded.cert).toBe(cert);
    expect(loaded.source).toBe('custom');
    expect(loaded.expiresAt).toBeGreaterThan(Date.now());
  });

  it('throws HttpsConfigError on missing files', () => {
    const dir = tmpDir();
    expect(() =>
      loadCustomCert({ certPath: join(dir, 'nope.crt'), keyPath: join(dir, 'nope.key') }),
    ).toThrow(HttpsConfigError);
  });
});

// ─── server.ts — SNICallback hot reload ─────────────────────────────

describe('createHttp2ServerFactory', () => {
  it('exposes createServer + serverOptions + reloadCert', async () => {
    const { cert, key } = await generateSelfSignedCert();
    const factory = createHttp2ServerFactory({ cert, key });
    expect(typeof factory.createServer).toBe('function');
    expect(factory.serverOptions.cert).toBe(cert);
    expect(factory.serverOptions.key).toBe(key);
    expect(factory.serverOptions.allowHTTP1).toBe(true);
    expect(typeof factory.serverOptions.SNICallback).toBe('function');
    expect(typeof factory.reloadCert).toBe('function');
  });

  it('reloadCert swaps the context that SNICallback returns', async () => {
    const a = await generateSelfSignedCert();
    const b = await generateSelfSignedCert();
    const factory = createHttp2ServerFactory({ cert: a.cert, key: a.key });

    const sniCallback = factory.serverOptions.SNICallback as (
      servername: string,
      cb: (err: Error | null, ctx?: unknown) => void,
    ) => void;

    const beforeCtx = await new Promise<unknown>((resolve) => {
      sniCallback('localhost', (_err, ctx) => resolve(ctx));
    });

    factory.reloadCert(b.cert, b.key);

    const afterCtx = await new Promise<unknown>((resolve) => {
      sniCallback('localhost', (_err, ctx) => resolve(ctx));
    });

    // Different SecureContext instances pre- and post-reload.
    expect(afterCtx).not.toBe(beforeCtx);
    // Both non-null.
    expect(beforeCtx).toBeTruthy();
    expect(afterCtx).toBeTruthy();
  });
});

// ─── app.ts secureCookies flag ──────────────────────────────────────

describe('secureCookies option', () => {
  it('sets Secure on session cookies when enabled', async () => {
    const members = createMemberStore([
      {
        name: 'director-1',
        role: { title: 'director', description: '' },
        permissions: ['members.manage'],
        token: OP_TOKEN,
        totpSecret: 'JBSWY3DPEHPK3PXP',
      },
    ]);
    const broker = new Broker({
      eventLog: new InMemoryEventLog(),
      now: () => 1_700_000_000_000,
      idFactory: () => 'msg-fixed',
    });
    const db = openDatabase(':memory:');
    const sessions = new SessionStore(db);
    const tokens = createTokenStoreFromMembers(db, members);
    // Dynamically import TOTP helpers so we don't ship them into
    // the stable part of the test fixtures.
    const { currentCode } = await import('../src/totp.js');
    const now = 1_700_000_000_000;
    const code = currentCode('JBSWY3DPEHPK3PXP', now);

    const { app } = createApp({
      broker,
      members,
      tokens,
      sessions,
      teamStore: mockTeamStore(TEAM),

      version: '0.0.0',
      secureCookies: true,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => now,
    });

    const res = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'director-1', code }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/i);
  });
});

// ─── runServer end-to-end HTTPS ─────────────────────────────────────

describe('runServer with self-signed HTTPS', () => {
  function seedAdmin() {
    return seedStores({
      team: TEAM,
      members: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          rawPermissions: ['members.manage'],
          permissions: ['members.manage'],
          token: OP_TOKEN,
        },
      ],
    });
  }

  const SELF_SIGNED_HTTPS = {
    mode: 'self-signed' as const,
    bindHttp: 0,
    bindHttps: 0,
    redirectHttpToHttps: false,
    hsts: 'off' as const,
    selfSigned: { lanIp: null, validityDays: 365, regenerateIfExpiringWithin: 30 },
    custom: { certPath: null, keyPath: null },
  };

  it('boots on HTTP/2 and responds to /healthz', async () => {
    const configDir = tmpDir();
    const seeded = seedAdmin();
    const running = await runServer({
      db: seeded.db,
      https: SELF_SIGNED_HTTPS,
      configDir,
      host: '127.0.0.1',
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    serversToStop.push(running);

    expect(running.protocol).toBe('https');
    expect(running.port).toBeGreaterThan(0);

    const client = http2Connect(`https://127.0.0.1:${running.port}`, {
      rejectUnauthorized: false,
    });
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = client.request({ ':method': 'GET', ':path': '/healthz' });
        let buf = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
          buf += chunk;
        });
        req.on('end', () => resolve(buf));
        req.on('error', reject);
        req.end();
      });
      const parsed = JSON.parse(body) as { status: string; version: string };
      expect(parsed.status).toBe('ok');
    } finally {
      client.close();
    }
  });

  it('persists the cert to <configDir>/certs/ so a restart reuses it', async () => {
    const configDir = tmpDir();
    const certPath = join(configDir, 'certs', 'server.crt');

    // First boot: generates + persists.
    const s1 = seedAdmin();
    const r1 = await runServer({
      db: s1.db,
      https: SELF_SIGNED_HTTPS,
      configDir,
      host: '127.0.0.1',
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await r1.stop();
    const cert1 = readFileSync(certPath, 'utf8');
    expect(cert1).toContain('-----BEGIN CERTIFICATE-----');

    // Second boot: reuses.
    const s2 = seedAdmin();
    const r2 = await runServer({
      db: s2.db,
      https: SELF_SIGNED_HTTPS,
      configDir,
      host: '127.0.0.1',
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    serversToStop.push(r2);
    const cert2 = readFileSync(certPath, 'utf8');
    expect(cert2).toBe(cert1);
  });
});
