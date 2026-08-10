/**
 * MCP tool surface tests.
 *
 * The agent-facing tool surface (`packages/cli/src/runtime/tools.ts`)
 * had no direct test coverage before — its handlers were exercised
 * indirectly through the smoke test. This file pins the new
 * channel-related tools (`channels_list`, `channels_post`, the
 * `channel` arg on `recent`) plus the `defineTools` output shape.
 *
 * The handlers all take a `BrokerClient`; we pass a minimal stub
 * implementing only the methods each handler touches so tests stay
 * tightly scoped.
 */

import type { Client as BrokerClient } from 'csuite-sdk/client';
import type {
  ChannelSummary,
  GetChannelResponse,
  InstructionsResponse,
  Message,
  PushPayload,
  PushResult,
} from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { defineTools, handleToolCall } from '../../src/runtime/tools.js';

const PACKET: InstructionsResponse = {
  name: 'scout',
  role: { title: 'engineer', description: '' },
  permissions: [],
  instructions: '',
  team: {
    name: 'demo',
    context: '',
    permissionPresets: {},
  },
  teammates: [
    { name: 'scout', role: { title: 'engineer', description: '' }, permissions: [] },
    {
      name: 'director',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
    },
  ],
  openObjectives: [],
  toolSources: [],
  processDocument: null,
};

const ADMIN_PACKET: InstructionsResponse = {
  ...PACKET,
  permissions: ['team.manage', 'members.manage'],
};

describe('instruction authoring tools report text cost', () => {
  it('removes the old caps from the agent-facing schemas', () => {
    const tools = defineTools(ADMIN_PACKET);
    const json = JSON.stringify(
      tools.filter((tool) => ['team_update', 'members_add', 'members_update'].includes(tool.name)),
    );
    expect(json).not.toContain('8192');
    expect(json).not.toContain('512 chars');
  });

  it('reports team context metrics and labels the estimate method', async () => {
    const broker = makeBroker({ getTeam: vi.fn(async () => ADMIN_PACKET.team) } as never);
    const text = getCallText((await handleToolCall('team_get', {}, broker, ADMIN_PACKET)) as never);
    expect(text).toContain('context size: 0 characters · ≈0 estimated tokens (characters ÷ 4)');
  });

  it('reports role and personal-instruction metrics after member creation', async () => {
    const broker = makeBroker({
      createMember: vi.fn(async () => ({
        member: {
          name: 'newbie',
          role: { title: 'engineer', description: '12345' },
          permissions: [],
          instructions: '12345678',
        },
        token: 'secret-token',
      })),
    } as never);
    const text = getCallText(
      (await handleToolCall(
        'members_add',
        { name: 'newbie', title: 'engineer', description: '12345', instructions: '12345678' },
        broker,
        ADMIN_PACKET,
      )) as never,
    );
    expect(text).toContain('role description: 5 characters · ≈2 estimated tokens');
    expect(text).toContain('personal instructions: 8 characters · ≈2 estimated tokens');
  });
});

function makeBroker(overrides: Partial<BrokerClient> = {}): BrokerClient {
  return overrides as BrokerClient;
}

function makeChannel(overrides: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    id: 'eng-id-123',
    slug: 'engineering',
    createdBy: 'director',
    createdAt: 1_700_000_000_000,
    archivedAt: null,
    joined: true,
    myRole: 'member',
    memberCount: 4,
    ...overrides,
  };
}

function getCallText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected text content');
  }
  return first.text;
}

// ─── tool definition surface ─────────────────────────────────────────

