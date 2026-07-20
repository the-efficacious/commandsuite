/**
 * Phase 1 auth surface: TOTP verification, session cookies, dual-auth.
 *
 * These tests exercise the new /session/* routes end-to-end through
 * the Hono app, plus the TOTP + SessionStore primitives directly.
 * Existing /roster identity/auth coverage lives in app.test.ts; this
 * file is focused on what's new.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Broker, InMemoryEventLog } from 'csuite-core';
import type { SessionResponse, Team } from 'csuite-sdk/types';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createJwtVerifier, type JwtConfig } from '../src/jwt.js';
import { createMemberStore } from '../src/members.js';
import { SESSION_COOKIE_NAME, SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { currentCode, generateSecret, verifyCode } from '../src/totp.js';
import { mockTeamStore } from './helpers/test-stores.js';

const OP_TOKEN = 'csuite_auth_test_operator_token';
const BOT_TOKEN = 'csuite_auth_test_bot_token';

const TEAM: Team = {
  name: 'demo-team',
  directive: 'Verify the auth surface.',
  context: '',
  permissionPresets: {},
};

/** Minimum helpers — each test gets its own app instance, no shared state. */
function makeApp(options: { now?: () => number; totpSecret?: string } = {}) {
  const secret = options.totpSecret ?? generateSecret();
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: () => 'msg-fixed',
  });
  const members = createMemberStore([
    {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      token: OP_TOKEN,
      totpSecret: secret,
    },
    {
      name: 'build-bot',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: BOT_TOKEN,
    },
  ]);
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db, { now: options.now });
  const tokens = createTokenStoreFromMembers(db, members, { now: options.now });
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    now: options.now,
  });
  return { app, members, sessions, tokens, secret };
}

function cookieFrom(res: Response): string | null {
  const sc = res.headers.get('set-cookie');
  if (!sc) return null;
  // Parse the first `name=value` pair from the header. Hono may serialize
  // multiple cookies into one header separated by ',' — for our tests we
  // only ever set one at a time so a simple match is enough.
  const match = sc.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  return match ? (match[1] ?? null) : null;
}

// ─── TOTP primitive ─────────────────────────────────────────────────

describe('verifyCode', () => {
  it('accepts the current code and returns a counter', () => {
    const secret = generateSecret();
    const now = 1_700_000_000_000;
    const code = currentCode(secret, now);
    const result = verifyCode(secret, code, 0, now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Counter is floor(now/1000/30). At time 1_700_000_000 that's
      // 56_666_666.
      expect(result.counter).toBe(Math.floor(now / 1000 / 30));
    }
  });

  it('rejects the same code used twice (replay guard)', () => {
    const secret = generateSecret();
    const now = 1_700_000_000_000;
    const code = currentCode(secret, now);
    const first = verifyCode(secret, code, 0, now);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = verifyCode(secret, code, first.counter, now);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('replay');
    }
  });

  it('rejects a wrong 6-digit code', () => {
    const secret = generateSecret();
    const result = verifyCode(secret, '000000', 0);
    // There's a tiny chance "000000" happens to be valid for the current
    // period; re-roll the secret once if that happens rather than
    // special-casing the tolerance.
    if (result.ok) {
      const secret2 = generateSecret();
      const retry = verifyCode(secret2, '000000', 0);
      expect(retry.ok).toBe(false);
    } else {
      expect(result.reason).toBe('invalid');
    }
  });

  it('rejects malformed codes (not 6 digits)', () => {
    const secret = generateSecret();
    expect(verifyCode(secret, '12345', 0).ok).toBe(false);
    expect(verifyCode(secret, '1234567', 0).ok).toBe(false);
    expect(verifyCode(secret, 'abcdef', 0).ok).toBe(false);
  });
});

// ─── Session store ──────────────────────────────────────────────────

