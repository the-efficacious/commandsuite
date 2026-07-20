/**
 * Per-runner ephemeral `CODEX_HOME` directory.
 *
 * Why we don't edit `~/.codex/config.toml` directly:
 *   - It's the user's HOME-level config and likely contains MCP server
 *     entries, profile defaults, etc. that we shouldn't merge into.
 *   - Multi-slot runs would race on the same file.
 *   - Backup/restore semantics for HOME-level state are scarier than
 *     for per-project state — a botched restore loses real config.
 *
 * Instead, every `csuite codex` invocation gets its own temporary
 * `CODEX_HOME`. We pass `CODEX_HOME=<dir>` to the spawned `codex
 * app-server`; codex reads ALL of its config (auth, config.toml,
 * sessions/) from that root, so we control it completely.
 *
 * Layout we create:
 *
 *   <csuite-codex-home>/
 *     auth.json       ← symlink to user's ~/.codex/auth.json (so OAuth
 *                       refreshes from the real codex login persist)
 *     config.toml     ← our own config: the [mcp_servers.csuite] block
 *                       pointing at `csuite mcp-bridge`, plus (when tracing
 *                       is on) an [otel] block that ships codex's native
 *                       operational telemetry to the broker's OTLP endpoint
 *     sessions/       ← (when `sessionsDir` is set) symlink to a durable
 *                       per-member dir, so codex's thread rollouts survive
 *                       the run and `thread/resume` works across runs
 *
 * On runner close, the entire directory is removed. Symlinks make the
 * cleanup safe — we never delete the real auth.json, and `rmSync` removes
 * the sessions link itself, not the durable rollouts behind it.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface CodexHomeOptions {
  /**
   * Path to the user's real codex home. Defaults to `~/.codex`.
   * Used only to symlink `auth.json` from. Tests override this so they
   * can run without touching the real codex login.
   */
  realCodexHome?: string;
  /**
   * Parent directory for our ephemeral home. Defaults to
   * `$XDG_CACHE_HOME/commandsuite/codex` (or `~/.cache/commandsuite/codex`).
   * NOT `$TMPDIR`: codex refuses to install helper binaries under
   * tmpfs and emits a `Refusing to create helper binaries under
   * temporary dir` warning, which means tooling like the apply-patch
   * helper isn't available to the agent.
   */
  parentDir?: string;
  /**
   * What `command` to write into the `[mcp_servers.csuite]` block. Always
   * `process.execPath` in production so codex spawns the same node
   * binary the runner is running under (no PATH dance).
   */
  bridgeCommand: string;
  /** Args to pass to the bridge command (`['<cli-entry>', 'mcp-bridge']`). */
  bridgeArgs: string[];
  /** Path to the runner's IPC socket — bridge env. */
  runnerSocketPath: string;
  /** Optional extra env vars to put on the bridge subprocess. */
  bridgeExtraEnv?: Record<string, string>;
  /**
   * Native OTEL export target. When present, an `[otel]` block is written
   * into config.toml so codex ships its operational telemetry (api
   * requests, token/sse accounting, tool decisions) to the broker's OTLP
   * logs endpoint. Absent under `--no-trace`. `endpoint` is the FULL logs
   * URL — codex POSTs to it verbatim (no `/v1/logs` suffix appended) — and
   * `token` is the member bearer. `log_user_prompt` stays off: prompts are
   * captured from the rollout, not the telemetry stream.
   */
  otel?: { endpoint: string; token: string; environment?: string };
  /**
   * Durable sessions directory. When set, it is created (recursively)
   * and `<home>/sessions` is written as a symlink to it, so the thread
   * rollouts codex persists there outlive the ephemeral home — the
   * precondition for `thread/resume` across runs. Codex resolves the
   * link transparently. When the symlink can't be created (Windows
   * without privileges, some FUSE mounts) we warn and fall through:
   * codex creates a real ephemeral `sessions/` and resume across runs
   * is unavailable for that run.
   */
  sessionsDir?: string;
}

export interface CodexHomeHandle {
  /** Absolute path to set as `CODEX_HOME` on the spawned codex. */
  readonly path: string;
  /** Absolute path of the config.toml we wrote (for diagnostics). */
  readonly configPath: string;
  /**
   * Whether we successfully linked the user's auth.json. When false,
   * codex will need to login on first connect (or fail with an auth
   * error). The CLI prints a helpful hint in this case.
   */
  readonly authLinked: boolean;
  /**
   * Whether `<home>/sessions` links to the durable `sessionsDir`.
   * False when no `sessionsDir` was requested or the symlink failed —
   * in either case rollouts die with the home and resume across runs
   * won't work.
   */
  readonly sessionsLinked: boolean;
  /** Best-effort recursive removal. Idempotent. */
  remove(): void;
}