describe('defineTools — chat surface includes channel tools', () => {
  it('includes channels_list and channels_post', () => {
    const names = defineTools(PACKET).map((t) => t.name);
    expect(names).toContain('channels_list');
    expect(names).toContain('channels_post');
  });

  it('broadcast description mentions channels_post for non-general channels', () => {
    const broadcast = defineTools(PACKET).find((t) => t.name === 'broadcast');
    expect(broadcast).toBeDefined();
    expect(broadcast?.description).toMatch(/channels_post/);
    expect(broadcast?.description).toMatch(/general/i);
  });

  it('recent description and schema mention the channel arg', () => {
    const recent = defineTools(PACKET).find((t) => t.name === 'recent');
    expect(recent).toBeDefined();
    expect(recent?.description).toMatch(/channel/i);
    const props = recent?.inputSchema.properties as Record<string, unknown>;
    expect(props?.channel).toBeDefined();
    expect(props?.with).toBeDefined();
  });

  it('channels_post requires channel + body', () => {
    const post = defineTools(PACKET).find((t) => t.name === 'channels_post');
    expect(post?.inputSchema.required).toEqual(['channel', 'body']);
  });
});

describe('roster — recent activity without liveness claims', () => {
  it('distinguishes recent working and blocked reports from no recent report', async () => {
    const broker = makeBroker({
      roster: vi.fn().mockResolvedValue({
        teammates: [
          ...PACKET.teammates,
          { name: 'reviewer', role: { title: 'reviewer', description: '' }, permissions: [] },
        ],
        connected: [
          {
            name: 'scout',
            connected: 1,
            createdAt: 1,
            lastSeen: 2,
            role: PACKET.teammates[0]?.role ?? null,
            activity: 'working',
            busy: true,
          },
          {
            name: 'director',
            connected: 1,
            createdAt: 1,
            lastSeen: 2,
            role: PACKET.teammates[1]?.role ?? null,
            activity: 'blocked',
            busy: false,
          },
        ],
        activityWindowMs: 45_000,
      }),
    });

    const text = getCallText(await handleToolCall('roster', {}, broker, PACKET));

    expect(text).toMatch(
      /scout \(you\) \[engineer\] connected=1; activity=reported working within last 45s/,
    );
    expect(text).toMatch(
      /director \[director\] \[admin\] connected=1; activity=reported blocked within last 45s/,
    );
    expect(text).toMatch(
      /reviewer \[reviewer\] offline; activity=no report within last 45s \(idle, lapsed, or never reported\)/,
    );
    expect(text).not.toContain('activity=idle');
  });

  it('describes the activity window and disclaims liveness in the tool metadata', () => {
    const roster = defineTools(PACKET).find((tool) => tool.name === 'roster');
    expect(roster?.description).toContain("broker's reporting window when supplied");
    expect(roster?.description).toContain('window is unknown');
    expect(roster?.description).toContain('not executor liveness');
  });

  it('renders an unknown window instead of inventing one for an older broker', async () => {
    const broker = makeBroker({
      roster: vi.fn().mockResolvedValue({
        teammates: PACKET.teammates,
        connected: [
          {
            name: 'scout',
            connected: 1,
            createdAt: 1,
            lastSeen: 2,
            role: PACKET.teammates[0]?.role ?? null,
            activity: 'working',
          },
        ],
      }),
    });

    const text = getCallText(await handleToolCall('roster', {}, broker, PACKET));
    expect(text).toContain('activity=reported working within an unknown window');
    expect(text).toContain(
      'director [director] [admin] offline; activity=no report within an unknown window (idle, lapsed, or never reported)',
    );
    expect(text).not.toMatch(/within last \d+s/);
  });
});

// ─── external tools (tool sources) ──────────────────────────────────

const EXTERNAL_SOURCES = [
  {
    source: 'jira',
    kind: 'custom' as const,
    tools: [
      {
        name: 'get_issue',
        description: 'Fetch a Jira issue.',
        inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
      },
    ],
  },
];

