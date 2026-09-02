/**
 * Respawn posture — that a `clear` starts the agent COLD.
 *
 * This suite exists because of a specific trap. Both adapters already
 * treated a null session id as "resume the most recent session
 * anyway" (claude sets `continue: true`, codex passes `true` as the
 * thread selector), because a predecessor that never ran a turn never
 * revealed an id and abandoning its conversation is the wrong default
 * for an INSTRUCTION restart. That makes `{ sessionId: null }`
 * unusable as "start cold" — it already means the opposite, and the
 * obvious implementation of `clear` (pass null) would silently
 * reattach the conversation the clear exists to discard.
 *
 * `RespawnPosture` closes that at the type level for callers. What
 * types cannot catch is an ADAPTER that accepts `resume: false` and
 * takes the resume branch anyway, so that is what is asserted here:
 * each adapter reports the cold branch and never the resuming one.
 *
 * SCOPE, STATED PLAINLY. `spawn` is stubbed, so this proves which
 * branch the adapter took — not that the framework subsequently
 * declines to resume. The end-to-end property (a cleared claude
 * session mints a fresh session id) needs a live agent and is not
 * covered here; `stub-cold-restart.test.ts` drives a real cold
 * respawn through the driver with the stub adapter. The driver now
 * asks for `{ resume: false }` on every swap (instruction restart,
 * reload, clear); the resuming arm is kept and tested here as the
 * posture's own contract.
 */

import type { Logger, LogRecord } from 'csuite-core';
import { describe, expect, it } from 'vitest';
import type {
  AgentProcess,
  AgentSessionContext,
  RespawnPosture,
} from '../../src/runtime/agents/adapter.js';
import { createClaudeAdapter } from '../../src/runtime/agents/claude-agent.js';
import { createCodexAdapter } from '../../src/runtime/agents/codex/codex-agent.js';
import { recordingLogger } from '../helpers/logger.js';

function fakeProcess(): AgentProcess {
  return {
    exitCode: Promise.resolve(0),
    sessionId: () => null,
    shutdown: async () => {},
  };
}

function fakeContext(logger: Logger) {
  return {
    runner: {
      secretsEnv: {},
      captureHost: null,
      instructions: {
        name: 'me',
        role: { title: 'engineer' },
        team: { name: 'team', context: '' },
        instructions: '',
        personalInstructions: '',
        permissions: [],
        openObjectives: [],
        teammates: [],
        toolSources: [],
      },
    },
    cwd: '/tmp',
    bridgeCommand: 'node',
    bridgeArgs: [],
    sessionLogPath: null,
    log: logger,
  } as unknown as AgentSessionContext;
}

/**
 * Drive one adapter's respawn under a posture, with `spawn` stubbed.
 * Overwriting `.spawn` on the returned object works because the
 * adapter's own `respawn` reaches it by property lookup at call time.
 */
async function respawnUnder(
  adapter: ReturnType<typeof createClaudeAdapter>,
  posture: RespawnPosture,
): Promise<{ logs: LogRecord[]; spawned: number }> {
  const rec = recordingLogger();
  let spawned = 0;
  adapter.spawn = async () => {
    spawned += 1;
    return fakeProcess();
  };
  await adapter.respawn?.(fakeContext(rec.logger), posture);
  return { logs: rec.records, spawned };
}

const SUBJECTS = [
  { id: 'claude', make: () => createClaudeAdapter({}) },
  { id: 'codex', make: () => createCodexAdapter({}) },
] as const;

describe.each(SUBJECTS)('$id adapter respawn posture', ({ id, make }) => {
  it('takes the COLD branch on { resume: false }', async () => {
    const { logs, spawned } = await respawnUnder(make(), { resume: false });

    expect(spawned).toBe(1);
    const messages = logs.map((l) => l.msg);
    expect(messages).toContain('respawning cold — conversation dropped by context clear');
    // The mutation this guards: falling through to the resume branch.
    // That branch logs the other line, so its absence is the assertion.
    expect(messages).not.toContain('respawning with refreshed instructions');
  });

  it('takes the RESUMING branch on { resume: true } — the nearest valid opposite', async () => {
    // Positive control. Without it, an adapter whose respawn always
    // logged "cold" (or never logged at all) would satisfy the test
    // above.
    const { logs, spawned } = await respawnUnder(make(), { resume: true, sessionId: 'sess-1' });

    expect(spawned).toBe(1);
    const messages = logs.map((l) => l.msg);
    expect(messages).toContain('respawning with refreshed instructions');
    expect(messages).not.toContain('respawning cold — conversation dropped by context clear');
    // And it carried the predecessor's conversation forward, which is
    // the entire difference between the two operations.
    expect(
      logs.find((l) => l.msg.endsWith('respawning with refreshed instructions')),
    ).toMatchObject({ resume: 'sess-1' });
  });

  it('declares a compaction capability', () => {
    // The coordinator reports `unsupported` for any adapter without
    // this method. Both shipped runners can compact — claude by
    // injecting the slash command, codex via `thread/compact/start` —
    // so an adapter that silently stopped declaring it would degrade
    // to a permanent `unsupported` that no other test would notice.
    expect(typeof make().compactContext).toBe('function');
  });

  it('still resumes when the predecessor never revealed an id', async () => {
    // `{ resume: true, sessionId: null }` is NOT a clear. An agent that
    // never ran a turn has no id to name, and an instruction restart
    // must still continue rather than silently dropping the
    // conversation — this is the exact ambiguity the union removed.
    const { logs } = await respawnUnder(make(), { resume: true, sessionId: null });

    expect(logs.map((l) => l.msg)).not.toContain(
      `${id}: respawning cold — conversation dropped by context clear`,
    );
  });
});
