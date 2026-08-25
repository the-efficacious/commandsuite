/**
 * Redirect handling in the custom-tool executor.
 *
 * A custom tool's credential is broker-held on purpose: the agent
 * invoking the tool is never supposed to see it. `redirect: 'follow'`
 * quietly undid that. The runtime strips `Authorization` on a
 * cross-origin hop — so `kind: 'bearer'` was covered — but a
 * `kind: 'header'` credential is an ordinary header to the fetch spec
 * and travels to wherever the redirect points. Tool arguments reach the
 * path and query, so the agent can pick that destination via a
 * cooperative upstream's open redirect.
 *
 * The same hop also walked straight past the origin pin, which was
 * checked once, before the first request.
 */

import type { CustomToolBinding } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { executeCustomTool } from '../src/tool-sources/custom-executor.js';

const binding = (overrides: Partial<CustomToolBinding> = {}): CustomToolBinding => ({
  method: 'GET',
  urlTemplate: 'https://api.example.com/things/{{args.id}}',
  ...overrides,
});

const CREDENTIAL = {
  kind: 'header' as const,
  headerName: 'X-Api-Key',
  secret: 'super-secret',
  updatedAt: 1_700_000_000_000,
};

/** A fetch stub that replays a scripted chain and records every hop. */
function scriptedFetch(steps: Array<{ status: number; location?: string; body?: string }>) {
  const seen: Array<{
    url: string;
    headers: Record<string, string>;
    method: string;
    body: BodyInit | null | undefined;
  }> = [];
  let call = 0;
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    seen.push({ url: String(url), headers, method: init?.method ?? 'GET', body: init?.body });
    const step = steps[Math.min(call++, steps.length - 1)];
    if (!step) throw new Error('fetch stub exhausted');
    return new Response(step.body ?? '', {
      status: step.status,
      headers: step.location
        ? { location: step.location, 'content-type': 'application/json' }
        : { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe('custom tool executor — redirects', () => {
  it('refuses a cross-origin redirect and sends the credential nowhere else', async () => {
    const { impl, seen } = scriptedFetch([
      { status: 302, location: 'https://evil.example.net/collect' },
      { status: 200, body: '{}' },
    ]);

    const result = await executeCustomTool({
      binding: binding(),
      credential: CREDENTIAL,
      args: { id: '1' },
      fetchImpl: impl,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/redirected off the configured origin/);
    // One request only: the hop was never made.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://api.example.com/things/1');
    // And the secret went only to the origin the operator configured.
    expect(seen.every((hop) => hop.url.startsWith('https://api.example.com/'))).toBe(true);
    expect(seen[0]?.headers['x-api-key']).toBe('super-secret');
  });

  it('blocks the agent-steered open redirect, argument or not', async () => {
    // The realistic shape: the upstream is legitimate, and the agent
    // supplies the path that makes it bounce.
    const { impl, seen } = scriptedFetch([
      { status: 302, location: 'https://attacker.example.org/?leak=1' },
    ]);
    const result = await executeCustomTool({
      binding: binding({ urlTemplate: 'https://api.example.com/redirect?to={{args.id}}' }),
      credential: CREDENTIAL,
      args: { id: 'https://attacker.example.org/' },
      fetchImpl: impl,
    });
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('refuses a redirect to loopback, which the save-time rule already forbids', async () => {
    const { impl, seen } = scriptedFetch([{ status: 307, location: 'http://127.0.0.1:9200/_all' }]);
    const result = await executeCustomTool({
      binding: binding(),
      credential: CREDENTIAL,
      args: { id: '1' },
      fetchImpl: impl,
    });
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('follows a same-origin redirect and keeps the credential attached', async () => {
    const { impl, seen } = scriptedFetch([
      { status: 302, location: 'https://api.example.com/things/1/canonical' },
      { status: 200, body: '{"ok":true}' },
    ]);
    const result = await executeCustomTool({
      binding: binding(),
      credential: CREDENTIAL,
      args: { id: '1' },
      fetchImpl: impl,
    });
    expect(result.isError).toBeUndefined();
    expect(seen.map((h) => h.url)).toEqual([
      'https://api.example.com/things/1',
      'https://api.example.com/things/1/canonical',
    ]);
    expect(seen[1]?.headers['x-api-key']).toBe('super-secret');
  });

  it('drops to GET on a 303, as every HTTP client does', async () => {
    const { impl, seen } = scriptedFetch([
      { status: 303, location: 'https://api.example.com/result' },
      { status: 200, body: '{}' },
    ]);
    await executeCustomTool({
      binding: binding({
        method: 'POST',
        urlTemplate: 'https://api.example.com/things',
        bodyTemplate: { id: '{{args.id}}' },
      }),
      credential: CREDENTIAL,
      args: { id: '1' },
      fetchImpl: impl,
    });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[1]?.method).toBe('GET');
    expect(seen[1]?.body).toBeNull();
    expect(seen[1]?.headers['content-type']).toBeUndefined();
  });

  it.each([
    ['PUT', 301],
    ['PUT', 302],
    ['PATCH', 301],
    ['PATCH', 302],
    ['DELETE', 301],
    ['DELETE', 302],
  ] as const)('preserves %s across a %s redirect', async (method, status) => {
    const { impl, seen } = scriptedFetch([
      { status, location: 'https://api.example.com/canonical' },
      { status: 200, body: '{}' },
    ]);
    await executeCustomTool({
      binding: binding({ method, bodyTemplate: 'payload' }),
      credential: CREDENTIAL,
      args: { id: '1' },
      fetchImpl: impl,
    });

    expect(seen.map((hop) => hop.method)).toEqual([method, method]);
    expect(seen[1]?.body).toBe('payload');
    expect(seen[1]?.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('changes POST to GET on a 302', async () => {
    const { impl, seen } = scriptedFetch([
      { status: 302, location: 'https://api.example.com/canonical' },
      { status: 200, body: '{}' },
    ]);
    await executeCustomTool({
      binding: binding({ method: 'POST', bodyTemplate: 'payload' }),
      credential: CREDENTIAL,
      args: { id: '1' },
      fetchImpl: impl,
    });

    expect(seen.map((hop) => hop.method)).toEqual(['POST', 'GET']);
    expect(seen[1]?.body).toBeNull();
  });

  it('gives up rather than chase an endless same-origin loop', async () => {
    const { impl, seen } = scriptedFetch([{ status: 302, location: 'https://api.example.com/a' }]);
    const result = await executeCustomTool({
      binding: binding(),
      credential: CREDENTIAL,
      args: { id: '1' },
      fetchImpl: impl,
    });
    expect(result.isError).toBe(true);
    expect(seen.length).toBeLessThanOrEqual(6);
  });

  it('leaves a plain 200 alone', async () => {
    const { impl } = scriptedFetch([{ status: 200, body: '{"value":42}' }]);
    const result = await executeCustomTool({
      binding: binding(),
      credential: CREDENTIAL,
      args: { id: '1' },
      fetchImpl: impl,
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain('42');
  });
});