describe('defineTools — external tools', () => {
  it('namespaces resolved tools as <source>__<name>', () => {
    const tools = defineTools(PACKET, EXTERNAL_SOURCES);
    const jira = tools.find((t) => t.name === 'jira__get_issue');
    expect(jira).toBeDefined();
    expect(jira?.description).toBe('Fetch a Jira issue.');
    expect(((jira?.inputSchema.properties ?? {}) as Record<string, unknown>).key).toBeDefined();
  });

  it('defaults a non-object inputSchema to an empty object schema', () => {
    const tools = defineTools(PACKET, [
      {
        source: 'x',
        kind: 'custom',
        tools: [{ name: 'weird', description: '', inputSchema: { type: 'string' } }],
      },
    ]);
    expect(tools.find((t) => t.name === 'x__weird')?.inputSchema).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('defaults to the instructions snapshot when no live set is passed', () => {
    const briefingWithTools = { ...PACKET, toolSources: EXTERNAL_SOURCES };
    const names = defineTools(briefingWithTools).map((t) => t.name);
    expect(names).toContain('jira__get_issue');
  });
});

// ─── tool-source admin tools (tools.manage-gated) ───────────────────

const TOOL_ADMIN_NAMES = [
  'tool_sources_list',
  'tool_sources_view',
  'tool_sources_create',
  'tool_sources_update',
  'tool_sources_delete',
  'tool_sources_define_tool',
  'tool_sources_delete_tool',
  'tool_sources_bindings',
  'tool_sources_set_credential',
  'tool_sources_delete_credential',
  'tool_sources_refresh',
];

describe('defineTools — tool-source admin gating', () => {
  it('hides the admin group without tools.manage', () => {
    const names = defineTools(PACKET).map((t) => t.name);
    for (const name of TOOL_ADMIN_NAMES) expect(names).not.toContain(name);
  });

  it('shows the full admin group with tools.manage', () => {
    const admin = { ...PACKET, permissions: ['tools.manage' as const] };
    const names = defineTools(admin).map((t) => t.name);
    for (const name of TOOL_ADMIN_NAMES) expect(names).toContain(name);
  });

  it('define_tool teaches the binding grammar inline', () => {
    const admin = { ...PACKET, permissions: ['tools.manage' as const] };
    const define = defineTools(admin).find((t) => t.name === 'tool_sources_define_tool');
    expect(define?.description).toContain('{{args.<name>}}');
    expect(define?.description).toContain('origin must be static');
    expect(define?.description).toContain('resultPath');
  });
});

describe('handleToolCall — tool-source admin handlers', () => {
  const ADMIN_PACKET = { ...PACKET, permissions: ['tools.manage' as const] };

  it('rechecks the permission defensively', async () => {
    const broker = makeBroker({});
    const result = await handleToolCall('tool_sources_list', {}, broker, PACKET);
    expect(getCallText(result as never)).toContain('tools.manage');
  });

  it('define_tool passes the definition through to setCustomTool', async () => {
    const setCustomTool = vi.fn(async () => {});
    const broker = makeBroker({ setCustomTool } as never);
    const binding = {
      method: 'GET',
      urlTemplate: 'https://api.example.com/items/{{args.id}}',
    };
    const result = await handleToolCall(
      'tool_sources_define_tool',
      {
        slug: 'jira',
        name: 'get_issue',
        description: 'Fetch an issue.',
        inputSchema: { type: 'object' },
        binding,
      },
      broker,
      ADMIN_PACKET,
    );
    expect(setCustomTool).toHaveBeenCalledWith('jira', 'get_issue', {
      description: 'Fetch an issue.',
      inputSchema: { type: 'object' },
      binding,
    });
    expect(getCallText(result as never)).toContain('jira__get_issue');
  });

  it('create requires url for mcp sources', async () => {
    const createToolSource = vi.fn();
    const broker = makeBroker({ createToolSource } as never);
    const result = await handleToolCall(
      'tool_sources_create',
      { slug: 'up', kind: 'mcp' },
      broker,
      ADMIN_PACKET,
    );
    expect(createToolSource).not.toHaveBeenCalled();
    expect(getCallText(result as never)).toContain('require `url`');
  });

  it('bindings adds and removes members then reports the bound set', async () => {
    const bindToolSource = vi.fn(async () => {});
    const unbindToolSource = vi.fn(async () => {});
    const getToolSource = vi.fn(async () => ({
      source: {
        id: 'x',
        slug: 'jira',
        kind: 'custom',
        displayName: '',
        enabled: true,
        allMembers: false,
        config: {},
        createdBy: 'a',
        createdAt: 1,
        updatedAt: 1,
        hasCredential: false,
        toolCount: 0,
        bound: true,
      },
      tools: [],
      boundMembers: ['scout'],
    }));
    const broker = makeBroker({ bindToolSource, unbindToolSource, getToolSource } as never);
    const result = await handleToolCall(
      'tool_sources_bindings',
      { slug: 'jira', add: ['scout'], remove: ['old-agent'] },
      broker,
      ADMIN_PACKET,
    );
    expect(bindToolSource).toHaveBeenCalledWith('jira', { member: 'scout' });
    expect(unbindToolSource).toHaveBeenCalledWith('jira', 'old-agent');
    expect(getCallText(result as never)).toContain('Now bound: scout');
  });

  it('set_credential validates headerName for header kind and reports write-only', async () => {
    const setToolCredential = vi.fn(async () => {});
    const broker = makeBroker({ setToolCredential } as never);

    const missing = await handleToolCall(
      'tool_sources_set_credential',
      { slug: 'jira', kind: 'header', secret: 's' },
      broker,
      ADMIN_PACKET,
    );
    expect(getCallText(missing as never)).toContain('headerName');
    expect(setToolCredential).not.toHaveBeenCalled();

    const ok = await handleToolCall(
      'tool_sources_set_credential',
      { slug: 'jira', kind: 'bearer', secret: 'the-pat' },
      broker,
      ADMIN_PACKET,
    );
    expect(setToolCredential).toHaveBeenCalledWith('jira', {
      kind: 'bearer',
      secret: 'the-pat',
    });
    expect(getCallText(ok as never)).toContain('write-only');
  });
});

describe('handleToolCall — external dispatch', () => {
  it('routes namespaced names to invokeTool and relays the result', async () => {
    const invokeTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'PROJ-1: fixed' }],
      isError: false,
    }));
    const broker = makeBroker({ invokeTool } as never);
    const result = await handleToolCall(
      'jira__get_issue',
      { key: 'PROJ-1' },
      broker,
      PACKET,
      EXTERNAL_SOURCES,
    );
    expect(invokeTool).toHaveBeenCalledWith('jira', 'get_issue', { key: 'PROJ-1' });
    expect(getCallText(result as never)).toBe('PROJ-1: fixed');
  });

  it('passes tool-level isError results through verbatim', async () => {
    const invokeTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'upstream returned HTTP 404' }],
      isError: true,
    }));
    const broker = makeBroker({ invokeTool } as never);
    const result = (await handleToolCall(
      'jira__get_issue',
      {},
      broker,
      PACKET,
      EXTERNAL_SOURCES,
    )) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('falls through to unknown-tool when the name matches no source', async () => {
    const invokeTool = vi.fn();
    const broker = makeBroker({ invokeTool } as never);
    const result = await handleToolCall('ghost__tool', {}, broker, PACKET, EXTERNAL_SOURCES);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(getCallText(result as never)).toContain('unknown tool');
  });

  it('maps broker ClientErrors (403 unbind race) to error results', async () => {
    const invokeTool = vi.fn(async () => {
      const err = Object.assign(new Error('forbidden'), {
        name: 'ClientError',
        status: 403,
        body: 'not bound to this tool source',
      });
      throw err;
    });
    const broker = makeBroker({ invokeTool } as never);
    const result = (await handleToolCall(
      'jira__get_issue',
      {},
      broker,
      PACKET,
      EXTERNAL_SOURCES,
    )) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(getCallText(result as never)).toContain('403');
  });
});

