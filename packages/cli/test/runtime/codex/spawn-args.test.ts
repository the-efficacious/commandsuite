/**
 * Verifies that arbitrary args passed via `codexArgs` reach the
 * `codex app-server` spawn call unchanged.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (must be declared before the import under test) ────────────

// vi.mock factories are hoisted; use vi.hoisted so spawnMock exists
// by the time the factory closure runs.
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
import { spawnCodex } from '../../../src/runtime/agents/codex/adapter.js';

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
  instructions: '',
  permissions: [],
  teammates: [],
  openObjectives: [],
  toolSources: [],
};

// Plain object (no `as const`) so spread-extension types stay assignable
// to `CodexSpawnOptions` — `as const` would freeze `bridgeArgs` to a
// readonly tuple and break the mutable `string[]` parameter shape.
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

// ── Tests ─────────────────────────────────────────────────────────────

describe('spawnCodex — codexArgs passthrough', () => {
  let fakeChild: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    rpcMock.request.mockResolvedValue({});
    fakeChild = makeFakeChild();
    spawnMock.mockReturnValue(fakeChild);
  });

  afterEach(() => {
    // Ensure any pending promise is settled so vitest doesn't hang.
    fakeChild.emit('exit', 0, null);
  });

  it('appends codexArgs verbatim after app-server', async () => {
    const codexArgs = [
      '-c',
      'model_provider="qwen"',
      '-c',
      'model_providers.qwen.base_url="http://localhost:8000/v1"',
    ];

    const promise = spawnCodex({ ...BASE_OPTS, codexArgs });
    // Yield so the async setup inside spawnCodex can run.
    await new Promise((r) => setTimeout(r, 0));

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/codex',
      ['app-server', ...codexArgs],
      expect.objectContaining({ cwd: '/tmp' }),
    );

    fakeChild.emit('exit', 0, null);
    await promise;
  });

  it('spawns with just app-server when codexArgs is omitted', async () => {
    const promise = spawnCodex({ ...BASE_OPTS });
    await new Promise((r) => setTimeout(r, 0));

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/codex',
      ['app-server'],
      expect.objectContaining({ cwd: '/tmp' }),
    );

    fakeChild.emit('exit', 0, null);
    await promise;
  });

  it('spawns with just app-server when codexArgs is an empty array', async () => {
    const promise = spawnCodex({ ...BASE_OPTS, codexArgs: [] });
    await new Promise((r) => setTimeout(r, 0));

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/codex',
      ['app-server'],
      expect.objectContaining({ cwd: '/tmp' }),
    );

    fakeChild.emit('exit', 0, null);
    await promise;
  });
});
