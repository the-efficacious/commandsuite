/**
 * Activity-printer tests — feed canned codex JSON-RPC notifications
 * into the printer through a fake `JsonRpcClient` and assert the
 * exact stderr lines that come out.
 *
 * Color is forced off (`color: false`) so output is plain ASCII and
 * test assertions read as the operator sees them in a non-TTY context
 * (CI logs). Fake timers pin elapsed-time math so the per-turn summary
 * is deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachCodexActivityPrinter } from '../../../src/runtime/agents/codex/activity-printer.js';
import type { JsonRpcClient } from '../../../src/runtime/agents/codex/json-rpc.js';

// ── Fake rpc client + capture stream ─────────────────────────────────

interface FakeRpc extends JsonRpcClient {
  emit(method: string, params: unknown): void;
}

function makeFakeRpc(): FakeRpc {
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  return {
    request: vi.fn().mockResolvedValue({}),
    notify: vi.fn(),
    onNotification(method: string, handler: (p: unknown) => void): () => void {
      const list = handlers.get(method) ?? [];
      list.push(handler);
      handlers.set(method, list);
      return () => {
        const cur = handlers.get(method) ?? [];
        const idx = cur.indexOf(handler);
        if (idx >= 0) cur.splice(idx, 1);
      };
    },
    onRequest: vi.fn(() => () => {}),
    closed: Promise.resolve(),
    close: vi.fn(),
    emit(method: string, params: unknown): void {
      const list = handlers.get(method) ?? [];
      for (const h of list) h(params);
    },
  };
}

/**
 * Stream double matching the `process.stderr.write` shape we depend on.
 * Captures every write into an array so tests can assert against the
 * concatenation. `isTTY=false` keeps the printer in non-color mode by
 * default (we also pass `color: false` for belt-and-suspenders).
 */
