/**
 * Fake agent binaries for the runner conformance suite.
 *
 * Each helper writes an executable into the sandbox that impersonates
 * one agent framework just enough to exercise the real runner path
 * end-to-end — real broker client, real IPC socket, real MCP bridge
 * subprocess, real adapter — with no actual LLM anywhere.
 *
 * Both fakes honor `FAKE_AGENT_EXIT_CODE` so the suite can assert
 * exit-code propagation through the driver.
 */

import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fake `claude`: resolves the MCP config from the `--mcp-config` arg
 * the runner injects (falling back to `./.mcp.json` for the legacy
 * inject mode), spawns the real `csuite mcp-bridge` from it, runs a
 * minimal MCP conversation (initialize + tools/list), then exits.
 * When `FAKE_CLAUDE_TRANSCRIPT` is set, writes what it saw there.
 */
export function writeFakeClaude(sandbox: string): string {
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
  if (process.env.FAKE_CLAUDE_TRANSCRIPT) {
    fs.writeFileSync(process.env.FAKE_CLAUDE_TRANSCRIPT, JSON.stringify({
      initialized: !!initResp.result,
      toolNames: listResp.result.tools.map(t => t.name).sort(),
    }));
  }
  child.stdin.end();
  child.kill('SIGTERM');
  process.exit(Number(process.env.FAKE_AGENT_EXIT_CODE || '0'));
})().catch((err) => { console.error('fake-claude:', err); process.exit(1); });
`;
  const driverPath = join(sandbox, 'fake-claude-driver.cjs');
  writeFileSync(driverPath, driverScript, 'utf8');
  const binPath = join(sandbox, 'fake-claude');
  writeFileSync(
    binPath,
    `#!/usr/bin/env bash\nexec ${process.execPath} ${driverPath} "$@"\n`,
    'utf8',
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

/**
 * Fake `codex app-server`: newline-delimited JSON-RPC over stdio.
 * Answers the `initialize` and `thread/start` handshakes the codex
 * adapter performs, emits a `thread/started` notification, then exits
 * on its own shortly after — driving the runner's `agent-exited`
 * teardown path, the same way a real headless codex ends a session.
 */
export function writeFakeCodex(sandbox: string): string {
  const driverScript = `
const readline = require('node:readline');
if (process.argv[2] !== 'app-server') {
  console.error('fake-codex: expected app-server subcommand, got', process.argv.slice(2));
  process.exit(2);
}
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const exitCode = Number(process.env.FAKE_AGENT_EXIT_CODE || '0');
let started = false;
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize' && msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'thread/start' && msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'fake-thread-1', status: { type: 'idle' } } } });
    send({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 'fake-thread-1', status: { type: 'idle' } } } });
    if (!started) {
      started = true;
      // Linger briefly so the runner finishes its post-spawn wiring,
      // then end the session like a real headless run would.
      setTimeout(() => process.exit(exitCode), 400);
    }
    return;
  }
  if (msg.id !== undefined && msg.method) {
    // Any other request (turn/interrupt, ...) gets an empty ack.
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
process.on('SIGTERM', () => process.exit(exitCode));
`;
  const driverPath = join(sandbox, 'fake-codex-driver.cjs');
  writeFileSync(driverPath, driverScript, 'utf8');
  const binPath = join(sandbox, 'fake-codex');
  writeFileSync(
    binPath,
    `#!/usr/bin/env bash\nexec ${process.execPath} ${driverPath} "$@"\n`,
    'utf8',
  );
  chmodSync(binPath, 0o755);
  return binPath;
}
