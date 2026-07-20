/**
 * OpenTelemetry primitive sink.
 *
 * A lossless, name-agnostic store for the operational telemetry Claude
 * Code (and any other OTLP exporter) ships to the broker: cost / token
 * counters, api_request/error events, decision + session/productivity
 * metrics, lifecycle events, and the resource/identity attributes that
 * ride along. Content — the conversation transcript — is handled
 * elsewhere; this store keeps the OTEL *primitive* faithful.
 *
 * Shape: one flat row per LOG RECORD and one flat row per METRIC DATA
 * POINT. There is deliberately NO allowlist of known event/metric
 * names — an unrecognized `event.name` or metric lands exactly like a
 * known one, so dashboards and analytics are pure downstream SQL rather
 * than a schema migration every time Claude Code adds a signal.
 *
 * The flattened `attributes` / `resource` / `payload` blobs are stored
 * as JSON text columns; the store never introspects them beyond the
 * indexed `member_name` / `name` / `ts_ms` triples. Parsing raw OTLP
 * into `TelemetryRecord`s (and secret-redaction) happens upstream in
 * `otlp-parse.ts` — this module is a dumb, transactional writer.
 *
 * This store is intentionally independent of the member-activity
 * stream: separate table, no EventEmitter, no shared append path. It
 * can share a `DatabaseSyncInstance` with the activity store (both are
 * heavy-write operational streams kept off the main broker write lock)
 * without any coupling.
 *
 * Timestamps are nanoseconds. A current-epoch nanosecond value
 * (~1.7e18) exceeds `Number.MAX_SAFE_INTEGER`, so node:sqlite refuses
 * to return it as a plain JS number on read — the read path enables
 * `setReadBigInts(true)` and narrows back to `number` at the JS
 * boundary (the `TelemetryRecord`/`TelemetryRow` contract is `number`,
 * matching the OTLP-parse layer, which already coerces via `Number()`).
 */

import type { DatabaseSyncInstance, StatementInstance } from './db.js';
import { logger as defaultLogger, type Logger } from './logger.js';

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_name TEXT NOT NULL,
    signal TEXT NOT NULL,
    name TEXT NOT NULL,
    ts_unix_nano INTEGER NOT NULL,
    ts_ms INTEGER NOT NULL,
    attributes TEXT NOT NULL,
    resource TEXT NOT NULL,
    scope TEXT,
    payload TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS telemetry_member_name_ts ON telemetry (member_name, name, ts_ms);
  CREATE INDEX IF NOT EXISTS telemetry_member_ts ON telemetry (member_name, ts_ms);
