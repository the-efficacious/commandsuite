/**
 * Retained completeness diagnostics.
 *
 * WHY THIS EXISTS
 * ---------------
 * All 50 broker log sites sink to one stderr line (`logger.ts:22`).
 * Nothing is retained. Twenty-one of those fifty are the product
 * detecting that data it claims completeness over was lost, truncated,
 * or never stored — and then discarding the evidence. A full day of
 * missing capture went unnoticed for exactly this reason: the
 * correlator detected and reported the failure the entire time, to a
 * terminal nothing kept. The product knew; nobody could find out.
 *
 * SCOPE, from the reconciled census
 * ---------------------------------
 *     50   broker log sites total
 *     21   completeness failures        ← in
 *     29   delivery / authorisation     ← out
 *
 * The rule: IN when the product detected that data it claims to be
 * complete about was lost, truncated, or never stored. OUT when an
 * operation failed and no completeness claim covers it — a push that
 * did not send, a websocket that dropped, an auth rejection. Those are
 * real and worth logging; they are not claims about the record.
 *
 * RUNNER-SIDE IS OUT, and it costs something specific. `otlp-relay`'s
 * `raw body unavailable` announces uncaptured bytes on the AGENT's
 * machine, and this store cannot reach it. Worse: when a broker
 * activity append fails, the runner re-queues with backoff and loses
 * nothing until its queue caps, then evicts oldest and counts `dropped`
 * — to the runner's own run summary and nowhere else. Capture-health
 * then sees fewer markers and reads HEALTHIER. The only signal that its
 * denominator shrank is runner-side and therefore uncovered here.
 *
 * WHAT IS RETAINED, AND WHAT IS DELIBERATELY NOT
 * ----------------------------------------------
 * These log sites carry attacker-influenced input: filesystem paths
 * from OTLP `body_ref` attributes, and arbitrary `Error.message`
 * strings. Retaining that context verbatim turns a diagnostic store
 * into a durable path and secret leak, and defeats any per-entry size
 * bound. So context is a finite cause code plus cause-specific,
 * length-bounded safe fields:
 *
 *     paths   NEVER stored. A 16-hex prefix of sha256(path) plus the
 *             path's length — enough to see the same path recur, not
 *             enough to reconstruct it.
 *     errors  NEVER stored as text. Classified to a finite code from a
 *             whitelist (ENOENT, EACCES, …), else `unclassified`.
 *     hashes  stored — already content addresses, already in the DB.
 *
 * CURRENT HEALTH IS NOT HISTORICAL PRESENCE
 * -----------------------------------------
 * A member who failed Monday and recovered Tuesday is currently
 * healthy, and Monday stays queryable. Detail expiry NEVER heals —
 * that would satisfy a disk bound by erasing evidence. Only an observed
 * recovery does, via `resolve()`. Unresolved state lives in its own
 * table and survives every retention sweep.
 *
 * COVERAGE, so eviction is never silent
 * -------------------------------------
 * Caps are hard and compaction is deterministic. When rows are evicted
 * the store does not simply forget: `coverageFloor` moves up, and any
 * query reaching below it answers `indeterminate` rather than a
 * confident zero. A sub-window query against bucketed data answers at
 * the bucket's resolution and says so. **Unknown stays a state** — the
 * same rule that makes an absent `captureHealth` mean "no opinion"
 * rather than "healthy", which is the defect this whole line of work
 * exists to remove.
 */

import { createHash } from 'node:crypto';
import type { DatabaseSyncInstance, StatementInstance } from './db.js';

/**
 * The finite cause enum. One code per in-scope site.
 *
 * This is the cardinality basis for the bucket tables, so it must stay
 * finite and closed. `diagnostics-census.test.ts` fails if an in-scope
 * module grows a completeness warning that is not registered here.
 */
