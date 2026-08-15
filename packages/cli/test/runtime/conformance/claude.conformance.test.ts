/**
 * Claude runner conformance — the shared kit run against the claude
 * adapter through its real command entry point, with `CLAUDE_PATH`
 * substituting the fake stream-json `claude` binary for the Agent
 * SDK's bundled one.
 */

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
    });
    try {
      return await runClaudeCommand({
        url: broker.url,
        token: FAKE_BROKER_TOKEN,
        cwd: sandbox,
        logger: log,
        bridgeCommand: process.execPath,
        bridgeArgs: [CLI_BINARY, 'mcp-bridge'],
        noTrace: !trace,
      });
    } finally {
      restoreEnv();
    }
  },
});
