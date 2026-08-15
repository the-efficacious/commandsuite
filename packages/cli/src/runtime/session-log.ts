/**
 * The runner's sink for the shared structured logger.
 *
 * This module owns *where* runner log records go, never what they look
 * like — the record shape is `csuite-core`'s `Logger` contract, one
 * JSON object per line, so a shipper parses broker and runner output
 * with the same rule.
 *
 * When stderr is a TTY — i.e. we're wrapping an agent's TUI in the
 * user's terminal — records go to `~/.cache/commandsuite/session-<pid>.log`
 * so runner/capture/uploader lines don't corrupt the ink-rendered
 * frame. When stderr is redirected (CI, `2> file.log`, pipe to jq),
 * records stay on stderr so existing automation keeps working.
 *
 * Each session uses its own pid-scoped path so concurrent runs don't
 * stomp each other. The directory is created 0o700 and files 0o600
 * since diagnostics can contain URLs / hostnames the user may not want
 * world-readable. Stale logs from dead pids are swept on start; see
 * `sweepStaleSessionLogs`.
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger, type Logger, type LogRecord } from 'csuite-core';

/** Session logs older than this are swept on the next runner start. */
export const SESSION_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionLog {
  /** Component-scoped logger. Shape and levels are core's contract. */
  logger: Logger;
  /** Absolute path of the active log file, or `null` when logging to stderr. */
  path: string | null;
  /** Close the underlying file descriptor. Safe to call more than once. */
  close: () => void;
}

export interface CreateSessionLogOptions {
  /** Component stamped on every record. Defaults to `'runner'`. */
  component?: string;
  /**
   * Force file or stderr routing. Defaults to auto-detect based on
   * `process.stderr.isTTY`. Tests use `'stderr'` to keep output
   * captureable via spyOn.
   */
  mode?: 'auto' | 'file' | 'stderr';
  /**
   * Override the log directory (defaults to `~/.cache/commandsuite`).
   * Tests point this at a scratch tmpdir.
   */
  dir?: string;
}

export function defaultSessionLogDir(): string {
  return join(homedir(), '.cache', 'commandsuite');
}

/**
 * Delete session logs older than `maxAgeMs`. Per-pid files are never
 * rotated in place — a live run holds its fd — so age is the only safe
 * discriminator, and the current process's own file is always spared.
 *
 * Best-effort by construction: a missing directory or an unreadable
 * entry is not an error worth failing a run over. Returns what it
 * removed so the caller can report rather than guess.
 */
export function sweepStaleSessionLogs(
  opts: { dir?: string; maxAgeMs?: number; now?: number } = {},
): { removed: number; failed: number } {
  const dir = opts.dir ?? defaultSessionLogDir();
  const maxAgeMs = opts.maxAgeMs ?? SESSION_LOG_MAX_AGE_MS;
  const now = opts.now ?? Date.now();
  const ownFile = `session-${process.pid}.log`;
  let removed = 0;
  let failed = 0;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { removed, failed };
  }

  for (const entry of entries) {
    if (!entry.startsWith('session-') || !entry.endsWith('.log')) continue;
    if (entry === ownFile) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs < maxAgeMs) continue;
      unlinkSync(full);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

export function createSessionLog(opts: CreateSessionLogOptions = {}): SessionLog {
  const component = opts.component ?? 'runner';
  const mode = opts.mode ?? 'auto';
  const routeToFile = mode === 'file' || (mode === 'auto' && process.stderr.isTTY === true);

  if (!routeToFile) {
    return {
      logger: createLogger({
        component,
        emit: (record: LogRecord) => {
          process.stderr.write(`${JSON.stringify(record)}\n`);
        },
      }),
      path: null,
      close: () => {},
    };
  }

  const dir = opts.dir ?? defaultSessionLogDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `session-${process.pid}.log`);
  const fd = openSync(path, 'a', 0o600);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  };

  const logger = createLogger({
    component,
    emit: (record: LogRecord) => {
      if (closed) return;
      const line = `${JSON.stringify(record)}\n`;
      try {
        writeSync(fd, line);
      } catch {
        // Fall back to an append if the fd went bad mid-session (disk
        // full, fd reaped). Better to risk some TUI noise than silently
        // swallow a diagnostic the user might need.
        try {
          appendFileSync(path, line);
        } catch {
          /* give up */
        }
      }
    },
  });

  return { logger, path, close };
}
