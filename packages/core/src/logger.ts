/**
 * Minimal structured logger.
 *
 * The default implementation writes one JSON line per event to the
 * runtime's error stream via `console.error` — on a server that is
 * stderr, pipeable straight into journald / a log shipper, leaving
 * stdout clean for startup banners. Hosts with their own log fabric
 * inject a `Logger` of their own instead.
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
  console.error(JSON.stringify(record));
}

export const logger: Logger = {
  debug: (msg, ctx) => emit('debug', msg, ctx),
  info: (msg, ctx) => emit('info', msg, ctx),
  warn: (msg, ctx) => emit('warn', msg, ctx),
  error: (msg, ctx) => emit('error', msg, ctx),
};
