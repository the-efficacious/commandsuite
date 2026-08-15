/**
 * Retention for the activity database.
 *
 * The activity DB holds four independent bodies of captured data, and
 * for a long time only one of them was prunable. `csuite prune-traces`
 * deleted from `member_activity` and nothing else, while the three
 * heaviest tables in the same file — `gen_ai_inference` (full request
 * context, quadratic in a conversation's turn count by design),
 * `raw_blob` (gzipped verbatim bodies) and `telemetry` (one row per
 * OTLP record) — grew without bound. The docs described the command as
 * the retention story for traces, which was true of the sentence and
 * false of the disk.
 *
 * So retention is defined here, over the whole file, in one pass:
 *
 *   member_activity    ts        < cutoff
 *   gen_ai_inference   ts        < cutoff
 *   telemetry          ts_ms     < cutoff
 *   raw_exchange       event_ts  < cutoff
 *   raw_blob           orphaned by the deletes above
 *
 * **Blobs are reference-counted, not time-bounded.** `raw_blob` is
 * content-addressed and deduped: one row can back many exchanges across
 * many turns, and `first_seen_at` records when the bytes were FIRST
 * stored, not when they were last needed. Deleting blobs by their own
 * timestamp would cut the bytes out from under retained exchanges — the
 * dedup that makes the store cheap is exactly what makes an age-based
 * delete wrong. A blob goes when nothing points at it, from either
 * direction: `raw_exchange.hash`, or the `request_sha256` /
 * `response_sha256` columns on a retained `gen_ai_inference`.
 *
 * Every statement is guarded on the table existing. The activity DB is
 * assembled by whichever stores a deployment wired, so a broker running
 * without gen-ai capture has no `gen_ai_inference` table and must still
 * be prunable.
 */

import type { SqlDriver } from './sql-driver.js';

/** Rows deleted per table. Zero and absent are reported the same way. */
export interface PruneActivityResult {
  memberActivity: number;
  genAiInference: number;
  telemetry: number;
  rawExchange: number;
  rawBlob: number;
  /** Sum across every table — what the operator sees by default. */
  total: number;
}

/**
 * Indexes supporting the retention DELETEs.
 *
 * Every table's existing index is member-leading — right for reads,
 * useless for `WHERE <ts> < ?`, which is a full scan without these. On
 * the table the command has always pruned that scan was the whole
 * table; adding the other three tables without these would multiply it.
 */
const RETENTION_INDEXES: ReadonlyArray<{ table: string; sql: string }> = [
  {
    table: 'member_activity',
    sql: 'CREATE INDEX IF NOT EXISTS member_activity_ts_idx ON member_activity (ts)',
  },
  {
    table: 'gen_ai_inference',
    sql: 'CREATE INDEX IF NOT EXISTS gen_ai_inference_ts_idx ON gen_ai_inference (ts)',
  },
  {
    table: 'telemetry',
    sql: 'CREATE INDEX IF NOT EXISTS telemetry_ts_ms_idx ON telemetry (ts_ms)',
  },
  {
    table: 'raw_exchange',
    sql: 'CREATE INDEX IF NOT EXISTS raw_exchange_event_ts_idx ON raw_exchange (event_ts)',
  },
];

function tableExists(db: SqlDriver, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return row?.name === name;
}

function deleteOlderThan(db: SqlDriver, table: string, column: string, cutoffTs: number): number {
  if (!tableExists(db, table)) return 0;
  const result = db.prepare(`DELETE FROM ${table} WHERE ${column} < ?`).run(cutoffTs);
  return Number(result.changes ?? 0);
}

/**
 * Ensure the retention indexes exist for whichever tables are present.
 * Safe to call repeatedly; `IF NOT EXISTS` makes it a no-op after the
 * first run.
 */
export function ensureRetentionIndexes(db: SqlDriver): void {
  for (const { table, sql } of RETENTION_INDEXES) {
    if (tableExists(db, table)) db.exec(sql);
  }
}

/**
 * Delete every captured row older than `cutoffTs` across the activity
 * database, then collect blobs nothing references any more.
 *
 * Ordering is load-bearing: exchanges and inferences are deleted
 * BEFORE the orphan sweep, so a blob whose last referrer was just
 * removed is collected in the same pass rather than surviving until the
 * next one.
 */
export function pruneActivityDb(db: SqlDriver, cutoffTs: number): PruneActivityResult {
  ensureRetentionIndexes(db);

  const memberActivity = deleteOlderThan(db, 'member_activity', 'ts', cutoffTs);
  const genAiInference = deleteOlderThan(db, 'gen_ai_inference', 'ts', cutoffTs);
  const telemetry = deleteOlderThan(db, 'telemetry', 'ts_ms', cutoffTs);
  const rawExchange = deleteOlderThan(db, 'raw_exchange', 'event_ts', cutoffTs);

  let rawBlob = 0;
  if (tableExists(db, 'raw_blob')) {
    // Both referrers are optional: a deployment may have raw_blob with
    // no gen_ai_inference table, or vice versa. Each NOT EXISTS clause
    // is only added when its table is there, so an absent referrer
    // cannot be read as "nothing references this".
    const clauses: string[] = [];
    if (tableExists(db, 'raw_exchange')) {
      clauses.push('NOT EXISTS (SELECT 1 FROM raw_exchange x WHERE x.hash = raw_blob.hash)');
    }
    if (tableExists(db, 'gen_ai_inference')) {
      clauses.push(
        'NOT EXISTS (SELECT 1 FROM gen_ai_inference g WHERE g.request_sha256 = raw_blob.hash ' +
          'OR g.response_sha256 = raw_blob.hash)',
      );
    }
    if (clauses.length > 0) {
      const result = db.prepare(`DELETE FROM raw_blob WHERE ${clauses.join(' AND ')}`).run();
      rawBlob = Number(result.changes ?? 0);
    }
  }

  return {
    memberActivity,
    genAiInference,
    telemetry,
    rawExchange,
    rawBlob,
    total: memberActivity + genAiInference + telemetry + rawExchange + rawBlob,
  };
}