describe('SessionStore', () => {
  it('creates, looks up, touches, and deletes sessions', () => {
    const db = openDatabase(':memory:');
    const store = new SessionStore(db);
    const created = store.create('director-1', 'test-ua');
    expect(created.memberName).toBe('director-1');

    const found = store.get(created.id);
    expect(found?.memberName).toBe('director-1');

    store.touch(created.id);
    const touched = store.get(created.id);
    expect(touched).not.toBeNull();
    if (touched) expect(touched.lastSeen).toBeGreaterThanOrEqual(created.lastSeen);

    store.delete(created.id);
    expect(store.get(created.id)).toBeNull();
  });

  it('treats expired sessions as missing and purges them', () => {
    let clock = 1_000_000;
    const db = openDatabase(':memory:');
    const store = new SessionStore(db, { now: () => clock });
    const created = store.create('director-1', null);
    // Jump past the 7d TTL.
    clock += 8 * 24 * 60 * 60 * 1000;
    expect(store.get(created.id)).toBeNull();
    expect(store.purgeExpired()).toBe(1);
  });
});

// ─── /session/totp — login flow ─────────────────────────────────────

describe('POST /session/totp', () => {
  it('issues a session cookie for a valid code and lets subsequent cookie-auth requests succeed', async () => {
    const now = 1_700_000_000_000;
    const { app, secret } = makeApp({ now: () => now });
    const code = currentCode(secret, now);

    const res = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member: 'director-1', code }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionResponse;
    expect(body.member).toBe('director-1');
    expect(body.role.title).toBe('director');
    expect(body.expiresAt).toBeGreaterThan(now);

    const cookie = cookieFrom(res);
    expect(cookie).toBeTruthy();
    if (!cookie) return;

    // Cookie-auth request works.
    const rosterRes = await app.request('/roster', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(rosterRes.status).toBe(200);
  });

  it('rejects the same code used twice (replay guard)', async () => {
    const now = 1_700_000_000_000;
    const { app, secret } = makeApp({ now: () => now });
    const code = currentCode(secret, now);

    const first = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member: 'director-1', code }),
    });
    expect(first.status).toBe(200);

    const second = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member: 'director-1', code }),
    });
    expect(second.status).toBe(401);
  });

  it('rejects an unknown/unenrolled slot with the same error shape (no enumeration)', async () => {
    const now = 1_700_000_000_000;
    const { app } = makeApp({ now: () => now });

    // build-bot has no TOTP enrollment; ghost doesn't exist at all.
    // Both should look identical to the caller.
    const botRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'build-bot', code: '000000' }),
    });
    const ghostRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'ghost', code: '000000' }),
    });
    expect(botRes.status).toBe(401);
    expect(ghostRes.status).toBe(401);
    const botBody = (await botRes.json()) as { error: string };
    const ghostBody = (await ghostRes.json()) as { error: string };
    expect(botBody.error).toBe(ghostBody.error);
  });

  it('400s on malformed login payload', async () => {
    const { app } = makeApp();
    const res = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member: 'director-1', code: 'abc' }),
    });
    expect(res.status).toBe(400);
  });

  it('locks out a slot after 5 failed attempts and clears on success', async () => {
    let clock = 1_700_000_000_000;
    const { app, secret } = makeApp({ now: () => clock });

    for (let i = 0; i < 5; i++) {
      const res = await app.request('/session/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member: 'director-1', code: '000000' }),
      });
      expect(res.status).toBe(401);
    }

    // 6th attempt — now locked out regardless of code correctness.
    const lockedRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member: 'director-1', code: currentCode(secret, clock) }),
    });
    expect(lockedRes.status).toBe(429);

    // Jump past the 15-minute window.
    clock += 16 * 60 * 1000;
    const recoveredRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member: 'director-1', code: currentCode(secret, clock) }),
    });
    expect(recoveredRes.status).toBe(200);
  });
});

// ─── /session/logout and /session ───────────────────────────────────