export const DIAGNOSTIC_CAUSES = [
  // genai-correlator (8)
  'correlator.body_ref_unreadable',
  'correlator.body_length_mismatch',
  'correlator.unlink_after_capture_failed',
  'correlator.raw_capture_failed',
  'correlator.body_json_parse_failed',
  'correlator.inference_build_failed',
  'correlator.request_id_assign_failed',
  'correlator.malformed_record_skipped',
  // raw-body-store (2)
  'rawstore.blob_gunzip_failed',
  'rawstore.blob_hash_mismatch',
  // genai-store (2)
  'genaistore.unserializable_record_skipped',
  'genaistore.malformed_row_skipped',
  // telemetry-store (2)
  'telemetrystore.unserializable_record_skipped',
  'telemetrystore.malformed_row_skipped',
  // app.ts ingest + append (7)
  'otlp.logs_store_failed',
  'otlp.genai_ingest_failed',
  'otlp.metrics_store_failed',
  'codex.genai_ingest_entry_failed',
  'activity.append_failed',
  'toolinvoke.audit_append_failed',
  'enrollment.source_label_truncated',
  // the store's own overflow — see `recordOverflow`
  'retention.overflow',
] as const;

export type DiagnosticCause = (typeof DIAGNOSTIC_CAUSES)[number];

/**
 * How a member relates to a diagnostic.
 *
 * `getBlob(hash)` takes no member and a content-addressed blob may be
 * referenced by several, so there is no single owner to record. Picking
 * the caller would be false attribution inside the store built to
 * prevent false absence.
 *
 *     producer      the member whose work produced the failure
 *     affected      members whose records are impacted (may be several)
 *     observer      a member was present but is not implicated
 *     unattributed  no member can be resolved — EXPOSED, never omitted
 */
export type Attribution = 'producer' | 'affected' | 'observer' | 'unattributed';

/** Coverage of an answer. `indeterminate` is a state, not a zero. */
export type Coverage = 'exact' | 'bucket' | 'indeterminate';

/** Health of the retention subsystem itself (criterion 7). */
export type RetentionHealth = 'healthy' | 'degraded' | 'unknown';

/** Safe, bounded context. Paths and error text never appear here. */
export interface SafeFields {
  /** sha256(path) first 16 hex — recurrence without reconstruction. */
  pathDigest?: string;
  /** Length of the original path, in bytes. */
  pathLength?: number;
  /** Content address — already a hash, already stored elsewhere. */
  hash?: string;
  /** `request` / `response` etc. Short, closed set at each call site. */
  kind?: string;
  /** Classified errno-style code, never `Error.message`. */
  errorCode?: string;
  /** A bounded count (records skipped, bytes over, …). */
  count?: number;
}

const MAX_FIELD_CHARS = 128;
/** Error codes we are willing to retain verbatim. Anything else is opaque. */
const KNOWN_ERROR_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EISDIR',
  'ENOTDIR',
  'EMFILE',
  'ENOSPC',
  'EROFS',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'SQLITE_BUSY',
  'SQLITE_FULL',
  'SQLITE_CORRUPT',
]);

/**
 * Classify an unknown thrown value to a finite code.
 *
 * Deliberately does NOT fall through to `err.message`. An error message
 * can contain a path, a token, or a fragment of a request body, and
 * this store is durable and queryable by agents.
 */
export function classifyError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && KNOWN_ERROR_CODES.has(code)) return code;
  if (err instanceof SyntaxError) return 'SYNTAX';
  if (err instanceof TypeError) return 'TYPE';
  if (err instanceof RangeError) return 'RANGE';
  return 'unclassified';
}

/** Digest a path for recurrence detection without retaining it. */
export function digestPath(path: string): { pathDigest: string; pathLength: number } {
  return {
    pathDigest: createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 16),
    pathLength: Buffer.byteLength(path, 'utf8'),
  };
}

