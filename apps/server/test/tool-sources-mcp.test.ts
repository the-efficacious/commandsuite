/**
 * MCP tool-source integration tests — the broker as MCP client.
 *
 * Spins a real Streamable HTTP MCP server in-process (SDK server +
 * stateless transport behind a Node http server, per-request
 * instances) and drives the full path through the app's routes:
 * discovery (refresh → cache → changed flag), credentialed relay of
 * tools/call, stale-cache 404s, and upstream-unreachable 502s.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Broker, InMemoryEventLog } from 'csuite-core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { testKek } from '../src/kek.js';
import { createMemberStore, setKek } from '../src/members.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import {
  createMcpClientManager,
  createSqliteToolSourceStore,
  type McpToolManager,
} from '../src/tool-sources/index.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN = 'csuite_test_admin_secret';
const BOUND = 'csuite_test_bound_secret';
const UPSTREAM_SECRET = 'upstream-pat';

const noopLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * Stateless Streamable HTTP MCP upstream: a fresh SDK server +
 * transport per POST (the documented stateless pattern), gated on a
 * bearer header so credential injection is provable.
 */
async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer: Server = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== `Bearer ${UPSTREAM_SECRET}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const server = new McpServer({ name: 'fixture-upstream', version: '0.0.1' });
      server.tool('echo', 'Echo the input back.', { text: z.string() }, async ({ text }) => ({
        content: [{ type: 'text' as const, text: `echo: ${text}` }],
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    })().catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
  return {
    url,
    close: () => new Promise<void>((r) => httpServer.close(() => r())),
  };
}

function makeApp() {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: (() => {
      let n = 0;
      return () => `msg-${++n}`;
    })(),
  });
  const members = createMemberStore([
    {
      name: 'admin',
      role: { title: 'director', description: '' },
      permissions: ['tools.manage'],
      token: ADMIN,
    },
    { name: 'bound', role: { title: 'engineer', description: '' }, permissions: [], token: BOUND },
  ]);
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
  const toolSources = createSqliteToolSourceStore(db);
  const mcpManager: McpToolManager = createMcpClientManager({
    store: toolSources,
    version: '0.0.0',
    logger: noopLog,
  });
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore({
      name: 'demo-team',
      directive: 'Ship the thing.',
      context: '',
      permissionPresets: {},
    }),
    toolSources,
    mcpManager,
    version: '0.0.0',
    logger: noopLog,
  });
  return { app, mcpManager };
}

function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = method ?? (body !== undefined ? 'POST' : 'GET');
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

let upstream: Awaited<ReturnType<typeof startUpstream>>;
const managers: McpToolManager[] = [];

beforeAll(async () => {
  setKek(testKek());
  upstream = await startUpstream();
});

afterAll(async () => {
  setKek(null);
  await upstream.close();
});

afterEach(async () => {
  await Promise.allSettled(managers.map((m) => m.closeAll()));
  managers.length = 0;
});

async function setupMcpSource(app: ReturnType<typeof makeApp>['app'], url = upstream.url) {
  const created = await app.request(
    '/tool-sources',
    authed(ADMIN, { slug: 'up', kind: 'mcp', config: { url } }),
  );
  expect(created.status).toBe(201);
  await app.request(
    '/tool-sources/up/credential',
    authed(ADMIN, { kind: 'bearer', secret: UPSTREAM_SECRET }, 'PUT'),
  );
  await app.request('/tool-sources/up/bindings', authed(ADMIN, { member: 'bound' }));
}

describe('mcp tool sources', () => {
  it('refresh discovers upstream tools into the cache (changed only on diff)', async () => {
    const { app, mcpManager } = makeApp();
    managers.push(mcpManager);
    await setupMcpSource(app);

    const first = await app.request('/tool-sources/up/refresh', authed(ADMIN, undefined, 'POST'));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      tools: Array<{ name: string }>;
      changed: boolean;
    };
    expect(firstBody.changed).toBe(true);
    expect(firstBody.tools.map((t) => t.name)).toEqual(['echo']);

    const second = await app.request('/tool-sources/up/refresh', authed(ADMIN, undefined, 'POST'));
    expect(((await second.json()) as { changed: boolean }).changed).toBe(false);

    // The briefing now resolves the discovered tool for bound members.
    const briefing = (await (await app.request('/briefing', authed(BOUND))).json()) as {
      toolSources: Array<{ source: string; tools: Array<{ name: string }> }>;
    };
    expect(briefing.toolSources[0]?.tools[0]?.name).toBe('echo');
  });

  it('relays tools/call through the credentialed upstream connection', async () => {
    const { app, mcpManager } = makeApp();
    managers.push(mcpManager);
    await setupMcpSource(app);
    await app.request('/tool-sources/up/refresh', authed(ADMIN, undefined, 'POST'));

    const res = await app.request(
      '/tool-sources/up/tools/echo/invoke',
      authed(BOUND, { args: { text: 'hello upstream' } }),
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('echo: hello upstream');
  });

  it('404s tools missing from the cache with a refresh hint', async () => {
    const { app, mcpManager } = makeApp();
    managers.push(mcpManager);
    await setupMcpSource(app);
    // No refresh — cache is empty.
    const res = await app.request(
      '/tool-sources/up/tools/echo/invoke',
      authed(BOUND, { args: { text: 'x' } }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain('refresh');
  });

  it('502s refresh when the upstream is unreachable', async () => {
    const { app, mcpManager } = makeApp();
    managers.push(mcpManager);
    // Point at a dead port (bind + close to guarantee it's free-ish).
    await setupMcpSource(app, 'http://127.0.0.1:1/mcp');
    const res = await app.request('/tool-sources/up/refresh', authed(ADMIN, undefined, 'POST'));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('unreachable');
  });

  it('surfaces upstream tool errors as isError results, not HTTP errors', async () => {
    const { app, mcpManager } = makeApp();
    managers.push(mcpManager);
    await setupMcpSource(app);
    await app.request('/tool-sources/up/refresh', authed(ADMIN, undefined, 'POST'));
    // Bad args: the upstream's zod schema rejects a missing `text`,
    // which the SDK surfaces as an McpError — relayed as isError.
    const res = await app.request(
      '/tool-sources/up/tools/echo/invoke',
      authed(BOUND, { args: {} }),
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
  });
});