// ─── channels_list handler ───────────────────────────────────────────

describe('channels_list handler', () => {
  it('renders joined channels first, then visible non-joined', async () => {
    const broker = makeBroker({
      listChannels: vi.fn(async () => [
        makeChannel({ slug: 'engineering', joined: true, myRole: 'admin', memberCount: 5 }),
        makeChannel({
          id: 'design-id',
          slug: 'design',
          joined: false,
          myRole: null,
          memberCount: 3,
        }),
        makeChannel({
          id: 'ops-id',
          slug: 'ops',
          joined: true,
          myRole: 'member',
          memberCount: 2,
        }),
      ]),
    });
    const result = await handleToolCall('channels_list', {}, broker, PACKET);
    const text = getCallText(
      result as unknown as { content: Array<{ type: string; text?: string }> },
    );
    // Joined section appears before non-joined.
    const engIdx = text.indexOf('#engineering');
    const opsIdx = text.indexOf('#ops');
    const designIdx = text.indexOf('#design');
    expect(engIdx).toBeGreaterThan(-1);
    expect(opsIdx).toBeGreaterThan(-1);
    expect(designIdx).toBeGreaterThan(engIdx);
    expect(text).toMatch(/admin/);
    expect(text).toMatch(/members=5/);
  });

  it('reports the empty case cleanly', async () => {
    const broker = makeBroker({
      listChannels: vi.fn(async () => []),
    });
    const result = await handleToolCall('channels_list', {}, broker, PACKET);
    const text = getCallText(
      result as unknown as { content: Array<{ type: string; text?: string }> },
    );
    expect(text).toMatch(/no channels/i);
  });
});

