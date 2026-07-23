/**
 * Codex runner conformance — the shared kit run against the codex
 * adapter through its real command entry point, wrapping the fake
 * `codex app-server` binary (newline-delimited JSON-RPC on stdio).
 *
 * XDG_CACHE_HOME and XDG_DATA_HOME are pointed into the sandbox so
 * the ephemeral CODEX_HOME and the durable per-member sessions dir
 * never touch the real user dirs and vanish with the sandbox.
 */

import { join } from 'node:path';
import { runCodexCommand } from '../../../src/commands/codex.js';
import { FAKE_BROKER_TOKEN } from '../fake-broker.js';
import { writeFakeCodex } from './fake-agents.js';
import { CLI_BINARY, describeRunnerConformance, withEnv } from './kit.js';

describeRunnerConformance({
  id: 'codex',
  async runSession({ broker, sandbox, trace, agentExitCode, log }) {
    const fakeCodex = writeFakeCodex(sandbox);
    const restoreEnv = withEnv({
      CODEX_PATH: fakeCodex,
      FAKE_AGENT_EXIT_CODE: String(agentExitCode),
      XDG_CACHE_HOME: join(sandbox, 'xdg-cache'),
      XDG_DATA_HOME: join(sandbox, 'xdg-data'),
    });
    try {
      return await runCodexCommand({
        url: broker.url,
        token: FAKE_BROKER_TOKEN,
        cwd: sandbox,
        log,
        bridgeCommand: process.execPath,
        bridgeArgs: [CLI_BINARY, 'mcp-bridge'],
        noTrace: !trace,
      });
    } finally {
      restoreEnv();
    }
  },
});
