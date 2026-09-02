/**
 * TranscriptReader tests.
 *
 * Feeds a hand-authored Claude Code transcript (newline-delimited JSON)
 * through the reader by writing it to a temp file and pointing `getPath`
 * at it, then asserts the mapped `ActivityEvent`s:
 *
 *   - an `assistant` line -> one `llm_exchange` carrying the thinking +
 *     text + tool_use blocks, the usage, model and stopReason;
 *   - a `user` tool_result line -> one `tool_action` per result, labeled
 *     from the tool_use id->name map, with result/isError/toolUseId;
 *   - a `user` text line -> a `user_prompt` opener;
 *   - an `isMeta` line -> skipped;
 *   - a duplicate `uuid` -> emitted once;
 *   - secrets in content -> redacted before they leave the reader;
 *   - every event carries the line's `uuid` as `sourceId` (per
 *     tool_result for tool_actions) so the broker can dedup a replay;
 *   - a CHANGE of transcript path re-pins the tail to the new file
 *     without re-emitting the history a resumed transcript replays.
 *
 * The reader tails a real file with fs.watch + a poll fallback, so the
 * tests write the fixture then poll the collected events until they
 * arrive (or a deadline elapses).
 */

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityEvent } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachTranscriptReader,
  type TranscriptReader,
} from '../../src/runtime/trace/transcript-reader.js';
import { silentLogger } from '../helpers/logger.js';

// Gate for the close()-races-an-in-flight-drain regression test: while
// armed, any open() of the transcript parks until released, so the test
// can interleave close() + an append inside a drain's await window. All
// other tests pass straight through to the real fs.
const openGate = vi.hoisted(() => ({
  armed: false,
  pending: [] as Array<() => void>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (openGate.armed) {
        await new Promise<void>((resolve) => openGate.pending.push(resolve));
      }
      return actual.open(...args);
    },
  };
});

/** Poll until `pred()` is true or the deadline elapses. */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const SECRET = 'sk-ant-api03-super-secret-key-value-1234567890';