`;

/**
 * One faithfully-captured OTEL primitive: a single log record or a
 * single metric data point. Produced by `otlp-parse.ts`, consumed by
 * `TelemetryStore.append`.
 */
export interface TelemetryRecord {
  signal: 'log' | 'metric';
  /** `event.name` for logs, metric name for metrics. Never dropped. */
  name: string;
  /** Record/data-point timestamp in nanoseconds; 0 when absent. */
  tsUnixNano: number;
  /** Flattened record/data-point attributes. */
  attributes: Record<string, unknown>;
  /** Flattened resource attributes. */
  resource: Record<string, unknown>;
  /** `{ name, version }` of the instrumentation scope, or null. */
  scope: Record<string, unknown> | null;
  /**
   * Signal-specific fields. Logs: `{ body, severityNumber, severityText }`.
   * Metrics: `{ value, valueType, metricType, unit, description,
   * temporality, isMonotonic }`.
   */
  payload: Record<string, unknown>;
}

/** A stored row decoded back out for reads (tests, downstream queries). */
export interface TelemetryRow {
  id: number;
  memberName: string;
  signal: 'log' | 'metric';
  name: string;
  tsUnixNano: number;
  tsMs: number;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  scope: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  receivedAt: number;
}

/** Optional filters for `list`. `from`/`to` bound on derived `ts_ms`. */
export interface TelemetryQuery {
  memberName?: string;
  signal?: 'log' | 'metric';
  name?: string;
  from?: number;
  to?: number;
  limit?: number;
}

export interface TelemetryStore {
  /** Bulk-insert records for a member in a single transaction. */
  append(memberName: string, records: TelemetryRecord[]): void;
  /** Total row count across all members. */
  count(): number;
  /** Read rows back, oldest-first, with optional filters. */
  list(filter?: TelemetryQuery): TelemetryRow[];
}

export interface TelemetryStoreOptions {
  logger?: Logger;
}

interface TelemetryRowRaw {
  id: bigint;
  member_name: string;
  signal: string;
  name: string;
  ts_unix_nano: bigint;
  ts_ms: bigint;
  attributes: string;
  resource: string;
  scope: string | null;
  payload: string;
  received_at: bigint;
}

const NANOS_PER_MS = 1_000_000;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

class SqliteTelemetryStore implements TelemetryStore {
  private readonly db: DatabaseSyncInstance;
  private readonly insertStmt: StatementInstance;
  private readonly log: Logger;

  constructor(db: DatabaseSyncInstance, log: Logger) {
    this.db = db;
    this.log = log;
    this.db.exec(CREATE_SCHEMA);
    this.insertStmt = db.prepare(
      `INSERT INTO telemetry
         (member_name, signal, name, ts_unix_nano, ts_ms, attributes, resource, scope, payload, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  append(memberName: string, records: TelemetryRecord[]): void {
    if (records.length === 0) return;
    const now = Date.now();

    // Serialize (and skip the unserializable) BEFORE opening the
    // transaction so one bad record can't abort the whole batch.
    const rows: Array<
      [string, string, string, number, number, string, string, string | null, string, number]
    > = [];
    for (const rec of records) {
      let attributes: string;
      let resource: string;
      let scope: string | null;
      let payload: string;
      try {
        attributes = JSON.stringify(rec.attributes ?? {});
        resource = JSON.stringify(rec.resource ?? {});
        scope = rec.scope == null ? null : JSON.stringify(rec.scope);
        payload = JSON.stringify(rec.payload ?? {});
      } catch (err) {
        this.log.warn('telemetry-store: skipped unserializable record', {
          memberName,
          name: rec.name,
          signal: rec.signal,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const tsUnixNano =
        typeof rec.tsUnixNano === 'number' && Number.isFinite(rec.tsUnixNano)
          ? Math.trunc(rec.tsUnixNano)
          : 0;
      const tsMs = Math.trunc(tsUnixNano / NANOS_PER_MS);
      rows.push([
        memberName,
        rec.signal,
        rec.name,
        tsUnixNano,
        tsMs,
        attributes,
        resource,
        scope,
        payload,
        now,
      ]);
    }
    if (rows.length === 0) return;

    // Transaction: either every row lands or none. node:sqlite has no
    // high-level transaction API — BEGIN/COMMIT via exec is the pattern
    // the activity store uses.
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        this.insertStmt.run(...r);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM telemetry').get() as
      | { n: number | bigint }
      | undefined;
    return row ? Number(row.n) : 0;
  }

  list(filter: TelemetryQuery = {}): TelemetryRow[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (filter.memberName !== undefined) {
      conditions.push('member_name = ?');
      params.push(filter.memberName);
    }
    if (filter.signal !== undefined) {
      conditions.push('signal = ?');
      params.push(filter.signal);
    }
    if (filter.name !== undefined) {
      conditions.push('name = ?');
      params.push(filter.name);
    }
    if (filter.from !== undefined) {
      conditions.push('ts_ms >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      conditions.push('ts_ms <= ?');
      params.push(filter.to);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const sql = `SELECT * FROM telemetry ${where} ORDER BY ts_ms ASC, id ASC LIMIT ?`;
    const stmt = this.db.prepare(sql);
    // Nanosecond timestamps overflow JS-number safe range; read INTEGER
    // columns as BigInt to avoid node:sqlite's out-of-range throw, then
    // narrow to number at the boundary.
    stmt.setReadBigInts(true);
    params.push(limit);
    const rows = stmt.all(...params) as unknown as TelemetryRowRaw[];
    const out: TelemetryRow[] = [];
    for (const raw of rows) {
      const decoded = this.decode(raw);
      if (decoded !== null) out.push(decoded);
    }
    return out;
  }

  private decode(raw: TelemetryRowRaw): TelemetryRow | null {
    try {
      return {
        id: Number(raw.id),
        memberName: raw.member_name,
        signal: raw.signal === 'metric' ? 'metric' : 'log',
        name: raw.name,
        tsUnixNano: Number(raw.ts_unix_nano),
        tsMs: Number(raw.ts_ms),
        attributes: JSON.parse(raw.attributes) as Record<string, unknown>,
        resource: JSON.parse(raw.resource) as Record<string, unknown>,
        scope: raw.scope ? (JSON.parse(raw.scope) as Record<string, unknown>) : null,
        payload: JSON.parse(raw.payload) as Record<string, unknown>,
        receivedAt: Number(raw.received_at),
      };
    } catch (err) {
      this.log.warn('telemetry-store: skipped malformed row', {
        id: Number(raw.id),
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

export function createTelemetryStore(
  db: DatabaseSyncInstance,
  opts: TelemetryStoreOptions = {},
): TelemetryStore {
  return new SqliteTelemetryStore(db, opts.logger ?? defaultLogger);
}
