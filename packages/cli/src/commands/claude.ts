/**
 * `csuite claude` — wrap a Claude Code session in a csuite runner.
 *
 * This verb is a thin wrapper: it constructs the Claude Code
 * `AgentAdapter` (`runtime/agents/claude-agent.ts`) and hands it
 * to the shared session driver (`runtime/agent-session.ts`), which
 * owns the full lifecycle — auth, runner startup, prepare/spawn
 * ordering, signal handling, idempotent teardown on every exit path,
 * and the end-of-run summary (`session_start`/`session_end` activity
 * events + the `run summary` log line).
 *
 * Everything Claude-Code-specific — binary location, MCP config
 * strategy, `.claude/settings.json` hooks, auto-injected posture
 * flags, the pty relay + HUD — lives in the adapter.
 */

import { runAgentSession } from '../runtime/agent-session.js';
import { createClaudeAdapter } from '../runtime/agents/claude-agent.js';
import { UsageError } from './errors.js';

// Re-exported for existing consumers/tests; the implementation moved
// into the adapter module alongside the rest of the claude-specific
// spawn logic.
export { computeInjectedClaudeArgs } from '../runtime/agents/claude-agent.js';
export { UsageError };

export interface ClaudeCommandInput {
  url?: string;
  token?: string;
  /**
   * Claude args to forward. Everything after `--` on the command line
   * lands here verbatim, plus any positional args we don't recognize.
   */
  claudeArgs: string[];
  /**
   * Directory the runner runs in — this is also where the adapter
   * reads/writes `.mcp.json`. Defaults to `process.cwd()`. Tests
   * override this to isolate from the real repo.
   */
  cwd?: string;
  /** Optional logger override; defaults to a session log + stderr. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /**
   * Override the `command` + `args` written into the MCP config for
   * the `csuite` server entry. Defaults to the node binary + CLI entry
   * script this process runs under. Tests override this to point at
   * the built dist so they don't depend on a global install.
   */
  bridgeCommand?: string;
  bridgeArgs?: string[];
  /**
   * How to hand claude our MCP server entry:
   *   - `'flag'` (default) — write a csuite-owned ephemeral config file
   *     and pass `--mcp-config <file>`. Never touches the project
   *     `.mcp.json`; isolates cleanly across concurrent runs.
   *   - `'inject'` — back up and rewrite the project `.mcp.json`
   *     (the legacy behavior). Retained as a fallback.
   * Overridable via `CSUITE_CLAUDE_MCP_MODE=flag|inject`; the explicit
   * input wins over the env var.
   */
  mcpMode?: 'flag' | 'inject';
  /**
   * Disable activity capture. When true, the runner skips starting the
   * capture host (activity uploader, busy signal, hook server) and
   * leaves the agent's environment untouched — no OpenTelemetry export.
   * `csuite claude --no-trace` sets this.
   */
  noTrace?: boolean;
  /**
   * Skip resolving/injecting broker-held secrets into the agent's
   * environment. `csuite claude --no-secrets` sets this.
   */
  noSecrets?: boolean;
}

/**
 * Run a Claude Code session wrapped in a csuite runner. Resolves with
 * the exit code of the claude subprocess (so the CLI entry can
 * propagate it via `process.exit`). Teardown is driver-owned and runs
 * on every exit path, so even a crashing claude leaves the operator's
 * `.mcp.json` in its original state.
 */
export async function runClaudeCommand(input: ClaudeCommandInput): Promise<number> {
  const adapter = createClaudeAdapter({
    claudeArgs: input.claudeArgs,
    mcpMode: input.mcpMode,
  });
  return runAgentSession(adapter, {
    url: input.url,
    token: input.token,
    cwd: input.cwd,
    log: input.log,
    noTrace: input.noTrace,
    noSecrets: input.noSecrets,
    bridgeCommand: input.bridgeCommand,
    bridgeArgs: input.bridgeArgs,
  });
}
