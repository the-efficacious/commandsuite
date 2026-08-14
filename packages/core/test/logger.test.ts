import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, envLogLevel, LOG_LEVELS, type LogRecord, logger } from '../src/logger.js';

// ── helpers ──────────────────────────────────────────────────────────

function collector(): { records: LogRecord[]; emit: (r: LogRecord) => void } {
  const records: LogRecord[] = [];
  return { records, emit: (r) => records.push(r) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('record shape', () => {
  it('emits ts/level/msg with ctx spread, and no component key when unscoped', () => {
    const { records, emit } = collector();
    const log = createLogger({ level: 'debug', emit });
    log.info('session created', { member: 'builder' });

    expect(records).toHaveLength(1);
    const rec: Partial<LogRecord> = records[0] ?? {};
    expect(rec).toMatchObject({ level: 'info', msg: 'session created', member: 'builder' });
    expect(Number.isNaN(Date.parse(String(rec.ts)))).toBe(false);
    expect('component' in rec).toBe(false);
    // Key order is part of the wire shape shippers grep: ts first.
    expect(Object.keys(rec)[0]).toBe('ts');
  });

  it('every level method stamps its own level', () => {
    const { records, emit } = collector();
    const log = createLogger({ level: 'debug', emit });
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(records.map((r) => r.level)).toEqual(LOG_LEVELS);
  });

  it('the default sink writes one JSON line to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger({ level: 'debug' });
    log.warn('push send failed', { to: 'builder' });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]?.[0]);
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ level: 'warn', msg: 'push send failed', to: 'builder' });
  });
});

describe('threshold', () => {
  it('suppresses records below the threshold and passes records at or above it', () => {
    const { records, emit } = collector();
    const log = createLogger({ level: 'warn', emit });
    log.debug('below');
    log.info('below');
    log.warn('at'); // positive control — the gate can pass
    log.error('above');
    expect(records.map((r) => r.msg)).toEqual(['at', 'above']);
  });

  it('debug threshold passes everything', () => {
    const { records, emit } = collector();
    const log = createLogger({ level: 'debug', emit });
    for (const level of LOG_LEVELS) log[level]('x');
    expect(records).toHaveLength(LOG_LEVELS.length);
  });
});

describe('CSUITE_LOG_LEVEL', () => {
  it('defaults to info when unset: debug suppressed, info emitted', () => {
    vi.stubEnv('CSUITE_LOG_LEVEL', '');
    const { records, emit } = collector();
    const log = createLogger({ emit });
    log.debug('suppressed');
    log.info('kept');
    expect(records.map((r) => r.msg)).toEqual(['kept']);
  });

  it('a valid env level takes effect', () => {
    vi.stubEnv('CSUITE_LOG_LEVEL', 'debug');
    const { records, emit } = collector();
    const log = createLogger({ emit });
    log.debug('now visible');
    expect(records.map((r) => r.msg)).toEqual(['now visible']);
  });

  it('an explicit level option beats the env', () => {
    vi.stubEnv('CSUITE_LOG_LEVEL', 'debug');
    const { records, emit } = collector();
    const log = createLogger({ level: 'error', emit });
    log.debug('suppressed');
    log.error('kept');
    expect(records.map((r) => r.msg)).toEqual(['kept']);
  });

  it('a value naming no level falls back to info AND reports the typo', () => {
    vi.stubEnv('CSUITE_LOG_LEVEL', 'trace');
    const { records, emit } = collector();
    createLogger({ emit });
    // The operator who set an unusable value must be able to see it did
    // nothing — a silent fallback is indistinguishable from working.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: 'warn', value: 'trace' });
  });

  it('envLogLevel reports the raw invalid value', () => {
    vi.stubEnv('CSUITE_LOG_LEVEL', 'verbose');
    expect(envLogLevel()).toEqual({ level: 'info', invalid: 'verbose' });
  });
});

describe('child', () => {
  it('stamps component on every record and shares the sink and threshold', () => {
    const { records, emit } = collector();
    const log = createLogger({ level: 'warn', emit });
    const bridge = log.child('bridge');
    bridge.info('suppressed like the parent');
    bridge.warn('IPC socket error', { code: 'EPIPE' });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'warn',
      component: 'bridge',
      msg: 'IPC socket error',
      code: 'EPIPE',
    });
  });

  it('child of a child replaces the component', () => {
    const { records, emit } = collector();
    const log = createLogger({ level: 'debug', emit }).child('runner').child('forwarder');
    log.info('x');
    expect(records[0]).toMatchObject({ component: 'forwarder' });
  });
});

describe('singleton', () => {
  it('exports a working logger bound to the default sink', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('boom');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(spy.mock.calls[0]?.[0])).msg).toBe('boom');
  });
});
