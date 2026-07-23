/**
 * The AgentAdapter contract — the formal interface between the shared
 * agent-session driver (`runtime/agent-session.ts`) and each supported
 * agent framework.
 *
 * A runner (`csuite claude`, `csuite codex`, ...) is the parent
 * process that owns one csuite session. Everything broker-side is
 * SHARED and lives in the driver + `startRunner`: auth, briefing, IPC
 * socket, SSE forwarder, objectives tracker, capture host, secrets,
 * presence, signal handling, teardown ordering, and the end-of-run
 * summary. An adapter implements ONLY what is specific to one agent
 * framework:
 *
 *   1. `locate()`      — find the agent binary (fail fast, no side
 *                        effects on the environment)
 *   2. `runnerOptions` — the runner knobs this framework needs
 *                        (notification sink, second-bridge policy)
 *   3. `prepare()`     — write config, compute env + args; return an
 *                        idempotent cleanup that restores everything
 *   4. `spawn()`       — start the agent, return a process handle
 *   5. `doctor()`      — extra preflight checks (optional)
 *
 * The driver guarantees the lifecycle invariants so adapters don't
 * re-earn them: `cleanup()` runs on EVERY exit path (normal exit,
 * SIGINT/SIGTERM, spawn failure, uncaught exception), `shutdown()` is
 * awaited before user files are restored and before the runner drains
 * the capture uploader, and the run summary is emitted regardless of
 * how the session ended.
 *
 * The conformance suite (`test/runtime/conformance/`) exercises any
 * adapter through this interface against a fake broker + fake agent
 * binary; a new runner is expected to pass it before shipping. See
 * docs/runners/conformance.mdx for the written standard.
 */

import type { Presence } from '../presence.js';
import type { RunnerHandle, RunnerOptions } from '../runner.js';

export type AgentLog = (msg: string, ctx?: Record<string, unknown>) => void;

/**
 * Base class for adapter-raised errors that should surface to the
 * operator as a usage error (clean one-line message + exit 2) rather
 * than a stack trace. `ClaudeCodeAdapterError` and `CodexAdapterError`
 * extend this; the driver maps any instance to the CLI's `UsageError`.
 */
export class AgentAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentAdapterError';
  }
}

/**
 * Capture capability tiers. A tier is a declaration, not an
 * aspiration — an adapter states what its agent's native
 * instrumentation actually provides, and the docs matrix tells
 * consumers what data to expect per runner:
 *
 *   0 — OPERABLE:   spawns, serves the MCP toolbox, receives ambient
 *                   events, presence transitions, clean teardown.
 *   1 — OBSERVABLE: tier 0 + live activity signal (idle/working/
 *                   blocked) from native instrumentation.
 *   2 — TRACEABLE:  tier 1 + normalized content capture —
 *                   `llm_exchange` / `tool_action` / `user_prompt`
 *                   events, redacted, in the activity stream.
 *   3 — FULL:       tier 2 + verbatim request/response bodies into
 *                   the gen_ai / raw-body layer.
 */
export type CaptureTier = 0 | 1 | 2 | 3;

/**
 * Tested agent-version range, declared by the adapter and checked by
 * the doctor (WARN outside the range, never FAIL — agents move fast
 * and an untested version is a heads-up, not a stop sign). Plain
 * numeric triples compared segment-wise; no semver library.
 */
export interface TestedVersionRange {
  /** Lowest agent version the adapter is tested against (inclusive). */
  min?: string;
  /** Highest agent version the adapter is tested against (inclusive). */
  max?: string;
}

export interface AgentAdapterMeta {
  /**
   * Stable runner id: `'claude'`, `'codex'`, ... Used as the
   * session-log component, the run-summary `runner` field, and the
   * `csuite <id>:` banner prefix. Kebab-case, matches the CLI verb.
   */
  readonly id: string;
  /** Human display name (`'Claude Code'`, `'OpenAI Codex'`). */
  readonly displayName: string;
  /** Declared capture capability tier. */
  readonly captureTier: CaptureTier;
  /**
   * How OS signals map to the session:
   *
   *   - `'forward'`  — the agent owns the terminal (interactive TUI).
   *     SIGINT/SIGTERM are forwarded to the agent via
   *     `AgentProcess.signal()`; the session ends when the agent exits.
   *   - `'teardown'` — the runner owns the terminal (headless agent).
   *     SIGINT/SIGTERM end the session: graceful `shutdown()`, then
   *     teardown.
   */
  readonly signals: 'forward' | 'teardown';
  /**
   * Agent version range this adapter is tested against, or `null`
   * when no range has been declared yet. The doctor detects the
   * installed version via `versionArgs` and WARNs outside the range.
   */
  readonly testedVersions: TestedVersionRange | null;
  /**
   * Args that make the agent binary print its version (typically
   * `['--version']`). `null` disables the doctor's version check for
   * agents with no stable version flag.
   */
  readonly versionArgs: readonly string[] | null;
}

