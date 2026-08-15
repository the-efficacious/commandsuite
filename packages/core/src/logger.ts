/**
 * The one structured logger.
 *
 * Every operational record in the suite has the same shape — one JSON
 * object per line: `{ts, level, component?, msg, ...ctx}`. The default
 * sink writes lines to the runtime's error stream via `console.error` —
 * on a server that is stderr, pipeable straight into journald / a log
 * shipper, leaving stdout clean for startup banners. Hosts with their
 * own log fabric (or the CLI's TTY-aware session log, which must keep
 * JSON off a live TUI) inject an `emit` instead; the record shape is
 * the contract, the sink is the variable.
 *
 * Records below the threshold are dropped before they are built. The
 * default threshold is `info`, overridable per process with
 * `CSUITE_LOG_LEVEL=debug|info|warn|error`. The env read is tolerant
 * of `process` being absent so this module stays runtime-neutral.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface LogContext {
  [key: string]: unknown;
}

/**
 * The wire shape of one emitted record. `ctx` keys are spread last and
 * may shadow `msg` — matching the shape every existing consumer of the
 * stderr stream already parses.
 */
export interface LogRecord {
  ts: string;
  level: LogLevel;
  component?: string;
  msg: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  /**
   * A logger that stamps `component` on every record, sharing this
   * logger's sink and threshold. Calling `child` on a child replaces
   * the component rather than nesting it.
   */
  child(component: string): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolve the process-wide default threshold from `CSUITE_LOG_LEVEL`.
 * Returns the level plus the raw value when it named no level — the
 * caller reports the typo instead of silently running at `info`, so an
 * operator who set `CSUITE_LOG_LEVEL=trace` learns it did nothing.
 */
export function envLogLevel(): { level: LogLevel; invalid?: string } {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.CSUITE_LOG_LEVEL;
  if (raw === undefined || raw === '') return { level: 'info' };
  if (isLogLevel(raw)) return { level: raw };
  return { level: 'info', invalid: raw };
}

export interface CreateLoggerOptions {
  /** Threshold; defaults to `CSUITE_LOG_LEVEL`, then `info`. */
  level?: LogLevel;
  /** Component stamped on every record. Omitted from records when unset. */
  component?: string;
  /** Sink. Defaults to `console.error(JSON.stringify(record))`. */
  emit?: (record: LogRecord) => void;
}

const defaultEmit = (record: LogRecord): void => {
  console.error(JSON.stringify(record));
};

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const emit = opts.emit ?? defaultEmit;
  let level = opts.level;
  let invalid: string | undefined;
  if (level === undefined) {
    const resolved = envLogLevel();
    level = resolved.level;
    invalid = resolved.invalid;
  }
  const threshold = LEVEL_RANK[level];

  function make(component: string | undefined): Logger {
    const log = (lvl: LogLevel, msg: string, ctx: LogContext = {}): void => {
      if (LEVEL_RANK[lvl] < threshold) return;
      const record: LogRecord =
        component === undefined
          ? { ts: new Date().toISOString(), level: lvl, msg, ...ctx }
          : { ts: new Date().toISOString(), level: lvl, component, msg, ...ctx };
      emit(record);
    };
    return {
      debug: (msg, ctx) => log('debug', msg, ctx),
      info: (msg, ctx) => log('info', msg, ctx),
      warn: (msg, ctx) => log('warn', msg, ctx),
      error: (msg, ctx) => log('error', msg, ctx),
      child: (name) => make(name),
    };
  }

  const root = make(opts.component);
  if (invalid !== undefined) {
    root.warn('CSUITE_LOG_LEVEL names no level; using info', {
      value: invalid,
      levels: LOG_LEVELS.join('|'),
    });
  }
  return root;
}

/**
 * The process-wide default. Threshold is read from `CSUITE_LOG_LEVEL`
 * once, at module load.
 */
export const logger: Logger = createLogger();
