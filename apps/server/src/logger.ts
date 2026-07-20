/**
 * Minimal structured logger for the csuite server.
 *
 * Writes one JSON line per event to stderr so it can be piped straight
 * into journald / a log shipper. Stdout is left clean for the server's
 * startup banner.
 */

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

function emit(level: string, msg: string, ctx: LogContext = {}): void {
  const record = { ts: new Date().toISOString(), level, msg, ...ctx };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

export const logger: Logger = {
  debug: (msg, ctx) => emit('debug', msg, ctx),
  info: (msg, ctx) => emit('info', msg, ctx),
  warn: (msg, ctx) => emit('warn', msg, ctx),
  error: (msg, ctx) => emit('error', msg, ctx),
};
