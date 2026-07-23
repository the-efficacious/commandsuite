/**
 * Claude Code framework adapter.
 *
 * The adapter knows three things about an agent framework that the
 * generic runner doesn't:
 *
 *   1. Where to find the binary (`findClaudeBinary`)
 *   2. How to configure it to spawn our MCP bridge as an MCP server.
 *      Two strategies:
 *        - `writeMcpConfigFile` (default) — write our server entry to a
 *          csuite-owned ephemeral file and pass `--mcp-config <file>`.
 *          The member's working tree is never touched; teardown just
 *          `cleanup()`s the temp dir. This is the codex-style approach.
 *        - `prepareMcpConfig` (fallback) — back up and rewrite the
 *          member's per-run `.mcp.json`. Retained behind a mode switch
 *          for environments where `--mcp-config` can't be used.
 *   3. How to spawn it with the right env vars (`spawnAgent`)
 *
 * The runner drives teardown on every exit path (normal, SIGINT,
 * SIGTERM, uncaughtException, unhandledRejection): `cleanup()` for the
 * file strategy, or `McpConfigHandle.restore()` for the rewrite fallback
 * so the member's `.mcp.json` is never left modified.
 *
 * Safety invariants (the `prepareMcpConfig` rewrite fallback):
 *
 *   - If `.mcp.json` exists but is not valid JSON, we throw WITHOUT
 *     modifying the file. The member gets a clear error and their
 *     existing file is preserved.
 *   - If the backup write fails, we throw WITHOUT modifying the file.
 *     Same invariant: never write the target until the backup is safe
 *     on disk.
 *   - Atomic write via temp + rename, in the same directory as the
 *     target, so the rename stays on one filesystem.
 *   - `restore()` is idempotent — calling it twice is a no-op on the
 *     second call.
 *   - `restore()` is best-effort in the sense that IO failures are
 *     swallowed with a stderr warning rather than throwing. The
 *     backup file stays on disk in that case so the member can
 *     manually recover.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  constants as FS,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { RUNNER_SOCKET_ENV } from '../ipc.js';
import { AgentAdapterError } from './adapter.js';

export class ClaudeCodeAdapterError extends AgentAdapterError {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCodeAdapterError';
  }
}

/**
 * Locate the `claude` binary. Checks `$CLAUDE_PATH` first (for
 * developers who built from source or installed to a non-default
 * location), then falls back to `which claude`.
 */
export function findClaudeBinary(): string {
  const fromEnv = process.env.CLAUDE_PATH;
  if (fromEnv && fromEnv.length > 0) {
    if (!existsSync(fromEnv)) {
      throw new ClaudeCodeAdapterError(`CLAUDE_PATH points at ${fromEnv} but no file exists there`);
    }
    return fromEnv;
  }
  try {
    const out = execFileSync('which', ['claude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out.length === 0) {
      throw new ClaudeCodeAdapterError('which found no claude binary');
    }
    return out;
  } catch (err) {
    throw new ClaudeCodeAdapterError(
      `failed to locate claude binary: ${err instanceof Error ? err.message : String(err)}\n` +
        '  Install claude and make sure it is on PATH, or set CLAUDE_PATH explicitly.',
    );
  }
}

/**
 * Shape of a project-level `.mcp.json`. We don't try to model the
 * whole schema — just `mcpServers` as an open record because that's
 * the only key we touch. Any other top-level keys the member had
 * (e.g. hooks, permissions, etc.) pass through unchanged.
 */
interface McpProjectConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [k: string]: unknown;
}

export interface PrepareMcpConfigOptions {
  /** Directory in which to read/write the project `.mcp.json`. */
  cwd: string;
  /** Path to the runner's IPC socket to bake into the env block. */
  runnerSocketPath: string;
  /**
   * Name of the `csuite` CLI binary the bridge entry should invoke.
   * Defaults to `csuite`. Tests override this to point at the built
   * cli's dist/index.js so the bridge subprocess is reachable
   * without requiring `csuite` to be globally installed.
   */
  bridgeCommand?: string;
  /** Args to pass to the bridge command. Defaults to `['mcp-bridge']`. */
  bridgeArgs?: string[];
  /**
   * Additional env vars to inject into the `csuite` mcp-server entry.
   * A general-purpose hook for the caller to thread extra environment
   * into the bridge subprocess; unused by the native-capture path (the
   * agent child's OTEL export env is set on the agent process itself,
   * not on the mcp-bridge server).
   */
  extraEnv?: Record<string, string>;
}

