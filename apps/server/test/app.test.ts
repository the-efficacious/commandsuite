import {
  Broker,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import { PROTOCOL_HEADER, RUNNER_VERSION_HEADER } from 'csuite-sdk/protocol';
import type { InstructionsResponse, Message, RosterResponse, Team } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { mockTeamStore } from './helpers/test-stores.js';

const OP_TOKEN = 'csuite_test_operator_secret';
const BOT_TOKEN = 'csuite_test_bot_secret';

const TEAM: Team = {
  name: 'demo-team',
  context: 'We own the full lifecycle.',
  permissionPresets: {},
};

async function makeApp(options: { instructions?: string; context?: string } = {}) {
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
      instructions: options.instructions ?? '',
      permissions: [],
      token: BOT_TOKEN,
    },
  ]);
  // Tests run with an in-memory SQLite for sessions + tokens tables.
  const db = openDatabase(':memory:');
  const sessions = new SqliteSessionStore(db);
  const tokens = await createTokenStoreFromMembers(db, members);
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore({ ...TEAM, context: options.context ?? TEAM.context }),
    version: '0.0.0',
    logger,
  });
  return { app, broker, members, sessions, db, tokens, logger };
}

function authed(token: string, body?: unknown): RequestInit {
  const init: RequestInit = {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) {
    init.method = 'POST';
    init.body = JSON.stringify(body);
  }
  return init;
}

describe('app GET /healthz', () => {
  it('returns status ok without auth', async () => {
    const { app } = await makeApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      version: '0.0.0',
      capabilities: { rawBodyAck: true },
    });
  });
});