function makeCaptureStream(): { writes: string[]; out: NodeJS.WriteStream } {
  const writes: string[] = [];
  const out = {
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
    isTTY: false,
  } as unknown as NodeJS.WriteStream;
  return { writes, out };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('attachCodexActivityPrinter', () => {
  let rpc: FakeRpc;
  let capture: ReturnType<typeof makeCaptureStream>;

  beforeEach(() => {
    rpc = makeFakeRpc();
    capture = makeCaptureStream();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prints a thread-started line with a shortened id', () => {
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    rpc.emit('thread/started', { thread: { id: '7f2a87e1deadbeef' } });
    expect(capture.writes.join('')).toBe('↻ thread 7f2a87e1 started\n\n');
  });

  it('opens a turn block with a short turn id', () => {
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    rpc.emit('turn/started', { threadId: 't1', turn: { id: '8a3f1234abcd' } });
    expect(capture.writes.join('')).toBe('▸ turn 8a3f1234\n');
  });

  it('renders a commandExecution item as `$ <command>` on start', () => {
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    rpc.emit('item/started', {
      threadId: 't1',
      turnId: 'turn-1',
      item: { type: 'commandExecution', id: 'i1', command: 'ls packages/cli/src' },
    });
    expect(capture.writes.join('')).toBe('   $ ls packages/cli/src\n');
  });

  it('collapses a multi-line command onto one line', () => {
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    rpc.emit('item/started', {
      threadId: 't1',
      turnId: 'turn-1',
      item: { type: 'commandExecution', id: 'i1', command: 'set -e\nls\n' },
    });
    expect(capture.writes.join('')).toBe('   $ set -e ls\n');
  });

  it('flags non-zero command exits on completion', () => {
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    rpc.emit('item/completed', {
      threadId: 't1',
      turnId: 'turn-1',
      item: { type: 'commandExecution', id: 'i1', exitCode: 2, durationMs: 1200 },
    });
    expect(capture.writes.join('')).toBe('     ↳ exit 2 · 1.2s\n');
  });

  it('stays silent on commandExecution success', () => {
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    rpc.emit('item/completed', {
      threadId: 't1',
      turnId: 'turn-1',
      item: { type: 'commandExecution', id: 'i1', exitCode: 0, durationMs: 500 },
    });
    expect(capture.writes.join('')).toBe('');
  });

  it('renders a single-file fileChange as the path; multi-file as a count', () => {
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    rpc.emit('item/started', {
      threadId: 't1',
      turnId: 'turn-1',
      item: {
        type: 'fileChange',
        id: 'i1',
        changes: [{ path: 'packages/cli/src/runtime/foo.ts' }],
      },
    });
    rpc.emit('item/started', {
      threadId: 't1',
      turnId: 'turn-1',
      item: {
        type: 'fileChange',
        id: 'i2',
        changes: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }],
      },
    });
    expect(capture.writes.join('')).toBe('   ± packages/cli/src/runtime/foo.ts\n   ± 3 files\n');
  });

  it('renders an mcpToolCall as `→ mcp: server.tool`', () => {
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    rpc.emit('item/started', {
      threadId: 't1',
      turnId: 'turn-1',
      item: { type: 'mcpToolCall', id: 'i1', server: 'csuite', tool: 'send_message' },
    });
    expect(capture.writes.join('')).toBe('   → mcp: csuite.send_message\n');
  });

  it('streams agent-message deltas inside an `assistant:` block', () => {
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    // item/started for an agentMessage is intentionally silent — the
    // deltas open the line themselves.
    rpc.emit('item/started', {
      threadId: 't1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'm1' },
    });
    expect(capture.writes.join('')).toBe('');

    rpc.emit('item/agentMessage/delta', {
      threadId: 't1',
      turnId: 'turn-1',
      itemId: 'm1',
      delta: 'Found ',
    });
    rpc.emit('item/agentMessage/delta', {
      threadId: 't1',
      turnId: 'turn-1',
      itemId: 'm1',
      delta: 'the issue.',
    });
    rpc.emit('item/completed', {
      threadId: 't1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'm1', text: 'Found the issue.' },
    });
    expect(capture.writes.join('')).toBe('   assistant: Found the issue.\n');
  });

  it('re-indents newlines inside a delta so continuation lines align', () => {
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    rpc.emit('item/agentMessage/delta', {
      threadId: 't1',
      turnId: 'turn-1',
      itemId: 'm1',
      delta: 'Line one\nLine two',
    });
    rpc.emit('item/completed', {
      threadId: 't1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'm1' },
    });
    // The 3-space INDENT after each `\n` keeps `Line two` aligned
    // under the assistant body column.
    expect(capture.writes.join('')).toBe('   assistant: Line one\n   Line two\n');
  });

  it('prints the full text when an agentMessage completes without deltas', () => {
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    rpc.emit('item/completed', {
      threadId: 't1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'm1', text: 'one-shot reply' },
    });
    expect(capture.writes.join('')).toBe('   assistant: one-shot reply\n');
  });

  it('summarises turn completion with elapsed time and tool count', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    rpc.emit('turn/started', { threadId: 't1', turn: { id: 'turn-42' } });
    rpc.emit('item/started', {
      threadId: 't1',
      turnId: 'turn-42',
      item: { type: 'commandExecution', id: 'a', command: 'ls' },
    });
    rpc.emit('item/started', {
      threadId: 't1',
      turnId: 'turn-42',
      item: { type: 'mcpToolCall', id: 'b', server: 'csuite', tool: 'push' },
    });
    // agentMessage doesn't count as a tool — only the busy-counted types do.
    rpc.emit('item/started', {
      threadId: 't1',
      turnId: 'turn-42',
      item: { type: 'agentMessage', id: 'm' },
    });
    vi.setSystemTime(new Date('2030-01-01T00:00:02.500Z'));
    rpc.emit('turn/completed', { threadId: 't1', turn: { id: 'turn-42' } });

    const out = capture.writes.join('');
    expect(out).toContain('└─ done · 2.5s · 2 tools');
  });

  it('uses singular "tool" when only one tool item ran', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    rpc.emit('turn/started', { threadId: 't1', turn: { id: 'turn-1' } });
    rpc.emit('item/started', {
      threadId: 't1',
      turnId: 'turn-1',
      item: { type: 'commandExecution', id: 'a', command: 'ls' },
    });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.300Z'));
    rpc.emit('turn/completed', { threadId: 't1', turn: { id: 'turn-1' } });
    expect(capture.writes.join('')).toContain('└─ done · 300ms · 1 tool');
  });

  it('surfaces error notifications on their own line', () => {
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    rpc.emit('error', { message: 'thread/start failed: timeout' });
    expect(capture.writes.join('')).toBe('! error: thread/start failed: timeout\n');
  });

  it('closes an open assistant line on shutdown so the terminal ends cleanly', () => {
    const printer = attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    rpc.emit('item/agentMessage/delta', {
      threadId: 't1',
      turnId: 'turn-1',
      itemId: 'm1',
      delta: 'streaming in progress',
    });
    // No item/completed fires — codex was killed mid-stream.
    printer.close();
    expect(capture.writes.join('').endsWith('\n')).toBe(true);
  });

  it('emits ANSI color codes when color is enabled', () => {
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: true });
    rpc.emit('error', { message: 'boom' });
    // Just check that *some* CSI escape is present — exact byte
    // assertions would couple the test to the palette constants.
    // ESC `[` is the SGR introducer; `.includes()` avoids embedding
    // a control character in a regex literal (which Biome lints).
    expect(capture.writes.join('').includes('\x1b[')).toBe(true);
  });

  it('falls back to plain ASCII when color is disabled', () => {
    attachCodexActivityPrinter({ rpc, stream: capture.out, color: false });
    rpc.emit('error', { message: 'boom' });
    expect(capture.writes.join('').includes('\x1b[')).toBe(false);
  });
});