export interface McpConfigHandle {
  /**
   * The path of the `.mcp.json` file the adapter is managing. Useful
   * for tests that want to inspect the modified file mid-run.
   */
  readonly path: string;
  /**
   * Restore the member's `.mcp.json` to its pre-run state. If the
   * file didn't exist before we touched it, delete it. If it did,
   * write the original contents back. Idempotent — safe to call
   * from multiple signal handlers concurrently.
   */
  restore(): void;
}

/**
 * Write our `csuite` entry into the project `.mcp.json`, backing
 * up the pre-existing contents first. Returns a handle whose
 * `.restore()` method undoes the modification.
 *
 * Failure modes that leave the original file UNTOUCHED:
 *   - existing `.mcp.json` is not valid JSON
 *   - backup write fails
 *   - staging temp file write fails (before rename)
 */
export function prepareMcpConfig(options: PrepareMcpConfigOptions): McpConfigHandle {
  const mcpConfigPath = resolve(options.cwd, '.mcp.json');
  const existedBefore = existsSync(mcpConfigPath);

  // Parse the existing file (if any) BEFORE we write anything. If
  // it's corrupt, bail out with a clear error — we'd rather the
  // member fix their JSON than have csuite silently replace it.
  let originalBytes: string | null = null;
  let existingConfig: McpProjectConfig = {};
  if (existedBefore) {
    originalBytes = readFileSync(mcpConfigPath, 'utf8');
    try {
      const parsed = JSON.parse(originalBytes);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existingConfig = parsed as McpProjectConfig;
      } else {
        throw new Error('top-level value is not an object');
      }
    } catch (err) {
      throw new ClaudeCodeAdapterError(
        `refusing to modify ${mcpConfigPath}: existing file is not a valid JSON object ` +
          `(${err instanceof Error ? err.message : String(err)}). ` +
          `Fix or delete the file, then re-run.`,
      );
    }
  }

  // Write backup BEFORE touching the target. Backup lives in a
  // pid-scoped tmp dir so concurrent runners don't stomp each other.
  const backupDir = mkdtempSync(join(tmpdir(), 'csuite-runner-'));
  const backupPath = join(backupDir, 'mcp.json.bak');
  let backupWritten = false;
  if (existedBefore && originalBytes !== null) {
    try {
      atomicWrite(backupPath, originalBytes);
      backupWritten = true;
    } catch (err) {
      // Clean up the empty backup dir and re-throw.
      try {
        rmdirSync(backupDir);
      } catch {
        /* ignore */
      }
      throw new ClaudeCodeAdapterError(
        `failed to write backup of ${mcpConfigPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Build the merged config. Start from the existing top-level
  // (preserving any non-mcpServers keys the member had) and
  // insert our `csuite` entry into mcpServers. If there's an existing
  // `csuite` entry we replace it — the runner socket path is per-run,
  // so a stale entry would be wrong anyway. The key has to be
  // exactly `csuite` so `--dangerously-load-development-channels
  // server:csuite` (auto-injected by the runner) matches.
  const servers: Record<string, McpServerEntry> =
    existingConfig.mcpServers && typeof existingConfig.mcpServers === 'object'
      ? { ...existingConfig.mcpServers }
      : {};

  servers.csuite = {
    command: options.bridgeCommand ?? 'csuite',
    args: options.bridgeArgs ?? ['mcp-bridge'],
    env: {
      [RUNNER_SOCKET_ENV]: options.runnerSocketPath,
      ...(options.extraEnv ?? {}),
    },
  };

  const mergedConfig: McpProjectConfig = {
    ...existingConfig,
    mcpServers: servers,
  };

  // Atomic write the merged config to the target. On failure, the
  // backup is already on disk (if we wrote one) and the original
  // file is untouched (atomicWrite uses temp + rename in the same
  // directory, so a failure leaves the original in place).
  try {
    atomicWrite(mcpConfigPath, `${JSON.stringify(mergedConfig, null, 2)}\n`);
  } catch (err) {
    // Clean up backup since we never got to the point of needing it.
    if (backupWritten) {
      try {
        unlinkSync(backupPath);
      } catch {
        /* ignore */
      }
    }
    try {
      rmdirSync(backupDir);
    } catch {
      /* ignore */
    }
    throw new ClaudeCodeAdapterError(
      `failed to write ${mcpConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      if (existedBefore && originalBytes !== null) {
        atomicWrite(mcpConfigPath, originalBytes);
      } else {
        try {
          unlinkSync(mcpConfigPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') throw err;
        }
      }
    } catch (err) {
      // Best-effort. Backup file stays on disk for manual recovery.
      process.stderr.write(
        `csuite: warning: failed to restore ${mcpConfigPath} from backup ${backupPath}: ${
          err instanceof Error ? err.message : String(err)
        }\n` + `  The backup file is still at ${backupPath} — you can copy it back manually.\n`,
      );
      return;
    }
    // Successful restore — clean up the backup.
    if (backupWritten) {
      try {
        unlinkSync(backupPath);
      } catch {
        /* ignore */
      }
    }
    try {
      rmdirSync(backupDir);
    } catch {
      /* ignore */
    }
  };

  return { path: mcpConfigPath, restore };
}

export interface WriteMcpConfigFileOptions {
  /** Path to the runner's IPC socket to bake into the env block. */
  runnerSocketPath: string;
  /**
   * Name of the `csuite` CLI binary the bridge entry should invoke.
   * Defaults to `csuite`. Callers pass `process.execPath` in production
   * so claude spawns the same node binary the runner runs under.
   */
  bridgeCommand?: string;
  /** Args to pass to the bridge command. Defaults to `['mcp-bridge']`. */
  bridgeArgs?: string[];
  /** Additional env vars to inject into the `csuite` mcp-server entry. */
  extraEnv?: Record<string, string>;
  /**
   * Parent directory for the ephemeral config dir. Defaults to
   * `$XDG_CACHE_HOME/commandsuite/claude` (or `~/.cache/commandsuite/claude`).
   * Tests override this to keep the write off the real cache dir.
   */
  parentDir?: string;
}

export interface McpConfigFileHandle {
  /** Absolute path of the ephemeral `mcp.json` we wrote. */
  readonly path: string;
  /**
   * The flag pair to inject into the claude invocation:
   * `['--mcp-config', <path>]`. Additive — no `--strict-mcp-config`,
   * so the member's own `.mcp.json` / settings servers still load
   * alongside ours, and we never read or write their file.
   */
  readonly flagArgs: readonly string[];
  /**
   * Best-effort recursive removal of the ephemeral dir. Idempotent —
   * safe to call from multiple signal handlers.
   */
  cleanup(): void;
}

/**
 * The non-invasive alternative to {@link prepareMcpConfig}.
 *
 * Instead of backing up and rewriting the member's project `.mcp.json`,
 * write our `csuite` MCP server entry to a csuite-OWNED file in an
 * ephemeral per-run directory and hand claude `--mcp-config <that file>`.
 * This mirrors what the codex runner already does with its ephemeral
 * `CODEX_HOME` — the config lives somewhere we control and destroy, so:
 *
 *   - The member's working tree is never touched. No backup, no restore,
 *     no corruption guards, no "your MCP servers disappeared" surprise
 *     from running in the wrong directory.
 *   - Two `csuite claude` runs in the same directory get DIFFERENT
 *     ephemeral files (mkdtemp), so they can't race on a shared file the
 *     way the `.mcp.json` rewrite does. Each is fully isolated.
 *   - The member's own `.mcp.json` servers still load — `--mcp-config`
 *     is additive without `--strict-mcp-config`, so we get
 *     `csuite + member servers` with zero mutation.
 *
 * The server key is exactly `csuite` so the runner's auto-injected
 * `--dangerously-load-development-channels server:csuite` still resolves
 * it. The file is `0o600` because its env block carries the runner
 * socket path — passing the same JSON inline via `--mcp-config '{...}'`
 * would leak it into `ps` output for other users on the box.
 */
export function writeMcpConfigFile(options: WriteMcpConfigFileOptions): McpConfigFileHandle {
  const parent =
    options.parentDir ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'commandsuite', 'claude');
  // mkdtempSync needs the parent to exist.
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'csuite-mcp-'));
  const configPath = join(dir, 'mcp.json');

  const config: McpProjectConfig = {
    mcpServers: {
      csuite: {
        command: options.bridgeCommand ?? 'csuite',
        args: options.bridgeArgs ?? ['mcp-bridge'],
        env: {
          [RUNNER_SOCKET_ENV]: options.runnerSocketPath,
          ...(options.extraEnv ?? {}),
        },
      },
    },
  };

  try {
    atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  } catch (err) {
    // Clean up the empty dir so a write failure doesn't litter the cache.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw new ClaudeCodeAdapterError(
      `failed to write ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let cleaned = false;
  return {
    path: configPath,
    flagArgs: ['--mcp-config', configPath],
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Shape of `.claude/settings.json`. Only `hooks` is modeled; everything
 * else is preserved verbatim during merge/restore.
 *
 * Claude Code accepts `hooks` as a map from event name → array of hook
 * matchers. For the busy-signal feeder we use `type: "http"` so each
 * event becomes a localhost POST rather than a process fork.
 */
interface ClaudeSettingsConfig {
  hooks?: Record<string, ClaudeHookMatcher[]>;
  [k: string]: unknown;
}

interface ClaudeHookMatcher {
  matcher?: string;
  hooks: ClaudeHookEntry[];
}

interface ClaudeHookEntry {
  type: 'command' | 'http';
  command?: string;
  url?: string;
  [k: string]: unknown;
}

export interface PrepareClaudeSettingsOptions {
  /** Directory containing `.claude/settings.json`. Usually the project cwd. */
  cwd: string;
  /**
   * Full URL the Claude Code harness should POST to for each hook
   * event. Comes from `CaptureHost.hookEndpointUrl`. The same URL handles
   * every registered event (tool windows plus UserPromptSubmit / Stop /
   * SubagentStop / Notification) — the runner routes by `hook_event_name`
   * in the payload.
   */
  hookUrl: string;
}

export interface ClaudeSettingsHandle {
  readonly path: string;
  /**
   * Restore `.claude/settings.json` to its pre-run state. If the file
   * didn't exist before we touched it, delete it (and remove the
   * `.claude/` dir if we created it). Idempotent.
   */
  restore(): void;
}

/**
 * Marker key we add under each csuite-managed hook entry so a later
 * restore (or stale state from a previous crash) can identify our
 * entries unambiguously even if the member later edits
 * the file.
 */
const CSUITE_HOOK_MARKER = 'x_csuite_busy_feeder';

/**
 * Merge our HTTP hook entries into `.claude/settings.json`, backing up
 * the existing file first. Returns a handle whose `.restore()` undoes
 * the modification.
 *
 * The hook config writes one entry per relevant lifecycle event
 * (PreToolUse, PostToolUse, PostToolUseFailure for tool windows;
 * UserPromptSubmit / Stop / SubagentStop / Notification for the
 * whole-turn `working` state and the `blocked` flag) pointing at the
 * loopback URL. Each entry is tagged with `x_csuite_busy_feeder: true`
 * so we don't accidentally drop unrelated hooks the user has
 * configured.
 *
 * Failure modes that leave the existing file UNTOUCHED:
 *   - file exists but is not valid JSON
 *   - backup write fails
 *   - staging temp file write fails (before rename)
 */
export function prepareClaudeSettings(options: PrepareClaudeSettingsOptions): ClaudeSettingsHandle {
  const claudeDir = resolve(options.cwd, '.claude');
  const settingsPath = join(claudeDir, 'settings.json');
  const dirExistedBefore = existsSync(claudeDir);
  const existedBefore = existsSync(settingsPath);

  // Parse before we touch anything. Invalid JSON → throw with a clear
  // message rather than overwriting the user's file.
  let originalBytes: string | null = null;
  let existingConfig: ClaudeSettingsConfig = {};
  if (existedBefore) {
    originalBytes = readFileSync(settingsPath, 'utf8');
    try {
      const parsed = JSON.parse(originalBytes);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existingConfig = parsed as ClaudeSettingsConfig;
      } else {
        throw new Error('top-level value is not an object');
      }
    } catch (err) {
      throw new ClaudeCodeAdapterError(
        `refusing to modify ${settingsPath}: existing file is not a valid JSON object ` +
          `(${err instanceof Error ? err.message : String(err)}). ` +
          `Fix or delete the file, then re-run.`,
      );
    }
  }

  // Backup BEFORE writing the target — same invariant as prepareMcpConfig.
  const backupDir = mkdtempSync(join(tmpdir(), 'csuite-runner-'));
  const backupPath = join(backupDir, 'claude-settings.json.bak');
  let backupWritten = false;
  if (existedBefore && originalBytes !== null) {
    try {
      atomicWrite(backupPath, originalBytes);
      backupWritten = true;
    } catch (err) {
      try {
        rmdirSync(backupDir);
      } catch {
        /* ignore */
      }
      throw new ClaudeCodeAdapterError(
        `failed to write backup of ${settingsPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Build the merged config. Preserve all existing keys, including any
  // hooks the user already configured for events we don't touch.
  const existingHooks: Record<string, ClaudeHookMatcher[]> =
    existingConfig.hooks && typeof existingConfig.hooks === 'object'
      ? { ...existingConfig.hooks }
      : {};

  const csuiteEntry: ClaudeHookEntry = {
    type: 'http',
    url: options.hookUrl,
    [CSUITE_HOOK_MARKER]: true,
  };

  // Tool-window events drive `tool_inflight`; the turn/notification
  // events drive the whole-turn `working` state and the `blocked` flag;
  // SessionStart carries the compact/clear signal that triggers the
  // runner's context re-brief. All point at the same loopback URL —
  // the hook server routes by `hook_event_name` in the payload.
  const CSUITE_HOOK_EVENTS = [
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'UserPromptSubmit',
    'Stop',
    'SubagentStop',
    'Notification',
    'SessionStart',
  ];
  for (const event of CSUITE_HOOK_EVENTS) {
    const existing = Array.isArray(existingHooks[event]) ? existingHooks[event] : [];
    // Drop any prior csuite entries (e.g. from a previous crash that
    // didn't restore cleanly) so we don't accumulate duplicates.
    const cleaned = existing.map((matcher) => ({
      ...matcher,
      hooks: (matcher.hooks ?? []).filter(
        (h) => !(typeof h === 'object' && h !== null && CSUITE_HOOK_MARKER in h),
      ),
    }));
    // Match-all matcher carrying just our hook entry.
    cleaned.push({ matcher: '*', hooks: [csuiteEntry] });
    existingHooks[event] = cleaned;
  }

  const mergedConfig: ClaudeSettingsConfig = {
    ...existingConfig,
    hooks: existingHooks,
  };

  // Ensure the .claude directory exists before writing. atomicWrite
  // does a same-directory rename, so the dir has to be in place first.
  if (!dirExistedBefore) {
    try {
      mkdirSync(claudeDir, { recursive: true });
    } catch (err) {
      if (backupWritten) {
        try {
          unlinkSync(backupPath);
        } catch {
          /* ignore */
        }
      }
      try {
        rmdirSync(backupDir);
      } catch {
        /* ignore */
      }
      throw new ClaudeCodeAdapterError(
        `failed to create ${claudeDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  try {
    atomicWrite(settingsPath, `${JSON.stringify(mergedConfig, null, 2)}\n`);
  } catch (err) {
    if (backupWritten) {
      try {
        unlinkSync(backupPath);
      } catch {
        /* ignore */
      }
    }
    try {
      rmdirSync(backupDir);
    } catch {
      /* ignore */
    }
    throw new ClaudeCodeAdapterError(
      `failed to write ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      if (existedBefore && originalBytes !== null) {
        atomicWrite(settingsPath, originalBytes);
      } else {
        try {
          unlinkSync(settingsPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') throw err;
        }
        // If we created the .claude/ dir for our own settings file
        // and it's still empty, clean it up. If the member
        // added unrelated files we leave it alone.
        if (!dirExistedBefore) {
          try {
            rmdirSync(claudeDir);
          } catch {
            // Directory not empty or some other error — leave it.
          }
        }
      }
    } catch (err) {
      process.stderr.write(
        `csuite: warning: failed to restore ${settingsPath} from backup ${backupPath}: ${
          err instanceof Error ? err.message : String(err)
        }\n` + `  The backup file is still at ${backupPath} — you can copy it back manually.\n`,
      );
      return;
    }
    if (backupWritten) {
      try {
        unlinkSync(backupPath);
      } catch {
        /* ignore */
      }
    }
    try {
      rmdirSync(backupDir);
    } catch {
      /* ignore */
    }
  };

  return { path: settingsPath, restore };
}

/**
 * Atomically write `body` to `path`. Same pattern as the server's
 * slot-config writer: open a temp file in the same directory with
 * `O_CREAT|O_WRONLY|O_EXCL`, write+fsync+close, then `rename` the
 * temp over the target. Keeps `0o600` permissions on the result since
 * a `.mcp.json` can contain tokens / secrets in its env blocks.
 */
function atomicWrite(path: string, body: string): void {
  const dir = dirname(path);
  const nonce = randomBytes(6).toString('hex');
  const tmp = join(dir, `.csuite-mcp-${nonce}.tmp`);
  let fd: number | null = null;
  try {
    // eslint-disable-next-line no-bitwise
    fd = openSync(tmp, FS.O_CREAT | FS.O_WRONLY | FS.O_EXCL, 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort: some filesystems (FUSE, Windows layers) ignore chmod
    }
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
