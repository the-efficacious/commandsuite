/**
 * Test sink for the shared structured logger.
 *
 * `recordingLogger()` captures the emitted records so a fixture can
 * assert level and component, not just a message string — severity is
 * the field the record shape gained, and a fixture that only checks
 * `msg` cannot see it regress. `silentLogger()` is for suites that
 * assert elsewhere and just need a valid `Logger`.
 */

import { createLogger, type Logger, type LogRecord } from 'csuite-core';

export interface RecordingLogger {
  logger: Logger;
  records: LogRecord[];
  messages: () => string[];
  atLeast: (level: 'debug' | 'info' | 'warn' | 'error') => LogRecord[];
}

const RANK = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export function recordingLogger(
  opts: { level?: 'debug' | 'info' | 'warn' | 'error'; component?: string } = {},
): RecordingLogger {
  const records: LogRecord[] = [];
  const logger = createLogger({
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

/** A logger that discards everything. */
export function silentLogger(): Logger {
  return createLogger({ level: 'error', emit: () => {} });
}