describe('TranscriptReader', () => {
  let dir: string;
  let path: string;
  let reader: TranscriptReader | null = null;
  let events: ActivityEvent[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'csuite-tr-'));
    path = join(dir, 'session.jsonl');
    events = [];
  });

  afterEach(() => {
    // Disarm + release the open() gate first so a parked drain can't
    // outlive its test (e.g. after a mid-test assertion failure).
    openGate.armed = false;
    for (const release of openGate.pending.splice(0)) release();
    reader?.close();
    reader = null;
    rmSync(dir, { recursive: true, force: true });
  });

  function start(pollMs = 25): void {
    reader = attachTranscriptReader({
      getPath: () => path,
      enqueue: (e) => events.push(e),
      logger: silentLogger(),
      pollMs,
    });
  }

  it('maps a full fixture: assistant turn, tool_result, opener; skips meta + dup; redacts', async () => {
    const lines = [
      // A meta line — system-reminder noise, must be skipped.
      {
        type: 'user',
        uuid: 'meta-1',
        isMeta: true,
        timestamp: '2026-07-05T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'system reminder noise' }] },
      },
      // A user TEXT line — the turn opener. Carries a secret to prove redaction.
      {
        type: 'user',
        uuid: 'user-open-1',
        promptId: 'p-1',
        timestamp: '2026-07-05T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `do the thing with ${SECRET}` }],
        },
      },
      // An assistant line with thinking + text + tool_use + usage.
      {
        type: 'assistant',
        uuid: 'asst-1',
        timestamp: '2026-07-05T00:00:03.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-8',
          stop_reason: 'tool_use',
          content: [
            { type: 'thinking', thinking: 'let me reason about this', signature: 'sig' },
            { type: 'text', text: 'running a command' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 2,
          },
        },
      },
      // A user tool_result line — the Bash output, with a secret to redact.
      {
        type: 'user',
        uuid: 'user-tr-1',
        timestamp: '2026-07-05T00:00:04.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              is_error: false,
              content: `file-a\nfile-b token=${SECRET}`,
            },
          ],
        },
      },
      // A DUPLICATE uuid of the assistant line — must be emitted once only.
      {
        type: 'assistant',
        uuid: 'asst-1',
        timestamp: '2026-07-05T00:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [{ type: 'text', text: 'duplicate — should be skipped' }],
        },
      },
    ];
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

    start();
    await waitFor(() => events.filter((e) => e.kind === 'tool_action').length > 0);
    // Give the reader a beat to prove the duplicate does NOT produce a second exchange.
    await new Promise((r) => setTimeout(r, 60));

    // ── llm_exchange ────────────────────────────────────────────────
    const exchanges = events.filter((e) => e.kind === 'llm_exchange');
    expect(exchanges).toHaveLength(1); // the duplicate uuid was skipped
    const ex = exchanges[0];
    if (ex?.kind !== 'llm_exchange') throw new Error('expected llm_exchange');
    expect(ex.agent).toBe('claude');
    expect(ex.entry.request.model).toBe('claude-opus-4-8');
    expect(ex.entry.request.messages).toEqual([]); // history is the sequence, not restuffed
    expect(ex.entry.response?.stopReason).toBe('tool_use');
    expect(ex.entry.response?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 2,
    });
    const blocks = ex.entry.response?.messages[0]?.content ?? [];
    // thinking text lands under the block's `text`.
    expect(blocks).toContainEqual({ type: 'thinking', text: 'let me reason about this' });
    expect(blocks).toContainEqual({ type: 'text', text: 'running a command' });
    expect(blocks).toContainEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'Bash',
      input: { command: 'ls' },
    });
    // duration ≈ this line's ts minus the prior line's ts (opener at :01,
    // assistant at :03 → 2000ms).
    expect(ex.duration).toBe(2000);
    // The line's uuid leaves the runner as the broker's dedup key.
    expect(ex.sourceId).toBe('asst-1');

    // ── tool_action ─────────────────────────────────────────────────
    const actions = events.filter((e) => e.kind === 'tool_action');
    expect(actions).toHaveLength(1);
    const action = actions[0];
    if (action?.kind !== 'tool_action') throw new Error('expected tool_action');
    expect(action.agent).toBe('claude');
    expect(action.source).toBe('transcript');
    expect(action.toolName).toBe('Bash'); // resolved from the tool_use id->name map
    expect(action.toolUseId).toBe('toolu_1');
    expect(action.isError).toBe(false);
    // Per tool_result, not per line — see the multi-result test below.
    expect(action.sourceId).toBe('user-tr-1:toolu_1');
    // Result content redacted.
    expect(JSON.stringify(action.result)).toContain('[REDACTED]');
    expect(JSON.stringify(action.result)).not.toContain('super-secret');

    // ── user_prompt ─────────────────────────────────────────────────
    const openers = events.filter((e) => e.kind === 'user_prompt');
    expect(openers).toHaveLength(1); // the meta line did NOT produce one
    const opener = openers[0];
    if (opener?.kind !== 'user_prompt') throw new Error('expected user_prompt');
    expect(opener.agent).toBe('claude');
    expect(opener.promptId).toBe('p-1');
    expect(opener.text).toContain('[REDACTED]');
    expect(opener.text).not.toContain('super-secret');
    expect(opener.sourceId).toBe('user-open-1');
  });

  it('gives each tool_result of one line its own sourceId', async () => {
    // One user line can carry several results. The broker dedups on
    // sourceId, so a per-line key would make the second result look
    // like a replay of the first and drop it at the store.
    const line = {
      type: 'user',
      uuid: 'user-multi-1',
      timestamp: '2026-07-05T00:00:01.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_a', is_error: false, content: 'a' },
          { type: 'tool_result', tool_use_id: 'toolu_b', is_error: false, content: 'b' },
        ],
      },
    };
    writeFileSync(path, `${JSON.stringify(line)}\n`);

    start();
    await waitFor(() => events.filter((e) => e.kind === 'tool_action').length >= 2);

    const ids = events.filter((e) => e.kind === 'tool_action').map((e) => e.sourceId);
    expect(ids).toEqual(['user-multi-1:toolu_a', 'user-multi-1:toolu_b']);
    expect(new Set(ids).size).toBe(2);
  });

  it('labels a tool_result from MCP attribution when no tool_use name was seen', async () => {
    const line = {
      type: 'user',
      uuid: 'u-mcp-1',
      timestamp: '2026-07-05T00:00:01.000Z',
      attributionMcpServer: 'github',
      attributionMcpTool: 'create_pr',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_unknown', is_error: true, content: 'nope' },
        ],
      },
    };
    writeFileSync(path, `${JSON.stringify(line)}\n`);

    start();
    await waitFor(() => events.some((e) => e.kind === 'tool_action'));

    const action = events.find((e) => e.kind === 'tool_action');
    if (action?.kind !== 'tool_action') throw new Error('expected tool_action');
    expect(action.toolName).toBe('create_pr'); // MCP tool attribution fallback
    expect(action.isError).toBe(true);
    expect(action.toolUseId).toBe('toolu_unknown');
  });

  it('never throws on a garbage/truncated line — skips it and keeps going', async () => {
    const good = JSON.stringify({
      type: 'user',
      uuid: 'good-1',
      timestamp: '2026-07-05T00:00:02.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'still here' }] },
    });
    // A complete-but-unparseable line between nothing and a good line.
    writeFileSync(path, `{ this is not json }\n${good}\n`);

    start();
    await waitFor(() => events.some((e) => e.kind === 'user_prompt'));

    expect(events.filter((e) => e.kind === 'user_prompt')).toHaveLength(1);
  });

  it('idles until getPath yields a path, then tails appended lines incrementally', async () => {
    let known: string | null = null;
    reader = attachTranscriptReader({
      getPath: () => known,
      enqueue: (e) => events.push(e),
      logger: silentLogger(),
      pollMs: 25,
    });

    // No path yet — nothing read even though the file exists.
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'user',
        uuid: 'pre-1',
        timestamp: '2026-07-05T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
      })}\n`,
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(events).toHaveLength(0);

    // Reveal the path — the reader picks up the backlog…
    known = path;
    await waitFor(() => events.some((e) => e.kind === 'user_prompt'));
    expect(events.filter((e) => e.kind === 'user_prompt')).toHaveLength(1);

    // …and a later append is tailed incrementally (no re-emit of 'pre-1').
    appendFileSync(
      path,
      `${JSON.stringify({
        type: 'user',
        uuid: 'post-1',
        timestamp: '2026-07-05T00:00:02.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
      })}\n`,
    );
    await waitFor(() => events.filter((e) => e.kind === 'user_prompt').length >= 2);
    expect(events.filter((e) => e.kind === 'user_prompt')).toHaveLength(2);
  });

  it('does not consume a partial final line until its newline arrives', async () => {
    // Write a complete line, then a partial one with NO trailing newline.
    const complete = JSON.stringify({
      type: 'user',
      uuid: 'complete-1',
      timestamp: '2026-07-05T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'complete' }] },
    });
    const partialObj = JSON.stringify({
      type: 'user',
      uuid: 'partial-1',
      timestamp: '2026-07-05T00:00:02.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'partial' }] },
    });
    writeFileSync(path, `${complete}\n${partialObj}`); // partial: no newline

    start();
    await waitFor(() => events.some((e) => e.kind === 'user_prompt'));
    await new Promise((r) => setTimeout(r, 60));
    // Only the complete line was consumed.
    expect(events.filter((e) => e.kind === 'user_prompt')).toHaveLength(1);

    // Finish the partial line — now it's consumed too, exactly once.
    appendFileSync(path, '\n');
    await waitFor(() => events.filter((e) => e.kind === 'user_prompt').length >= 2);
    expect(events.filter((e) => e.kind === 'user_prompt')).toHaveLength(2);
  });

  it('close() stops further tailing', async () => {
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'user',
        uuid: 'c-1',
        timestamp: '2026-07-05T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'one' }] },
      })}\n`,
    );
    start();
    await waitFor(() => events.some((e) => e.kind === 'user_prompt'));
    const countAtClose = events.length;
    reader?.close();
    reader = null;

    appendFileSync(
      path,
      `${JSON.stringify({
        type: 'user',
        uuid: 'c-2',
        timestamp: '2026-07-05T00:00:02.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'two' }] },
      })}\n`,
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(events).toHaveLength(countAtClose); // nothing new after close
  });

  it('drops lines read by a drain that was in flight when close() landed', async () => {
    // Regression: a drain passes its entry `closed` check, then awaits
    // open/stat/read. If close() AND a new line land inside that window,
    // the resumed drain must not emit the post-close line.
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'user',
        uuid: 'race-1',
        timestamp: '2026-07-05T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'one' }] },
      })}\n`,
    );
    start();
    await waitFor(() => events.some((e) => e.kind === 'user_prompt'));
    const countAtClose = events.length;

    // Arm the gate, then wait for the next poll's drain to park inside
    // open() — past the entry check, mid-flight.
    openGate.armed = true;
    await waitFor(() => openGate.pending.length > 0);

    // close() and a fresh line both land while that drain is parked.
    reader?.close();
    reader = null;
    appendFileSync(
      path,
      `${JSON.stringify({
        type: 'user',
        uuid: 'race-2',
        timestamp: '2026-07-05T00:00:02.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'two' }] },
      })}\n`,
    );

    // Release the drain: it reads the new bytes but must drop them.
    openGate.armed = false;
    for (const release of openGate.pending.splice(0)) release();
    await new Promise((r) => setTimeout(r, 80));
    expect(events).toHaveLength(countAtClose); // nothing emitted past close
  });

  // ── Following a transcript path change ─────────────────────────────
  //
  // The agent process is swapped under a live capture host on every
  // restart, and each successor writes a NEW transcript. A resumed or
  // forked transcript begins by replaying the prior session's lines
  // under their original uuids. Measured in production before this
  // existed: a fresh reader on such a file re-emitted 1000+ rows of
  // history in one second. The contract: follow the new file, emit
  // only what is genuinely new, and never lose the new file's own
  // first lines to a stale offset.

  const userLine = (uuid: string, second: number, text: string): string =>
    JSON.stringify({
      type: 'user',
      uuid,
      timestamp: `2026-07-05T00:00:${String(second).padStart(2, '0')}.000Z`,
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  const prompts = (): string[] =>
    events.filter((e) => e.kind === 'user_prompt').map((e) => e.sourceId ?? '?');

  it('re-pins to a new path, re-emits nothing a resumed transcript replays, and tails the new file', async () => {
    const pathA = join(dir, 'session-a.jsonl');
    const pathB = join(dir, 'session-b.jsonl');
    let current: string = pathA;
    writeFileSync(pathA, `${userLine('a-1', 1, 'one')}\n${userLine('a-2', 2, 'two')}\n`);
    reader = attachTranscriptReader({
      getPath: () => current,
      enqueue: (e) => events.push(e),
      logger: silentLogger(),
      pollMs: 25,
    });
    await waitFor(() => prompts().length >= 2);
    expect(prompts()).toEqual(['a-1', 'a-2']);

    // The successor's transcript: the whole prior history replayed
    // under the SAME uuids (the resumed/forked shape), then one line
    // that is genuinely new. It is also LONGER than A, so a reader that
    // kept A's offset would skip straight past the replay AND the new
    // line — and one that reset the offset but not the dedup set would
    // re-emit both replayed lines.
    writeFileSync(
      pathB,
      `${userLine('a-1', 1, 'one')}\n${userLine('a-2', 2, 'two')}\n${userLine('b-1', 3, 'three')}\n`,
    );
    current = pathB;
    await waitFor(() => prompts().includes('b-1'));
    // Exactly the new line: the two replayed ones were recognised.
    expect(prompts()).toEqual(['a-1', 'a-2', 'b-1']);

    // The tail now follows B incrementally — the watcher and offset
    // moved, not just the dedup.
    appendFileSync(pathB, `${userLine('b-2', 4, 'four')}\n`);
    await waitFor(() => prompts().includes('b-2'));
    expect(prompts()).toEqual(['a-1', 'a-2', 'b-1', 'b-2']);

    // …and A is dead to us: a line appended there is never read.
    appendFileSync(pathA, `${userLine('a-3', 5, 'stale')}\n`);
    await new Promise((r) => setTimeout(r, 120));
    expect(prompts()).toEqual(['a-1', 'a-2', 'b-1', 'b-2']);
  });

  it('a cold successor transcript (no replay) is read from its first line', async () => {
    // The mirror of the test above and the one a dedup-only fix would
    // pass by accident: B shares nothing with A, and its FIRST line
    // must be emitted. A stale offset would skip it silently.
    const pathA = join(dir, 'session-a.jsonl');
    const pathB = join(dir, 'session-b.jsonl');
    let current: string = pathA;
    writeFileSync(
      pathA,
      `${userLine('a-1', 1, 'a long first line to give A some bytes')}\n${userLine('a-2', 2, 'two')}\n`,
    );
    reader = attachTranscriptReader({
      getPath: () => current,
      enqueue: (e) => events.push(e),
      logger: silentLogger(),
      pollMs: 25,
    });
    await waitFor(() => prompts().length >= 2);

    writeFileSync(pathB, `${userLine('b-1', 3, 'b')}\n`); // shorter than A
    current = pathB;
    await waitFor(() => prompts().includes('b-1'));
    expect(prompts()).toEqual(['a-1', 'a-2', 'b-1']);
  });

  it('carries tool names across the seam and resets the duration baseline', async () => {
    // A resume can land between a tool_use and its result: the
    // successor's first line is the tool_result for a tool_use issued
    // in the predecessor's transcript. The label must survive the
    // re-pin (else 'tool'). And an assistant line at the top of a cold
    // file must not measure its duration against the last line of a
    // different conversation hours earlier.
    const pathA = join(dir, 'session-a.jsonl');
    const pathB = join(dir, 'session-b.jsonl');
    let current: string = pathA;
    const assistantA = JSON.stringify({
      type: 'assistant',
      uuid: 'asst-a',
      timestamp: '2026-07-05T00:00:01.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    writeFileSync(pathA, `${assistantA}\n`);
    reader = attachTranscriptReader({
      getPath: () => current,
      enqueue: (e) => events.push(e),
      logger: silentLogger(),
      pollMs: 25,
    });
    await waitFor(() => events.some((e) => e.kind === 'llm_exchange'));

    const resultB = JSON.stringify({
      type: 'user',
      uuid: 'user-b',
      // Six hours later — a baseline carried over would show up as a
      // six-hour duration on the assistant line that follows.
      timestamp: '2026-07-05T06:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_9', is_error: false, content: 'x' }],
      },
    });
    const assistantB = JSON.stringify({
      type: 'assistant',
      uuid: 'asst-b',
      timestamp: '2026-07-05T06:00:02.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'done' }],
      },
    });
    writeFileSync(pathB, `${resultB}\n${assistantB}\n`);
    current = pathB;
    await waitFor(() => events.some((e) => e.kind === 'llm_exchange' && e.sourceId === 'asst-b'));

    const action = events.find((e) => e.kind === 'tool_action');
    if (action?.kind !== 'tool_action') throw new Error('expected tool_action');
    expect(action.toolName).toBe('Bash'); // harvested in A, applied in B
    const second = events.find((e) => e.kind === 'llm_exchange' && e.sourceId === 'asst-b');
    if (second?.kind !== 'llm_exchange') throw new Error('expected llm_exchange');
    // Measured against B's own previous line (2s), not A's (six hours).
    expect(second.duration).toBe(2000);
  });

  it('a re-pin landing mid-drain does not let the old file advance the new offset', async () => {
    // Regression for the snapshot-and-recheck in drain(): the reader is
    // parked inside open() on A when the path flips to B. The resumed
    // drain has read A's bytes; committing them would set B's offset to
    // A's length and B's first lines would never be read.
    const pathA = join(dir, 'session-a.jsonl');
    const pathB = join(dir, 'session-b.jsonl');
    let current: string = pathA;
    writeFileSync(pathA, `${userLine('a-1', 1, 'one')}\n`);
    reader = attachTranscriptReader({
      getPath: () => current,
      enqueue: (e) => events.push(e),
      logger: silentLogger(),
      pollMs: 25,
    });
    await waitFor(() => prompts().includes('a-1'));

    // Park a drain inside open() BEFORE A grows. Arming after the append
    // raced: the 25ms poll (and fs.watch) could consume 'a-2' legitimately
    // in the window between the two statements, which is a pass locally and
    // a failure under CI timing. The parked drain opens A while it still
    // ends at 'a-1', so its snapshot offset sits before the tail; it stats
    // and reads that tail only after release.
    openGate.armed = true;
    await waitFor(() => openGate.pending.length > 0);

    // Now give A a fat tail. Only the parked drain can observe it.
    appendFileSync(pathA, `${userLine('a-2', 2, 'x'.repeat(2000))}\n`);

    // Flip the path while that drain is parked. B is shorter than A's
    // unread tail, so a stale commit would put B's offset past its end.
    writeFileSync(pathB, `${userLine('b-1', 3, 'b')}\n`);
    current = pathB;
    await new Promise((r) => setTimeout(r, 60)); // let the poll observe the change
    openGate.armed = false;
    for (const release of openGate.pending.splice(0)) release();

    await waitFor(() => prompts().includes('b-1'));
    expect(prompts()).toContain('b-1');
    // The parked drain's bytes belonged to A after the flip: dropped.
    expect(prompts()).not.toContain('a-2');
  });
});
