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

import { sha256Hex } from './hashing.js';
import { runInTransaction, type SqlDriver, type SqlStatement } from './sql-driver.js';

/**
 * The finite cause enum. One code per in-scope site.
 *
 * This is the cardinality basis for the bucket tables, so it must stay
 * finite and closed. `diagnostics-census.test.ts` fails if an in-scope
 * module grows a completeness warning that is not registered here.
 */
export const DIAGNOSTIC_CAUSES = [
  // genai-correlator (9)
  'correlator.body_ref_unreadable',
  'correlator.body_length_mismatch',
  'correlator.unlink_after_capture_failed',
  'correlator.raw_capture_failed',
  'correlator.body_json_parse_failed',
  'correlator.inference_build_failed',
  'correlator.request_id_assign_failed',
  'correlator.malformed_record_skipped',
  'correlator.pending_exchange_dropped',
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
  // affected-member fanout exceeded its bound — see MAX_FANOUT
  'retention.fanout_truncated',
  // the store was unreachable for a period — see the durable latch
  'retention.unavailable',
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

/**
 * Stored stand-in for "no member resolved".
 *
 * SQLite does NOT consider two NULLs equal, so a nullable column inside
 * a composite PRIMARY KEY silently defeats `ON CONFLICT`: two identical
 * unattributed folds produce two rows, not one, and the same applies to
 * unresolved state. Measured directly before this was changed — NULL
 * gave 2 rows where a real member gave 1. `NameSchema` forbids the
 * empty string, so it can never collide with a real member.
 */
const UNATTRIBUTED = '';

/**
 * How a cause behaves for CURRENT health.
 *
 *   point     a one-off loss. It is history the moment it happens and
 *             creates no unresolved state — a malformed row skipped
 *             last Tuesday is not an ongoing illness, and there is no
 *             coherent "recovery" event for it.
 *   incident  an ongoing condition with a named observed recovery. Only
 *             these create unresolved state.
 *
 * Without this split, wiring all 21 sites would mark every member
 * permanently sick from their first malformed record onward — the
 * mirror of permanent false health, and just as wrong.
 */
export type HealthMode = 'point' | 'incident';

/** Which safe fields a cause is allowed to carry. */
export type FieldPolicy = 'path' | 'hash' | 'count' | 'none';

export interface CauseSpec {
  mode: HealthMode;
  /** The attribution this cause ALWAYS uses. Not a caller decision. */
  attribution: Attribution;
  /** Fields permitted. Anything else is dropped before storage. */
  fields: readonly FieldPolicy[];
}

/**
 * The per-cause policy table.
 *
 * `Record<DiagnosticCause, CauseSpec>` is EXHAUSTIVE BY TYPE: adding a
 * cause without a policy is a compile error. The previous
 * `Record<string, HealthMode>` silently defaulted a new cause to
 * `point`, which is the quiet-failure shape this module exists to
 * remove, inside the module itself.
 *
 * ATTRIBUTION IS A PROPERTY OF THE CAUSE, not of the call site. A
 * caller cannot pair `members: []` with `producer`, and cannot decide
 * that a blob corruption is attributable to whoever happened to read
 * it — `getBlob(hash)` has no member, and the affected set is resolved
 * from `raw_exchange` by the wiring rather than guessed here.
 */
const CAUSE_SPEC: Record<DiagnosticCause, CauseSpec> = {
  'correlator.body_ref_unreadable': { mode: 'incident', attribution: 'producer', fields: ['path'] },
  'correlator.body_length_mismatch': { mode: 'point', attribution: 'producer', fields: ['count'] },
  'correlator.unlink_after_capture_failed': {
    mode: 'point',
    attribution: 'producer',
    fields: ['path'],
  },
  'correlator.raw_capture_failed': { mode: 'incident', attribution: 'producer', fields: ['hash'] },
  'correlator.body_json_parse_failed': {
    mode: 'point',
    attribution: 'producer',
    fields: ['count'],
  },
  'correlator.inference_build_failed': { mode: 'point', attribution: 'producer', fields: ['none'] },
  'correlator.request_id_assign_failed': {
    mode: 'point',
    attribution: 'producer',
    fields: ['hash'],
  },
  'correlator.malformed_record_skipped': {
    mode: 'point',
    attribution: 'producer',
    fields: ['none'],
  },
  'correlator.pending_exchange_dropped': {
    mode: 'point',
    attribution: 'producer',
    fields: ['count'],
  },
  'rawstore.blob_gunzip_failed': { mode: 'point', attribution: 'affected', fields: ['hash'] },
  'rawstore.blob_hash_mismatch': { mode: 'point', attribution: 'affected', fields: ['hash'] },
  'genaistore.unserializable_record_skipped': {
    mode: 'point',
    attribution: 'producer',
    fields: ['none'],
  },
  'genaistore.malformed_row_skipped': { mode: 'point', attribution: 'affected', fields: ['none'] },
  'telemetrystore.unserializable_record_skipped': {
    mode: 'point',
    attribution: 'producer',
    fields: ['none'],
  },
  'telemetrystore.malformed_row_skipped': {
    mode: 'point',
    attribution: 'affected',
    fields: ['none'],
  },
  'otlp.logs_store_failed': { mode: 'incident', attribution: 'producer', fields: ['count'] },
  'otlp.genai_ingest_failed': { mode: 'incident', attribution: 'producer', fields: ['count'] },
  'otlp.metrics_store_failed': { mode: 'incident', attribution: 'producer', fields: ['count'] },
  'codex.genai_ingest_entry_failed': {
    mode: 'incident',
    attribution: 'producer',
    fields: ['none'],
  },
  'activity.append_failed': { mode: 'incident', attribution: 'producer', fields: ['count'] },
  'toolinvoke.audit_append_failed': { mode: 'incident', attribution: 'producer', fields: ['none'] },
  'enrollment.source_label_truncated': {
    mode: 'point',
    attribution: 'unattributed',
    fields: ['count'],
  },
  'retention.overflow': { mode: 'point', attribution: 'unattributed', fields: ['count'] },
  'retention.fanout_truncated': { mode: 'point', attribution: 'unattributed', fields: ['count'] },
  'retention.unavailable': { mode: 'point', attribution: 'unattributed', fields: ['count'] },
};

export function causeSpec(cause: DiagnosticCause): CauseSpec {
  return CAUSE_SPEC[cause];
}

export function healthMode(cause: DiagnosticCause): HealthMode {
  return CAUSE_SPEC[cause].mode;
}

/** Coverage of an answer. `indeterminate` is a state, not a zero. */
export type Coverage = 'exact' | 'bucket' | 'indeterminate';

/** Health of the retention subsystem itself (criterion 7). */
export type RetentionHealth = 'healthy' | 'degraded' | 'unknown';

/**
 * Brand carried only by values the constructors below produce.
 *
 * The symbol is module-private, so a caller CANNOT write a `SafeFields`
 * literal: `{ pathDigest: 'secret-path-fragment', pathLength: 20 }`
 * fails to compile. Filtering field NAMES by a per-cause policy was not
 * enough — it kept `pathDigest` for a path-permitted cause without
 * establishing that the value ever went through `digestPath()`, so a
 * caller could persist a raw path fragment in a field whose whole
 * purpose is that raw paths are never stored.
 *
 * The type system owns this rather than a review convention, because a
 * forged value is indistinguishable from a real one once written.
 */
declare const SAFE_BRAND: unique symbol;

/** Safe, bounded context. Paths and error text never appear here. */
export interface SafeFields {
  /**
   * Present only on constructor output. REQUIRED, not optional: an
   * optional brand is satisfied by any literal that omits it, so the
   * first version of this rejected nothing and a forged
   * `{ pathDigest: 'secret-path-fragment' }` compiled. Caught by
   * compiling the hostile literal rather than by assuming the brand
   * worked.
   */
  readonly [SAFE_BRAND]: true;
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

/**
 * Digest a path for recurrence detection without retaining it.
 *
 * The ONLY way to obtain a `pathDigest` the store will accept.
 */
export async function digestPath(path: string): Promise<SafeFields> {
  return {
    pathDigest: (await sha256Hex(path)).slice(0, 16),
    pathLength: new TextEncoder().encode(path).length,
  } as SafeFields;
}

/** The only way to attach a content address. */
export function safeHash(hash: string): SafeFields {
  return { hash: hash.slice(0, 64) } as SafeFields;
}

/** The only way to attach a bounded count. */
export function safeCount(n: number): SafeFields {
  return { count: Math.trunc(n) } as SafeFields;
}

/** The only way to attach a classified error code. */
export function safeError(err: unknown): SafeFields {
  return { errorCode: classifyError(err) } as SafeFields;
}

/** Merge constructor outputs. Still unforgeable — inputs are branded. */
export function safeFields(...parts: readonly SafeFields[]): SafeFields {
  return Object.assign({}, ...parts) as SafeFields;
}

/**
 * Filter to the fields this CAUSE is permitted to carry.
 *
 * Truncating a value is not the same as refusing it: the previous
 * version accepted any `SafeFields` from any caller and merely capped
 * the string lengths, so a caller could persist an arbitrary
 * 128-character `errorCode` or a `pathDigest` that was never a digest.
 * The policy is a property of the cause, so it is applied here rather
 * than trusted at the call site.
 */
const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Runtime shape validation, because the brand is compile-time only.
 *
 * A cast defeats the type, so every retained value must also LOOK like
 * what it claims: a path digest is exactly 16 lowercase hex, a content
 * address exactly 64, an error code a member of the finite set. A value
 * that fails is dropped rather than stored — a field-name allowlist is
 * not a value-provenance boundary.
 */
function validShape(f: SafeFields): SafeFields {
  const out = {} as SafeFields;
  if (typeof f.pathDigest === 'string' && HEX16.test(f.pathDigest)) {
    out.pathDigest = f.pathDigest;
    if (typeof f.pathLength === 'number' && Number.isFinite(f.pathLength)) {
      out.pathLength = Math.trunc(f.pathLength);
    }
  }
  if (typeof f.hash === 'string' && HEX64.test(f.hash)) out.hash = f.hash;
  if (
    typeof f.errorCode === 'string' &&
    (KNOWN_ERROR_CODES.has(f.errorCode) ||
      ['unclassified', 'SYNTAX', 'TYPE', 'RANGE'].includes(f.errorCode))
  ) {
    out.errorCode = f.errorCode;
  }
  if (typeof f.count === 'number' && Number.isFinite(f.count)) out.count = Math.trunc(f.count);
  if (typeof f.kind === 'string' && /^[a-z_]{1,32}$/.test(f.kind)) out.kind = f.kind;
  return out;
}

function sanitize(fields: SafeFields, allow: readonly FieldPolicy[]): SafeFields {
  fields = validShape(fields);
  const ok = new Set(allow);
  const out = {} as SafeFields;
  if (!ok.has('path')) {
    fields = { ...fields, pathDigest: undefined, pathLength: undefined };
  }
  if (!ok.has('hash')) fields = { ...fields, hash: undefined };
  if (!ok.has('count')) fields = { ...fields, count: undefined };
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
   * Members this concerns. Empty records an explicit `unattributed`
   * row rather than dropping the diagnostic.
   */
  members?: readonly string[];
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

/**
 * The 21 in-scope sites, one method each.
 *
 * Each method takes RAW inputs — a path, a thrown value, a hash — and
 * owns the conversion to safe stored fields. Call sites do not
 * manufacture a `pathDigest` or classify an error; they hand over what
 * they have and this layer decides what is retainable.
 *
 * Generic `record` is NOT on `DiagnosticStore`. Branding `fields` is
 * not sufficient on its own: fields are optional, so a caller could
 * still emit `rawstore.blob_hash_mismatch` with a hand-picked member
 * list and no hash at all — manufacturing an affected-corruption
 * attribution without the emitter's `raw_exchange` lookup. Runtime
 * validation proves the SHAPE of fields that exist; it cannot prove
 * the right emitter established the event or its affected set.
 *
 * Criterion 9's guarantee is architectural, so the boundary has to be
 * one too. An internal factory exposes the raw closures for the
 * store's own mechanics tests; production has no route to them.
 *
 * THERE WERE THREE DOORS TO THE SAME ROOM, not one. Closing generic
 * `record` and then `emit.recovered` still left `store.resolve`
 * public, which cleared any incident — including a point cause that
 * can never have one. Closing a bypass means enumerating every route
 * to the capability, not fixing the route someone named.
 *
 * BLOB CORRUPTION RESOLVES ITS OWN ATTRIBUTION. `getBlob(hash)` has no
 * member, so these methods look the affected set up from `raw_exchange`
 * by hash rather than accepting one from the caller — which would be
 * whoever happened to read it.
 */
export interface DiagnosticEmitter {
  /**
   * `pathFields` comes from `digestPath` (async, Web Crypto) or a
   * host-supplied sync equivalent — the caller hashes so this method
   * stays synchronous and records land in call order.
   */
  correlatorBodyRefUnreadable(member: string, pathFields: SafeFields, err: unknown): void;
  correlatorBodyLengthMismatch(member: string, expected: number, actual: number): void;
  correlatorUnlinkAfterCaptureFailed(member: string, pathFields: SafeFields, err: unknown): void;
  correlatorRawCaptureFailed(member: string, err: unknown): void;
  correlatorBodyJsonParseFailed(member: string, bytes: number): void;
  correlatorInferenceBuildFailed(member: string, err: unknown): void;
  correlatorRequestIdAssignFailed(member: string, err: unknown): void;
  correlatorMalformedRecordSkipped(member: string): void;
  /**
   * A pending exchange left correlation without becoming an inference —
   * evicted stale or displaced by the pending-request cap. Point cause:
   * the loss is a fact about that exchange, not an ongoing condition a
   * later success could clear.
   */
  correlatorPendingExchangeDropped(member: string, dropped: number): void;
  rawstoreBlobGunzipFailed(hash: string): void;
  rawstoreBlobHashMismatch(hash: string): void;
  genaistoreUnserializableRecordSkipped(member: string): void;
  genaistoreMalformedRowSkipped(rowId: number): void;
  telemetrystoreUnserializableRecordSkipped(member: string): void;
  telemetrystoreMalformedRowSkipped(rowId: number): void;
  otlpLogsStoreFailed(member: string, records: number): void;
  otlpGenaiIngestFailed(member: string, records: number): void;
  otlpMetricsStoreFailed(member: string, records: number): void;
  codexGenaiIngestEntryFailed(member: string): void;
  activityAppendFailed(member: string, events: number): void;
  toolinvokeAuditAppendFailed(member: string): void;
  enrollmentSourceLabelTruncated(field: string, dropped: number): void;
  // ── Observed recoveries ────────────────────────────────────────
  //
  // One method per INCIDENT cause, named for the success that actually
  // heals it. A generic `recovered(cause, member)` let a call site pick
  // which incident its success cleared, which is the same convention
  // this interface exists to replace — a site that succeeded at writing
  // activity should not be able to clear a correlator incident.
  //
  // Point causes have no method here and cannot be cleared: they never
  // create unresolved state, so "recovering" one is meaningless.
  correlatorBodyRefRead(member: string): void;
  correlatorRawCaptureSucceeded(member: string): void;
  otlpLogsStored(member: string): void;
  otlpGenaiIngested(member: string): void;
  otlpMetricsStored(member: string): void;
  codexGenaiIngestEntrySucceeded(member: string): void;
  activityAppended(member: string): void;
  toolinvokeAuditAppended(member: string): void;
}

export interface DiagnosticStore {
  /**
   * The 21 typed methods. This is the path every production call site
   * uses: they hand over raw inputs and this layer decides what is
   * retainable.
   */
  readonly emit: DiagnosticEmitter;
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
  maxStateRows?: number;
}

const DEFAULT_DETAIL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days of per-event detail
const DEFAULT_HOUR_MS = 30 * 24 * 60 * 60 * 1000; // 30 days at hour resolution
const DEFAULT_DAY_MS = 400 * 24 * 60 * 60 * 1000; // ~13 months at day resolution
const DEFAULT_MAX_DETAIL_ROWS = 50_000;
const DEFAULT_MAX_BUCKET_ROWS = 200_000;
const DEFAULT_MAX_STATE_ROWS = 20_000;
/** Cap on affected-member fanout for a single diagnostic. */
const MAX_FANOUT = 256;

const HOUR = 3_600_000;
const DAY = 86_400_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS diagnostic_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cause TEXT NOT NULL,
    member_name TEXT NOT NULL,
    attribution TEXT NOT NULL,
    ts INTEGER NOT NULL,
    fields TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS diagnostic_event_ts ON diagnostic_event (ts);
  CREATE INDEX IF NOT EXISTS diagnostic_event_member ON diagnostic_event (member_name, ts);

  CREATE TABLE IF NOT EXISTS diagnostic_bucket (
    cause TEXT NOT NULL,
    member_name TEXT NOT NULL,
    bucket_start INTEGER NOT NULL,
    bucket_end INTEGER NOT NULL,
    resolution TEXT NOT NULL,
    n INTEGER NOT NULL,
    first_ts INTEGER NOT NULL,
    last_ts INTEGER NOT NULL,
    PRIMARY KEY (cause, member_name, bucket_start, resolution)
  );
  CREATE INDEX IF NOT EXISTS diagnostic_bucket_start ON diagnostic_bucket (bucket_start);

  CREATE TABLE IF NOT EXISTS diagnostic_state (
    cause TEXT NOT NULL,
    member_name TEXT NOT NULL,
    since INTEGER NOT NULL,
    PRIMARY KEY (cause, member_name)
  );

  CREATE TABLE IF NOT EXISTS diagnostic_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/**
 * Internal factory exposing the raw insert for the store's OWN
 * mechanics tests — caps, floors, folding, coverage — which need states
 * the emitter has no reason to produce.
 *
 * Not exported from the package surface and not reachable from
 * production: `createDiagnosticStore` returns the narrow interface.
 */
export function createDiagnosticStoreInternalForTests(
  db: SqlDriver,
  options: DiagnosticOptions = {},
): DiagnosticStore & {
  record(input: DiagnosticInput): void;
  resolve(cause: DiagnosticCause, member: string | null): void;
} {
  return buildStore(db, options);
}

export function createDiagnosticStore(
  db: SqlDriver,
  options: DiagnosticOptions = {},
): DiagnosticStore {
  return buildStore(db, options);
}

function buildStore(
  db: SqlDriver,
  options: DiagnosticOptions = {},
): DiagnosticStore & {
  record(input: DiagnosticInput): void;
  resolve(cause: DiagnosticCause, member: string | null): void;
} {
  db.exec(SCHEMA);

  // Unresolved state whose cause this build no longer emits can never
  // be cleared — its clearing emit is gone with the mechanism — so it
  // would latch in every health view forever. Sweep it at open.
  // Historical `diagnostic_event`/`diagnostic_bucket` rows keep their
  // retired causes: they are the record of what happened, and reads
  // treat cause as data, not as a member of the live enum.
  {
    const placeholders = DIAGNOSTIC_CAUSES.map(() => '?').join(',');
    db.prepare(`DELETE FROM diagnostic_state WHERE cause NOT IN (${placeholders})`).run(
      ...DIAGNOSTIC_CAUSES,
    );
  }

  const now = options.now ?? (() => Date.now());
  const detailMs = options.detailMs ?? DEFAULT_DETAIL_MS;
  const hourMs = options.hourMs ?? DEFAULT_HOUR_MS;
  const dayMs = options.dayMs ?? DEFAULT_DAY_MS;
  const maxDetailRows = options.maxDetailRows ?? DEFAULT_MAX_DETAIL_ROWS;
  const maxBucketRows = options.maxBucketRows ?? DEFAULT_MAX_BUCKET_ROWS;
  const maxStateRows = options.maxStateRows ?? DEFAULT_MAX_STATE_ROWS;

  const insertEvent: SqlStatement = db.prepare(
    `INSERT INTO diagnostic_event (cause, member_name, attribution, ts, fields)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const upsertState: SqlStatement = db.prepare(
    `INSERT INTO diagnostic_state (cause, member_name, since) VALUES (?, ?, ?)
     ON CONFLICT (cause, member_name) DO NOTHING`,
  );
  const clearState: SqlStatement = db.prepare(
    `DELETE FROM diagnostic_state WHERE cause = ? AND member_name = ?`,
  );
  const getMeta: SqlStatement = db.prepare(`SELECT value FROM diagnostic_meta WHERE key = ?`);
  const setMeta: SqlStatement = db.prepare(
    `INSERT INTO diagnostic_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  );

  /** Fold a set of rows into a bucket row, accumulating deterministically. */
  const foldBucket: SqlStatement = db.prepare(
    `INSERT INTO diagnostic_bucket (cause, member_name, bucket_start, bucket_end, resolution, n, first_ts, last_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (cause, member_name, bucket_start, resolution) DO UPDATE SET
       n = n + excluded.n,
       first_ts = MIN(first_ts, excluded.first_ts),
       last_ts = MAX(last_ts, excluded.last_ts)`,
  );

  function metaNum(key: string, fallback: number): number {
    const row = getMeta.get(key) as { value: string } | undefined;
    return row === undefined ? fallback : Number(row.value);
  }
  /**
   * The floor is the FIRST FULLY COVERED INSTANT, so it must be the
   * EXCLUSIVE end of everything destroyed — not the last timestamp
   * removed. With the inclusive form, a query starting exactly at a
   * removed event's timestamp passed the `from < floor` guard and
   * answered confidently from whatever survived.
   */
  function raiseFloor(firstCoveredInstant: number): void {
    if (firstCoveredInstant > metaNum('coverage_floor', 0)) {
      setMeta.run('coverage_floor', String(firstCoveredInstant));
    }
  }

  /** Fanout loss is a queryable fact, folded like overflow. */
  function recordFanoutTruncated(n: number): void {
    const ts = now();
    const start = Math.floor(ts / HOUR) * HOUR;
    foldBucket.run(
      'retention.fanout_truncated',
      UNATTRIBUTED,
      start,
      start + HOUR,
      'hour',
      n,
      ts,
      ts,
    );
    setMeta.run('fanout_truncated_last', String(ts));
  }

  /**
   * Overflow is recorded as a QUERYABLE EVENT, not only a meta counter.
   * "Record an overflow fact" is not met by a number no query surface
   * returns — the caller asking what happened to a window must be able
   * to see that evidence was shed.
   */
  function recordOverflow(): void {
    const ts = now();
    setMeta.run('overflow_count', String(metaNum('overflow_count', 0) + 1));
    setMeta.run('overflow_last', String(ts));
    // Folded STRAIGHT TO A BUCKET, not written as a detail event.
    //
    // Written as an event it was subject to the same detail cap that
    // produced it — the overflow fact was evicted by the mechanism it
    // exists to report, and the query for it came back empty. Found
    // while testing the repair for the missing-overflow defect, which
    // is the same defect one layer in.
    //
    // At hour resolution this is also bounded by construction: sustained
    // overflow is one row per hour, not one row per eviction.
    const start = Math.floor(ts / HOUR) * HOUR;
    foldBucket.run('retention.overflow', UNATTRIBUTED, start, start + HOUR, 'hour', 1, ts, ts);
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
    // Each cap is delete + floor + overflow-fact as ONE transaction. A
    // crash between the delete and the floor raise destroys evidence
    // while leaving coverage confident, which is the precise failure
    // the floor exists to prevent.
    const detail = db.prepare(`SELECT COUNT(*) AS n FROM diagnostic_event`).get() as { n: number };
    if (Number(detail.n) > maxDetailRows) {
      const over = Number(detail.n) - maxDetailRows;
      const cut = db
        .prepare(`SELECT MAX(ts) AS t FROM (SELECT ts FROM diagnostic_event ORDER BY ts LIMIT ?)`)
        .get(over) as { t: number | null };
      runInTransaction(db, () => {
        db.prepare(
          `DELETE FROM diagnostic_event WHERE id IN
           (SELECT id FROM diagnostic_event ORDER BY ts LIMIT ?)`,
        ).run(over);
        // +1: the removed instant itself is NOT covered.
        if (cut.t !== null) raiseFloor(Number(cut.t) + 1);
        recordOverflow();
      });
    }

    const bucket = db.prepare(`SELECT COUNT(*) AS n FROM diagnostic_bucket`).get() as { n: number };
    if (Number(bucket.n) > maxBucketRows) {
      // Reserve a row for the overflow fact this enforcement is about
      // to record. Deleting exactly to the cap and THEN inserting left
      // the table at max + 1 — a bound that breaks itself by reporting
      // that it was reached.
      const over = Number(bucket.n) - maxBucketRows + 1;
      // The floor comes from the removed rows' own EXCLUSIVE ends, so a
      // day bucket raises it by a day and an hour bucket by an hour.
      // Adding a fixed HOUR left day-bucket evidence destroyed below a
      // floor that claimed to cover it.
      const cut = db
        .prepare(
          `SELECT MAX(bucket_end) AS t FROM
             (SELECT bucket_end FROM diagnostic_bucket ORDER BY bucket_start LIMIT ?)`,
        )
        .get(over) as { t: number | null };
      runInTransaction(db, () => {
        db.prepare(
          `DELETE FROM diagnostic_bucket WHERE rowid IN
           (SELECT rowid FROM diagnostic_bucket ORDER BY bucket_start LIMIT ?)`,
        ).run(over);
        if (cut.t !== null) raiseFloor(Number(cut.t));
        recordOverflow();
      });
    }

    // Unresolved state was the remaining unbounded axis: events and
    // buckets were capped, `(cause, member)` was not, and member
    // cardinality is exactly what criterion 5 named. Evicting the
    // OLDEST unresolved rows loses the least recent evidence, and the
    // overflow fact says it happened.
    const st = db.prepare(`SELECT COUNT(*) AS n FROM diagnostic_state`).get() as { n: number };
    if (Number(st.n) > maxStateRows) {
      const over = Number(st.n) - maxStateRows;
      runInTransaction(db, () => {
        db.prepare(
          `DELETE FROM diagnostic_state WHERE rowid IN
           (SELECT rowid FROM diagnostic_state ORDER BY since LIMIT ?)`,
        ).run(over);
        recordOverflow();
        // PERSISTENT, not ageing. Evicting unresolved state destroys
        // current health that cannot be reconstructed — the member
        // simply reads clean afterwards. So retention health latches to
        // `unknown` and stays there; a time-based recovery here would
        // be the cap that exists to prevent reading clean, reading
        // clean.
        setMeta.run('state_evicted', '1');
      });
    }
  }

  /** Private. The public surface is `emit`. */
  function record(input: DiagnosticInput): void {
    const ts = now();
    const spec = CAUSE_SPEC[input.cause];
    const fields = JSON.stringify(sanitize(input.fields ?? ({} as SafeFields), spec.fields));
    // Bounded, deduped fanout: a corrupt blob referenced by a very
    // large number of members must not turn one diagnostic into an
    // unbounded insert burst.
    const all = [...new Set(input.members ?? [])];
    // REFUSE the per-member attribution wholesale when it exceeds the
    // bound. Keeping the first 256 is selection masquerading as
    // completeness: no later query can know whether its member was
    // 257, and the retained prefix reads as the complete affected
    // set. One unattributed row plus a queryable loss fact is honest;
    // a truncated list is not.
    const overFanout = all.length > MAX_FANOUT;
    const named = overFanout ? [] : all;
    const truncated = overFanout ? all.length : 0;
    const members = named.length > 0 ? named : [UNATTRIBUTED];
    // Attribution comes from the CAUSE, never the caller — a caller
    // cannot pair `members: []` with `producer`, and cannot decide a
    // blob corruption belongs to whoever happened to read it.
    const attribution: Attribution = named.length === 0 ? 'unattributed' : spec.attribution;
    const mode = spec.mode;

    // ATOMIC. A throw between the event insert and the state upsert
    // would leave an event with no unresolved state, or the reverse.
    runInTransaction(db, () => {
      for (const m of members) {
        insertEvent.run(input.cause, m, attribution, ts, fields);
        // Only incidents create unresolved state. A point event is
        // history the instant it happens.
        if (mode === 'incident') upsertState.run(input.cause, m, ts);
      }
    });
    // Truncation is LOSS and must say so. `slice()` alone dropped
    // members 257..N with no fact and no unknown attribution, so the
    // stored set looked like the complete affected set.
    if (truncated > 0) recordFanoutTruncated(truncated);
    enforceCaps();
  }

  /**
   * Affected members for a corrupt blob, resolved from `raw_exchange`.
   *
   * `getBlob(hash)` has no member and a content-addressed blob may be
   * referenced by several. Taking the caller's member would attribute
   * the corruption to whoever happened to read it, which is false
   * attribution inside the store built to prevent false absence.
   */
  function membersForHash(hash: string): string[] {
    try {
      const rows = db
        .prepare(`SELECT DISTINCT member_name FROM raw_exchange WHERE hash = ?`)
        .all(hash) as Array<{ member_name: string }>;
      return rows.map((r) => r.member_name);
    } catch {
      // No raw_exchange table (a store wired without capture): the
      // affected set is genuinely unknown, so record it unattributed
      // rather than guessing or dropping the diagnostic.
      return [];
    }
  }

  /**
   * Set when a retention write throws.
   *
   * IN MEMORY, deliberately. The store shares a database handle with
   * the operations it observes, so a full, busy or corrupt handle can
   * fail both — and recording "retention is broken" through the broken
   * store is the recursion this objective exists to close. `health()`
   * consults this BEFORE touching SQLite.
   */
  let writeFailed = false;

  const rawEmit: DiagnosticEmitter = {
    correlatorBodyRefUnreadable(member, pathFields, err) {
      record({
        cause: 'correlator.body_ref_unreadable',
        members: [member],
        fields: safeFields(pathFields, safeError(err)),
      });
    },
    correlatorBodyLengthMismatch(member, expected, actual) {
      record({
        cause: 'correlator.body_length_mismatch',
        members: [member],
        fields: safeCount(Math.abs(expected - actual)),
      });
    },
    correlatorUnlinkAfterCaptureFailed(member, pathFields, err) {
      record({
        cause: 'correlator.unlink_after_capture_failed',
        members: [member],
        fields: safeFields(pathFields, safeError(err)),
      });
    },
    correlatorRawCaptureFailed(member, err) {
      record({
        cause: 'correlator.raw_capture_failed',
        members: [member],
        fields: safeError(err),
      });
    },
    correlatorBodyJsonParseFailed(member, bytes) {
      record({
        cause: 'correlator.body_json_parse_failed',
        members: [member],
        fields: safeCount(bytes),
      });
    },
    correlatorInferenceBuildFailed(member, err) {
      record({
        cause: 'correlator.inference_build_failed',
        members: [member],
        fields: safeError(err),
      });
    },
    correlatorRequestIdAssignFailed(member, err) {
      record({
        cause: 'correlator.request_id_assign_failed',
        members: [member],
        fields: safeError(err),
      });
    },
    correlatorMalformedRecordSkipped(member) {
      record({ cause: 'correlator.malformed_record_skipped', members: [member] });
    },
    correlatorPendingExchangeDropped(member, dropped) {
      record({
        cause: 'correlator.pending_exchange_dropped',
        members: [member],
        fields: safeCount(dropped),
      });
    },
    rawstoreBlobGunzipFailed(hash) {
      record({
        cause: 'rawstore.blob_gunzip_failed',
        members: membersForHash(hash),
        fields: safeHash(hash),
      });
    },
    rawstoreBlobHashMismatch(hash) {
      record({
        cause: 'rawstore.blob_hash_mismatch',
        members: membersForHash(hash),
        fields: safeHash(hash),
      });
    },
    genaistoreUnserializableRecordSkipped(member) {
      record({ cause: 'genaistore.unserializable_record_skipped', members: [member] });
    },
    genaistoreMalformedRowSkipped(_rowId) {
      // A stored row that cannot be read back. The row's member is not
      // available at the failure site, so this is unattributed rather
      // than guessed.
      record({ cause: 'genaistore.malformed_row_skipped' });
    },
    telemetrystoreUnserializableRecordSkipped(member) {
      record({ cause: 'telemetrystore.unserializable_record_skipped', members: [member] });
    },
    telemetrystoreMalformedRowSkipped(_rowId) {
      record({ cause: 'telemetrystore.malformed_row_skipped' });
    },
    otlpLogsStoreFailed(member, records) {
      record({ cause: 'otlp.logs_store_failed', members: [member], fields: safeCount(records) });
    },
    otlpGenaiIngestFailed(member, records) {
      record({ cause: 'otlp.genai_ingest_failed', members: [member], fields: safeCount(records) });
    },
    otlpMetricsStoreFailed(member, records) {
      record({ cause: 'otlp.metrics_store_failed', members: [member], fields: safeCount(records) });
    },
    codexGenaiIngestEntryFailed(member) {
      record({ cause: 'codex.genai_ingest_entry_failed', members: [member] });
    },
    activityAppendFailed(member, events) {
      record({ cause: 'activity.append_failed', members: [member], fields: safeCount(events) });
    },
    toolinvokeAuditAppendFailed(member) {
      record({ cause: 'toolinvoke.audit_append_failed', members: [member] });
    },
    enrollmentSourceLabelTruncated(_field, dropped) {
      // An enrollment is not yet a member, so there is nobody to
      // attribute this to.
      record({ cause: 'enrollment.source_label_truncated', fields: safeCount(dropped) });
    },
    correlatorBodyRefRead(member) {
      clearState.run('correlator.body_ref_unreadable', member);
    },
    correlatorRawCaptureSucceeded(member) {
      clearState.run('correlator.raw_capture_failed', member);
    },
    otlpLogsStored(member) {
      clearState.run('otlp.logs_store_failed', member);
    },
    otlpGenaiIngested(member) {
      clearState.run('otlp.genai_ingest_failed', member);
    },
    otlpMetricsStored(member) {
      clearState.run('otlp.metrics_store_failed', member);
    },
    codexGenaiIngestEntrySucceeded(member) {
      clearState.run('codex.genai_ingest_entry_failed', member);
    },
    activityAppended(member) {
      clearState.run('activity.append_failed', member);
    },
    toolinvokeAuditAppended(member) {
      clearState.run('toolinvoke.audit_append_failed', member);
    },
  };

  /**
   * Production adapter: retention MUST NOT replace the failure it is
   * observing.
   *
   * Every site calls diagnostics beside an existing stderr warning. An
   * emitter that throws propagates out of the catch block it was added
   * to, skips the logger, and changes what the original operation does
   * — so adding retention would have made the product worse at exactly
   * the moments it matters. Measured: a throwing emitter escaped
   * `getBlob` and the warning never fired.
   *
   * IF YOU ARE HERE TO REMOVE THIS EMPTY CATCH, READ THIS FIRST.
   * A general rule says never swallow an exception, and applying it
   * here restores a defect while cleaning up a smell. The alternative
   * to swallowing is a diagnostic subsystem holding authority to break
   * capture — and because this store shares the activity DB handle
   * with the streams it reports on, a full or corrupt handle fails the
   * original operation and the diagnostic insert TOGETHER. That is
   * precisely the moment the product's prior behaviour must survive.
   *
   * The failure is not discarded: it latches below and surfaces as
   * retention health `unknown`. What is discarded is the exception's
   * ability to propagate into an unrelated caller.
   */
  const emit: DiagnosticEmitter = Object.fromEntries(
    Object.entries(rawEmit).map(([name, fn]) => [
      name,
      (...args: unknown[]) => {
        try {
          (fn as (...a: unknown[]) => void)(...args);
          // The latch is PROCESS-LOCAL, so a restart would heal it
          // silently — "expiry heals" at a process boundary, which is
          // the defect this store exists to prevent. So the first
          // write that succeeds after a failure durably records that
          // the store was unavailable, and the latch clears ONLY if
          // that record itself lands.
          if (writeFailed) {
            try {
              const ts = now();
              const start = Math.floor(ts / HOUR) * HOUR;
              foldBucket.run(
                'retention.unavailable',
                UNATTRIBUTED,
                start,
                start + HOUR,
                'hour',
                1,
                ts,
                ts,
              );
              writeFailed = false;
            } catch {
              // Still broken. Stay `unknown`.
            }
          }
        } catch {
          writeFailed = true;
        }
      },
    ]),
  ) as unknown as DiagnosticEmitter;

  return {
    emit,
    record,

    resolve(cause: DiagnosticCause, member: string | null): void {
      clearState.run(cause, member ?? UNATTRIBUTED);
    },

    unresolved(member: string | null) {
      return (
        db
          .prepare(`SELECT cause, since FROM diagnostic_state WHERE member_name = ? ORDER BY since`)
          .all(member ?? UNATTRIBUTED) as Array<{ cause: DiagnosticCause; since: number }>
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
        // `null` here means "the unattributed bucket", which is stored
        // under the sentinel rather than SQL NULL — see UNATTRIBUTED.
        memberClause = ' AND member_name = ?';
        params.push(opts.member ?? UNATTRIBUTED);
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

      // TRUE interval overlap. The previous form was
      // `bucket_start >= from - DAY`, which admitted every bucket in the
      // preceding 24 hours — so a narrow Wednesday query could count
      // Tuesday's evidence. `bucket_end` is stored per row, so mixed
      // hour and day buckets each contribute their own width and the
      // union end is correct rather than derived from one resolution.
      const bucketParams: Array<string | number | null> = [to, from, ...params.slice(2)];
      const bk = db
        .prepare(
          `SELECT COALESCE(SUM(n),0) AS n, MIN(first_ts) AS first_ts, MAX(last_ts) AS last_ts,
                  MIN(bucket_start) AS lo, MAX(bucket_end) AS hi, MIN(resolution) AS res
             FROM diagnostic_bucket
            WHERE bucket_start <= ? AND bucket_end > ?${memberClause}${causeClause}`,
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

      // A MEMBER-FILTERED window crossing a fanout refusal is not exact,
      // REGARDLESS of what else it contains.
      //
      // This was previously gated on `evN + bkN === 0`, so a single
      // unrelated row for the member restored `exact` — asserting the
      // window was complete while a refused affected set from the same
      // window might also have contained them. Retained rows are
      // partial evidence and are still returned; they cannot restore
      // exactness, because the refused set is exactly the thing nobody
      // can consult.
      //
      // Unfiltered queries are unaffected: the global loss fact is exact.
      let refusalCrosses = false;
      if (opts.member !== undefined) {
        const refused = db
          .prepare(
            `SELECT COALESCE(SUM(n),0) AS n FROM diagnostic_bucket
              WHERE cause = 'retention.fanout_truncated'
                AND bucket_start <= ? AND bucket_end > ?`,
          )
          .get(to, from) as { n: number };
        refusalCrosses = Number(refused.n) > 0;
      }

      if (bkN === 0) {
        return {
          interval: { from, to },
          resolution: evN > 0 ? 'event' : 'none',
          count: evN,
          first: ev.first_ts === null ? null : Number(ev.first_ts),
          last: ev.last_ts === null ? null : Number(ev.last_ts),
          coverage: refusalCrosses ? 'indeterminate' : 'exact',
        };
      }

      // Bucketed evidence answers at ITS resolution, not the request's.
      // A window narrower than a bucket gets the bucket's interval back
      // and a `bucket` coverage flag — never a boolean-looking answer
      // the data cannot support.
      const lo = bk.lo === null ? from : Number(bk.lo);
      const hi = bk.hi === null ? to : Number(bk.hi);
      const firsts = [ev.first_ts, bk.first_ts].filter((x) => x !== null).map(Number);
      const lasts = [ev.last_ts, bk.last_ts].filter((x) => x !== null).map(Number);
      return {
        interval: { from: Math.min(from, lo), to: Math.max(to, hi) },
        resolution: bk.res === 'day' ? 'day' : 'hour',
        count: evN + bkN,
        first: firsts.length > 0 ? Math.min(...firsts) : null,
        last: lasts.length > 0 ? Math.max(...lasts) : null,
        coverage: refusalCrosses ? 'indeterminate' : 'bucket',
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

      // ATOMIC per stage. Successful-repeat idempotence is not
      // crash idempotence: an earlier version upserted buckets row by
      // row and deleted the sources afterwards outside a transaction,
      // so a throw between the two made the NEXT sweep fold the same
      // rows again and double the count. Running a successful sweep
      // three times cannot establish this property; only wrapping it
      // can.
      runInTransaction(db, () => {
        const detailCut = t - detailMs;
        const rows = db
          .prepare(
            `SELECT cause, member_name, ts FROM diagnostic_event
          WHERE ts < ?`,
          )
          .all(detailCut) as Array<{ cause: string; member_name: string | null; ts: number }>;
        for (const r of rows) {
          const start = Math.floor(Number(r.ts) / HOUR) * HOUR;
          foldBucket.run(
            r.cause,
            r.member_name,
            start,
            start + HOUR,
            'hour',
            1,
            Number(r.ts),
            Number(r.ts),
          );
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
            start + DAY,
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
          // The floor is the exclusive END of the newest bucket removed,
          // not `dayCut` — an aligned day bucket straddling the cut
          // extends past it, and using the cut left destroyed evidence
          // below a floor that claimed to cover it.
          const removedEnd = db
            .prepare(
              `SELECT MAX(bucket_end) AS t FROM diagnostic_bucket
            WHERE resolution = 'day' AND bucket_start < ?`,
            )
            .get(dayCut) as { t: number | null };
          db.prepare(
            `DELETE FROM diagnostic_bucket WHERE resolution = 'day' AND bucket_start < ?`,
          ).run(dayCut);
          raiseFloor(removedEnd.t === null ? dayCut : Number(removedEnd.t));
        }
      });
      enforceCaps();
    },

    health(): RetentionHealth {
      // `unknown` must be reachable or the recursion criterion fails on
      // its own terms: a store that cannot say "I don't know" is the
      // thing that criterion exists to prevent. It is reported when the
      // store cannot read its own state — which deliberately does NOT
      // depend on this same store having recorded the failure.
      // The latch first: if a write threw, the store cannot be trusted
      // to describe itself, and asking it would be the recursion.
      if (writeFailed) return 'unknown';
      let last: number;
      try {
        last = metaNum('overflow_last', 0);
      } catch {
        return 'unknown';
      }
      if (metaNum('state_evicted', 0) === 1) return 'unknown';
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
