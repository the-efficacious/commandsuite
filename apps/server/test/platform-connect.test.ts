/**
 * Platform pairing-code handshake on the server side.
 *
 * Covers the three-endpoint contract:
 *   - POST /platform-connect/bind (auth-required) stores a code→member binding
 *   - GET /platform-connect/lookup?code=X (public) returns the bound member
 *     exactly once, then the binding is consumed
 *   - Expired bindings get swept before lookup
 *
 * The platform calls /lookup over HTTPS right after the user confirms
 * in their browser; the single-use semantic keeps a stale retry from
 * re-binding. The auth requirement on /bind is what closes the
 * impersonation hole — the csuite server is authoritative for who the
 * caller is.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import type { Team } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const OP_TOKEN = 'csuite_platform_connect_op_token';

const TEAM: Team = {
  name: 'demo-team',
  directive: 'Exercise the platform-connect handshake.',
  context: '',
  permissionPresets: {},
};

function makeApp(options: { now?: () => number } = {}) {
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
  return { app };
}

describe('POST /platform-connect/bind', () => {
  it('binds a code to the authenticated member', async () => {
    const { app } = makeApp();
    const res = await app.request('/platform-connect/bind', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OP_TOKEN}`,
      },
      body: JSON.stringify({ code: 'ABCD1234' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; memberName: string };
    expect(body.ok).toBe(true);
    expect(body.memberName).toBe('director-1');
  });

  it('rejects unauthenticated callers', async () => {
    const { app } = makeApp();
    const res = await app.request('/platform-connect/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABCD1234' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects missing or oversized code', async () => {
    const { app } = makeApp();
    const empty = await app.request('/platform-connect/bind', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OP_TOKEN}`,
      },
      body: JSON.stringify({ code: '' }),
    });
    expect(empty.status).toBe(400);

    const oversized = await app.request('/platform-connect/bind', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OP_TOKEN}`,
      },
      body: JSON.stringify({ code: 'X'.repeat(100) }),
    });
    expect(oversized.status).toBe(400);
  });
});

describe('GET /platform-connect/lookup', () => {
  it('returns the bound memberName, then 404s on replay', async () => {
    const { app } = makeApp();
    // Bind first.
    const bind = await app.request('/platform-connect/bind', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OP_TOKEN}`,
      },
      body: JSON.stringify({ code: 'LOOKUP12' }),
    });
    expect(bind.status).toBe(200);

    // First lookup returns the bound member.
    const first = await app.request('/platform-connect/lookup?code=LOOKUP12');
    expect(first.status).toBe(200);
    const body = (await first.json()) as { memberName: string };
    expect(body.memberName).toBe('director-1');

    // Second lookup fails — single-use consumed on read.
    const second = await app.request('/platform-connect/lookup?code=LOOKUP12');
    expect(second.status).toBe(404);
  });

  it('returns 404 for unknown codes', async () => {
    const { app } = makeApp();
    const res = await app.request('/platform-connect/lookup?code=NEVERMINTED');
    expect(res.status).toBe(404);
  });

  it('requires the code query param', async () => {
    const { app } = makeApp();
    const res = await app.request('/platform-connect/lookup');
    expect(res.status).toBe(400);
  });

  it('does not require authentication (platform calls this server-to-server)', async () => {
    const { app } = makeApp();
    // Bind with auth; look up without.
    await app.request('/platform-connect/bind', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OP_TOKEN}`,
      },
      body: JSON.stringify({ code: 'NOAUTHCH' }),
    });
    const res = await app.request('/platform-connect/lookup?code=NOAUTHCH');
    expect(res.status).toBe(200);
  });
});

describe('TTL', () => {
  it('sweeps expired bindings before lookup', async () => {
    // Freeze time at T=1000, bind, then jump forward past the 10-min TTL.
    let now = 1_000_000;
    const { app } = makeApp({ now: () => now });
    await app.request('/platform-connect/bind', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OP_TOKEN}`,
      },
      body: JSON.stringify({ code: 'EXPIRE12' }),
    });
    now += 11 * 60 * 1000;
    const res = await app.request('/platform-connect/lookup?code=EXPIRE12');
    expect(res.status).toBe(404);
  });
});

describe('GET /setup/connect-platform', () => {
  it('renders HTML with the code embedded in the inline script', async () => {
    const { app } = makeApp();
    const res = await app.request('/setup/connect-platform?code=PAIR1234');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    // The page ships a vanilla-JS client that reads `code` out of a
    // JSON literal we inject server-side. Assert the code landed
    // in the script so the client doesn't silently render a
    // "missing code" error.
    expect(body).toContain('PAIR1234');
    expect(body).toContain('/platform-connect/bind');
    expect(body).toContain('/session');
  });

  it('escapes HTML-unsafe characters in the code', async () => {
    const { app } = makeApp();
    // Realistic codes never contain these, but defense-in-depth: if
    // the code format changes we don't want to ship an injection.
    const res = await app.request(
      `/setup/connect-platform?code=${encodeURIComponent('<img onerror=x>')}`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('<img onerror=x>');
    expect(body).toContain('&lt;img');
  });
});

describe('GET /setup/connect-platform — iframe mode', () => {
  it('injects mode=iframe + parentOrigin when valid query params are present', async () => {
    const { app } = makeApp();
    const parent = 'https://app.example.com';
    const res = await app.request(
      `/setup/connect-platform?code=ABCD1234&mode=iframe&parentOrigin=${encodeURIComponent(parent)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"iframe"');
    expect(body).toContain(parent);
    // The postMessage branch only fires on mode==='iframe' AND a
    // validated parentOrigin, so both must be present in the
    // rendered script to enable the hand-off path.
    expect(body).toContain('platform-connect-bound');
    expect(body).toContain('window.parent.postMessage');
  });

  it('falls back to tab mode when parentOrigin is missing', async () => {
    const { app } = makeApp();
    const res = await app.request('/setup/connect-platform?code=ABCD1234&mode=iframe');
    expect(res.status).toBe(200);
    const body = await res.text();
    // `modeLiteral` collapses to 'tab' when parentOrigin is unset,
    // so the close-this-tab copy renders instead of the iframe copy.
    expect(body).toContain('"tab"');
  });

  it('rejects garbage parentOrigin values (no wildcard postMessage)', async () => {
    const { app } = makeApp();
    const res = await app.request(
      `/setup/connect-platform?code=ABCD1234&mode=iframe&parentOrigin=${encodeURIComponent('not a url')}`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // parentOrigin failed validation → empty string → no postMessage.
    expect(body).not.toContain('not a url');
    // modeLiteral drops back to 'tab' per renderConnectPlatformPage.
    expect(body).toContain('"tab"');
  });
});

// Reset any shared state between files. Each test uses a fresh app
// so the Map is scoped to its call, but keeping this here means a
// future global-state leak fails fast.
beforeEach(() => {
  // no-op today; placeholder for future cleanup hooks
});
