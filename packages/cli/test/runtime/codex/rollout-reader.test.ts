/**
 * Tests for the codex rollout reader (the I/O tailer).
 *
 * Exercises the real file machinery — resolve a `rollout-*.jsonl` under an
 * ephemeral sessions dir, tail it live, and do a guaranteed final drain +
 * parser flush on close — against actual temp files. The line→event
 * mapping itself is covered by rollout-parser.test.ts; here we assert the
 * tailer delivers those events from disk.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityEvent } from 'csuite-sdk/types';
import { afterEach, describe, expect, it } from 'vitest';
import { attachRolloutReader } from '../../../src/runtime/agents/codex/rollout-reader.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempSessions(): { sessionsDir: string; dayDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'csuite-rollout-test-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const sessionsDir = join(root, 'sessions');
  const dayDir = join(sessionsDir, '2026', '07', '09');
  mkdirSync(dayDir, { recursive: true });
  return { sessionsDir, dayDir };
}

const fullTurn = (): string =>
  [
    {
      timestamp: '2026-07-09T12:40:09.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 't1', started_at: 1783626009 },
    },
    {
      timestamp: '2026-07-09T12:40:09.500Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'do it' },
    },
    {
      timestamp: '2026-07-09T12:40:10.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'c1',
        arguments: '{"cmd":"ls"}',
      },
    },
    {
      timestamp: '2026-07-09T12:40:11.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'c1',
        output: 'Process exited with code 0',
      },
    },
    {
      timestamp: '2026-07-09T12:40:13.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'done', phase: 'final_answer' },
    },
    {
      timestamp: '2026-07-09T12:40:14.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 't1',
        duration_ms: 5000,
        completed_at: 1783626014,
      },
    },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n') + '\n';

/**
 * Thread attribution of an event. `querySource` only exists on the
 * kinds this reader emits (user_prompt / tool_action / llm_exchange),
 * so narrow before reading it off the union.
 */
const srcOf = (e: ActivityEvent): string | undefined =>
  'querySource' in e ? e.querySource : undefined;