export class CodexHomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexHomeError';
  }
}

export function setupCodexHome(options: CodexHomeOptions): CodexHomeHandle {
  const realHome = options.realCodexHome ?? join(homedir(), '.codex');
  const parent =
    options.parentDir ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'commandsuite', 'codex');
  // mkdtempSync needs the parent to exist.
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'csuite-codex-'));

  let authLinked = false;
  const realAuth = join(realHome, 'auth.json');
  if (existsSync(realAuth)) {
    try {
      symlinkSync(realAuth, join(dir, 'auth.json'));
      authLinked = true;
    } catch (err) {
      // Symlink can fail on Windows without privileges or on some
      // FUSE mounts. We fall through and let codex attempt its own
      // login — the CLI surfaces a hint about this.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`csuite codex: warning — could not link auth.json: ${msg}\n`);
    }
  }

  let sessionsLinked = false;
  if (options.sessionsDir) {
    try {
      mkdirSync(options.sessionsDir, { recursive: true });
      symlinkSync(options.sessionsDir, join(dir, 'sessions'));
      sessionsLinked = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `csuite codex: warning — could not link sessions dir (resume across runs disabled): ${msg}\n`,
      );
    }
  }

  const configPath = resolve(dir, 'config.toml');
  writeFileSync(configPath, renderConfigToml(options), { mode: 0o600 });

  let removed = false;
  return {
    path: dir,
    configPath,
    authLinked,
    sessionsLinked,
    remove() {
      if (removed) return;
      removed = true;
      try {
        // `rm -rf`. The auth.json entry is a symlink so this only
        // removes the link, not the real file.
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Format the config.toml we hand to codex. We hand-write rather than
 * using a TOML library because the shape is fixed and the strings we
 * embed are tightly controlled (paths, env values) — we know what
 * needs escaping.
 *
 * The settings we set explicitly:
 *   - `[mcp_servers.csuite]` — points at `csuite mcp-bridge`
 *   - `default_tools_approval_mode = "approve"` — the bridge's tools are
 *     trusted by definition (team authority is the access control), so
 *     codex must auto-approve every call. The enum is
 *     `auto | prompt | approve` (snake_case); `approve` is the explicit
 *     always-approve mode. `auto` defaults to the global per-tool policy
 *     and would still escalate some calls.
 *   - `enabled = true` — explicit, in case codex ever defaults the
 *     other way
 */
function renderConfigToml(opts: CodexHomeOptions): string {
  const env: Record<string, string> = {
    CSUITE_RUNNER_SOCKET: opts.runnerSocketPath,
    ...(opts.bridgeExtraEnv ?? {}),
  };
  const lines = [
    '# Auto-generated by csuite codex runner — do not edit.',
    '# Lifetime: this entire CODEX_HOME directory is ephemeral.',
    '',
    '[mcp_servers.csuite]',
    `command = ${tomlString(opts.bridgeCommand)}`,
    `args = ${tomlStringArray(opts.bridgeArgs)}`,
    'enabled = true',
    'default_tools_approval_mode = "approve"',
    '',
    '[mcp_servers.csuite.env]',
    ...Object.entries(env).map(([k, v]) => `${k} = ${tomlString(v)}`),
    '',
    ...(opts.otel ? renderOtelBlock(opts.otel) : []),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The `[otel]` block that turns on codex's native OpenTelemetry export.
 * Codex treats the configured `endpoint` as the full POST URL (verified
 * against 0.130.0 — it does NOT append `/v1/logs`), sends the
 * `Authorization` header verbatim, and — with `log_user_prompt = false` —
 * omits prompt text (captured from the rollout instead). Written as a
 * single inline-table `exporter` value, the exact form validated live.
 */
function renderOtelBlock(otel: {
  endpoint: string;
  token: string;
  environment?: string;
}): string[] {
  const bearer = tomlString(`Bearer ${otel.token}`);
  const endpoint = tomlString(otel.endpoint);
  return [
    '[otel]',
    `environment = ${tomlString(otel.environment ?? 'csuite')}`,
    'log_user_prompt = false',
    `exporter = { otlp-http = { endpoint = ${endpoint}, protocol = "json", headers = { Authorization = ${bearer} } } }`,
    '',
  ];
}

function tomlString(s: string): string {
  // TOML basic strings: double-quoted, with these mandatory escapes.
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function tomlStringArray(arr: string[]): string {
  return `[${arr.map(tomlString).join(', ')}]`;
}
