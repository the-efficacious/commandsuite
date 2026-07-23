/**
 * Runner conformance kit — the shared scenario suite every AgentAdapter
 * must pass before shipping.
 *
 * A subject provides ONE thing: `runSession`, which executes a full
 * runner session (through the real command entry point) against the
 * fake broker inside a sandbox, wrapping whatever fake agent binary
 * impersonates its framework. The kit then asserts the lifecycle
 * invariants the adapter contract promises, identically for every
 * runner:
 *
 *   S1. A session completes end-to-end, exits 0, and the runner's IPC
 *       socket is unlinked afterwards.
 *   S2. The agent's exit code propagates through the driver.
 *   S3. Operator files present in the cwd before the run are
 *       byte-identical after it (config restoration).
 *   S4. With capture on, the run bracket reaches the broker:
 *       `session_start` then `session_end` (with runner id, exit code,
 *       reason, duration, capture stats).
 *   S5. A machine-readable `run summary` log line is emitted on every
 *       exit path, with capture accounting when tracing and `null`
 *       when not.
 *
 * Scenarios the kit deliberately does NOT cover yet (documented in
 * docs/runners/conformance.mdx): in-process SIGINT/SIGTERM delivery
 * (vitest owns the process signals), and ambient broker-event
 * delivery, which is framework-specific enough to live in per-runner
 * tests (see `bridge.test.ts` for the claude path and
 * `codex/channel-sink.test.ts` for codex).
 *
 * Usage:
 *
 *   describeRunnerConformance({
 *     id: 'my-runner',
 *     runSession: async ({ broker, sandbox, trace, agentExitCode, log }) => {
 *       // install fake agent binary + env, call the real command fn,
 *       // restore env, return the exit code
 *     },
 *   });
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FAKE_BROKER_NAME,
  type FakeBroker,
  fakeBrokerActivity,
  startFakeBroker,
} from '../fake-broker.js';

export const CLI_BINARY = resolve(
  fileURLToPath(new URL('../../../dist/index.js', import.meta.url)),
);

export interface ConformanceRunOptions {
  broker: FakeBroker;
  /** Sandbox directory: agent cwd, fake binaries, scratch XDG homes. */
  sandbox: string;
  /** Whether the capture subsystem is enabled for this run. */
  trace: boolean;
  /** Exit code the fake agent should exit with. */
  agentExitCode: number;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface ConformanceSubject {
  /** Runner id as it appears in run summaries and session events. */
  id: string;
  /** Execute one full session; resolve with the propagated exit code. */
  runSession(opts: ConformanceRunOptions): Promise<number>;
}

interface CapturedLog {
  msg: string;
  ctx: Record<string, unknown>;
}

