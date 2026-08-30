/**
 * Stub runner conformance — the shared kit run against the stub
 * adapter through its real command entry point. No fake binary: the
 * stub IS the credential-free agent, so the only test affordance is
 * the bounded-run knob (`CSUITE_STUB_EXIT_AFTER_MS` +
 * `CSUITE_STUB_EXIT_CODE`, standing in for `FAKE_AGENT_EXIT_CODE`).
 * Passing the same suite as claude and codex is what makes the stub a
 * lifecycle harness rather than a mock.
 */

import { runStubCommand } from '../../../src/commands/stub.js';
import { FAKE_BROKER_TOKEN } from '../fake-broker.js';
import { CLI_BINARY, describeRunnerConformance, withEnv } from './kit.js';

describeRunnerConformance({
  id: 'stub',
  async runSession({ broker, sandbox, trace, agentExitCode, log }) {
    const restoreEnv = withEnv({
      CSUITE_STUB_EXIT_AFTER_MS: '400',
      CSUITE_STUB_EXIT_CODE: String(agentExitCode),
    });
    try {
      return await runStubCommand({
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
