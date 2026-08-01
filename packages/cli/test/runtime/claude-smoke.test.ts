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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runClaudeCommand } from '../../src/commands/claude.js';
import { writeFakeClaude } from './conformance/fake-agents.js';
import { FAKE_BROKER_TOKEN, type FakeBroker, startFakeBroker } from './fake-broker.js';

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
    sandbox = mkdtempSync(join(tmpdir(), 'csuite-claude-smoke-'));
    transcriptPath = join(sandbox, 'claude-transcript.txt');
    fakeClaudePath = writeFakeClaude(sandbox);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

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
        log: () => {},
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
      'fs_ls',
      'fs_mkdir',
      'fs_mv',
      'fs_read',
      'fs_rm',
      'fs_shared',
      'fs_stat',
      'fs_write',
      'members_add',
      'members_remove',
      'members_update',
      'objectives_amend',
      'objectives_cancel',
      'objectives_complete',
      'objectives_correct_event',
      'objectives_create',
      'objectives_discuss',
      'objectives_list',
      'objectives_reassign',
      'objectives_update',
      'objectives_view',
      'objectives_watchers',
      'presets_delete',
      'presets_list',
      'presets_set',
      'process_document_get',
      'process_document_history',
      'recent',
      'roster',
      'send',
      'team_get',
      'team_update',
    ]);
  }, 30_000);
});