export function describeRunnerConformance(subject: ConformanceSubject): void {
  const describeIfBuilt = existsSync(CLI_BINARY) ? describe : describe.skip;

  describeIfBuilt(`runner conformance: ${subject.id}`, () => {
    let broker: FakeBroker;
    let sandbox: string;
    let logs: CapturedLog[];

    const log = (msg: string, ctx: Record<string, unknown> = {}): void => {
      logs.push({ msg, ctx });
    };

    const run = async (opts?: Partial<ConformanceRunOptions>): Promise<number> =>
      subject.runSession({
        broker,
        sandbox,
        trace: false,
        agentExitCode: 0,
        log,
        ...opts,
      });

    beforeAll(async () => {
      broker = await startFakeBroker();
    });

    afterAll(async () => {
      await broker.close();
    });

    beforeEach(() => {
      sandbox = mkdtempSync(join(tmpdir(), `csuite-conformance-${subject.id}-`));
      logs = [];
      fakeBrokerActivity.length = 0;
    });

    afterEach(() => {
      rmSync(sandbox, { recursive: true, force: true });
    });

    it('S1: completes a session end-to-end and unlinks the runner socket', async () => {
      const exitCode = await run();
      expect(exitCode).toBe(0);

      // The runner logged its socket path at bind time; it must be
      // gone after teardown.
      const bound = logs.find((l) => l.msg === 'runner: IPC socket bound');
      expect(bound, 'runner never logged its IPC socket bind').toBeDefined();
      const socketPath = bound?.ctx.socketPath as string;
      expect(typeof socketPath).toBe('string');
      expect(existsSync(socketPath)).toBe(false);
    }, 30_000);

    it('S2: propagates the agent exit code', async () => {
      const exitCode = await run({ agentExitCode: 3 });
      expect(exitCode).toBe(3);
    }, 30_000);

    it('S3: leaves operator files in the cwd byte-identical', async () => {
      const sentinels: Array<{ path: string; body: string }> = [
        {
          path: join(sandbox, '.mcp.json'),
          body: `${JSON.stringify({ mcpServers: { keepme: { command: 'true' } } }, null, 2)}\n`,
        },
        { path: join(sandbox, 'notes.txt'), body: 'operator scratch file\n' },
      ];
      for (const s of sentinels) writeFileSync(s.path, s.body, 'utf8');

      // Trace ON so config-writing paths that only run with capture
      // (e.g. claude's `.claude/settings.json` hooks) are exercised.
      const exitCode = await run({ trace: true });
      expect(exitCode).toBe(0);

      for (const s of sentinels) {
        expect(readFileSync(s.path, 'utf8'), `${s.path} was modified by the run`).toBe(s.body);
      }
    }, 30_000);

    it('S4: emits the session_start/session_end run bracket to the broker', async () => {
      const exitCode = await run({ trace: true });
      expect(exitCode).toBe(0);

      const mine = fakeBrokerActivity.filter((a) => a.member === FAKE_BROKER_NAME);
      const start = mine.find((a) => a.event.kind === 'session_start');
      const end = mine.find((a) => a.event.kind === 'session_end');

      expect(start, 'no session_start uploaded').toBeDefined();
      expect(start?.event.runner).toBe(subject.id);
      expect(typeof start?.event.captureTier).toBe('number');

      expect(end, 'no session_end uploaded').toBeDefined();
      expect(end?.event.runner).toBe(subject.id);
      expect(end?.event.exitCode).toBe(0);
      expect(end?.event.reason).toBe('agent-exited-0');
      expect(typeof end?.event.durationMs).toBe('number');
      const capture = end?.event.capture as
        | { enqueued: number; uploaded: number; dropped: number }
        | undefined;
      expect(capture, 'session_end missing capture accounting').toBeDefined();
      expect(capture && capture.enqueued >= 1).toBe(true);
      expect(capture?.dropped).toBe(0);

      // The bracket is ordered: start before end.
      expect(mine.indexOf(start as (typeof mine)[number])).toBeLessThan(
        mine.indexOf(end as (typeof mine)[number]),
      );
    }, 30_000);

    it('S5: logs a machine-readable run summary on every exit path', async () => {
      const exitCode = await run({ agentExitCode: 3 });
      expect(exitCode).toBe(3);

      const summary = logs.find((l) => l.msg === `${subject.id}: run summary`);
      expect(summary, 'no run summary log line').toBeDefined();
      expect(summary?.ctx.runner).toBe(subject.id);
      expect(summary?.ctx.member).toBe(FAKE_BROKER_NAME);
      expect(summary?.ctx.exitCode).toBe(3);
      expect(summary?.ctx.reason).toBe('agent-exited-3');
      expect(typeof summary?.ctx.durationMs).toBe('number');
      // Trace was off for this run — capture accounting must say so
      // explicitly rather than reporting zeros.
      expect(summary?.ctx.capture).toBeNull();
    }, 30_000);
  });
}

/**
 * Helper for subjects: set env vars for the duration of a run and get
 * a restore function. Keeps each subject's env juggling uniform.
 */
export function withEnv(vars: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