/**
 * Everything an adapter may need while preparing and spawning,
 * assembled by the driver after `startRunner` succeeds.
 */
export interface AgentSessionContext {
  readonly runner: RunnerHandle;
  readonly presence: Presence;
  /** Working directory the agent runs in. */
  readonly cwd: string;
  /**
   * Command + args an agent's config should use to spawn
   * `csuite mcp-bridge` — resolved by the driver to the same node
   * binary + CLI entry script the runner itself runs under (or test
   * overrides), so the bridge subprocess never depends on PATH.
   */
  readonly bridgeCommand: string;
  readonly bridgeArgs: readonly string[];
  readonly log: AgentLog;
  /** Path of the driver-owned session log file, when one was created. */
  readonly sessionLogPath: string | null;
}

export interface AgentPrepared {
  /**
   * Undo everything `prepare()` wrote — remove ephemeral config dirs,
   * restore user files from backup. MUST be idempotent, synchronous,
   * and non-throwing (swallow + warn internally): the driver calls it
   * on every exit path, including from `uncaughtException` handlers
   * where an exception would mask the original crash.
   */
  cleanup(): void;
  /**
   * Operator-facing banner lines the driver prints (to stderr) under
   * its standard header, before the agent spawns. One string per line,
   * no trailing newlines; empty strings render as blank lines.
   */
  bannerLines?: readonly string[];
}

export interface AgentProcess {
  /**
   * Resolves with the agent's exit code once it terminates. Must also
   * resolve after `shutdown()` kills the agent. Never rejects — spawn
   * failures resolve with a non-zero code after logging.
   */
  readonly exitCode: Promise<number>;
  /**
   * Agent-native session identity — Claude Code session id, codex
   * thread id — for the run summary and resume hints. Return `null`
   * when unknown.
   */
  sessionId(): string | null;
  /**
   * Forward an OS signal to the agent. Required for
   * `signals: 'forward'` adapters; ignored otherwise.
   */
  signal?(sig: NodeJS.Signals): void;
  /**
   * Graceful stop, idempotent. Flush agent-side sinks/readers (their
   * content must reach the capture host's uploader BEFORE this
   * resolves — the runner drains the uploader afterwards), kill the
   * agent if still alive, remove ephemeral state the spawn created.
   */
  shutdown(reason: string): Promise<void>;
}

/** One preflight check result — same shape the doctor renders. */
export interface AgentDoctorCheck {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
}

export interface AgentAdapter {
  readonly meta: AgentAdapterMeta;
  /**
   * Locate the agent binary and validate invocation inputs. Called
   * FIRST, before the runner starts or anything is written — a
   * missing binary must not leave sockets bound or files modified.
   * Throw `AgentAdapterError` (or a subclass) for operator-readable
   * failures. Must have no side effects on the environment.
   */
  locate(): void | Promise<void>;
  /**
   * Absolute path of the agent binary after a successful `locate()`,
   * or `null` before/without one. The doctor's version probe uses it.
   */
  binaryPath?(): string | null;
  /**
   * Runner options this agent framework needs — a notification-sink
   * override (how broker events become the framework's "ambient
   * input") and/or the second-bridge policy. Called once, before
   * `startRunner`. Omit entirely for frameworks happy with the
   * defaults (MCP-notification sink, `displace-old`).
   */
  runnerOptions?(): Pick<RunnerOptions, 'notificationSink' | 'onSecondBridge'>;
  /**
   * Write agent config / compute env + args for the spawn. Throwing
   * here aborts the session cleanly (runner shuts down; nothing was
   * spawned). Everything written must be undone by the returned
   * `cleanup()`.
   */
  prepare(ctx: AgentSessionContext): Promise<AgentPrepared> | AgentPrepared;
  /**
   * Start the agent process. Throwing here triggers
   * `prepared.cleanup()` + runner shutdown before the error
   * propagates.
   */
  spawn(ctx: AgentSessionContext): Promise<AgentProcess>;
  /**
   * Adapter-specific preflight checks beyond the shared set (binary
   * present, version range, tmpdir writable, loopback bindable).
   * Local-only: must not contact a broker or spawn the agent proper.
   */
  doctor?(): Promise<AgentDoctorCheck[]>;
}
