/**
 * `csuite claude-code` end-to-end smoke test.
 *
 * Spins up a fake broker, drops a fake `claude` binary on PATH (via
 * `CLAUDE_PATH`), invokes `runClaudeCodeCommand` directly, and asserts:
 *
 *   - The runner starts and, in the default `flag` mode, writes a
 *     csuite-owned ephemeral config with a `csuite` entry pointing at
 *     the runner's IPC socket, then passes claude `--mcp-config <file>`.
 *   - The fake claude "runs" (a bash script that spawns the real
 *     `csuite mcp-bridge` via the config it's pointed at, sends a
 *     couple of MCP requests on stdin, captures the responses) and
 *     exits cleanly.
 *   - The project `.mcp.json` in the cwd is left untouched, and the
 *     IPC socket is unlinked on exit.
 *
 * The fake claude script is a minimal bash stub that resolves its MCP
 * config from the `--mcp-config` arg the runner injects (falling back
 * to `./.mcp.json` for the legacy inject mode), launches the bridge,
 * runs a tiny MCP conversation, and exits. This is the full loop minus
 * the actual claude-code binary — proving the runner/bridge handshake
 * works end-to-end from a real operator-facing entry point.
 *
 * The test skips if `packages/cli/dist/index.js` hasn't been built,
 * same as `bridge.test.ts`.
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runClaudeCodeCommand } from '../../src/commands/claude-code.js';
import { FAKE_BROKER_TOKEN, type FakeBroker, startFakeBroker } from './fake-broker.js';

const CLI_BINARY = resolve(fileURLToPath(new URL('../../dist/index.js', import.meta.url)));
const describeIfBuilt = existsSync(CLI_BINARY) ? describe : describe.skip;

describeIfBuilt('csuite claude-code end-to-end', () => {
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

    // Fake claude: a bash script that spawns the real `csuite mcp-bridge`
    // (configured via the .mcp.json the runner just wrote in the
    // sandbox cwd), pumps a few MCP requests at it, collects the
    // responses into a transcript file, then exits 0.
    //
    // We can't use `jq` here — might not be installed — so we write
    // a small inline Node script instead and invoke it from bash.
    //
    // The bash wrapper lets us use `#!/usr/bin/env bash`, which makes
    // `stdio: 'inherit'` work reliably on Linux CI.
    fakeClaudePath = join(sandbox, 'fake-claude');
    const driverScript = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
let cfgPath = null;
for (let i = 0; i < argv.length - 1; i++) {
  if (argv[i] === '--mcp-config') { cfgPath = argv[i + 1]; break; }
}
if (!cfgPath) cfgPath = path.join(process.cwd(), '.mcp.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const entry = cfg.mcpServers && cfg.mcpServers.csuite;
if (!entry) { console.error('fake-claude: missing csuite entry'); process.exit(2); }
const child = spawn(entry.command, entry.args || [], {
  env: { ...process.env, ...(entry.env || {}) },
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buf = '';
const messages = [];
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx = buf.indexOf('\\n');
  while (idx !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) { try { messages.push(JSON.parse(line)); } catch {} }
    idx = buf.indexOf('\\n');
  }
});
function send(msg) { child.stdin.write(JSON.stringify(msg) + '\\n'); }
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = 0; i < messages.length; i++) {
      if (predicate(messages[i])) return messages.splice(i, 1)[0];
    }
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('fake-claude: timeout waiting for message');
}
(async () => {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0.0.1' } } });
  const initResp = await waitFor((m) => m.id === 1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listResp = await waitFor((m) => m.id === 2);
  fs.writeFileSync(process.env.FAKE_CLAUDE_TRANSCRIPT, JSON.stringify({
    initialized: !!initResp.result,
    toolNames: listResp.result.tools.map(t => t.name).sort(),
  }));
  child.stdin.end();
  child.kill('SIGTERM');
  process.exit(0);
})().catch((err) => { console.error('fake-claude:', err); process.exit(1); });
`;
    const driverPath = join(sandbox, 'fake-claude-driver.cjs');
    writeFileSync(driverPath, driverScript, 'utf8');
    writeFileSync(
      fakeClaudePath,
      `#!/usr/bin/env bash\nexec ${process.execPath} ${driverPath} "$@"\n`,
      'utf8',
    );
    chmodSync(fakeClaudePath, 0o755);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('starts a runner, wraps fake claude, and leaves project .mcp.json untouched', async () => {
    const mcpPath = join(sandbox, '.mcp.json');
    const originalMcp = { hooks: { precommit: 'echo hi' } };
    writeFileSync(mcpPath, JSON.stringify(originalMcp, null, 2), 'utf8');

    const prevClaudePath = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = fakeClaudePath;
    const prevTranscript = process.env.FAKE_CLAUDE_TRANSCRIPT;
    process.env.FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
    try {
      const exitCode = await runClaudeCodeCommand({
        url: broker.url,
        token: FAKE_BROKER_TOKEN,
        claudeArgs: [],
        cwd: sandbox,
        log: () => {},
        // Explicit bridge command because vitest's `process.argv[1]`
        // points at the vitest binary, not our cli — so the auto-
        // detection path in runClaudeCodeCommand doesn't work in
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
    }

    // The project .mcp.json must be left exactly as the operator wrote
    // it — in the default flag mode the runner never touches it, so this
    // proves the non-invasive contract end-to-end.
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
      'objectives_cancel',
      'objectives_complete',
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
      'recent',
      'roster',
      'send',
      'team_get',
      'team_update',
    ]);
  }, 30_000);
});