// ─── channels_post handler ──────────────────────────────────────────

function pushOk(): PushResult {
  return {
    message: {
      id: 'msg-x',
      ts: 1,
      to: null,
      from: 'scout',
      title: null,
      body: 'b',
      level: 'info',
      data: {},
      attachments: [],
    } as Message,
    delivery: { live: 1, targets: 1 },
  };
}

describe('channels_post handler', () => {
  it('resolves slug → id and stamps data.thread = chan:<id>', async () => {
    const push = vi.fn(async (_p: PushPayload): Promise<PushResult> => pushOk());
    const broker = makeBroker({
      getChannel: vi.fn(
        async (_slug: string): Promise<GetChannelResponse> => ({
          channel: makeChannel({ slug: 'engineering', joined: true, myRole: 'member' }),
          members: [],
        }),
      ),
      push,
    });
    const result = await handleToolCall(
      'channels_post',
      { channel: 'engineering', body: 'hi team' },
      broker,
      PACKET,
    );
    expect(getCallText(result as never)).toMatch(/posted to #engineering/);
    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0]?.[0] as PushPayload;
    expect(arg.body).toBe('hi team');
    expect((arg.data as { thread?: string })?.thread).toBe('chan:eng-id-123');
    // No `to` for channel posts — the broker resolves recipients
    // server-side from channel membership.
    expect(arg.to).toBeUndefined();
  });

  it('errors with a useful hint when channel does not exist', async () => {
    const broker = makeBroker({
      getChannel: vi.fn(async () => {
        const err = Object.assign(new Error('not found'), { name: 'ClientError', status: 404 });
        throw err;
      }),
    });
    const result = await handleToolCall(
      'channels_post',
      { channel: 'ghost', body: 'hi' },
      broker,
      PACKET,
    );
    const text = getCallText(result as never);
    expect(text).toMatch(/no channel/);
    expect(text).toMatch(/channels_list/);
  });

  it('errors when caller is not a member of the channel', async () => {
    const broker = makeBroker({
      getChannel: vi.fn(
        async (): Promise<GetChannelResponse> => ({
          channel: makeChannel({ slug: 'private', joined: false, myRole: null }),
          members: [],
        }),
      ),
    });
    const result = await handleToolCall(
      'channels_post',
      { channel: 'private', body: 'hi' },
      broker,
      PACKET,
    );
    expect(getCallText(result as never)).toMatch(/not a member/);
  });

  it('rejects missing required args', async () => {
    const broker = makeBroker({});
    const noChannel = await handleToolCall('channels_post', { body: 'x' }, broker, PACKET);
    expect(getCallText(noChannel as never)).toMatch(/channel/);
    const noBody = await handleToolCall(
      'channels_post',
      { channel: 'engineering' },
      broker,
      PACKET,
    );
    expect(getCallText(noBody as never)).toMatch(/body/);
  });
});