describe('session lifecycle', () => {
  it('logs out: cookie becomes invalid, subsequent requests 401', async () => {
    const now = 1_700_000_000_000;
    const { app, secret } = makeApp({ now: () => now });
    const code = currentCode(secret, now);

    const loginRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member: 'director-1', code }),
    });
    const cookie = cookieFrom(loginRes);
    expect(cookie).toBeTruthy();
    if (!cookie) return;

    const logoutRes = await app.request('/session/logout', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(logoutRes.status).toBe(204);

    // Cookie is now stale server-side.
    const afterRes = await app.request('/roster', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(afterRes.status).toBe(401);
  });

  it('GET /session returns the current slot/role/expiresAt', async () => {
    const now = 1_700_000_000_000;
    const { app, secret } = makeApp({ now: () => now });
    const loginRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member: 'director-1', code: currentCode(secret, now) }),
    });
    const cookie = cookieFrom(loginRes);
    if (!cookie) return;

    const sessionRes = await app.request('/session', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(sessionRes.status).toBe(200);
    const body = (await sessionRes.json()) as SessionResponse;
    expect(body.member).toBe('director-1');
    expect(body.role.title).toBe('director');
    expect(body.expiresAt).toBeGreaterThan(now);
  });
});

// ─── Dual-auth middleware ───────────────────────────────────────────

describe('dual auth (bearer OR cookie)', () => {
  it('accepts /roster with bearer token', async () => {
    const { app } = makeApp();
    const res = await app.request('/roster', {
      headers: { Authorization: `Bearer ${OP_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('accepts /roster with session cookie', async () => {
    const now = 1_700_000_000_000;
    const { app, secret } = makeApp({ now: () => now });
    const loginRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member: 'director-1', code: currentCode(secret, now) }),
    });
    const cookie = cookieFrom(loginRes);
    if (!cookie) return;

    const res = await app.request('/roster', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects /roster with no credentials at all', async () => {
    const { app } = makeApp();
    const res = await app.request('/roster');
    expect(res.status).toBe(401);
  });

  it('rejects /roster with a stale cookie even if the session was valid before', async () => {
    const now = 1_700_000_000_000;
    const { app, sessions, secret } = makeApp({ now: () => now });

    const loginRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member: 'director-1', code: currentCode(secret, now) }),
    });
    const cookie = cookieFrom(loginRes);
    if (!cookie) return;

    // Forcibly delete the session server-side to simulate logout-from-
    // another-device or the purge job running.
    sessions.delete(cookie);

    const res = await app.request('/roster', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    // Distinct error so the SPA can tell "no cookie" from "stale cookie".
    expect(body.error).toBe('session expired');
  });

  it('cookie-auth on /subscribe still enforces to === name', async () => {
    const now = 1_700_000_000_000;
    const { app, secret } = makeApp({ now: () => now });
    const loginRes = await app.request('/session/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member: 'director-1', code: currentCode(secret, now) }),
    });
    const cookie = cookieFrom(loginRes);
    if (!cookie) return;

    const res = await app.request('/subscribe?name=build-bot', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(res.status).toBe(403);
  });
});

// ─── Federated JWT auth (Phase 4) ───────────────────────────────────
//
// Hermetic: we generate an RS256 keypair in the test, serve the
// public JWK from an ephemeral HTTP server, build a verifier against
// that server's /.well-known/jwks.json, and mint tokens with the
// private key. No network, no fixtures — each test round-trip runs
// fully in-process.

const ISSUER = 'http://test-issuer.local';
const AUDIENCE = 'team:demo-team-id';

type GeneratedPrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

interface JwtFixture {
  config: JwtConfig;
  privateKey: GeneratedPrivateKey;
  publicJwk: JWK;
  kid: string;
  jwksServer: Server;
  close: () => Promise<void>;
}

async function bootJwksFixture(): Promise<JwtFixture> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  // Minimal JWKS HTTP server. Listens on port 0 so parallel test runs
  // don't fight over a fixed port.
  const jwksServer = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const addr = jwksServer.address() as AddressInfo;
  const jwksUrl = `http://127.0.0.1:${addr.port}/.well-known/jwks.json`;

  return {
    config: { issuer: ISSUER, audience: AUDIENCE, jwksUrl },
    privateKey,
    publicJwk,
    kid,
    jwksServer,
    close: () => new Promise<void>((resolve) => jwksServer.close(() => resolve())),
  };
}

interface MintOptions {
  member?: string;
  sub?: string;
  issuer?: string;
  audience?: string;
  /** Seconds-from-now expiry. Negative = already expired. */
  expSeconds?: number;
}

async function mintTestToken(
  privateKey: GeneratedPrivateKey,
  kid: string,
  options: MintOptions = {},
): Promise<string> {
  const member = options.member ?? 'director-1';
  const sub = options.sub ?? 'user_abc123';
  const issuer = options.issuer ?? ISSUER;
  const audience = options.audience ?? AUDIENCE;
  const expSeconds = options.expSeconds ?? 300;
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ member })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt(nowSec)
    .setNotBefore(nowSec)
    .setExpirationTime(nowSec + expSeconds)
    .sign(privateKey);
}

function makeJwtApp(fixture: JwtFixture) {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: () => 'msg-fixed',
  });
  const members = createMemberStore([
    {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      token: OP_TOKEN,
    },
    {
      name: 'build-bot',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: BOT_TOKEN,
    },
  ]);
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    jwt: createJwtVerifier(fixture.config),
  });
  return { app, members };
}