function sanitize(fields: SafeFields): SafeFields {
  const out: SafeFields = {};
  if (fields.pathDigest !== undefined) out.pathDigest = fields.pathDigest.slice(0, 32);
  if (fields.pathLength !== undefined) out.pathLength = Math.trunc(fields.pathLength);
  if (fields.hash !== undefined) out.hash = fields.hash.slice(0, 64);
  if (fields.kind !== undefined) out.kind = fields.kind.slice(0, MAX_FIELD_CHARS);
  if (fields.errorCode !== undefined) out.errorCode = fields.errorCode.slice(0, MAX_FIELD_CHARS);
  if (fields.count !== undefined) out.count = Math.trunc(fields.count);
  return out;
}

export interface DiagnosticInput {
  cause: DiagnosticCause;
  /**
   * Members this concerns. Empty means unattributed, which is recorded
   * explicitly as a row with `member_name IS NULL` rather than dropped.
   */
  members?: readonly string[];
  attribution: Attribution;
  fields?: SafeFields;
}

export interface DiagnosticWindowResult {
  /** The interval actually answered, which may exceed the request. */
  interval: { from: number; to: number };
  resolution: 'event' | 'hour' | 'day' | 'none';
  count: number;
  first: number | null;
  last: number | null;
  coverage: Coverage;
}

export interface DiagnosticStore {
  record(input: DiagnosticInput): void;
  /** An observed recovery. The ONLY thing that clears unresolved state. */
  resolve(cause: DiagnosticCause, member: string | null): void;
  /** Causes currently unresolved for a member, oldest first. */
  unresolved(member: string | null): Array<{ cause: DiagnosticCause; since: number }>;
  query(opts: {
    member?: string | null;
    cause?: DiagnosticCause;
    from: number;
    to: number;
  }): DiagnosticWindowResult;
  /** Fold aged detail into hour buckets and hour into day. Idempotent. */
  sweep(): void;
  health(): RetentionHealth;
  /** Oldest instant still fully covered; below this, answers are indeterminate. */
  coverageFloor(): number;
}

export interface DiagnosticOptions {
  now?: () => number;
  /** Detail rows are folded once older than this. */
  detailMs?: number;
  /** Hour buckets are folded to day buckets once older than this. */
  hourMs?: number;
  /** Day buckets are dropped past this, moving the coverage floor. */
  dayMs?: number;
  /** Hard row caps. Exceeding one evicts oldest AND raises the floor. */
  maxDetailRows?: number;
  maxBucketRows?: number;
}

const DEFAULT_DETAIL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days of per-event detail
const DEFAULT_HOUR_MS = 30 * 24 * 60 * 60 * 1000; // 30 days at hour resolution
const DEFAULT_DAY_MS = 400 * 24 * 60 * 60 * 1000; // ~13 months at day resolution
const DEFAULT_MAX_DETAIL_ROWS = 50_000;
const DEFAULT_MAX_BUCKET_ROWS = 200_000;