const until = async (pred: () => boolean, timeoutMs = 1500): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('attachRolloutReader', () => {
  it('reads a pre-existing rollout on close (final drain + flush)', async () => {
    const { sessionsDir, dayDir } = tempSessions();
    writeFileSync(join(dayDir, 'rollout-2026-07-09T12-40-09-abc.jsonl'), fullTurn());

    const events: ActivityEvent[] = [];
    const reader = attachRolloutReader({
      sessionsDir,
      enqueue: (e) => events.push(e),
      log: () => {},
    });
    // Close does a guaranteed final drain, so we don't depend on poll timing.
    await reader.close();

    expect(events.filter((e) => e.kind === 'user_prompt')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'tool_action')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'llm_exchange')).toHaveLength(1);
    // No root id known → the lone file is attributed as the main thread.
    for (const e of events) expect(srcOf(e)).toBe('codex_main_thread');
  });

  it('tails a rollout that appears and grows after attach', async () => {
    const { sessionsDir, dayDir } = tempSessions();
    const events: ActivityEvent[] = [];
    const reader = attachRolloutReader({
      sessionsDir,
      enqueue: (e) => events.push(e),
      log: () => {},
      pollMs: 15,
    });
    cleanups.push(() => void reader.close());

    const file = join(dayDir, 'rollout-2026-07-09T12-40-09-live.jsonl');
    // File doesn't exist yet at attach time — the poll must discover it.
    const lines = fullTurn().split('\n').filter(Boolean);
    writeFileSync(file, `${lines.slice(0, 2).join('\n')}\n`); // task_started + user_message
    await until(() => events.some((e) => e.kind === 'user_prompt'));
    // Append the rest, including task_complete → the exchange flushes.
    appendFileSync(file, `${lines.slice(2).join('\n')}\n`);
    await until(() => events.some((e) => e.kind === 'llm_exchange'));

    expect(events.filter((e) => e.kind === 'tool_action')).toHaveLength(1);
    await reader.close();
  });

  it('tails every thread and attributes root vs subagent', async () => {
    const { sessionsDir, dayDir } = tempSessions();
    // The ephemeral CODEX_HOME holds this run's threads: the root plus a
    // dispatched subagent, each in its own rollout file (real codex uuid
    // filenames so the subagent id can be extracted).
    const rootId = '019f5b0c-2bad-7520-8394-803e0a18c52b';
    const subId = '019f5b1a-9999-7000-8000-0123456789ab';
    writeFileSync(join(dayDir, `rollout-2026-07-09T12-40-09-${rootId}.jsonl`), fullTurn());
    writeFileSync(join(dayDir, `rollout-2026-07-09T12-41-00-${subId}.jsonl`), fullTurn());

    const events: ActivityEvent[] = [];
    const reader = attachRolloutReader({
      sessionsDir,
      getSessionId: () => rootId,
      enqueue: (e) => events.push(e),
      log: () => {},
    });
    await reader.close();

    // Both threads' turns are captured (2 of each kind), not just the root.
    const exchanges = events.filter((e) => e.kind === 'llm_exchange');
    expect(exchanges).toHaveLength(2);
    const sources = events.map(srcOf).sort();
    // Every event carries a thread attribution; the root is the main
    // thread and the other file is a subagent labelled by its id prefix.
    expect(new Set(events.map(srcOf))).toEqual(
      new Set(['codex_main_thread', 'codex_subagent:019f5b1a']),
    );
    // Balanced: one main + one subagent per event kind.
    expect(sources.filter((s) => s === 'codex_main_thread')).toHaveLength(3);
    expect(sources.filter((s) => s === 'codex_subagent:019f5b1a')).toHaveLength(3);
  });

  it("preexisting:'ignore' skips prior runs' rollouts but tracks new files", async () => {
    const { sessionsDir, dayDir } = tempSessions();
    // History from a previous run in the DURABLE sessions dir — was
    // already captured when written; must produce no events now.
    writeFileSync(join(dayDir, 'rollout-2026-07-08T09-00-00-old.jsonl'), fullTurn());

    const events: ActivityEvent[] = [];
    const reader = attachRolloutReader({
      sessionsDir,
      enqueue: (e) => events.push(e),
      log: () => {},
      pollMs: 15,
      preexisting: 'ignore',
    });
    cleanups.push(() => void reader.close());

    // A file created after attach (this run's thread) is tracked from 0.
    writeFileSync(join(dayDir, 'rollout-2026-07-09T12-40-09-new.jsonl'), fullTurn());
    await until(() => events.some((e) => e.kind === 'llm_exchange'));
    await reader.close();

    // Exactly the new file's turn — nothing from the ignored history.
    expect(events.filter((e) => e.kind === 'llm_exchange')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'user_prompt')).toHaveLength(1);
  });

  it('resumeThreadId tails the resumed rollout from its current EOF', async () => {
    const { sessionsDir, dayDir } = tempSessions();
    const resumedId = '019f5b0c-2bad-7520-8394-803e0a18c52b';
    const file = join(dayDir, `rollout-2026-07-09T12-40-09-${resumedId}.jsonl`);
    // The thread's persisted history (captured by the run that wrote it)…
    writeFileSync(file, fullTurn());
    // …plus an unrelated old thread that must stay ignored.
    writeFileSync(join(dayDir, 'rollout-2026-07-08T09-00-00-other.jsonl'), fullTurn());

    const events: ActivityEvent[] = [];
    const reader = attachRolloutReader({
      sessionsDir,
      getSessionId: () => resumedId,
      enqueue: (e) => events.push(e),
      log: () => {},
      pollMs: 15,
      preexisting: 'ignore',
      resumeThreadId: resumedId,
    });
    cleanups.push(() => void reader.close());

    // Codex appends the resumed run's turns to the SAME file.
    appendFileSync(file, fullTurn());
    await until(() => events.some((e) => e.kind === 'llm_exchange'));
    await reader.close();

    // Only the appended turn flowed — one of each kind, attributed to the
    // main thread; the pre-existing history and the other file stay quiet.
    expect(events.filter((e) => e.kind === 'llm_exchange')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'user_prompt')).toHaveLength(1);
    for (const e of events) {
      expect('querySource' in e && e.querySource).toBe('codex_main_thread');
    }
  });
});
