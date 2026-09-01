/**
 * `csuite claude` — run Claude Code headlessly, via the Claude Agent
 * SDK, as a csuite team member.
 *
 * This verb is a thin wrapper: it constructs the Claude `AgentAdapter`
 * (`runtime/agents/claude-agent.ts`) and hands it to the shared session
 * driver (`runtime/agent-session.ts`), which owns the full lifecycle —
 * auth, runner startup, prepare/spawn ordering, signal handling,
 * idempotent teardown on every exit path, and the end-of-run summary
 * (`session_start`/`session_end` activity events + the `run summary`
 * log line).
 *
 * Everything Claude-specific — SDK option composition, the channel
 * sink feeding streaming input, hook forwarders, the activity printer
 * and HUD — lives in the adapter.
 */

import type { Logger } from 'csuite-core';
import { runAgentSession } from '../runtime/agent-session.js';
import { createClaudeAdapter } from '../runtime/agents/claude-agent.js';
import { UsageError } from './errors.js';

export { UsageError };

export interface ClaudeCommandInput {
  url?: string;
  token?: string;
  resolveReplacementToken?: () => string | null;
  /** Model override forwarded to the SDK (e.g. `claude-sonnet-5`). */
  model?: string;
  /**
   * Resume a previous Claude Code session. A string is a session id;
   * `true` passes the SDK's `continue` through: Claude Code picks up
   * the member's most recent session in the cwd if one exists, else
   * starts fresh — the runner does not predict which.
   */
  resume?: string | true;
  /**
   * Directory the agent runs in. Defaults to `process.cwd()`. Tests
   * override this to isolate from the real repo.
   */
  cwd?: string;
  /** Optional logger override; defaults to a session log + stderr. */
  logger?: Logger;
  /**
   * Override the `command` + `args` the SDK's MCP config uses for the
   * `csuite` server entry. Defaults to the node binary + CLI entry
   * script this process runs under. Tests override this to point at
   * the built dist so they don't depend on a global install.
   */
  bridgeCommand?: string;
  bridgeArgs?: string[];
  /**
   * Disable activity capture. When true, the runner skips starting the
   * capture host (activity uploader, busy signal, hook server) and
   * leaves the agent's environment untouched — no OpenTelemetry
   * export, no hook forwarders. `csuite claude --no-trace` sets this.
   */
  noTrace?: boolean;
  /**
   * Skip resolving/injecting broker-held secrets into the agent's
   * environment. `csuite claude --no-secrets` sets this.
   */
  noSecrets?: boolean;
  noEnvReload?: boolean;
}

/**
 * Run a headless Claude session wrapped in a csuite runner. Resolves
 * with the exit code of the Claude Code subprocess (so the CLI entry
 * can propagate it via `process.exit`). Teardown is driver-owned and
 * runs on every exit path.
 */
export async function runClaudeCommand(input: ClaudeCommandInput): Promise<number> {
  const adapter = createClaudeAdapter({
    model: input.model,
    resume: input.resume,
  });
  return runAgentSession(adapter, {
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
