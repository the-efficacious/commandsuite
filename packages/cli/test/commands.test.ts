import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'csuite-sdk/client';
import type { Message, Presence, PushResult, Teammate } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { buildPushPayload, runPushCommand, UsageError } from '../src/commands/push.js';
import { runRosterCommand } from '../src/commands/roster.js';

function mockFetch(handler: (url: URL, init: RequestInit) => Response): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('buildPushPayload', () => {
  it('rejects missing body', () => {
    expect(() => buildPushPayload({ body: '', to: 'a' })).toThrow(UsageError);
  });

  it('rejects when neither --agent nor --broadcast is set', () => {
    expect(() => buildPushPayload({ body: 'hi' })).toThrow(UsageError);
  });

  it('rejects when both --agent and --broadcast are set', () => {
    expect(() => buildPushPayload({ body: 'hi', to: 'a', broadcast: true })).toThrow(UsageError);
  });

  it('rejects an invalid --level', () => {
    expect(() => buildPushPayload({ body: 'hi', to: 'a', level: 'bogus' })).toThrow(UsageError);
  });

  it('targeted push produces an agentId payload', () => {
    const p = buildPushPayload({ body: 'hi', to: 'a1', title: 't' });
    expect(p.to).toBe('a1');
    expect(p.body).toBe('hi');
    expect(p.title).toBe('t');
    expect(p.level).toBe('info');
  });

  it('broadcast produces a null agentId payload', () => {
    const p = buildPushPayload({ body: 'hi', broadcast: true });
    expect(p.to).toBe(null);
  });

  it('honors a valid --level', () => {
    const p = buildPushPayload({ body: 'hi', broadcast: true, level: 'warning' });
    expect(p.level).toBe('warning');
  });
});

describe('runPushCommand', () => {
  it('issues a POST /push and returns a formatted summary', async () => {
    const fakeMessage: Message = {
      id: 'msg-x',
      ts: 1,
      to: 'a1',
      from: 'alice',
      title: null,
      body: 'hi',
      level: 'info',
      data: {},
      attachments: [],
    };
    const fakeResult: PushResult = {
      delivery: { live: 2, targets: 1 },
      message: fakeMessage,
    };
    let captured: { method?: string; path?: string; body?: string } = {};
    const client = new Client({
      url: 'http://broker.test',
      token: 'secret',
      fetch: mockFetch((url, init) => {
        captured = {
          method: init.method ?? 'GET',
          path: url.pathname,
          body: typeof init.body === 'string' ? init.body : undefined,
        };
        return jsonResponse(fakeResult);
      }),
    });
    const out = await runPushCommand({ to: 'a1', body: 'hi' }, client);
    expect(captured.method).toBe('POST');
    expect(captured.path).toBe('/push');
    expect(out).toContain('delivered to a1');
    expect(out).toContain('msg-x');
    expect(out).toContain('live: 2');
    expect(out).toContain('targets: 1');
  });
});

describe('runRosterCommand', () => {
  it('renders a formatted table when teammates exist', async () => {
    const teammates: Teammate[] = [
      {
        name: 'director-1',
        role: { title: 'engineer', description: '' },
        permissions: ['members.manage'],
      },
      { name: 'engineer-1', role: { title: 'engineer', description: '' }, permissions: [] },
    ];
    const connected: Presence[] = [
      {
        name: 'director-1',
        connected: 1,
        createdAt: 1_700_000_000_000,
        lastSeen: 1_700_000_100_000,
        role: { title: 'engineer', description: '' },
      },
    ];
    const client = new Client({
      url: 'http://broker.test',
      token: 'secret',
      fetch: mockFetch(() => jsonResponse({ teammates, connected })),
    });
    const out = await runRosterCommand(client);
    expect(out).toContain('name');
    expect(out).toContain('director-1');
    expect(out).toContain('engineer-1');
    expect(out).toContain('engineer');
    expect(out).toContain('members.manage');
  });

  it('renders a friendly message when empty', async () => {
    const client = new Client({
      url: 'http://broker.test',
      token: 'secret',
      fetch: mockFetch(() => jsonResponse({ teammates: [], connected: [] })),
    });
    const out = await runRosterCommand(client);
    expect(out).toBe('no members defined');
  });
});

/**
 * The top-level `USAGE` block is the CLI's primary discovery surface:
 * every verb `main()` dispatches has to appear in it. The only
 * exceptions are the hidden `mcp-bridge` verb and the aliases, which
 * are named here so that adding another is a deliberate act.
 *
 * `src/index.ts` runs `main()` on import, so this reads the source
 * text rather than importing the module.
 */
describe('top-level usage', () => {
  const HIDDEN = new Set(['mcp-bridge']);
  const ALIASES = new Set(['claude-code', 'vars', 'hooks']);
  const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');

  function captures(text: string, pattern: RegExp): string[] {
    const found: string[] = [];
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      if (value) found.push(value);
    }
    return found;
  }

  function usageBlock(): string {
    const start = source.indexOf('const USAGE = `');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n`;\n', start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('documents every dispatched verb and no others', () => {
    const dispatched = [...new Set(captures(source, /case '([a-z][a-z0-9-]*)':/g))]
      .filter((verb) => !HIDDEN.has(verb) && !ALIASES.has(verb))
      .sort();
    const documented = [...new Set(captures(usageBlock(), /^ {2}csuite (\S+)/gm))]
      .filter((verb) => !verb.includes('<'))
      .sort();
    expect(documented).toEqual(dispatched);
  });

  it('gives `csuite team` exactly the subcommands runTeamCommand dispatches', () => {
    const line = usageBlock()
      .split('\n')
      .find((candidate) => /^ {2}csuite team\s/.test(candidate));
    expect(line).toBeDefined();
    const listed = /^ {2}csuite team +(\S+)/.exec(line ?? '');
    expect(listed).not.toBeNull();
    expect(listed?.[1]?.split('|').sort()).toEqual(['get', 'set', 'status']);
  });
});