const HOUR = 3_600_000;
const DAY = 86_400_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS diagnostic_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cause TEXT NOT NULL,
    member_name TEXT,
    attribution TEXT NOT NULL,
    ts INTEGER NOT NULL,
    fields TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS diagnostic_event_ts ON diagnostic_event (ts);
  CREATE INDEX IF NOT EXISTS diagnostic_event_member ON diagnostic_event (member_name, ts);

  CREATE TABLE IF NOT EXISTS diagnostic_bucket (
    cause TEXT NOT NULL,
    member_name TEXT,
    bucket_start INTEGER NOT NULL,
    resolution TEXT NOT NULL,
    n INTEGER NOT NULL,
    first_ts INTEGER NOT NULL,
    last_ts INTEGER NOT NULL,
    PRIMARY KEY (cause, member_name, bucket_start, resolution)
  );
  CREATE INDEX IF NOT EXISTS diagnostic_bucket_start ON diagnostic_bucket (bucket_start);

  CREATE TABLE IF NOT EXISTS diagnostic_state (
    cause TEXT NOT NULL,
    member_name TEXT,
    since INTEGER NOT NULL,
    PRIMARY KEY (cause, member_name)
  );

  CREATE TABLE IF NOT EXISTS diagnostic_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export function createDiagnosticStore(
  db: DatabaseSyncInstance,
  options: DiagnosticOptions = {},
): DiagnosticStore {
  db.exec(SCHEMA);

  const now = options.now ?? (() => Date.now());
  const detailMs = options.detailMs ?? DEFAULT_DETAIL_MS;
  const hourMs = options.hourMs ?? DEFAULT_HOUR_MS;
  const dayMs = options.dayMs ?? DEFAULT_DAY_MS;
  const maxDetailRows = options.maxDetailRows ?? DEFAULT_MAX_DETAIL_ROWS;
  const maxBucketRows = options.maxBucketRows ?? DEFAULT_MAX_BUCKET_ROWS;

  const insertEvent: StatementInstance = db.prepare(
    `INSERT INTO diagnostic_event (cause, member_name, attribution, ts, fields)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const upsertState: StatementInstance = db.prepare(
    `INSERT INTO diagnostic_state (cause, member_name, since) VALUES (?, ?, ?)
     ON CONFLICT (cause, member_name) DO NOTHING`,
  );
  const clearState: StatementInstance = db.prepare(
    `DELETE FROM diagnostic_state WHERE cause = ? AND member_name IS ?`,
  );
  const getMeta: StatementInstance = db.prepare(`SELECT value FROM diagnostic_meta WHERE key = ?`);
  const setMeta: StatementInstance = db.prepare(
    `INSERT INTO diagnostic_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  );

  function metaNum(key: string, fallback: number): number {
    const row = getMeta.get(key) as { value: string } | undefined;
    return row === undefined ? fallback : Number(row.value);
  }
  function raiseFloor(to: number): void {
    if (to > metaNum('coverage_floor', 0)) setMeta.run('coverage_floor', String(to));
  }
  function bumpOverflow(): void {
    setMeta.run('overflow_count', String(metaNum('overflow_count', 0) + 1));
    setMeta.run('overflow_last', String(now()));
  }

  /**
   * Evict oldest rows past a hard cap, and RAISE THE COVERAGE FLOOR to
   * the newest evicted timestamp.
   *
   * This is the mechanism that keeps eviction honest. Without the floor,
   * a capped store answers a historical window with a confident zero
   * having deleted the evidence — satisfying the disk bound by
   * destroying exactly what the bound was supposed to protect.
   */
  function enforceCaps(): void {
    const detail = db.prepare(`SELECT COUNT(*) AS n FROM diagnostic_event`).get() as { n: number };
    if (Number(detail.n) > maxDetailRows) {
      const over = Number(detail.n) - maxDetailRows;
      const cut = db
        .prepare(`SELECT MAX(ts) AS t FROM (SELECT ts FROM diagnostic_event ORDER BY ts LIMIT ?)`)
        .get(over) as { t: number | null };
      db.prepare(
        `DELETE FROM diagnostic_event WHERE id IN
           (SELECT id FROM diagnostic_event ORDER BY ts LIMIT ?)`,
      ).run(over);
      if (cut.t !== null) raiseFloor(Number(cut.t));
      bumpOverflow();
    }
    const bucket = db.prepare(`SELECT COUNT(*) AS n FROM diagnostic_bucket`).get() as { n: number };
    if (Number(bucket.n) > maxBucketRows) {
      const over = Number(bucket.n) - maxBucketRows;
      const cut = db
        .prepare(
          `SELECT MAX(bucket_start) AS t FROM
             (SELECT bucket_start FROM diagnostic_bucket ORDER BY bucket_start LIMIT ?)`,
        )
        .get(over) as { t: number | null };
      db.prepare(
        `DELETE FROM diagnostic_bucket WHERE rowid IN
           (SELECT rowid FROM diagnostic_bucket ORDER BY bucket_start LIMIT ?)`,
      ).run(over);
      if (cut.t !== null) raiseFloor(Number(cut.t) + HOUR);
      bumpOverflow();
    }
  }

  /** Fold a set of rows into a bucket row, accumulating deterministically. */
  const foldBucket: StatementInstance = db.prepare(
    `INSERT INTO diagnostic_bucket (cause, member_name, bucket_start, resolution, n, first_ts, last_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (cause, member_name, bucket_start, resolution) DO UPDATE SET
       n = n + excluded.n,
       first_ts = MIN(first_ts, excluded.first_ts),
       last_ts = MAX(last_ts, excluded.last_ts)`,
  );

  return {
    record(input: DiagnosticInput): void {
      const ts = now();
      const fields = JSON.stringify(sanitize(input.fields ?? {}));
      const members =
        input.members !== undefined && input.members.length > 0
          ? [...new Set(input.members)]
          : [null];
      for (const m of members) {
        insertEvent.run(input.cause, m, input.attribution, ts, fields);
        // Unresolved state is per (cause, member) and survives every
        // sweep. Only `resolve()` clears it.
        upsertState.run(input.cause, m, ts);
      }
      enforceCaps();
    },

    resolve(cause: DiagnosticCause, member: string | null): void {
      clearState.run(cause, member);
    },

    unresolved(member: string | null) {
      return (
        db
          .prepare(
            `SELECT cause, since FROM diagnostic_state WHERE member_name IS ? ORDER BY since`,
          )
          .all(member) as Array<{ cause: DiagnosticCause; since: number }>
      ).map((r) => ({ cause: r.cause, since: Number(r.since) }));
    },

    query(opts): DiagnosticWindowResult {
      const floor = metaNum('coverage_floor', 0);
      const { from, to } = opts;
      // Positional binding throughout: the codebase's statement type
      // does not surface named parameters, and mixing the two styles in
      // one file is how a parameter ends up bound to the wrong slot.
      const params: Array<string | number | null> = [from, to];
      let memberClause = '';
      if (opts.member !== undefined) {
        memberClause = ' AND member_name IS ?';
        params.push(opts.member);
      }
      let causeClause = '';
      if (opts.cause !== undefined) {
        causeClause = ' AND cause = ?';
        params.push(opts.cause);
      }

      // A window reaching below the coverage floor cannot be answered.
      // Say so rather than returning a confident count over whatever
      // happens to survive.
      if (from < floor) {
        return {
          interval: { from, to },
          resolution: 'none',
          count: 0,
          first: null,
          last: null,
          coverage: 'indeterminate',
        };
      }

      const ev = db
        .prepare(
          `SELECT COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts
             FROM diagnostic_event
            WHERE ts >= ? AND ts <= ?${memberClause}${causeClause}`,
        )
        .get(...params) as { n: number; first_ts: number | null; last_ts: number | null };

      const bucketParams: Array<string | number | null> = [to, from - DAY, ...params.slice(2)];
      const bk = db
        .prepare(
          `SELECT COALESCE(SUM(n),0) AS n, MIN(first_ts) AS first_ts, MAX(last_ts) AS last_ts,
                  MIN(bucket_start) AS lo, MAX(bucket_start) AS hi, MIN(resolution) AS res
             FROM diagnostic_bucket
            WHERE bucket_start <= ? AND bucket_start >= ?${memberClause}${causeClause}`,
        )
        .get(...bucketParams) as {
        n: number;
        first_ts: number | null;
        last_ts: number | null;
        lo: number | null;
        hi: number | null;
        res: string | null;
      };

      const evN = Number(ev.n ?? 0);
      const bkN = Number(bk.n ?? 0);

      if (bkN === 0) {
        return {
          interval: { from, to },
          resolution: evN > 0 ? 'event' : 'none',
          count: evN,
          first: ev.first_ts === null ? null : Number(ev.first_ts),
          last: ev.last_ts === null ? null : Number(ev.last_ts),
          coverage: 'exact',
        };
      }

      // Bucketed evidence answers at ITS resolution, not the request's.
      // A window narrower than a bucket gets the bucket's interval back
      // and a `bucket` coverage flag — never a boolean-looking answer
      // the data cannot support.
      const width = bk.res === 'day' ? DAY : HOUR;
      const lo = bk.lo === null ? from : Number(bk.lo);
      const hi = bk.hi === null ? to : Number(bk.hi) + width;
      const firsts = [ev.first_ts, bk.first_ts].filter((x) => x !== null).map(Number);
      const lasts = [ev.last_ts, bk.last_ts].filter((x) => x !== null).map(Number);
      return {
        interval: { from: Math.min(from, lo), to: Math.max(to, hi) },
        resolution: bk.res === 'day' ? 'day' : 'hour',
        count: evN + bkN,
        first: firsts.length > 0 ? Math.min(...firsts) : null,
        last: lasts.length > 0 ? Math.max(...lasts) : null,
        coverage: 'bucket',
      };
    },

    /**
     * IDEMPOTENT by construction: each fold DELETES the rows it
     * consumed, so a second sweep over the same data finds nothing to
     * fold and cannot double a count.
     *
     * An earlier version also carried a `rolled` flag for this. It was
     * dead weight — the delete already provided the property, and a
     * mutation removing the flag changed no test while removing the
     * delete failed two. Keeping it would have implied a guarantee it
     * was not the source of.
     */
    sweep(): void {
      const t = now();

      const detailCut = t - detailMs;
      const rows = db
        .prepare(
          `SELECT cause, member_name, ts FROM diagnostic_event
            WHERE ts < ?`,
        )
        .all(detailCut) as Array<{ cause: string; member_name: string | null; ts: number }>;
      for (const r of rows) {
        const start = Math.floor(Number(r.ts) / HOUR) * HOUR;
        foldBucket.run(r.cause, r.member_name, start, 'hour', 1, Number(r.ts), Number(r.ts));
      }
      db.prepare(`DELETE FROM diagnostic_event WHERE ts < ?`).run(detailCut);

      const hourCut = t - hourMs;
      const hourRows = db
        .prepare(
          `SELECT cause, member_name, bucket_start, n, first_ts, last_ts
             FROM diagnostic_bucket
            WHERE resolution = 'hour' AND bucket_start < ?`,
        )
        .all(hourCut) as Array<{
        cause: string;
        member_name: string | null;
        bucket_start: number;
        n: number;
        first_ts: number;
        last_ts: number;
      }>;
      for (const r of hourRows) {
        const start = Math.floor(Number(r.bucket_start) / DAY) * DAY;
        foldBucket.run(
          r.cause,
          r.member_name,
          start,
          'day',
          Number(r.n),
          Number(r.first_ts),
          Number(r.last_ts),
        );
      }
      db.prepare(
        `DELETE FROM diagnostic_bucket
          WHERE resolution = 'hour' AND bucket_start < ?`,
      ).run(hourCut);

      // Past the day horizon evidence genuinely goes. The floor moves
      // with it so queries below say `indeterminate` rather than zero.
      const dayCut = t - dayMs;
      const dropped = db
        .prepare(
          `SELECT COUNT(*) AS n FROM diagnostic_bucket
            WHERE resolution = 'day' AND bucket_start < ?`,
        )
        .get(dayCut) as { n: number };
      if (Number(dropped.n) > 0) {
        db.prepare(
          `DELETE FROM diagnostic_bucket WHERE resolution = 'day' AND bucket_start < ?`,
        ).run(dayCut);
        raiseFloor(dayCut);
      }
      enforceCaps();
    },

    health(): RetentionHealth {
      const last = metaNum('overflow_last', 0);
      if (last === 0) return 'healthy';
      // Overflow within the detail window means evidence is actively
      // being shed; say `degraded` rather than reporting healthy while
      // the audit signal is lossy.
      return now() - last < detailMs ? 'degraded' : 'healthy';
    },

    coverageFloor(): number {
      return metaNum('coverage_floor', 0);
    },
  };
}
