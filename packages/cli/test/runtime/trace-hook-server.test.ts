/**
 * Hook server tests.
 *
 * Pins the busy-signal contract the Claude Code hook endpoint
 * implements:
 *
 *   - PreToolUse bumps tool_inflight by tool_use_id
 *   - PostToolUse / PostToolUseFailure decrement the matching handle
 *   - Mismatched events (Post without a prior Pre, duplicate Pre, etc.)
 *     do not corrupt the count
 *   - Bad bodies are rejected with 4xx
 *   - close() drains every outstanding handle so a torn-down runner
 *     can't leave the indicator wedged
 *
 * The HTTP server binds on 127.0.0.1:0 (random ephemeral port) so the
 * tests are hermetic and don't collide with anything else listening.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createActivitySignal } from '../../src/runtime/trace/busy.js';
import { type HookServer, startHookServer } from '../../src/runtime/trace/hook-server.js';

async function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

describe('hook server', () => {
  let server: HookServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close().catch(() => {});
      server = null;
    }
  });

  it('PreToolUse bumps tool_inflight; PostToolUse drains it', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    expect(busy.getSourceCounts().tool_inflight).toBe(0);

    const r1 = await postJson(server.url, {
      hook_event_name: 'PreToolUse',
      tool_use_id: 'tool-1',
      tool_name: 'Bash',
    });
    expect(r1.status).toBe(200);
    expect(busy.busy).toBe(true);
    expect(busy.getSourceCounts().tool_inflight).toBe(1);

    const r2 = await postJson(server.url, {
      hook_event_name: 'PostToolUse',
      tool_use_id: 'tool-1',
      tool_name: 'Bash',
    });
    expect(r2.status).toBe(200);
    expect(busy.busy).toBe(false);
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });

  it('counts overlapping tool calls correctly', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, { hook_event_name: 'PreToolUse', tool_use_id: 'a' });
    await postJson(server.url, { hook_event_name: 'PreToolUse', tool_use_id: 'b' });
    await postJson(server.url, { hook_event_name: 'PreToolUse', tool_use_id: 'c' });
    expect(busy.getSourceCounts().tool_inflight).toBe(3);

    await postJson(server.url, { hook_event_name: 'PostToolUse', tool_use_id: 'b' });
    expect(busy.getSourceCounts().tool_inflight).toBe(2);
    expect(busy.busy).toBe(true);

    await postJson(server.url, { hook_event_name: 'PostToolUse', tool_use_id: 'a' });
    await postJson(server.url, { hook_event_name: 'PostToolUseFailure', tool_use_id: 'c' });
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
    expect(busy.busy).toBe(false);
  });

  it('duplicate PreToolUse for the same id is a no-op', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, { hook_event_name: 'PreToolUse', tool_use_id: 'dup' });
    await postJson(server.url, { hook_event_name: 'PreToolUse', tool_use_id: 'dup' });
    expect(busy.getSourceCounts().tool_inflight).toBe(1);

    await postJson(server.url, { hook_event_name: 'PostToolUse', tool_use_id: 'dup' });
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });

  it('PostToolUse for an unknown id is silently ignored (no underflow)', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    const res = await postJson(server.url, {
      hook_event_name: 'PostToolUse',
      tool_use_id: 'never-saw-this',
    });
    expect(res.status).toBe(200);
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });

  it('unhandled events (PreCompact, etc.) are accepted without changing state', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, { hook_event_name: 'PreCompact' });
    expect(busy.state()).toBe('idle');
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });

  it('SessionStart relays its source via onSessionStart and drives no presence', async () => {
    const busy = createActivitySignal();
    const sources: string[] = [];
    server = await startHookServer({
      busy,
      log: () => {},
      onSessionStart: (source) => sources.push(source),
    });

    await postJson(server.url, { hook_event_name: 'SessionStart', source: 'compact' });
    await postJson(server.url, { hook_event_name: 'SessionStart', source: 'startup' });
    // Payloads without a source relay an empty string rather than
    // being dropped — the callback owns the routing decision.
    await postJson(server.url, { hook_event_name: 'SessionStart' });

    expect(sources).toEqual(['compact', 'startup', '']);
    expect(busy.state()).toBe('idle');
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });

  it('rejects malformed bodies with 400', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });

  it('returns 200 with accepted=false when fields are missing (avoid retry storms)', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    const res = await postJson(server.url, { hook_event_name: 'PreToolUse' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    expect(body.accepted).toBe(false);
  });

  it('non-matching routes return 404', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    const res = await fetch(server.url.replace('/hook/tool-event', '/something-else'));
    expect(res.status).toBe(404);
  });

  it('close() drains outstanding handles so busy unwedges', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, { hook_event_name: 'PreToolUse', tool_use_id: 'left-dangling' });
    expect(busy.busy).toBe(true);

    await server.close();
    server = null;
    expect(busy.busy).toBe(false);
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });
});

describe('hook server — turn lifecycle (UserPromptSubmit / Stop)', () => {
  let server: HookServer | null = null;
  afterEach(async () => {
    if (server) {
      await server.close().catch(() => {});
      server = null;
    }
  });

  it('UserPromptSubmit opens turn_active (working); Stop closes it (idle)', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, {
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'p-1',
      session_id: 's-1',
    });
    expect(busy.state()).toBe('working');
    expect(busy.getSourceCounts().turn_active).toBe(1);

    await postJson(server.url, {
      hook_event_name: 'Stop',
      prompt_id: 'p-1',
      session_id: 's-1',
    });
    expect(busy.state()).toBe('idle');
    expect(busy.getSourceCounts().turn_active).toBe(0);
  });

  it('duplicate UserPromptSubmit for the same prompt_id does not double-count', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, { hook_event_name: 'UserPromptSubmit', prompt_id: 'p-1' });
    await postJson(server.url, { hook_event_name: 'UserPromptSubmit', prompt_id: 'p-1' });
    expect(busy.getSourceCounts().turn_active).toBe(1);

    await postJson(server.url, { hook_event_name: 'Stop', prompt_id: 'p-1' });
    expect(busy.getSourceCounts().turn_active).toBe(0);
  });

  it('Stop clears blocked even when no turn handle is open', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    busy.setBlocked(true);
    expect(busy.state()).toBe('blocked');

    await postJson(server.url, { hook_event_name: 'Stop', prompt_id: 'unknown' });
    expect(busy.state()).toBe('idle');
    expect(busy.blocked).toBe(false);
  });

  it('Stop with a mismatched key still drains open turn handles (no leak)', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, { hook_event_name: 'UserPromptSubmit', prompt_id: 'p-1' });
    expect(busy.getSourceCounts().turn_active).toBe(1);

    // Stop carries a different id shape (only session_id) — fallback drain.
    await postJson(server.url, { hook_event_name: 'Stop', session_id: 's-9' });
    expect(busy.getSourceCounts().turn_active).toBe(0);
    expect(busy.state()).toBe('idle');
  });

  it('turn_active + tool_inflight overlap: still working until the turn ends', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, { hook_event_name: 'UserPromptSubmit', prompt_id: 'p-1' });
    await postJson(server.url, { hook_event_name: 'PreToolUse', tool_use_id: 't-1' });
    await postJson(server.url, { hook_event_name: 'PostToolUse', tool_use_id: 't-1' });
    // Tool window closed but the turn is still active.
    expect(busy.state()).toBe('working');
    expect(busy.getSourceCounts()).toEqual({ turn_active: 1, tool_inflight: 0 });

    await postJson(server.url, { hook_event_name: 'Stop', prompt_id: 'p-1' });
    expect(busy.state()).toBe('idle');
  });

  it('SubagentStop is informational — no top-level state change', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, { hook_event_name: 'UserPromptSubmit', prompt_id: 'p-1' });
    await postJson(server.url, { hook_event_name: 'SubagentStop', agent_id: 'sub-1' });
    // Main turn still active.
    expect(busy.state()).toBe('working');
    expect(busy.getSourceCounts().turn_active).toBe(1);
  });

  it('close() drains a dangling turn_active handle', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, { hook_event_name: 'UserPromptSubmit', prompt_id: 'p-1' });
    expect(busy.state()).toBe('working');

    await server.close();
    server = null;
    expect(busy.state()).toBe('idle');
    expect(busy.getSourceCounts().turn_active).toBe(0);
  });
});

describe('hook server — transcript path relay (onTranscriptPath)', () => {
  let server: HookServer | null = null;
  afterEach(async () => {
    if (server) {
      await server.close().catch(() => {});
      server = null;
    }
  });

  it('relays transcript_path from a hook body', async () => {
    const paths: string[] = [];
    const busy = createActivitySignal();
    server = await startHookServer({
      busy,
      log: () => {},
      onTranscriptPath: (p) => paths.push(p),
    });

    await postJson(server.url, {
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'p-1',
      transcript_path: '/home/x/.claude/projects/slug/session.jsonl',
    });

    expect(paths).toEqual(['/home/x/.claude/projects/slug/session.jsonl']);
    // Presence still opens too — the relay is independent of routing.
    expect(busy.getSourceCounts().turn_active).toBe(1);
  });

  it('relays the path even for an event it does not act on (e.g. SessionStart)', async () => {
    const paths: string[] = [];
    const busy = createActivitySignal();
    server = await startHookServer({
      busy,
      log: () => {},
      onTranscriptPath: (p) => paths.push(p),
    });

    await postJson(server.url, {
      hook_event_name: 'SessionStart',
      transcript_path: '/t/session.jsonl',
    });

    expect(paths).toEqual(['/t/session.jsonl']);
    // SessionStart drives no presence.
    expect(busy.state()).toBe('idle');
  });

  it('dedups: the same transcript_path fires the callback only once', async () => {
    const paths: string[] = [];
    const busy = createActivitySignal();
    server = await startHookServer({
      busy,
      log: () => {},
      onTranscriptPath: (p) => paths.push(p),
    });

    for (const evt of ['UserPromptSubmit', 'PreToolUse', 'Stop']) {
      await postJson(server.url, {
        hook_event_name: evt,
        tool_use_id: 't-1',
        prompt_id: 'p-1',
        transcript_path: '/t/session.jsonl',
      });
    }

    expect(paths).toEqual(['/t/session.jsonl']);
  });

  it('does not fire when a hook body carries no transcript_path', async () => {
    const paths: string[] = [];
    const busy = createActivitySignal();
    server = await startHookServer({
      busy,
      log: () => {},
      onTranscriptPath: (p) => paths.push(p),
    });

    await postJson(server.url, { hook_event_name: 'UserPromptSubmit', prompt_id: 'p-1' });

    expect(paths).toHaveLength(0);
  });
});

describe('hook server — Notification (blocked flag)', () => {
  let server: HookServer | null = null;
  afterEach(async () => {
    if (server) {
      await server.close().catch(() => {});
      server = null;
    }
  });

  it.each(['permission_prompt', 'agent_needs_input', 'elicitation_dialog'])(
    'blocking notification_type %s sets blocked',
    async (notification_type) => {
      const busy = createActivitySignal();
      server = await startHookServer({ busy, log: () => {} });

      await postJson(server.url, { hook_event_name: 'Notification', notification_type });
      expect(busy.state()).toBe('blocked');
      expect(busy.blocked).toBe(true);
    },
  );

  it('idle_prompt clears blocked', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
    });
    expect(busy.blocked).toBe(true);

    await postJson(server.url, {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
    });
    expect(busy.blocked).toBe(false);
    expect(busy.state()).toBe('idle');
  });

  it('unknown notification_type is ignored (no state change)', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, {
      hook_event_name: 'Notification',
      notification_type: 'some_future_type',
    });
    expect(busy.state()).toBe('idle');
    expect(busy.blocked).toBe(false);
  });

  it('blocked wins over an active turn, then Stop clears both', async () => {
    const busy = createActivitySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, { hook_event_name: 'UserPromptSubmit', prompt_id: 'p-1' });
    expect(busy.state()).toBe('working');

    await postJson(server.url, {
      hook_event_name: 'Notification',
      notification_type: 'agent_needs_input',
    });
    // Turn still in flight, but blocked wins.
    expect(busy.state()).toBe('blocked');

    await postJson(server.url, { hook_event_name: 'Stop', prompt_id: 'p-1' });
    expect(busy.state()).toBe('idle');
    expect(busy.blocked).toBe(false);
  });
});