describe('JWT auth (federated)', () => {
  let fixture: JwtFixture;

  beforeAll(async () => {
    fixture = await bootJwksFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it('accepts a well-formed JWT and resolves to the named member', async () => {
    const { app } = makeJwtApp(fixture);
    const token = await mintTestToken(fixture.privateKey, fixture.kid, {
      member: 'director-1',
    });

    const res = await app.request('/roster', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a JWT whose `member` claim names no one on the roster', async () => {
    const { app } = makeJwtApp(fixture);
    const token = await mintTestToken(fixture.privateKey, fixture.kid, {
      member: 'ghost-member',
    });

    const res = await app.request('/roster', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unknown member');
  });

  it('rejects a JWT with a wrong issuer', async () => {
    const { app } = makeJwtApp(fixture);
    const token = await mintTestToken(fixture.privateKey, fixture.kid, {
      issuer: 'http://not-the-issuer.local',
    });

    const res = await app.request('/roster', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid jwt');
  });

  it('rejects a JWT with a wrong audience', async () => {
    const { app } = makeJwtApp(fixture);
    const token = await mintTestToken(fixture.privateKey, fixture.kid, {
      audience: 'team:some-other-team',
    });

    const res = await app.request('/roster', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects an expired JWT', async () => {
    const { app } = makeJwtApp(fixture);
    const token = await mintTestToken(fixture.privateKey, fixture.kid, {
      expSeconds: -60,
    });

    const res = await app.request('/roster', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a JWT with a tampered signature', async () => {
    const { app } = makeJwtApp(fixture);
    const token = await mintTestToken(fixture.privateKey, fixture.kid);
    // Swap the first char of the signature segment — base64url's final
    // char has "don't care" low bits for sig-length-256, so flipping
    // the head is the safest poison. The header + payload round-trip
    // unchanged, so the only thing `verify` can reject on is the
    // signature itself.
    const [header, payload, sig] = token.split('.') as [string, string, string];
    const firstChar = sig[0] ?? 'A';
    const swapped = firstChar === 'A' ? 'B' : 'A';
    const tampered = `${header}.${payload}.${swapped}${sig.slice(1)}`;

    const res = await app.request('/roster', {
      headers: { Authorization: `Bearer ${tampered}` },
    });
    expect(res.status).toBe(401);
  });

  it('falls through to the opaque bearer path for non-JWT tokens', async () => {
    // With JWT config active, an opaque csuite_ token still works — the
    // structural check filters it out before verify runs.
    const { app } = makeJwtApp(fixture);
    const res = await app.request('/roster', {
      headers: { Authorization: `Bearer ${OP_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('does NOT fall back to opaque lookup when a structurally-valid JWT fails verify', async () => {
    // A forged JWT should 401, not leak into the opaque-token path.
    // Even if an attacker's forged JWT happens to collide with a valid
    // opaque token (pathological), it must still hard-fail here.
    const { app } = makeJwtApp(fixture);
    const forged = 'aaaa.bbbb.cccc'; // well-formed structure, garbage contents
    const res = await app.request('/roster', {
      headers: { Authorization: `Bearer ${forged}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid jwt');
  });

  it('rejects a JWT missing the `member` claim', async () => {
    const { app } = makeJwtApp(fixture);
    // Mint without the member claim by hand.
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: fixture.kid, typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('user_abc123')
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 300)
      .sign(fixture.privateKey);

    const res = await app.request('/roster', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid jwt');
  });
});