// ─── recent (extended with channel arg) ─────────────────────────────

describe('recent handler — channel arg', () => {
  it('resolves slug → id and queries history({channel: id})', async () => {
    const history = vi.fn(async () => [] as Message[]);
    const broker = makeBroker({
      getChannel: vi.fn(
        async (_slug: string): Promise<GetChannelResponse> => ({
          channel: makeChannel({ slug: 'engineering' }),
          members: [],
        }),
      ),
      history,
    });
    await handleToolCall('recent', { channel: 'engineering' }, broker, PACKET);
    expect(history).toHaveBeenCalledWith(expect.objectContaining({ channel: 'eng-id-123' }));
    // `with` should NOT be set — channel + with are mutually exclusive.
    expect(history).toHaveBeenCalledWith(expect.not.objectContaining({ with: expect.anything() }));
  });

  it('rejects passing both `with` and `channel`', async () => {
    const broker = makeBroker({});
    const result = await handleToolCall(
      'recent',
      { with: 'director', channel: 'engineering' },
      broker,
      PACKET,
    );
    expect(getCallText(result as never)).toMatch(/with.*channel/i);
  });

  it('renders the empty-channel message with the slug', async () => {
    const broker = makeBroker({
      getChannel: vi.fn(
        async (): Promise<GetChannelResponse> => ({
          channel: makeChannel({ slug: 'engineering' }),
          members: [],
        }),
      ),
      history: vi.fn(async () => [] as Message[]),
    });
    const result = await handleToolCall('recent', { channel: 'engineering' }, broker, PACKET);
    expect(getCallText(result as never)).toMatch(/#engineering/);
  });

  it('returns a useful error when channel does not exist', async () => {
    const broker = makeBroker({
      getChannel: vi.fn(async () => {
        const err = Object.assign(new Error('nope'), { name: 'ClientError', status: 404 });
        throw err;
      }),
    });
    const result = await handleToolCall('recent', { channel: 'ghost' }, broker, PACKET);
    expect(getCallText(result as never)).toMatch(/no channel/);
  });
});

// ─── External Notifications admin tools ─────────────────────────────

const NOTIFICATION_ADMIN_NAMES = [
  'notifications_list',
  'notifications_view',
  'notifications_create',
  'notifications_update',
  'notifications_delete',
  'notifications_set_secret',
  'notifications_delete_secret',
  'notifications_deliveries',
  'notifications_replay',
  'notifications_profiles',
  'notifications_profile_create',
  'notifications_profile_delete',
  'notifications_profile_set_secret',
];

const NOTIF_ADMIN_PACKET: InstructionsResponse = {
  ...PACKET,
  permissions: ['notifications.manage'],
};

function makeEndpointSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ep-1',
    slug: 'ci-alerts',
    displayName: 'CI Alerts',
    description: '',
    enabled: true,
    auth: { kind: 'hmac-sha256', headerName: null, prefix: null },
    authProfile: null,
    targets: [{ member: 'scout' }],
    level: 'warning',
    title: null,
    template: null,
    filters: [],
    policy: {
      ifOffline: 'queue',
      ifBusy: 'now',
      debounceMs: 0,
      debounceMax: 20,
      queueTtlMs: 86_400_000,
      maxWaitMs: 900_000,
    },
    dedupeHeader: null,
    createdBy: 'director',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    hasSecret: true,
    ...overrides,
  };
}

describe('defineTools — notifications admin gating', () => {
  it('hides the family without notifications.manage', () => {
    const names = defineTools(PACKET).map((t) => t.name);
    for (const name of NOTIFICATION_ADMIN_NAMES) {
      expect(names).not.toContain(name);
    }
  });

  it('shows the whole family with notifications.manage', () => {
    const names = defineTools(NOTIF_ADMIN_PACKET).map((t) => t.name);
    for (const name of NOTIFICATION_ADMIN_NAMES) {
      expect(names).toContain(name);
    }
  });
});

