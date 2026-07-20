/**
 * Session-online notice tests.
 *
 * The broker pushes a "session online" message to a runner the moment
 * its WebSocket subscribe lands, so the agent's first turn carries
 * enough context to decide whether to resume work or stand by. The
 * message used to be titled "comms check" — agents read that as a
 * probe and started DMing teammates to "test" the chat. This file
 * pins the new wording and the auth-plane gating.
 *
 * Two layers of coverage:
 *
 *   1. `composeSessionOnlineMessage` — pure unit test on the
 *      composer's output. Cheap, runs against the source directly.
 *
 *   2. End-to-end via runServer + a real WebSocket client. Covers
 *      both auth planes:
 *        - bearer-auth subscriber receives the new notice
 *        - session-cookie subscriber does NOT
 *      The session-cookie path is the actual bug the user reported.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Broker, InMemoryEventLog } from 'csuite-core';
import type { Message, Team } from 'csuite-sdk/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { composeSessionOnlineMessage, createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { createSqliteObjectivesStore } from '../src/objectives.js';
import { type RunningServer, runServer } from '../src/run.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore, seedStores } from './helpers/test-stores.js';

// ─── unit: composeSessionOnlineMessage ──────────────────────────────

describe('composeSessionOnlineMessage', () => {
  it('renders the empty-plate variant when no objectives are active', () => {
    const m = composeSessionOnlineMessage('scout', 0);
    expect(m.title).toBe('csuite session online');
    expect(m.body).toContain('Connected to csuite as scout');
    expect(m.body).toContain('No active objectives');
    // Explicit framing that this is NOT a probe.
    expect(m.body).toMatch(/system notice/i);
    expect(m.body).toMatch(/no acknowledgement/i);
  });

  it('renders the populated-plate variant with the count', () => {
    const m = composeSessionOnlineMessage('scout', 3);
    expect(m.body).toContain('3 active objective(s)');
    expect(m.body).toContain('objectives_list');
  });

  it('does NOT use the historical "comms check" title (regression)', () => {
    const m = composeSessionOnlineMessage('scout', 1);
    expect(m.title.toLowerCase()).not.toContain('comms');
    expect(m.body.toLowerCase()).not.toContain('comms check');
  });

  it('does NOT phrase the message as a request for response', () => {
    // Wording sanity — these phrasings would invite an agent to
    // generate a reply turn instead of just absorbing the context.
    const m = composeSessionOnlineMessage('scout', 0);
    expect(m.body.toLowerCase()).not.toMatch(/please respond/);
    expect(m.body.toLowerCase()).not.toMatch(/reply\b/);
    expect(m.body.toLowerCase()).not.toMatch(/are you there/);
  });
});

// ─── end-to-end: gating on auth plane ───────────────────────────────

const ADMIN_TOKEN = 'csuite_session_online_test_admin_token';
const TEAM: Team = {
  name: 'session-online-team',
  directive: 'Verify the session-online notice is gated by auth plane.',
  context: '',
  permissionPresets: {},
};

function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface BootedServer {
  running: RunningServer;
  origin: string;
  wsOrigin: string;
}

async function bootServer(): Promise<BootedServer> {
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
    port: 0,
    host: '127.0.0.1',
    logger: silentLogger(),
  });
  return {
    running,
    origin: `http://127.0.0.1:${running.port}`,
    wsOrigin: `ws://127.0.0.1:${running.port}`,
  };
}

/**
 * Connect a WebSocket and capture every inbound message into an
 * array. The caller decides when to inspect the array — typically
 * after a fixed wait, since negative-result tests need to confirm
 * NO message arrived. Listeners are installed before `open` resolves
 * so we don't lose messages in the open→message-listener race window.
 */
async function connectAndCapture(
  url: string,
  headers: Record<string, string>,
): Promise<{ ws: WebSocket; messages: Message[] }> {
  const ws = new WebSocket(url, { headers });
  const messages: Message[] = [];
  ws.on('message', (data) => {
    try {
      messages.push(JSON.parse(data.toString()) as Message);
    } catch {
      /* ignore malformed */
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_req: unknown, res: IncomingMessage) =>
      reject(new Error(`upgrade rejected: ${res.statusCode}`)),
    );
  });
  return { ws, messages };
}

