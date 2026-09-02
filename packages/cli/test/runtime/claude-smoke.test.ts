/**
 * `csuite claude` end-to-end smoke test.
 *
 * Spins up a fake broker, substitutes a fake stream-json `claude`
 * binary for the Agent SDK's bundled one (via `CLAUDE_PATH`), invokes
 * `runClaudeCommand` directly, and asserts:
 *
 *   - The runner starts, the SDK spawns the fake agent, and the fake
 *     "runs": it answers the SDK's initialize handshake, spawns the
 *     real `csuite mcp-bridge` from the inline `--mcp-config` JSON the
 *     SDK composed, runs a tiny MCP conversation (initialize +
 *     tools/list), and exits cleanly.
 *   - The bridge served the real csuite tool surface (transcript
 *     assertion on the sorted tool names).
 *   - The project `.mcp.json` in the cwd is left byte-identical — the
 *     SDK runner writes nothing into the member's working tree.
 *
 * This is the full loop minus the actual Claude Code binary — proving
 * the runner/SDK/bridge handshake works end-to-end from a real
 * operator-facing entry point.
 *
 * The test skips if `packages/cli/dist/index.js` hasn't been built,
 * same as `bridge.test.ts`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runClaudeCommand } from '../../src/commands/claude.js';
import { recordingLogger, silentLogger } from '../helpers/logger.js';
import { writeFakeClaude } from './conformance/fake-agents.js';
import {
  FAKE_BROKER_TOKEN,
  type FakeBroker,
  fakeBrokerActivity,
  fakeBrokerActivityFailure,
  fakeBrokerInstructions,
  fakeBrokerTimeline,
  startFakeBroker,
} from './fake-broker.js';

const CLI_BINARY = resolve(fileURLToPath(new URL('../../dist/index.js', import.meta.url)));
const describeIfBuilt = existsSync(CLI_BINARY) ? describe : describe.skip;

describeIfBuilt('csuite claude end-to-end', () => {
  let broker: FakeBroker;
  let sandbox: string;
  let fakeClaudePath: string;
  let transcriptPath: string;

  beforeAll(async () => {
    broker = await startFakeBroker();
  });

  afterAll(async () => {
    await broker.close();
  });

  beforeEach(() => {
    fakeBrokerActivityFailure.enabled = false;
    fakeBrokerTimeline.length = 0;
    sandbox = mkdtempSync(join(tmpdir(), 'csuite-claude-smoke-'));
    transcriptPath = join(sandbox, 'claude-transcript.txt');
    fakeClaudePath = writeFakeClaude(sandbox);
  });

  it('fails causally before presence when session_start cannot be acknowledged', async () => {
    const previous = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = fakeClaudePath;
    fakeBrokerActivityFailure.enabled = true;
    try {
      await expect(
        runClaudeCommand({
          url: broker.url,
          token: FAKE_BROKER_TOKEN,
          cwd: sandbox,
          logger: silentLogger(),
          bridgeCommand: process.execPath,
          bridgeArgs: [CLI_BINARY, 'mcp-bridge'],
        }),
      ).rejects.toThrow('session_start could not be delivered; runner presence was not opened');
      expect(fakeBrokerTimeline.some((entry) => entry.kind === 'subscribe')).toBe(false);
    } finally {
      fakeBrokerActivityFailure.enabled = false;
      if (previous === undefined) delete process.env.CLAUDE_PATH;
      else process.env.CLAUDE_PATH = previous;
    }
  });

  afterEach(() => {
    fakeBrokerActivityFailure.enabled = false;
    fakeBrokerInstructions.value = '';
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('starts when the instructions exceeds the former 8192-character client cap', async () => {
    fakeBrokerInstructions.value = 'oversized instruction '.repeat(500);
    expect(fakeBrokerInstructions.value.length).toBeGreaterThan(8_192);

    const prevClaudePath = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = fakeClaudePath;
    const prevTranscript = process.env.FAKE_CLAUDE_TRANSCRIPT;
    process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
    const prevExitCode = process.env.FAKE_AGENT_EXIT_CODE;
    process.env.FAKE_AGENT_EXIT_CODE = '0';
    try {
      const exitCode = await runClaudeCommand({
        url: broker.url,
        token: FAKE_BROKER_TOKEN,
        cwd: sandbox,
        logger: silentLogger(),
        bridgeCommand: process.execPath,
        bridgeArgs: [CLI_BINARY, 'mcp-bridge'],
        noTrace: true,
      });
      expect(exitCode).toBe(0);
      expect(JSON.parse(readFileSync(transcriptPath, 'utf8')).initialized).toBe(true);
    } finally {
      if (prevClaudePath === undefined) delete process.env.CLAUDE_PATH;
      else process.env.CLAUDE_PATH = prevClaudePath;
      if (prevTranscript === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPT;
      else process.env.FAKE_CLAUDE_TRANSCRIPT = prevTranscript;
      if (prevExitCode === undefined) delete process.env.FAKE_AGENT_EXIT_CODE;
      else process.env.FAKE_AGENT_EXIT_CODE = prevExitCode;
    }
  }, 30_000);

  it('starts a runner, drives fake claude through the SDK, and leaves project .mcp.json untouched', async () => {
    const mcpPath = join(sandbox, '.mcp.json');
    const originalMcp = { hooks: { precommit: 'echo hi' } };
    writeFileSync(mcpPath, JSON.stringify(originalMcp, null, 2), 'utf8');

    const prevClaudePath = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = fakeClaudePath;
    const prevTranscript = process.env.FAKE_CLAUDE_TRANSCRIPT;
    process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
    const prevExitCode = process.env.FAKE_AGENT_EXIT_CODE;
    process.env.FAKE_AGENT_EXIT_CODE = '0';
    try {
      const exitCode = await runClaudeCommand({
        url: broker.url,
        token: FAKE_BROKER_TOKEN,
        cwd: sandbox,
        logger: silentLogger(),
        // Explicit bridge command because vitest's `process.argv[1]`
        // points at the vitest binary, not our cli — so the auto-
        // detection path in runClaudeCommand doesn't work in
        // this context. In real-world use, argv[1] is always the
        // cli's entry script (dev alias or global install) and the
        // defaults Just Work.
        bridgeCommand: process.execPath,
        bridgeArgs: [CLI_BINARY, 'mcp-bridge'],
        noTrace: true,
      });
      expect(exitCode).toBe(0);
    } finally {
      if (prevClaudePath === undefined) delete process.env.CLAUDE_PATH;
      else process.env.CLAUDE_PATH = prevClaudePath;
      if (prevTranscript === undefined) delete process.env.FAKE_CLAUDE_TRANSCRIPT;
      else process.env.FAKE_CLAUDE_TRANSCRIPT = prevTranscript;
      if (prevExitCode === undefined) delete process.env.FAKE_AGENT_EXIT_CODE;
      else process.env.FAKE_AGENT_EXIT_CODE = prevExitCode;
    }

    // The project .mcp.json must be left exactly as the operator wrote
    // it — the SDK runner delivers its MCP entry inline on the agent
    // invocation and never touches the member's tree.
    const untouched = JSON.parse(readFileSync(mcpPath, 'utf8'));
    expect(untouched).toEqual(originalMcp);

    // Fake claude wrote a transcript — assert the bridge served it
    // a real tools/list response with the agent's tool surface.
    const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8'));
    expect(transcript.initialized).toBe(true);
    expect(transcript.toolNames).toEqual([
      'broadcast',
      'channels_list',
      'channels_post',
      'connect_approve',
      'connect_pending',
      'context_control',
      'fs_download',
      'fs_ls',
      'fs_mkdir',
      'fs_mv',
      'fs_read',
      'fs_rm',
      'fs_shared',
      'fs_stat',
      'fs_upload',
      'fs_write',
      'members_add',
      'members_remove',
      'members_update',
      'objectives_cancel',
      'objectives_complete',
      'objectives_create',
      'objectives_discuss',
      'objectives_list',
      'objectives_update',
      'objectives_view',
      'recent',
      'roster',
      'send',
      'team_get',
      'team_process_get',
      'team_process_history',
      'team_status',
      'team_update',
    ]);
  }, 30_000);

  /**
   * Drive one bare-`--resume` run and return the session_start events
   * the fake broker received plus the runner's own log records. HOME is
   * pointed at the sandbox so the test controls whether a prior session
   * exists under `~/.claude/projects/<slug>/`.
   */
  async function runBareResume(opts: { priorSession: boolean }) {
    const prevClaudePath = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = fakeClaudePath;
    const prevExitCode = process.env.FAKE_AGENT_EXIT_CODE;
    process.env.FAKE_AGENT_EXIT_CODE = '0';
    const prevHome = process.env.HOME;
    process.env.HOME = sandbox;
    if (opts.priorSession) {
      const slugDir = join(sandbox, '.claude', 'projects', sandbox.replace(/[/.]/g, '-'));
      mkdirSync(slugDir, { recursive: true });
      writeFileSync(join(slugDir, 'prior-session.jsonl'), '');
    }
    fakeBrokerActivity.length = 0;
    const rec = recordingLogger();
    try {
      const exitCode = await runClaudeCommand({
        url: broker.url,
        token: FAKE_BROKER_TOKEN,
        cwd: sandbox,
        resume: true,
        logger: rec.logger,
        bridgeCommand: process.execPath,
        bridgeArgs: [CLI_BINARY, 'mcp-bridge'],
      });
      expect(exitCode).toBe(0);
      const starts = fakeBrokerActivity
        .map((a) => a.event)
        .filter((e) => e.kind === 'session_start');
      expect(starts.length).toBeGreaterThan(0);
      return { starts, records: rec.records };
    } finally {
      if (prevClaudePath === undefined) delete process.env.CLAUDE_PATH;
      else process.env.CLAUDE_PATH = prevClaudePath;
      if (prevExitCode === undefined) delete process.env.FAKE_AGENT_EXIT_CODE;
      else process.env.FAKE_AGENT_EXIT_CODE = prevExitCode;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  }

  it('bare --resume on a cold directory: no verdict on session_start, continue still handed to the SDK', async () => {
    // The runner no longer predicts resume from the filesystem. With
    // nothing under ~/.claude/projects the SDK still receives
    // `continue: true` (the agent decides — measured: it starts fresh,
    // no error) and the real session_start carries neither `resumed`
    // nor a `resumeReason`, because the runner did not decide.
    const { starts, records } = await runBareResume({ priorSession: false });
    expect(starts[0]).not.toHaveProperty('resumed');
    expect(starts[0]).not.toHaveProperty('resumeReason');
    const spawnLog = records.find((r) => r.msg === 'starting agent sdk session');
    expect(spawnLog, 'no spawn log').toBeDefined();
    expect(spawnLog?.resume).toBe(true); // not downgraded to a fresh start by a probe
    // The old fallback's log line and banner are gone with the probe.
    expect(records.map((r) => r.msg)).not.toContain(
      'resume: no previous claude session found — starting fresh',
    );
  }, 30_000);

  it('bare --resume with a prior session on disk: the stamp is IDENTICAL — no probe, no guess', async () => {
    // Positive control for the absence above: a .jsonl under the slug
    // used to flip the stamp to resumed:true. A runner that still
    // looked would produce a different session_start here.
    const { starts, records } = await runBareResume({ priorSession: true });
    expect(starts[0]).not.toHaveProperty('resumed');
    expect(starts[0]).not.toHaveProperty('resumeReason');
    expect(records.find((r) => r.msg === 'starting agent sdk session')?.resume).toBe(true);
  }, 30_000);

  it('explicit --resume <id> stamps resumed:true — the one resume the runner itself decides', async () => {
    const prevClaudePath = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = fakeClaudePath;
    const prevExitCode = process.env.FAKE_AGENT_EXIT_CODE;
    process.env.FAKE_AGENT_EXIT_CODE = '0';
    fakeBrokerActivity.length = 0;
    try {
      const exitCode = await runClaudeCommand({
        url: broker.url,
        token: FAKE_BROKER_TOKEN,
        cwd: sandbox,
        resume: 'f4c0de00-0000-4000-8000-00000000000a',
        logger: silentLogger(),
        bridgeCommand: process.execPath,
        bridgeArgs: [CLI_BINARY, 'mcp-bridge'],
      });
      expect(exitCode).toBe(0);
      const starts = fakeBrokerActivity
        .map((a) => a.event)
        .filter((e) => e.kind === 'session_start');
      expect(starts[0]).toMatchObject({ resumed: true });
      expect(starts[0]).not.toHaveProperty('resumeReason');
    } finally {
      if (prevClaudePath === undefined) delete process.env.CLAUDE_PATH;
      else process.env.CLAUDE_PATH = prevClaudePath;
      if (prevExitCode === undefined) delete process.env.FAKE_AGENT_EXIT_CODE;
      else process.env.FAKE_AGENT_EXIT_CODE = prevExitCode;
    }
  }, 30_000);
});