describe('handleToolCall — notifications admin handlers', () => {
  it('re-checks the permission defensively', async () => {
    const result = await handleToolCall('notifications_list', {}, makeBroker(), PACKET);
    expect(getCallText(result as never)).toContain('notifications.manage');
  });

  it('lists endpoints with targets, policy flags, and secret state', async () => {
    const listNotificationEndpoints = vi.fn(async () => [makeEndpointSummary()]);
    const broker = makeBroker({ listNotificationEndpoints } as never);
    const result = await handleToolCall('notifications_list', {}, broker, NOTIF_ADMIN_PACKET);
    const text = getCallText(result as never);
    expect(text).toContain('ci-alerts');
    expect(text).toContain('@scout');
    expect(text).toContain('queue-offline');
    expect(text).not.toContain('NO-SECRET');
  });

  it('create parses @/# targets and flattened auth/policy args into the request', async () => {
    const createNotificationEndpoint = vi.fn(async () => makeEndpointSummary());
    const broker = makeBroker({ createNotificationEndpoint } as never);
    const result = await handleToolCall(
      'notifications_create',
      {
        slug: 'ci-alerts',
        targets: ['@scout', '#ops', 'bare-name'],
        authKind: 'hmac-sha256',
        authHeader: 'x-sig',
        ifOffline: 'queue',
        debounceMs: 5000,
        level: 'warning',
      },
      broker,
      NOTIF_ADMIN_PACKET,
    );
    expect(createNotificationEndpoint).toHaveBeenCalledWith({
      slug: 'ci-alerts',
      targets: [{ member: 'scout' }, { channel: 'ops' }, { member: 'bare-name' }],
      auth: { kind: 'hmac-sha256', headerName: 'x-sig' },
      policy: { ifOffline: 'queue', debounceMs: 5000 },
      level: 'warning',
    });
    expect(getCallText(result as never)).toContain('/hooks/ci-alerts');
  });

  it('create rejects a missing/empty targets array', async () => {
    const result = await handleToolCall(
      'notifications_create',
      { slug: 'x', targets: [] },
      makeBroker(),
      NOTIF_ADMIN_PACKET,
    );
    expect(getCallText(result as never)).toMatch(/targets/);
  });

  it('set_secret never echoes the secret back', async () => {
    const setNotificationEndpointSecret = vi.fn(async () => {});
    const broker = makeBroker({ setNotificationEndpointSecret } as never);
    const result = await handleToolCall(
      'notifications_set_secret',
      { slug: 'ci-alerts', secret: 'super-secret-value' },
      broker,
      NOTIF_ADMIN_PACKET,
    );
    expect(setNotificationEndpointSecret).toHaveBeenCalledWith('ci-alerts', {
      secret: 'super-secret-value',
    });
    expect(getCallText(result as never)).not.toContain('super-secret-value');
  });

  it('lists deliveries with status and reason', async () => {
    const listNotificationDeliveries = vi.fn(async () => [
      {
        id: 'd-1',
        endpointSlug: 'ci-alerts',
        receivedAt: 1_700_000_000_000,
        status: 'rejected',
        statusReason: 'signature mismatch',
        dedupeKey: null,
        messageIds: [],
        bodyPreview: '{}',
        contentType: 'application/json',
        overrides: null,
        deliveredAt: null,
        replayOf: null,
      },
    ]);
    const broker = makeBroker({ listNotificationDeliveries } as never);
    const result = await handleToolCall(
      'notifications_deliveries',
      { slug: 'ci-alerts', limit: 5 },
      broker,
      NOTIF_ADMIN_PACKET,
    );
    expect(listNotificationDeliveries).toHaveBeenCalledWith('ci-alerts', { limit: 5 });
    const text = getCallText(result as never);
    expect(text).toContain('rejected');
    expect(text).toContain('signature mismatch');
  });

  it('replay reports the fresh delivery id and status', async () => {
    const replayNotificationDelivery = vi.fn(async () => ({
      id: 'd-2',
      endpointSlug: 'ci-alerts',
      receivedAt: 1_700_000_001_000,
      status: 'delivered',
      statusReason: null,
      dedupeKey: null,
      messageIds: ['msg-9'],
      bodyPreview: '{}',
      contentType: null,
      overrides: null,
      deliveredAt: 1_700_000_001_000,
      replayOf: 'd-1',
    }));
    const broker = makeBroker({ replayNotificationDelivery } as never);
    const result = await handleToolCall(
      'notifications_replay',
      { deliveryId: 'd-1' },
      broker,
      NOTIF_ADMIN_PACKET,
    );
    expect(getCallText(result as never)).toContain('d-2');
    expect(getCallText(result as never)).toContain('delivered');
  });
});

