/**
 * `csuite stub` — run the stub agent (a test/CI instrument) as a
 * csuite team member.
 *
 * Same thin-wrapper shape as `csuite claude`/`csuite codex`: construct
 * the adapter (`runtime/agents/stub-agent.ts`), hand it to the shared
 * session driver. Everything the stub is — and is not — is documented
 * on the adapter; the one-line version: it proves the runner lifecycle
 * (presence, bridge, session bracket, restart/clear/reload, teardown)
 * with no model credential, and must never be deployed as a member.
 */

import type { Logger } from 'csuite-core';
import { runAgentSession } from '../runtime/agent-session.js';
import { createStubAdapter } from '../runtime/agents/stub-agent.js';
import { UsageError } from './errors.js';

export { UsageError };

export interface StubCommandInput {
  url?: string;
  token?: string;
  resolveReplacementToken?: () => string | null;
  cwd?: string;
  logger?: Logger;
  /** Test overrides for the bridge invocation, as on the real verbs. */
  bridgeCommand?: string;
  bridgeArgs?: string[];
  noTrace?: boolean;
  noSecrets?: boolean;
  noEnvReload?: boolean;
}

/** Run a stub session. Resolves with the session's exit code. */
export async function runStubCommand(input: StubCommandInput): Promise<number> {
  return runAgentSession(createStubAdapter(), {
    url: input.url,
    token: input.token,
    resolveReplacementToken: input.resolveReplacementToken,
    cwd: input.cwd,
    logger: input.logger,
    noTrace: input.noTrace,
    noSecrets: input.noSecrets,
    noEnvReload: input.noEnvReload,
    bridgeCommand: input.bridgeCommand,
    bridgeArgs: input.bridgeArgs,
  });
}
