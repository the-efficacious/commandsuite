/**
 * Tool-sources endpoint tests — registry CRUD gating, credential
 * write-only redaction, binding-gated invoke, the custom executor
 * end-to-end against a local HTTP fixture (credential injection,
 * templating, truncation), audit append, change-event fanout, and
 * briefing resolution.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Broker, InMemoryEventLog } from 'csuite-core';
import type { BriefingResponse, ToolSourceSummary } from 'csuite-sdk/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { testKek } from '../src/kek.js';
import { createSqliteActivityStore } from '../src/member-activity.js';
import { createMemberStore, setKek } from '../src/members.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { createSqliteToolSourceStore } from '../src/tool-sources/index.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN = 'csuite_test_admin_secret';
const BOUND = 'csuite_test_bound_secret';
const OUTSIDER = 'csuite_test_outsider_secret';

const noopLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeApp(opts: { withActivity?: boolean } = {}) {
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
      permissions: ['tools.manage', 'members.manage'],
      token: ADMIN,
    },
    {
      name: 'bound',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: BOUND,
    },
    {
      name: 'outsider',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: OUTSIDER,
    },
  ]);
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
  const toolSources = createSqliteToolSourceStore(db);
  const activityStore = opts.withActivity
    ? createSqliteActivityStore(openDatabase(':memory:'), noopLog)
    : undefined;
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore({
      name: 'demo-team',
      context: '',
      permissionPresets: {},
    }),
    toolSources,
    ...(activityStore ? { activityStore } : {}),
    version: '0.0.0',
    logger: noopLog,
  });
  return { app, broker, toolSources, activityStore };
}

function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = method ?? (body !== undefined ? 'POST' : 'GET');
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

/** Flush queueMicrotask + broker push promises. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeAll(() => {
  setKek(testKek());
});

afterAll(() => {
  setKek(null);
});

describe('registry CRUD + gating', () => {
  it('create requires tools.manage', async () => {
    const { app } = makeApp();
    const denied = await app.request(
      '/tool-sources',
      authed(BOUND, { slug: 'jira', kind: 'custom' }),
    );
    expect(denied.status).toBe(403);

    const created = await app.request(
      '/tool-sources',
      authed(ADMIN, { slug: 'jira', kind: 'custom', displayName: 'Jira' }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { slug: string; enabled: boolean };
    expect(body.slug).toBe('jira');
    expect(body.enabled).toBe(true);
  });

  it('rejects duplicate slugs with 409 and bad kinds with 400', async () => {
    const { app } = makeApp();
    await app.request('/tool-sources', authed(ADMIN, { slug: 'jira', kind: 'custom' }));
    const dupe = await app.request(
      '/tool-sources',
      authed(ADMIN, { slug: 'jira', kind: 'custom' }),
    );
    expect(dupe.status).toBe(409);
    const bad = await app.request('/tool-sources', authed(ADMIN, { slug: 'x', kind: 'weird' }));
    expect(bad.status).toBe(400);
  });

  it('mcp sources require config.url', async () => {
    const { app } = makeApp();
    const missing = await app.request('/tool-sources', authed(ADMIN, { slug: 'up', kind: 'mcp' }));
    expect(missing.status).toBe(400);
    const ok = await app.request(
      '/tool-sources',
      authed(ADMIN, { slug: 'up', kind: 'mcp', config: { url: 'https://mcp.example.com/v1' } }),
    );
    expect(ok.status).toBe(201);
  });

  it('any member can list; bound flag is per-viewer', async () => {
    const { app } = makeApp();
    await app.request('/tool-sources', authed(ADMIN, { slug: 'jira', kind: 'custom' }));
    await app.request('/tool-sources/jira/bindings', authed(ADMIN, { member: 'bound' }));

    const asBound = await app.request('/tool-sources', authed(BOUND));
    const boundList = (await asBound.json()) as { sources: ToolSourceSummary[] };
    expect(boundList.sources[0]?.bound).toBe(true);

    const asOutsider = await app.request('/tool-sources', authed(OUTSIDER));
    const outsiderList = (await asOutsider.json()) as { sources: ToolSourceSummary[] };
    expect(outsiderList.sources[0]?.bound).toBe(false);
  });

  it('binding list is admin-only on detail', async () => {
    const { app } = makeApp();
    await app.request('/tool-sources', authed(ADMIN, { slug: 'jira', kind: 'custom' }));
    await app.request('/tool-sources/jira/bindings', authed(ADMIN, { member: 'bound' }));

    const asAdmin = (await (await app.request('/tool-sources/jira', authed(ADMIN))).json()) as {
      boundMembers?: string[];
    };
    expect(asAdmin.boundMembers).toEqual(['bound']);
    const asBound = (await (await app.request('/tool-sources/jira', authed(BOUND))).json()) as {
      boundMembers?: string[];
    };
    expect(asBound.boundMembers).toBeUndefined();
  });
});

describe('credentials', () => {
  it('is write-only: set succeeds, no endpoint returns the secret', async () => {
    const { app } = makeApp();
    await app.request('/tool-sources', authed(ADMIN, { slug: 'jira', kind: 'custom' }));
    const set = await app.request(
      '/tool-sources/jira/credential',
      authed(ADMIN, { kind: 'bearer', secret: 'super-secret-pat' }, 'PUT'),
    );
    expect(set.status).toBe(200);

    const list = await (await app.request('/tool-sources', authed(ADMIN))).text();
    const detail = await (await app.request('/tool-sources/jira', authed(ADMIN))).text();
    expect(list).not.toContain('super-secret-pat');
    expect(detail).not.toContain('super-secret-pat');
    expect(JSON.parse(list).sources[0].hasCredential).toBe(true);
  });

  it('fails closed (503) when no KEK is active', async () => {
    setKek(null);
    try {
      const { app } = makeApp();
      await app.request('/tool-sources', authed(ADMIN, { slug: 'jira', kind: 'custom' }));
      const set = await app.request(
        '/tool-sources/jira/credential',
        authed(ADMIN, { kind: 'bearer', secret: 's' }, 'PUT'),
      );
      expect(set.status).toBe(503);
    } finally {
      setKek(testKek());
    }
  });

  it('stores the secret encrypted at rest', async () => {
    const { app, toolSources } = makeApp();
    await app.request('/tool-sources', authed(ADMIN, { slug: 'jira', kind: 'custom' }));
    await app.request(
      '/tool-sources/jira/credential',
      authed(ADMIN, { kind: 'header', headerName: 'X-Api-Key', secret: 'raw-secret' }, 'PUT'),
    );
    const source = toolSources.getBySlug('jira');
    expect(source).not.toBeNull();
    const cred = toolSources.getCredential((source as { id: string }).id);
    expect(cred?.secret).toBe('raw-secret'); // decrypt round-trip
    expect(cred?.headerName).toBe('X-Api-Key');
  });
});

describe('invoke — custom executor end-to-end', () => {
  let upstream: Server;
  let upstreamUrl: string;
  let lastRequest: { url: string; headers: Record<string, string>; body: string } | null = null;
  let respondWith: { status: number; body: string; contentType?: string } = {
    status: 200,
    body: '{}',
  };

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastRequest = {
          url: req.url ?? '',
          headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.writeHead(respondWith.status, {
          'Content-Type': respondWith.contentType ?? 'application/json',
        });
        res.end(respondWith.body);
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  afterEach(() => {
    lastRequest = null;
    respondWith = { status: 200, body: '{}' };
  });

  async function setupSource(app: Awaited<ReturnType<typeof makeApp>>['app']) {
    await app.request('/tool-sources', authed(ADMIN, { slug: 'jira', kind: 'custom' }));
    await app.request(
      '/tool-sources/jira/credential',
      authed(ADMIN, { kind: 'bearer', secret: 'the-pat' }, 'PUT'),
    );
    await app.request('/tool-sources/jira/bindings', authed(ADMIN, { member: 'bound' }));
    const def = await app.request(
      '/tool-sources/jira/tools/get_issue',
      authed(
        ADMIN,
        {
          description: 'Fetch a Jira issue',
          inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
          binding: {
            method: 'GET',
            urlTemplate: `${upstreamUrl}/rest/api/3/issue/{{args.key}}`,
            resultPath: 'fields.summary',
          },
        },
        'PUT',
      ),
    );
    expect(def.status).toBe(200);
  }

  it('403s unbound members before revealing anything', async () => {
    const { app } = makeApp();
    await setupSource(app);
    const res = await app.request(
      '/tool-sources/jira/tools/get_issue/invoke',
      authed(OUTSIDER, { args: { key: 'X-1' } }),
    );
    expect(res.status).toBe(403);
    expect(lastRequest).toBeNull();
  });

  it('injects the credential, templates the URL, extracts resultPath', async () => {
    const { app } = makeApp();
    await setupSource(app);
    respondWith = {
      status: 200,
      body: JSON.stringify({ fields: { summary: 'Fix the login bug' } }),
    };
    const res = await app.request(
      '/tool-sources/jira/tools/get_issue/invoke',
      authed(BOUND, { args: { key: 'PROJ-7' } }),
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('Fix the login bug');
    expect(lastRequest?.url).toBe('/rest/api/3/issue/PROJ-7');
    expect(lastRequest?.headers.authorization).toBe('Bearer the-pat');
  });

  it('returns template errors as isError results without any I/O', async () => {
    const { app } = makeApp();
    await setupSource(app);
    const res = await app.request(
      '/tool-sources/jira/tools/get_issue/invoke',
      authed(BOUND, { args: {} }),
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('{{args.key}}');
    expect(lastRequest).toBeNull();
  });

  it('maps upstream non-2xx to isError with the response body', async () => {
    const { app } = makeApp();
    await setupSource(app);
    respondWith = { status: 404, body: '{"errorMessages":["Issue does not exist"]}' };
    const res = await app.request(
      '/tool-sources/jira/tools/get_issue/invoke',
      authed(BOUND, { args: { key: 'GONE-1' } }),
    );
    const result = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean };
    expect(res.status).toBe(200);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('HTTP 404');
    expect(result.content[0]?.text).toContain('Issue does not exist');
  });

  it('truncates oversized responses with a visible marker', async () => {
    const { app } = makeApp();
    await setupSource(app);
    respondWith = {
      status: 200,
      body: 'x'.repeat(100_000),
      contentType: 'text/plain',
    };
    const res = await app.request(
      '/tool-sources/jira/tools/get_issue/invoke',
      authed(BOUND, { args: { key: 'BIG-1' } }),
    );
    const result = (await res.json()) as { content: Array<{ text: string }> };
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('[csuite: response truncated at 65536 bytes]');
    expect(text.length).toBeLessThan(70_000);
  });

  it('409s a disabled source for bound members but 403s outsiders first', async () => {
    const { app } = makeApp();
    await setupSource(app);
    await app.request('/tool-sources/jira', authed(ADMIN, { enabled: false }, 'PATCH'));
    const boundRes = await app.request(
      '/tool-sources/jira/tools/get_issue/invoke',
      authed(BOUND, { args: { key: 'X-1' } }),
    );
    expect(boundRes.status).toBe(409);
    const outsiderRes = await app.request(
      '/tool-sources/jira/tools/get_issue/invoke',
      authed(OUTSIDER, { args: { key: 'X-1' } }),
    );
    expect(outsiderRes.status).toBe(403);
  });

  it('appends a tool_action audit row on invoke', async () => {
    const { app, activityStore } = makeApp({ withActivity: true });
    await setupSource(app);
    respondWith = { status: 200, body: '{"fields":{"summary":"ok"}}' };
    await app.request(
      '/tool-sources/jira/tools/get_issue/invoke',
      authed(BOUND, { args: { key: 'A-1' } }),
    );
    const rows = activityStore?.list({ memberName: 'bound' }) ?? [];
    const toolActions = rows.filter((r) => r.event.kind === 'tool_action');
    expect(toolActions).toHaveLength(1);
    const event = toolActions[0]?.event as { toolName: string; isError?: boolean };
    expect(event.toolName).toBe('jira__get_issue');
    expect(event.isError).toBe(false);
  });
});

describe('change events', () => {
  it('fans out registry changes to bound members + tools.manage holders', async () => {
    const { app, broker } = makeApp();
    const pushSpy = vi.spyOn(broker, 'push');
    await app.request('/tool-sources', authed(ADMIN, { slug: 'jira', kind: 'custom' }));
    await app.request('/tool-sources/jira/bindings', authed(ADMIN, { member: 'bound' }));
    await settle();

    const calls = pushSpy.mock.calls.filter(
      (call) => (call[0]?.data as { kind?: string } | undefined)?.kind === 'tool_source',
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const bindCall = calls.find(
      (call) => (call[0]?.data as { event?: string } | undefined)?.event === 'bound',
    );
    expect(bindCall).toBeDefined();
    const recipients = (bindCall?.[1] as { recipients: string[] } | undefined)?.recipients;
    expect(recipients).toContain('admin');
    expect(recipients).toContain('bound');
    expect(recipients).not.toContain('outsider');
    const data = bindCall?.[0]?.data as Record<string, unknown>;
    expect(data.thread).toBe('tool:jira');
    expect(data.source_slug).toBe('jira');
  });

  it('unbound events still reach the removed member', async () => {
    const { app, broker } = makeApp();
    await app.request('/tool-sources', authed(ADMIN, { slug: 'jira', kind: 'custom' }));
    await app.request('/tool-sources/jira/bindings', authed(ADMIN, { member: 'bound' }));
    await settle();
    const pushSpy = vi.spyOn(broker, 'push');
    await app.request('/tool-sources/jira/bindings/bound', authed(ADMIN, undefined, 'DELETE'));
    await settle();
    const unbindCall = pushSpy.mock.calls.find(
      (call) => (call[0]?.data as { event?: string } | undefined)?.event === 'unbound',
    );
    expect((unbindCall?.[1] as { recipients: string[] } | undefined)?.recipients).toContain(
      'bound',
    );
  });
});

describe('briefing integration', () => {
  it('resolves tools only for visible sources', async () => {
    const { app } = makeApp();
    await app.request('/tool-sources', authed(ADMIN, { slug: 'jira', kind: 'custom' }));
    await app.request('/tool-sources/jira/bindings', authed(ADMIN, { member: 'bound' }));
    await app.request(
      '/tool-sources/jira/tools/get_issue',
      authed(
        ADMIN,
        {
          description: 'Fetch an issue',
          inputSchema: { type: 'object' },
          binding: { method: 'GET', urlTemplate: 'https://api.example.com/{{args.key}}' },
        },
        'PUT',
      ),
    );

    const boundBriefing = (await (
      await app.request('/briefing', authed(BOUND))
    ).json()) as BriefingResponse;
    expect(boundBriefing.toolSources).toHaveLength(1);
    expect(boundBriefing.toolSources[0]?.source).toBe('jira');
    expect(boundBriefing.toolSources[0]?.tools[0]?.name).toBe('get_issue');

    const outsiderBriefing = (await (
      await app.request('/briefing', authed(OUTSIDER))
    ).json()) as BriefingResponse;
    expect(outsiderBriefing.toolSources).toHaveLength(0);
  });

  it('allMembers sources reach everyone without bindings', async () => {
    const { app } = makeApp();
    await app.request(
      '/tool-sources',
      authed(ADMIN, { slug: 'shared', kind: 'custom', allMembers: true }),
    );
    const briefing = (await (
      await app.request('/briefing', authed(OUTSIDER))
    ).json()) as BriefingResponse;
    expect(briefing.toolSources).toHaveLength(1);
  });
});
