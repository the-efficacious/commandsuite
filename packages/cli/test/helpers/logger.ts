/**
 * Test sink for the shared structured logger.
 *
 * `recordingLogger()` returns a `Logger` plus the records it captured,
 * so a fixture can assert the *emitted record* — level, component, and
 * context — rather than a bare message string. Asserting the record is
 * the point: severity is the field the runner's JSON stream previously
 * lacked, and a fixture that only checks `msg` cannot see it regress.
 */

import { createLogger, type Logger, type LogRecord } from 'csuite-core';

export interface RecordingLogger {
  logger: Logger;
  /** Every record emitted, in order, including those from `.child()`. */
  records: LogRecord[];
  /** Just the messages, for fixtures that only care that something was said. */
  messages: () => string[];
  /** Records at or above `level`. */
  atLeast: (level: 'debug' | 'info' | 'warn' | 'error') => LogRecord[];
}

const RANK = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export function recordingLogger(
  opts: { level?: 'debug' | 'info' | 'warn' | 'error'; component?: string } = {},
): RecordingLogger {
  const records: LogRecord[] = [];
  const logger = createLogger({
    // Default to debug so a fixture sees everything the code emits;
    // a test that cares about thresholds sets its own.
    level: opts.level ?? 'debug',
    ...(opts.component !== undefined ? { component: opts.component } : {}),
    emit: (record) => records.push(record),
  });
  return {
    logger,
    records,
    messages: () => records.map((r) => r.msg),
    atLeast: (level) => records.filter((r) => RANK[r.level] >= RANK[level]),
  };
}

/** A logger that discards everything — for fixtures that assert elsewhere. */
export function silentLogger(): Logger {
  return createLogger({ level: 'error', emit: () => {} });
}
