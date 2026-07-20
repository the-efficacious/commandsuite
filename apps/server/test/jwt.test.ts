/**
 * JWT verifier tests.
 *
 * Stands up a real RS256 keypair, exports the public JWK on a tiny
 * loopback HTTP server, then verifies tokens minted with the matching
 * private key against `createJwtVerifier`. We exercise:
 *
 *   - happy path → returns the `member` + `sub` claims
 *   - wrong issuer / wrong audience → throws
 *   - expired / not-yet-valid → throws
 *   - missing `member` / missing `sub` → throws JwtClaimError
 *   - bad signature (signed by an unrelated key) → throws
 *   - structurally malformed token → throws
 *
 * The JWKS server runs on a random port and shuts down per-test so
 * the cache inside `jose` doesn't leak across cases. `looksLikeJwt`
 * gets its own pure-string suite.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJwtVerifier, JwtClaimError, looksLikeJwt } from '../src/jwt.js';

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
type SigningKey = KeyPair['privateKey'];
type VerifyingKey = KeyPair['publicKey'];

const ISSUER = 'https://issuer.test';
const AUDIENCE = 'team:demo';
const KID = 'test-key-1';

interface Harness {
  privateKey: SigningKey;
  publicKey: VerifyingKey;
  jwksUrl: string;
  server: Server;
}

async function startJwksServer(publicKey: VerifyingKey): Promise<{
  url: string;
  server: Server;
}> {
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const body = JSON.stringify({ keys: [jwk] });

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/.well-known/jwks.json`,
    server,
  };
}

async function setup(): Promise<Harness> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const { url, server } = await startJwksServer(publicKey);
  return { privateKey, publicKey, jwksUrl: url, server };
}

async function mint(
  privateKey: SigningKey,
  overrides: {
    iss?: string;
    aud?: string;
    sub?: string | null;
    member?: string | null;
    iat?: number;
    exp?: number;
    nbf?: number;
    role?: string;
  } = {},
): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (overrides.member !== null) claims.member = overrides.member ?? 'alice';
  if (overrides.role !== undefined) claims.role = overrides.role;
  const sub = overrides.sub === null ? undefined : (overrides.sub ?? 'oauth|alice@issuer');

  let signer = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? AUDIENCE)
    .setIssuedAt(overrides.iat)
    .setExpirationTime(overrides.exp ?? '5m');
  if (sub !== undefined) signer = signer.setSubject(sub);
  if (overrides.nbf !== undefined) signer = signer.setNotBefore(overrides.nbf);
  return signer.sign(privateKey);
}

describe('createJwtVerifier — happy path', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(() => {
    h.server.close();
  });

  it('returns member + subject for a well-formed token', async () => {
    const verifier = createJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: h.jwksUrl,
    });
    const token = await mint(h.privateKey, { member: 'alice', sub: 'oauth|123' });
    const claims = await verifier.verify(token);
    expect(claims.member).toBe('alice');
    expect(claims.subject).toBe('oauth|123');
    expect(claims.payload.iss).toBe(ISSUER);
    expect(claims.payload.aud).toBe(AUDIENCE);
  });

  it('exposes the raw payload to callers that want it', async () => {
    const verifier = createJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: h.jwksUrl,
    });
    const token = await mint(h.privateKey, { role: 'admin' });
    const claims = await verifier.verify(token);
    expect(claims.payload.role).toBe('admin');
  });
});

describe('createJwtVerifier — rejection paths', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(() => {
    h.server.close();
  });

  it('rejects a token from the wrong issuer', async () => {
    const verifier = createJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: h.jwksUrl,
    });
    const token = await mint(h.privateKey, { iss: 'https://attacker.example' });
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('rejects a token with the wrong audience', async () => {
    const verifier = createJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: h.jwksUrl,
    });
    const token = await mint(h.privateKey, { aud: 'team:other' });
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const verifier = createJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: h.jwksUrl,
    });
    // Issued an hour ago, expired half an hour ago.
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await mint(h.privateKey, { iat: nowSec - 3600, exp: nowSec - 1800 });
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('rejects a not-yet-valid token (nbf in the future)', async () => {
    const verifier = createJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: h.jwksUrl,
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await mint(h.privateKey, { nbf: nowSec + 3600 });
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('rejects when `member` claim is missing', async () => {
    const verifier = createJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: h.jwksUrl,
    });
    const token = await mint(h.privateKey, { member: null });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(JwtClaimError);
  });

  it('rejects when `member` claim is empty string', async () => {
    const verifier = createJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: h.jwksUrl,
    });
    const token = await mint(h.privateKey, { member: '' });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(JwtClaimError);
  });

  it('rejects when `sub` claim is missing', async () => {
    const verifier = createJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: h.jwksUrl,
    });
    const token = await mint(h.privateKey, { sub: null });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(JwtClaimError);
  });

  it('rejects a token signed by an unrelated key', async () => {
    const verifier = createJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: h.jwksUrl,
    });
    // Mint with a private key that doesn't match the published JWKS.
    const { privateKey: rogueKey } = await generateKeyPair('RS256');
    const token = await mint(rogueKey);
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('rejects a structurally malformed token', async () => {
    const verifier = createJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: h.jwksUrl,
    });
    await expect(verifier.verify('not.a.jwt')).rejects.toThrow();
    await expect(verifier.verify('eyJtb29i')).rejects.toThrow();
  });
});

describe('looksLikeJwt', () => {
  it('matches a 3-segment base64url string', () => {
    expect(looksLikeJwt('aaa.bbb.ccc')).toBe(true);
    expect(looksLikeJwt('eyJ0eXAiOiJKV1QifQ.eyJpc3MiOiJpIn0.sig-bytes')).toBe(true);
  });

  it('rejects opaque csuite tokens (no dots)', () => {
    expect(looksLikeJwt('csuite_abc123')).toBe(false);
    expect(looksLikeJwt('plain-string')).toBe(false);
  });

  it('rejects 2-segment or 4-segment strings', () => {
    expect(looksLikeJwt('a.b')).toBe(false);
    expect(looksLikeJwt('a.b.c.d')).toBe(false);
  });

  it('rejects strings with characters outside base64url', () => {
    expect(looksLikeJwt('a/a.b/b.c/c')).toBe(false);
    expect(looksLikeJwt('a+a.b+b.c+c')).toBe(false);
  });

  it('rejects empty segments', () => {
    expect(looksLikeJwt('a..c')).toBe(false);
    expect(looksLikeJwt('.b.c')).toBe(false);
    expect(looksLikeJwt('a.b.')).toBe(false);
  });
});
