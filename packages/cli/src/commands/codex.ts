/**
 * `csuite codex` — wrap an OpenAI Codex CLI session in a csuite runner.
 *
 * This verb is a thin wrapper: it constructs the codex `AgentAdapter`
 * (`runtime/agents/codex/codex-agent.ts`) and hands it to the shared
 * session driver (`runtime/agent-session.ts`), which owns the full
 * lifecycle — auth, runner startup, prepare/spawn ordering, signal
 * handling, idempotent teardown on every exit path, and the
 * end-of-run summary (`session_start`/`session_end` activity events +
 * the `run summary` log line).
 *
 * Unlike `csuite claude` (interactive, with a TUI you talk to in
 * the same terminal), codex runs headlessly under `codex app-server`.
 * The director communicates with the agent through the broker — chat,
 * DMs, objectives, `csuite push` — and the agent's outputs flow back
 * out through the same channels (or as work products on the local
 * filesystem). The adapter declares `signals: 'teardown'`, so Ctrl-C
 * ends the session gracefully instead of being forwarded.
 */

import { existsSync } from 'node:fs';
import { runAgentSession } from '../runtime/agent-session.js';
import { createCodexAdapter } from '../runtime/agents/codex/codex-agent.js';
import { UsageError } from './errors.js';

export { UsageError };

export interface CodexCommandInput {
  url?: string;
  token?: string;
  /** Working directory for codex. Defaults to process.cwd(). */
  cwd?: string;
  /** Optional model override forwarded as `thread/start`'s `model`. */
  model?: string;
  /**
   * Resume a previous codex thread instead of starting fresh. A string
   * is a thread id (printed in the banner of the run that created it);
   * `true` resumes this member's most recent thread on this machine.
   * `csuite codex --resume [<threadId>]` sets this.
   */
  resume?: string | true;
  /** Disable trace capture. */
  noTrace?: boolean;
  /** Skip resolving/injecting broker-held secrets. */
  noSecrets?: boolean;
  /**
   * Extra args forwarded verbatim to `codex app-server`. Populated by
   * everything the caller passes after `--` on the command line.
   */
  codexArgs?: string[];
  /** Optional logger override; defaults to a session log + stderr. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Override the bridge command (tests). */
  bridgeCommand?: string;
  /** Override the bridge args (tests). */
  bridgeArgs?: string[];
}

export async function runCodexCommand(input: CodexCommandInput): Promise<number> {
  const adapter = createCodexAdapter({
    model: input.model,
    resume: input.resume,
    codexArgs: input.codexArgs,
  });
  const exitCode = await runAgentSession(adapter, {
    url: input.url,
    token: input.token,
    cwd: input.cwd,
    log: input.log,
    noTrace: input.noTrace,
    noSecrets: input.noSecrets,
    bridgeCommand: input.bridgeCommand,
    bridgeArgs: input.bridgeArgs,
  });

  // Verify cwd existed at start — surfaces "user passed --cwd <typo>"
  // as a clean warning instead of a confusing codex-side failure. Runs
  // after teardown so a bad cwd still tears down cleanly.
  const cwd = input.cwd ?? process.cwd();
  if (!existsSync(cwd)) {
    process.stderr.write(`csuite codex: warning — cwd ${cwd} did not exist at exit\n`);
  }

  return exitCode;
}
