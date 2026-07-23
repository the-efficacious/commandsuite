/**
 * Claude Code runner conformance — the shared kit run against the
 * claude adapter through its real command entry point, wrapping
 * the fake `claude` binary.
 *
 * XDG_CACHE_HOME is pointed into the sandbox so the ephemeral
 * `--mcp-config` files (and anything else cache-scoped) never touch
 * the real user cache and vanish with the sandbox.
 */

import { join } from 'node:path';
import { runClaudeCommand } from '../../../src/commands/claude.js';
import { FAKE_BROKER_TOKEN } from '../fake-broker.js';
import { writeFakeClaude } from './fake-agents.js';
import { CLI_BINARY, describeRunnerConformance, withEnv } from './kit.js';

describeRunnerConformance({
  id: 'claude',
  async runSession({ broker, sandbox, trace, agentExitCode, log }) {
    const fakeClaude = writeFakeClaude(sandbox);
    const restoreEnv = withEnv({
      CLAUDE_PATH: fakeClaude,
      FAKE_AGENT_EXIT_CODE: String(agentExitCode),
      FAKE_CLAUDE_TRANSCRIPT: undefined,
      XDG_CACHE_HOME: join(sandbox, 'xdg-cache'),
    });
    try {
      return await runClaudeCommand({
        url: broker.url,
        token: FAKE_BROKER_TOKEN,
        claudeArgs: [],
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
