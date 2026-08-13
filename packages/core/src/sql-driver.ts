/**
 * The SQL seam for csuite-core's SQL-backed stores.
 *
 * Synchronous by design: the broker's storage model is single-writer
 * SQLite, and a synchronous driver keeps store code free of
 * interleaving hazards — a store method runs start-to-finish against
 * one consistent view of the database. Implementations wrap
 * `node:sqlite` (see `csuite-server`'s `openDatabase`, whose
 * `DatabaseSync` satisfies this interface structurally, no adapter
 * needed) or any engine with compatible SQL semantics. The stores use
 * SQLite dialect, including the JSON1 functions (`json_extract`).
 *
 * Connection ownership stays with the caller: stores receive a driver,
 * prepare their statements once, and never open or close anything.
 * PRAGMA tuning (journal mode, busy timeout, …) is the driver
 * constructor's business — store code must not depend on it.
 *
 * Parameters are positional only (`?`), values as SQLite maps them:
 * `null`, `number`, `bigint`, `string`, `Uint8Array`.
 */

/** A value bindable to a `?` placeholder. */
export type SqlValue = null | number | bigint | string | Uint8Array;

export interface SqlRunResult {
  /** Rows changed by the statement. */
  changes: number | bigint;
  /** Rowid of the last inserted row. */
  lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  /** First result row, or `undefined` when the query matches nothing. */
  get(...params: SqlValue[]): unknown;
  /** Every result row, in statement order. */
  all(...params: SqlValue[]): unknown[];
  /** Execute without reading rows back. */
  run(...params: SqlValue[]): SqlRunResult;
  /**
   * Optional capability: read SQLite INTEGER columns as `bigint`
   * instead of `number`. Stores that persist values outside
   * `Number.MAX_SAFE_INTEGER` (e.g. nanosecond timestamps) require a
   * driver that provides this; drivers without native 64-bit reads
   * omit it, and such stores must refuse the driver rather than
   * silently truncate.
   */
  setReadBigInts?(enabled: boolean): void;
}

export interface SqlDriver {
  /** Run one or more statements without reading results (DDL, PRAGMA). */
  exec(sql: string): void;
  /** Compile a statement for repeated execution. */
  prepare(sql: string): SqlStatement;
}
