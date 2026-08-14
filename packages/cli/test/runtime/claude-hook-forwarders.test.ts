/**
 * Hook forwarder unit tests — the SDK in-process hook callbacks that
 * keep the capture host's hook server fed.
 *
 * The forwarders replace the `.claude/settings.json` `type: "http"`
 * hook entries the CLI wrapper used to write: same endpoint, same
 * payload shape, so the hook server's routing (busy signal, transcript
 * path discovery, SessionStart re-brief relay) is exercised unchanged.
 * What's asserted here: every registered event forwards, POSTs stay
 * ordered (Pre/Post pairs must not reorder), the separately-passed
 * tool_use_id callback argument is merged into the body, and the agent
 * loop is never blocked by a dead endpoint.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHookForwarders } from '../../src/runtime/agents/claude-agent.js';
import { silentLogger } from '../helpers/logger.js';

interface ReceivedBody {
  hook_event_name?: string;
  tool_use_id?: string;
  [key: string]: unknown;
}

describe('buildHookForwarders', () => {
  let server: Server;
  let url: string;
  let received: ReceivedBody[];
  let resolveNext: (() => void) | null = null;

  beforeEach(async () => {
    received = [];
    server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => {
        received.push(JSON.parse(Buffer.concat(parts).toString('utf8')));
        resolveNext?.();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/tool-event`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  const waitForCount = async (n: number, timeoutMs = 2_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (received.length < n && Date.now() < deadline) {
      await new Promise<void>((r) => {
        resolveNext = r;
        setTimeout(r, 20);
      });
    }
    expect(received.length).toBeGreaterThanOrEqual(n);
  };

  it('registers the eight events the hook server routes on', () => {
    const hooks = buildHookForwarders(url, silentLogger());
    expect(Object.keys(hooks).sort()).toEqual([
      'Notification',
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'SessionStart',
      'Stop',
      'SubagentStop',
      'UserPromptSubmit',
    ]);
  });

  it('forwards payloads in order and merges the tool_use_id argument', async () => {
    const hooks = buildHookForwarders(url, silentLogger());
    const pre = hooks.PreToolUse?.[0]?.hooks[0];
    const post = hooks.PostToolUse?.[0]?.hooks[0];
    expect(pre).toBeDefined();
    expect(post).toBeDefined();
    if (!pre || !post) return;

    const abort = new AbortController();
    const preInput = {
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/tmp',
      tool_name: 'Bash',
      tool_input: {},
    } as unknown as HookInput;
    const postInput = {
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/tmp',
      tool_name: 'Bash',
      tool_input: {},
      tool_response: {},
    } as unknown as HookInput;

    const preResult = await pre(preInput, 'tu-1', { signal: abort.signal });
    const postResult = await post(postInput, 'tu-1', { signal: abort.signal });
    expect(preResult).toEqual({ continue: true });
    expect(postResult).toEqual({ continue: true });

    await waitForCount(2);
    expect(received[0]?.hook_event_name).toBe('PreToolUse');
    expect(received[0]?.tool_use_id).toBe('tu-1');
    expect(received[1]?.hook_event_name).toBe('PostToolUse');
    expect(received[1]?.tool_use_id).toBe('tu-1');
  });

  it('returns immediately even when the endpoint is dead', async () => {
    const hooks = buildHookForwarders('http://127.0.0.1:1/hook/tool-event', silentLogger());
    const stop = hooks.Stop?.[0]?.hooks[0];
    expect(stop).toBeDefined();
    if (!stop) return;
    const abort = new AbortController();
    const input = {
      hook_event_name: 'Stop',
      session_id: 's1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/tmp',
      stop_hook_active: false,
    } as unknown as HookInput;
    const started = Date.now();
    const result = await stop(input, undefined, { signal: abort.signal });
    expect(result).toEqual({ continue: true });
    // The callback must not wait on the (failing) network round-trip.
    expect(Date.now() - started).toBeLessThan(200);
  });
});
