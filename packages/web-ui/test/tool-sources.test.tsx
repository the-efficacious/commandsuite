/**
 * Tool-sources UI tests — permission gating, list rendering, source
 * creation, and the detail view's bind/credential actions, driven
 * through a stubbed fetch + real SDK Client so schema validation runs
 * end-to-end.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { Client } from 'csuite-sdk/client';
import type { BriefingResponse, ToolSourceSummary } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolSourceDetail } from '../src/components/ToolSourceDetail.js';
import {
  __resetToolSourcesPanelForTests,
  ToolSourcesPanel,
} from '../src/components/ToolSourcesPanel.js';
import { __resetBriefingForTests, briefing } from '../src/lib/briefing.js';
import { __resetClientForTests, setClient } from '../src/lib/client.js';
import { __resetToolSourcesForTests, toolSources } from '../src/lib/tool-sources.js';

const originalFetch = globalThis.fetch;

function mkBriefing(permissions: BriefingResponse['permissions']): BriefingResponse {
  return {
    name: 'director-1',
    role: { title: 'director', description: '' },
    permissions,
    instructions: '',
    team: { name: 'demo', directive: 'ship', context: '', permissionPresets: {} },
    teammates: [
      { name: 'director-1', role: { title: 'director', description: '' }, permissions: [] },
      { name: 'scout', role: { title: 'engineer', description: '' }, permissions: [] },
    ],
    openObjectives: [],
    toolSources: [],
  };
}

function mkSource(overrides: Partial<ToolSourceSummary> = {}): ToolSourceSummary {
  return {
    id: 'ts-1',
    slug: 'jira',
    kind: 'custom',
    displayName: 'Jira',
    enabled: true,
    allMembers: false,
    config: {},
    createdBy: 'director-1',
    createdAt: 1,
    updatedAt: 1,
    hasCredential: true,
    toolCount: 1,
    bound: false,
    ...overrides,
  };
}

interface Captured {
  url: string;
  init: RequestInit;
}

function stubFetch(
  routes: Array<[method: string, suffix: string, body: unknown, status?: number]>,
  captured?: Captured[],
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    captured?.push({ url, init });
    for (const [m, suffix, body, status] of routes) {
      if (m === method && url.includes(suffix)) {
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: status ?? 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
    }
    return Promise.resolve(new Response('{"error":"no stub route"}', { status: 500 }));
  }) as typeof fetch;
  setClient(new Client({ url: 'http://localhost', useCookies: true }));
}

beforeEach(() => {
  __resetBriefingForTests();
  __resetClientForTests();
  __resetToolSourcesForTests();
  __resetToolSourcesPanelForTests();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('ToolSourcesPanel', () => {
  it('shows a restricted callout without tools.manage', () => {
    briefing.value = mkBriefing(['members.manage']);
    stubFetch([['GET', '/tool-sources', { sources: [] }]]);
    render(<ToolSourcesPanel />);
    expect(screen.getByText(/requires the tools\.manage permission/i)).toBeTruthy();
  });

  it('lists sources with kind + credential state and links to detail', async () => {
    briefing.value = mkBriefing(['tools.manage']);
    stubFetch([
      [
        'GET',
        '/tool-sources',
        {
          sources: [
            mkSource(),
            mkSource({
              id: 'ts-2',
              slug: 'up',
              kind: 'mcp',
              config: { url: 'https://mcp.example.com' },
              hasCredential: false,
              toolCount: 3,
            }),
          ],
        },
      ],
    ]);
    render(<ToolSourcesPanel />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /manage tool source jira/i })).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: /manage tool source up/i })).toBeTruthy();
    expect(screen.getByText('MCP')).toBeTruthy();
    expect(screen.getByText('Custom')).toBeTruthy();
    expect(screen.getByText(/3 tools/i)).toBeTruthy();
  });

  it('shows the empty state when the registry is empty', async () => {
    briefing.value = mkBriefing(['tools.manage']);
    stubFetch([['GET', '/tool-sources', { sources: [] }]]);
    render(<ToolSourcesPanel />);
    await waitFor(() => {
      expect(screen.getByText(/no tool sources yet/i)).toBeTruthy();
    });
  });

  it('creates a source via the inline form (POST /tool-sources)', async () => {
    briefing.value = mkBriefing(['tools.manage']);
    const captured: Captured[] = [];
    stubFetch(
      [
        ['POST', '/tool-sources', mkSource({ slug: 'github' }), 201],
        ['GET', '/tool-sources/github', { source: mkSource({ slug: 'github' }), tools: [] }],
        ['GET', '/tool-sources', { sources: [mkSource({ slug: 'github' })] }],
      ],
      captured,
    );
    render(<ToolSourcesPanel />);
    fireEvent.click(screen.getByRole('button', { name: /new source/i }));
    const slugInput = screen.getByPlaceholderText('jira');
    fireEvent.input(slugInput, { target: { value: 'github' } });
    fireEvent.click(screen.getByRole('button', { name: /register source/i }));

    await waitFor(() => {
      const post = captured.find(
        (c) => (c.init.method ?? 'GET') === 'POST' && c.url.endsWith('/tool-sources'),
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.init.body))).toMatchObject({
        slug: 'github',
        kind: 'custom',
      });
    });
  });
});

describe('ToolSourceDetail', () => {
  it('renders sections and binds a member', async () => {
    briefing.value = mkBriefing(['tools.manage']);
    toolSources.value = [mkSource()];
    const captured: Captured[] = [];
    stubFetch(
      [
        [
          'GET',
          '/tool-sources/jira',
          {
            source: mkSource(),
            tools: [
              {
                name: 'get_issue',
                description: 'Fetch a Jira issue.',
                inputSchema: { type: 'object' },
                binding: { method: 'GET', urlTemplate: 'https://x.example.com/{{args.key}}' },
              },
            ],
            boundMembers: [],
          },
        ],
        ['POST', '/bindings', { ok: true, boundMembers: ['scout'] }],
        ['GET', '/tool-sources', { sources: [mkSource()] }],
      ],
      captured,
    );
    render(<ToolSourceDetail slug="jira" />);

    await waitFor(() => {
      expect(screen.getByText('jira__get_issue')).toBeTruthy();
    });
    expect(screen.getByText(/a credential is set/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/member to bind/i), { target: { value: 'scout' } });
    fireEvent.click(screen.getByRole('button', { name: /bind member/i }));
    await waitFor(() => {
      const post = captured.find(
        (c) => (c.init.method ?? 'GET') === 'POST' && c.url.includes('/bindings'),
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.init.body))).toEqual({ member: 'scout' });
    });
  });

  it('sets a credential write-only (PUT /credential)', async () => {
    briefing.value = mkBriefing(['tools.manage']);
    toolSources.value = [mkSource({ hasCredential: false })];
    const captured: Captured[] = [];
    stubFetch(
      [
        ['GET', '/tool-sources/jira', { source: mkSource(), tools: [], boundMembers: [] }],
        ['PUT', '/credential', { ok: true }],
        ['GET', '/tool-sources', { sources: [mkSource()] }],
      ],
      captured,
    );
    render(<ToolSourceDetail slug="jira" />);
    await waitFor(() => {
      expect(screen.getByText(/no credential set/i)).toBeTruthy();
    });
    fireEvent.input(screen.getByLabelText(/secret/i), { target: { value: 'the-pat' } });
    fireEvent.click(screen.getByRole('button', { name: /set credential/i }));
    await waitFor(() => {
      const put = captured.find((c) => (c.init.method ?? 'GET') === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(String(put?.init.body))).toEqual({ kind: 'bearer', secret: 'the-pat' });
    });
  });

  it('requires a second click to delete', async () => {
    briefing.value = mkBriefing(['tools.manage']);
    toolSources.value = [mkSource()];
    const captured: Captured[] = [];
    stubFetch(
      [
        ['GET', '/tool-sources/jira', { source: mkSource(), tools: [], boundMembers: [] }],
        ['DELETE', '/tool-sources/jira', { ok: true }],
        ['GET', '/tool-sources', { sources: [] }],
      ],
      captured,
    );
    render(<ToolSourceDetail slug="jira" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /delete source/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /delete source/i }));
    expect(captured.some((c) => (c.init.method ?? 'GET') === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /click again to permanently delete/i }));
    await waitFor(() => {
      expect(captured.some((c) => (c.init.method ?? 'GET') === 'DELETE')).toBe(true);
    });
  });
});
