/**
 * File-backed structured logger for interactive `csuite claude`
 * sessions. When stderr is a TTY — i.e. we're wrapping claude's TUI
 * in the user's terminal — writes go to `~/.cache/commandsuite/session-<pid>.log`
 * so runner/proxy/uploader JSON lines don't corrupt the ink-rendered
 * frame. When stderr is redirected (CI, `2> file.log`, pipe to jq),
 * the default logger stays on stderr so existing automation keeps
 * working byte-for-byte.
 *
 * The log file is append-mode, one JSON object per line, same shape
 * as the previous stderr format. Each session uses its own pid-scoped
 * path so concurrent `csuite claude` invocations don't stomp each
 * other. The directory is created with 0o700 and files 0o600 since
 * trace diagnostics can contain URLs / hostnames the user may not
 * want world-readable.
 */

import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SessionLog {
  /** Structured-log function with the same shape the rest of the runner expects. */
  log: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Absolute path of the active log file, or `null` when logging to stderr. */
  path: string | null;
  /** Close the underlying file descriptor. Safe to call more than once. */
  close: () => void;
}

export interface CreateSessionLogOptions {
  /** Component name stamped on every record. Defaults to `'claude'`. */
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

export function createSessionLog(opts: CreateSessionLogOptions = {}): SessionLog {
  const component = opts.component ?? 'claude';
  const mode = opts.mode ?? 'auto';
  const routeToFile = mode === 'file' || (mode === 'auto' && process.stderr.isTTY === true);

  if (!routeToFile) {
    return {
      log: (msg, ctx = {}) => {
        const record = { ts: new Date().toISOString(), component, msg, ...ctx };
        process.stderr.write(`${JSON.stringify(record)}\n`);
      },
      path: null,
      close: () => {},
    };
  }

  const dir = opts.dir ?? join(homedir(), '.cache', 'commandsuite');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `session-${process.pid}.log`);
  // eslint-disable-next-line no-bitwise
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

  return {
    log: (msg, ctx = {}) => {
      if (closed) return;
      const record = { ts: new Date().toISOString(), component, msg, ...ctx };
      try {
        writeSync(fd, `${JSON.stringify(record)}\n`);
      } catch {
        // Fall back to stderr append if the fd went bad mid-session
        // (disk full, fd reaped, etc). Better to risk some TUI noise
        // than silently swallow a diagnostic the user might need.
        try {
          appendFileSync(path, `${JSON.stringify(record)}\n`);
        } catch {
          /* give up */
        }
      }
    },
    path,
    close,
  };
}