async function waitForMessage(
  messages: Message[],
  predicate: (m: Message) => boolean,
  timeoutMs: number,
): Promise<Message | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('runServer session-online notice — auth-plane gating', () => {
  let booted: BootedServer | null = null;

  afterEach(async () => {
    if (booted) {
      await booted.running.stop();
      booted = null;
    }
  });

  it('bearer-auth subscriber receives the session-online notice', async () => {
    booted = await bootServer();
    const { ws, messages } = await connectAndCapture(`${booted.wsOrigin}/subscribe?name=alice`, {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    });
    try {
      const msg = await waitForMessage(messages, (m) => m.from === 'csuite', 2_000);
      expect(msg).not.toBeNull();
      expect(msg?.title).toBe('csuite session online');
      expect(msg?.from).toBe('csuite');
      expect(msg?.to).toBe('alice');
      expect(msg?.body).toContain('Connected to csuite');
    } finally {
      ws.close();
    }
  }, 10_000);
});

// ─── lower-level: WS subscribe with a session cookie ────────────────
//
// To prove the gate against an actual cookie-auth subscriber, we need
// a session cookie. Minting one through TOTP requires running the
// wizard's enrollment flow, which is heavyweight. Instead we use the
// non-Hono test pattern: createApp directly with an injected session,
// then make a raw HTTP upgrade against it. The cookie-auth path
// rejects before the WS upgrade only if auth fails — a valid cookie
// gets through. We verify that no session-online notice arrives
// within a 1-second window (vs the bearer case where it lands in
// <100ms).

describe('session-online gate — cookie subscriber receives nothing', () => {
  let httpServer: Server | null = null;

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
      httpServer = null;
    }
  });

  it('a cookie-auth WS subscribe yields no session-online push within 1s', async () => {
    // Build createApp with everything wired except objectives gating.
    // Mint a session cookie directly via the SessionStore, then do a
    // raw WS upgrade against the live HTTP server using that cookie.
    const broker = new Broker({ eventLog: new InMemoryEventLog() });
    const members = createMemberStore([
      {
        name: 'alice',
        role: { title: 'admin', description: '' },
        permissions: ['members.manage'],
        token: ADMIN_TOKEN,
      },
    ]);
    const db = openDatabase(':memory:');
    const sessions = new SessionStore(db);
    const tokens = createTokenStoreFromMembers(db, members);
    const objectives = createSqliteObjectivesStore(db);
    const { app, injectWebSocket } = createApp({
      broker,
      members,
      tokens,
      sessions,
      teamStore: mockTeamStore(TEAM),
      objectives,
      version: '0.0.0',
      logger: silentLogger(),
    });

    // Mint a session for alice without going through TOTP.
    const session = sessions.create('alice', null);

    // Boot the app on a free port + inject the WS handler so the
    // upgrade fires on incoming WS requests.
    httpServer = createHttpServer(async (req, res) => {
      const url = `http://${req.headers.host}${req.url}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
      }
      const body: Buffer[] = [];
      for await (const chunk of req) body.push(chunk as Buffer);
      const init: RequestInit = { method: req.method, headers };
      if (body.length > 0) init.body = Buffer.concat(body);
      const response = await app.fetch(new Request(url, init));
      res.statusCode = response.status;
      response.headers.forEach((v, k) => {
        res.setHeader(k, v);
      });
      const arr = await response.arrayBuffer();
      res.end(Buffer.from(arr));
    });
    injectWebSocket(httpServer);
    await new Promise<void>((resolve) => httpServer?.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const { ws, messages } = await connectAndCapture(
      `ws://127.0.0.1:${port}/subscribe?name=alice`,
      { Cookie: `csuite_session=${session.id}` },
    );
    try {
      // Regression: a cookie-auth subscriber must NOT receive the
      // csuite-system push. We give it 1.5s — comfortably longer than
      // the bearer-side delivery window (typically <100ms) so the
      // gate is genuinely skipping the push, not just slow.
      const msg = await waitForMessage(messages, (m) => m.from === 'csuite', 1_500);
      expect(msg).toBeNull();
    } finally {
      ws.close();
    }
  }, 10_000);
});