describe('variables admin tools — the agent-facing half of the runner environment', () => {
  const ADMIN_PACKET = { ...PACKET, permissions: ['secrets.manage' as const] };

  it('are gated on secrets.manage, like secrets', () => {
    expect(defineTools(PACKET).map((t) => t.name)).not.toContain('variables_list');
    expect(defineTools(ADMIN_PACKET).map((t) => t.name)).toContain('variables_list');
  });

  it('exposes the same verbs as the secrets surface', () => {
    // After the split, identity leaves `secrets_list` and has to arrive
    // somewhere an agent can reach. A partial surface is how a
    // capability becomes an accident of where it was built.
    const names = defineTools(ADMIN_PACKET).map((t) => t.name);
    for (const verb of [
      'list',
      'view',
      'create',
      'update',
      'delete',
      'set_value',
      'delete_value',
      'bindings',
    ]) {
      expect(names).toContain(`secrets_${verb}`);
      expect(names).toContain(`variables_${verb}`);
    }
  });

  it('states the classification rule in the descriptions, since that is the only spec an agent gets', () => {
    const tools = defineTools(ADMIN_PACKET);
    const list = tools.find((t) => t.name === 'variables_list');
    // An agent that cannot tell which store holds git identity will
    // look in the wrong one and conclude it is unconfigured.
    expect(list?.description).toContain('GIT_AUTHOR_NAME');
    expect(list?.description).toContain('secrets_list');
    // And the residue: a value here is published, not protected.
    expect(list?.description).toMatch(/NOT redacted/);
    const create = tools.find((t) => t.name === 'variables_create');
    expect(create?.description).toMatch(/409|collision|collid/i);
  });

  it('rechecks the permission defensively even though the broker also enforces it', async () => {
    const broker = makeBroker({});
    const result = await handleToolCall('variables_list', {}, broker, PACKET);
    expect(getCallText(result as never)).toContain('secrets.manage');
  });

  it('renders the value, and distinguishes unset from not-visible', async () => {
    const listVariables = vi.fn(async () => [
      {
        id: '1',
        slug: 'cora-git-author-name',
        envName: 'GIT_AUTHOR_NAME',
        description: '',
        enabled: true,
        allMembers: false,
        createdBy: 'admin',
        createdAt: 0,
        updatedAt: 0,
        hasValue: true,
        bound: true,
        value: 'Cora',
      },
      {
        id: '2',
        slug: 'hidden',
        envName: 'REGION',
        description: '',
        enabled: true,
        allMembers: false,
        createdBy: 'admin',
        createdAt: 0,
        updatedAt: 0,
        hasValue: true,
        bound: false,
        // value withheld — set, but not visible to this caller
      },
      {
        id: '3',
        slug: 'empty',
        envName: 'UNSET_ONE',
        description: '',
        enabled: true,
        allMembers: false,
        createdBy: 'admin',
        createdAt: 0,
        updatedAt: 0,
        hasValue: false,
        bound: false,
      },
    ]);
    const broker = makeBroker({ listVariables } as never);
    const text = getCallText(
      (await handleToolCall('variables_list', {}, broker, ADMIN_PACKET)) as never,
    );

    // The value itself — the capability that distinguishes this surface.
    expect(text).toContain('"Cora"');
    // Set-but-hidden and unset must not render identically; an agent
    // that reads both as blank concludes a configured variable is
    // missing and re-creates it.
    expect(text).toContain('(value hidden)');
    expect(text).toContain('NO-VALUE');
  });
});
