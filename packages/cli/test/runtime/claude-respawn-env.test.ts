import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionContext } from '../../src/runtime/agents/adapter.js';
import { createClaudeAdapter } from '../../src/runtime/agents/claude-agent.js';
import { createPresence } from '../../src/runtime/presence.js';
import { silentLogger } from '../helpers/logger.js';

const sdk = vi.hoisted(() => ({ childValues: [] as string[] }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { env?: NodeJS.ProcessEnv } }) => {
    const q = {
      [Symbol.asyncIterator]() {
        let read = false;
        return {
          async next() {
            if (read) return { done: true as const, value: undefined };
            read = true;
            // Read from a real successor process. Inspecting options.env here
            // would repeat the runner-level false positive this regression had:
            // the outcome is what the child actually receives.
            const child = spawnSync(
              process.execPath,
              ['-e', "process.stdout.write(process.env.ACCEPT_PROBE || '')"],
              { env: options.env, encoding: 'utf8' },
            );
            sdk.childValues.push(child.stdout);
            return { done: true as const, value: undefined };
          },
        };
      },
      interrupt: async () => {},
      close: () => {},
    };
    return q;
  },
}));

function instructions() {
  return {
    name: 'builder',
    role: { title: 'engineer' },
    team: { name: 'team', context: '' },
    instructions: '',
    personalInstructions: '',
    permissions: [],
    openObjectives: [],
    teammates: [],
    toolSources: [],
  };
}

describe('claude respawn child environment', () => {
  let sandbox = '';

  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    delete process.env.CLAUDE_PATH;
    sdk.childValues.length = 0;
  });

  it('starts the successor child with the runner current secret snapshot', async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'csuite-claude-respawn-env-'));
    const fakeClaude = join(sandbox, 'claude');
    writeFileSync(fakeClaude, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeClaude, 0o755);
    process.env.CLAUDE_PATH = fakeClaude;

    const secretsEnv: Record<string, string> = { ACCEPT_PROBE: 'before' };
    const ctx = {
      runner: {
        instructions: instructions(),
        secretsEnv,
        captureHost: null,
        socketPath: join(sandbox, 'runner.sock'),
      },
      cwd: sandbox,
      bridgeCommand: process.execPath,
      bridgeArgs: [],
      sessionLogPath: null,
      log: silentLogger(),
      presence: createPresence('online'),
    } as unknown as AgentSessionContext;

    const adapter = createClaudeAdapter({});
    adapter.locate();
    adapter.prepare(ctx);
    const predecessor = await adapter.spawn(ctx);
    await predecessor.exitCode;
    expect(sdk.childValues).toEqual(['before']);

    // refreshSecrets preserves snapshot identity and mutates its values.
    // The adapter must read it again rather than reuse prepare()'s copy.
    secretsEnv.ACCEPT_PROBE = 'after';
    adapter.detachForRestart?.();
    const successor = await adapter.respawn?.(ctx, { resume: true, sessionId: 'session-1' });
    expect(successor).toBeDefined();
    await successor?.exitCode;
    expect(sdk.childValues).toEqual(['before', 'after']);
  });
});
