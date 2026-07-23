/**
 * Verifies the `resume` option's handshake wiring: `thread/resume` is
 * issued (with the same headless posture overrides as a fresh start)
 * instead of `thread/start`, bare-resume resolves the newest rollout in
 * the durable sessions dir, and the resolved thread id is exposed on
 * the spawn result.
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (must be declared before the import under test) ────────────

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFileSync: vi.fn(() => '/usr/bin/codex'),
}));

vi.mock('../../../src/runtime/agents/codex/codex-home.js', () => ({
  setupCodexHome: vi.fn(() => ({
    path: '/tmp/fake-codex-home',
    configPath: '/tmp/fake-codex-home/config.toml',
    authLinked: true,
    sessionsLinked: true,
    remove: vi.fn(),
  })),
}));

const rpcMock = vi.hoisted(() => ({
  request: vi.fn().mockResolvedValue({}),
  onNotification: vi.fn(),
  onRequest: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../../../src/runtime/agents/codex/json-rpc.js', () => ({
  createJsonRpcClient: vi.fn(() => rpcMock),
}));

vi.mock('../../../src/runtime/agents/codex/busy-sniff.js', () => ({
  attachCodexBusySniff: vi.fn(() => ({ drain: vi.fn() })),
}));

vi.mock('../../../src/runtime/agents/codex/channel-sink.js', () => ({
  createCodexChannelSink: vi.fn(() => ({
    flushNow: vi.fn().mockResolvedValue(undefined),
    notification: vi.fn(),
  })),
}));

import type { BriefingResponse } from 'csuite-sdk/types';
import {
  CodexAdapterError,
  findLatestThreadId,
  spawnCodex,
} from '../../../src/runtime/agents/codex/adapter.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeFakeChild() {
  const child = new EventEmitter() as NodeJS.EventEmitter & {
    stdin: object;
    stdout: EventEmitter;
    exitCode: number | null;
    signalCode: string | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  child.stdout = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

const MINIMAL_BRIEFING: BriefingResponse = {
  name: 'test-agent',
  role: { title: 'tester', description: '' },
  team: { name: 'test-team', context: '', permissionPresets: {} },
  instructions: 'briefing prose',
  permissions: [],
  teammates: [],
  openObjectives: [],
  toolSources: [],
};

const THREAD_A = '019f0000-0000-7000-8000-00000000000a';
const THREAD_B = '019f0000-0000-7000-8000-00000000000b';

const BASE_OPTS = {
  briefing: MINIMAL_BRIEFING,
  runnerSocketPath: '/tmp/sock',
  bridgeCommand: '/usr/bin/node',
  bridgeArgs: ['/path/to/cli', 'mcp-bridge'],
  captureHost: null,
  codexBinary: '/usr/bin/codex',
  cwd: '/tmp',
  presence: {
    state: 'connecting' as const,
    setConnecting: vi.fn(),
    setOnline: vi.fn(),
    setOffline: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  },
  log: vi.fn(),
};

const cleanups: Array<() => void> = [];

/** A durable sessions dir with two rollouts, THREAD_B the newer. */
function seededSessionsDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'csuite-resume-test-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const d1 = join(root, '2026', '07', '18');
  const d2 = join(root, '2026', '07', '19');
  mkdirSync(d1, { recursive: true });
  mkdirSync(d2, { recursive: true });
  writeFileSync(join(d1, `rollout-2026-07-18T10-00-00-${THREAD_A}.jsonl`), '{}\n');
  writeFileSync(join(d2, `rollout-2026-07-19T09-30-00-${THREAD_B}.jsonl`), '{}\n');
  return root;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('spawnCodex — resume', () => {
  let fakeChild: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    rpcMock.request.mockImplementation(async (method: string) => {
      if (method === 'thread/resume' || method === 'thread/start') {
        return { thread: { id: THREAD_B, status: { type: 'idle' } } };
      }
      return {};
    });
    fakeChild = makeFakeChild();
    spawnMock.mockReturnValue(fakeChild);
  });

  afterEach(() => {
    fakeChild.emit('exit', 0, null);
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it('issues thread/resume (not thread/start) with the headless posture', async () => {
    const result = await spawnCodex({
      ...BASE_OPTS,
      resume: THREAD_B,
      sessionsDir: seededSessionsDir(),
    });

    const methods = rpcMock.request.mock.calls.map((c) => c[0]);
    expect(methods).toContain('thread/resume');
    expect(methods).not.toContain('thread/start');
    const resumeCall = rpcMock.request.mock.calls.find((c) => c[0] === 'thread/resume');
    expect(resumeCall?.[1]).toMatchObject({
      threadId: THREAD_B,
      cwd: '/tmp',
      developerInstructions: 'briefing prose',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    expect(result.getThreadId()).toBe(THREAD_B);

    fakeChild.emit('exit', 0, null);
    await result.exitCode;
  });

  it('bare resume resolves the newest rollout in the sessions dir', async () => {
    const result = await spawnCodex({
      ...BASE_OPTS,
      resume: true,
      sessionsDir: seededSessionsDir(),
    });

    const resumeCall = rpcMock.request.mock.calls.find((c) => c[0] === 'thread/resume');
    expect(resumeCall?.[1]).toMatchObject({ threadId: THREAD_B });

    fakeChild.emit('exit', 0, null);
    await result.exitCode;
  });

  it('bare resume with no prior sessions fails fast without spawning', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'csuite-resume-empty-'));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));

    await expect(spawnCodex({ ...BASE_OPTS, resume: true, sessionsDir: empty })).rejects.toThrow(
      CodexAdapterError,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('still uses thread/start when resume is not requested', async () => {
    const result = await spawnCodex({ ...BASE_OPTS, sessionsDir: seededSessionsDir() });

    const methods = rpcMock.request.mock.calls.map((c) => c[0]);
    expect(methods).toContain('thread/start');
    expect(methods).not.toContain('thread/resume');

    fakeChild.emit('exit', 0, null);
    await result.exitCode;
  });
});

describe('findLatestThreadId', () => {
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it('picks the lexicographically newest rollout and extracts its uuid', () => {
    expect(findLatestThreadId(seededSessionsDir())).toBe(THREAD_B);
  });

  it('returns null for a missing or empty dir', () => {
    expect(findLatestThreadId('/nonexistent/nowhere')).toBeNull();
    const empty = mkdtempSync(join(tmpdir(), 'csuite-resume-empty-'));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    expect(findLatestThreadId(empty)).toBeNull();
  });
});