describe('app GET /instructions', () => {
  it('returns the composed instruction packet for the authenticated slot', async () => {
    const { app } = await makeApp();
    const res = await app.request('/instructions', authed(OP_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as InstructionsResponse;
    expect(body.name).toBe('director-1');
    expect(body.role.title).toBe('director');
    expect(body.permissions).toContain('members.manage');
    expect(body.team).toEqual(TEAM);
    expect(body.teammates.map((t) => t.name).sort()).toEqual(['build-bot', 'director-1']);
    expect(body.openObjectives).toEqual([]);
    expect(body.instructions).toContain('director-1');
    expect(body.instructions).toContain('director');
    expect(body.instructions).toContain(TEAM.context);
  });

  it('returns empty permissions for plain members', async () => {
    const { app } = await makeApp();
    const res = await app.request('/instructions', authed(BOT_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as InstructionsResponse;
    expect(body.name).toBe('build-bot');
    expect(body.role.title).toBe('engineer');
    expect(body.permissions).toEqual([]);
  });

  it('distinguishes an absent runner report from a rejected one without withholding packet', async () => {
    const { app, logger } = await makeApp();
    const absent = await app.request('/instructions', authed(BOT_TOKEN));
    expect(absent.status).toBe(200);
    expect(((await absent.json()) as InstructionsResponse).instructions).toContain(
      'runner=unknown',
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      'instructions runner version rejected',
      expect.anything(),
    );

    const rejected = await app.request('/instructions', {
      headers: {
        Authorization: `Bearer ${BOT_TOKEN}`,
        [RUNNER_VERSION_HEADER]: 'not a version',
      },
    });
    expect(rejected.status).toBe(200);
    expect(((await rejected.json()) as InstructionsResponse).instructions).toContain(
      'runner=unknown',
    );
    expect(logger.warn).toHaveBeenCalledWith('instructions runner version rejected', {
      member: 'build-bot',
    });
  });

  it('renders a bounded opaque runner version reported by the runner', async () => {
    const { app, logger } = await makeApp();
    const res = await app.request('/instructions', {
      headers: {
        Authorization: `Bearer ${BOT_TOKEN}`,
        [RUNNER_VERSION_HEADER]: '0.5.0-rc.1+build.3',
      },
    });
    expect(res.status).toBe(200);
    const instructions = ((await res.json()) as InstructionsResponse).instructions;
    expect(instructions).toContain(
      'demo-team CommandSuite/csuite: broker=0.0.0 runner=0.5.0-rc…d.3',
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      'instructions runner version rejected',
      expect.anything(),
    );
  });

  it('serves an oversized composed packet whole — no cap, no warning', async () => {
    // The 8192-cap era is fully dead: the cap itself (#122, removed in
    // #129) and the legacy-runner warning that outlived it (removed
    // with zero deployed runners). This is the guard against either
    // quietly returning.
    const { app, logger } = await makeApp({ instructions: 'x'.repeat(8_300) });
    const res = await app.request('/instructions', authed(BOT_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as InstructionsResponse;
    expect(body.instructions.length).toBeGreaterThan(8_192);
    // Complete, not truncated at the old boundary.
    expect(body.instructions).toContain('x'.repeat(8_300));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('requires auth', async () => {
    const { app } = await makeApp();
    const res = await app.request('/instructions');
    expect(res.status).toBe(401);
  });
});

describe('app auth', () => {
  it('rejects /roster without a bearer token', async () => {
    const { app } = await makeApp();
    const res = await app.request('/roster');
    expect(res.status).toBe(401);
  });

  it('rejects /roster with an unknown token', async () => {
    const { app } = await makeApp();
    const res = await app.request('/roster', {
      headers: { Authorization: 'Bearer not-in-config' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts a percent-encoded `Bearer%20<token>` (OTEL OTLP exporter form)', async () => {
    // Claude Code's OTLP log export passes the OTEL_EXPORTER_OTLP_HEADERS
    // value without URL-decoding, so the space arrives as `%20`. The
    // middleware must normalize it or every log export 401s.
    const { app } = await makeApp();
    const res = await app.request('/roster', {
      headers: { Authorization: `Bearer%20${OP_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('accepts /roster from any configured slot', async () => {
    const { app } = await makeApp();
    const asOp = await app.request('/roster', authed(OP_TOKEN));
    expect(asOp.status).toBe(200);
    const asBot = await app.request('/roster', authed(BOT_TOKEN));
    expect(asBot.status).toBe(200);
  });

  it('rejects requests with a mismatched protocol version', async () => {
    const { app } = await makeApp();
    const res = await app.request('/roster', {
      headers: {
        Authorization: `Bearer ${OP_TOKEN}`,
        [PROTOCOL_HEADER]: '999',
      },
    });
    expect(res.status).toBe(400);
  });
});

describe('app GET /roster', () => {
  it('returns all teammates from the slot config plus runtime connection state', async () => {
    const { app, broker } = await makeApp();
    // Pre-seed both slots so they appear in connected state
    broker.seedMembers([
      { name: 'director-1', role: { title: 'director', description: '' } },
      { name: 'build-bot', role: { title: 'engineer', description: '' } },
    ]);

    const res = await app.request('/roster', authed(OP_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RosterResponse;
    expect(body.teammates.map((t) => t.name).sort()).toEqual(['build-bot', 'director-1']);
    expect(body.connected.map((a) => a.name).sort()).toEqual(['build-bot', 'director-1']);
    expect(body.connected.every((a) => a.connected === 0)).toBe(true);
  });
});

describe('app GET /subscribe identity', () => {
  it('rejects subscribe to a name other than the caller', async () => {
    const { app } = await makeApp();
    const res = await app.request('/subscribe?name=build-bot', authed(OP_TOKEN));
    expect(res.status).toBe(403);
  });

  it('requires to query parameter', async () => {
    const { app } = await makeApp();
    const res = await app.request('/subscribe', authed(OP_TOKEN));
    expect(res.status).toBe(400);
  });
});

describe('app POST /push', () => {
  it('delivers a targeted push and stamps from=<name>', async () => {
    const { app, broker } = await makeApp();
    await broker.register('build-bot');
    const received: Message[] = [];
    broker.subscribe('build-bot', (m) => {
      received.push(m);
    });

    const res = await app.request('/push', authed(OP_TOKEN, { to: 'build-bot', body: 'hello' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      delivery: { live: number; targets: number };
      message: { body: string; from: string };
    };
    expect(body.delivery.live).toBe(1);
    expect(body.delivery.targets).toBe(1);

    expect(body.message.body).toBe('hello');
    expect(body.message.from).toBe('director-1');
    expect(received).toHaveLength(1);
    expect(received[0]?.from).toBe('director-1');
  });

  it('fans out a DM to the sender if the sender is registered', async () => {
    const { app, broker } = await makeApp();
    await broker.register('build-bot');
    await broker.register('director-1');
    const opInbox: Message[] = [];
    const botInbox: Message[] = [];
    broker.subscribe('director-1', (m) => {
      opInbox.push(m);
    });
    broker.subscribe('build-bot', (m) => {
      botInbox.push(m);
    });

    const res = await app.request('/push', authed(OP_TOKEN, { to: 'build-bot', body: 'status?' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delivery: { live: number; targets: number } };
    expect(body.delivery.targets).toBe(1);
    expect(body.delivery.live).toBe(2);
    expect(botInbox).toHaveLength(1);
    expect(opInbox).toHaveLength(1);
  });

  it('stamps from based on which token authenticated, not on payload', async () => {
    const { app } = await makeApp();
    const res = await app.request(
      '/push',
      authed(BOT_TOKEN, { body: 'hi', data: { from: 'spoofed' } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { from: string; data: Record<string, unknown> } };
    expect(body.message.from).toBe('build-bot');
    expect(body.message.data).toEqual({ from: 'spoofed' });
  });

  it('returns 404 when targeting an unknown name', async () => {
    const { app } = await makeApp();
    const res = await app.request('/push', authed(OP_TOKEN, { to: 'ghost', body: 'hi' }));
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid push body', async () => {
    const { app } = await makeApp();
    const res = await app.request('/push', authed(OP_TOKEN, { body: '' }));
    expect(res.status).toBe(400);
  });

  it('broadcasts to all registered agents when to is omitted', async () => {
    const { app, broker } = await makeApp();
    await broker.register('a1');
    await broker.register('a2');
    const res = await app.request('/push', authed(OP_TOKEN, { body: 'broadcast' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delivery: { targets: number } };
    expect(body.delivery.targets).toBe(2);
  });

  it('treats explicit to: null as a broadcast', async () => {
    const { app, broker } = await makeApp();
    await broker.register('a1');
    const res = await app.request('/push', authed(OP_TOKEN, { to: null, body: 'null-target' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      delivery: { targets: number };
      message: { to: string | null };
    };
    expect(body.delivery.targets).toBe(1);
    expect(body.message.to).toBeNull();
  });
});

describe('app GET /history', () => {
  it('returns history filtered by the with parameter', async () => {
    const { app, broker } = await makeApp();
    await broker.register('director-1');
    await broker.register('build-bot');

    // Use the broker directly to push so we can set from.
    await broker.push({ body: 'broadcast' }, { from: 'director-1' });
    await broker.push({ to: 'build-bot', body: 'dm to bot' }, { from: 'director-1' });
    await broker.push({ to: 'director-1', body: 'dm from bot' }, { from: 'build-bot' });

    // Full feed for the operator: broadcast + both DMs
    const full = await app.request('/history', authed(OP_TOKEN));
    expect(full.status).toBe(200);
    const fullBody = (await full.json()) as { messages: Array<{ body: string }> };
    expect(fullBody.messages).toHaveLength(3);

    // DMs with build-bot only
    const dm = await app.request('/history?with=build-bot', authed(OP_TOKEN));
    expect(dm.status).toBe(200);
    const dmBody = (await dm.json()) as { messages: Array<{ body: string }> };
    expect(dmBody.messages).toHaveLength(2);
    expect(dmBody.messages.every((m) => m.body.includes('dm'))).toBe(true);
  });

  it('rejects an invalid `with` name with 400', async () => {
    const { app } = await makeApp();
    const res = await app.request('/history?with=%00%20bad%20callsign', authed(OP_TOKEN));
    expect(res.status).toBe(400);
  });

  it('rejects a non-finite `before` parameter with 400', async () => {
    const { app } = await makeApp();
    const res = await app.request('/history?before=not-a-number', authed(OP_TOKEN));
    expect(res.status).toBe(400);
  });

  it('clamps limit=0 to the default page size', async () => {
    const { app, broker } = await makeApp();
    for (let i = 0; i < 3; i++) {
      await broker.push({ body: `msg-${i}` }, { from: 'director-1' });
    }
    const res = await app.request('/history?limit=0', authed(OP_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages.length).toBe(3);
  });
});
