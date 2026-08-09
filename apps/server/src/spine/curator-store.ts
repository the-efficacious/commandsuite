/**
 * The curator's bookkeeping — leases, receipts, the injection ledger,
 * and the policy rows that make attention allocation data.
 *
 * This module holds NO policy. It stores lease rows and reports their
 * state against a clock it is given; it does not decide what a lease
 * buys, who hears what, or when a nudge is due. That split is the
 * point: policy will keep being tuned long after these five tables
 * have frozen, and every tuning argument should be an argument about
 * `curator.ts` (or, better, about a row) rather than about storage.
 *
 * Every method that needs a clock TAKES one. There is no `Date.now()`
 * in this file. A lease store that reads the wall clock cannot be
 * tested for the property that matters — that the same sequence of
 * acts produces the same end state whether four hours pass in four
 * hours or in four microseconds.
 */

import type {
  ListSpineInjectionsQuery,
  SpineCuratorPolicy,
  SpineInjection,
  SpineInjectionKind,
  SpineSubscription,
  SpineSubscriptionLevel,
} from 'csuite-sdk/types';
import type { DatabaseSyncInstance } from '../db.js';
import {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_NUDGE_MIN_INTERVAL_MS,
  SPINE_CURATOR_SCHEMA,
} from './curator-schema.js';

/** Why a lease was granted or renewed. `act` is the write path proving liveness. */
export type LeaseSource = 'orient' | 'class0' | 'class1' | 'class2' | 'act';

/**
 * A lease's state, derived — never stored.
 *
 *   live         the member is assumed to still hold this
 *   expired      the clock ran out
 *   invalidated  a floor signal said the context is gone
 *
 * `expired` and `invalidated` buy exactly the same thing (one cheap
 * nudge), and that is not an oversight to be tidied away later: it is
 * the floor rule in one line. A declared dump signal moves a lease
 * from `live` to `invalidated` sooner than the clock would have moved
 * it to `expired`, and changes nothing else about what happens next.
 */
export type LeaseState = 'live' | 'expired' | 'invalidated';

export interface LeaseRecord {
  member: string;
  ref: string;
  seq: number;
  grantedAt: number;
  source: LeaseSource;
  invalidatedAt: number | null;
  invalidatedBy: string | null;
  nudgedAt: number | null;
  /** Whether that nudge landed. `null` when none has been spent this epoch. */
  nudgeDelivered: boolean | null;
}

export interface ReceiptRecord {
  member: string;
  seq: number;
  at: number;
  via: ReceiptVia;
}

/**
 * What can move a receipt, and it is a WATERMARK — "everything up to
 * seq N has been read" — so only a read that establishes that claim
 * may move it.
 *
 *   orient      composed at a cursor, and carries everything below it
 *   annex_read  a page, through its LAST RETURNED seq (never headSeq:
 *               a short page proves only as far as it got)
 *   ack         an explicit "handled", the human seat's act
 *
 * There is deliberately no `push` — the type is where "the curator's
 * own pushes never advance a receipt" is enforced, because a rule that
 * lives only in a comment is a rule the next caller will not know
 * about.
 *
 * And there is deliberately no `event_read`. A by-id read of one event
 * proves that one event was seen and NOTHING about the events below
 * it, so moving a watermark to its seq silently discharges every
 * unread event underneath. That is not hypothetical: the by-id read is
 * the natural response to a class-1 line, which hands the member an
 * event id — so the path most likely to be taken was the one that
 * marked a member caught up on things they had never seen.
 */
export type ReceiptVia = 'orient' | 'annex_read' | 'ack';

export interface LogInjectionInput {
  member: string;
  class: 0 | 1 | 2;
  kind: SpineInjectionKind;
  refs: readonly string[];
  cursor: number;
  bytes: number;
  delivered: boolean;
  at: number;
}

export interface CuratorStore {
  /**
   * Record that `member` holds `refs` as of `seq`. Idempotent per ref:
   * a second grant renews the existing row rather than adding one, and
   * renewal starts a new generation (the spent nudge is forgotten,
   * any invalidation is cleared).
   */
  grantLeases(
    member: string,
    refs: readonly string[],
    seq: number,
    source: LeaseSource,
    now: number,
  ): void;
  leases(member?: string): LeaseRecord[];
  leaseState(lease: LeaseRecord, ttlMs: number, now: number): LeaseState;
  /** Returns how many LIVE leases were invalidated — zero is an answer, not a failure. */
  invalidateLeases(member: string, by: string, now: number, ttlMs: number): number;
  /**
   * Spend this generation's nudge, recording whether it LANDED.
   *
   * Also stamps the per-member cadence floor, which lives outside the
   * lease rows precisely so a re-arm cannot erase it. The attempt is
   * what counts against cadence — a nudge into a dead sink still costs
   * the sweep — while only the delivery decides whether the epoch is
   * genuinely spent.
   */
  markNudged(member: string, refs: readonly string[], now: number, delivered: boolean): void;
  /** The most recent nudge to this member across every lease, for the cadence floor. */
  lastNudgeAt(member: string): number | null;
  /**
   * Re-arm the nudges this member never actually received.
   *
   * Called when their LIVENESS is proven: they read, they wrote, or
   * their runner bracketed a session. It exists for one case and is
   * scoped to exactly that case — a nudge attempted while the member
   * was offline was spent on nobody, and without a re-arm the member
   * who could not be reached is precisely the member who is never
   * reached again. Permanent dark for the opaque-runner population
   * this whole design is for.
   *
   * UNDELIVERED ONLY, and the narrowing is not a refinement — the
   * broad version was a regression that rebuilt the dead
   * objective-context watchdog. Re-arming DELIVERED nudges too meant
   * every proof of liveness re-opened a nudge the member had already
   * been given, so a member working steadily was nudged again on every
   * sweep tick past a lease's TTL: six writes over six hours produced
   * six nudges. A delivered nudge is spent for its epoch, and only a
   * lease re-grant — a genuine new epoch — resets it.
   *
   * It does not touch the cadence floor. That is why the floor is in
   * another table.
   */
  rearmNudges(member: string): void;

  /** Monotonic. A read that proves less than the last one moves nothing. */
  advanceReceipt(member: string, seq: number, via: ReceiptVia, now: number): ReceiptRecord;
  receipt(member: string): ReceiptRecord | null;

  logInjection(input: LogInjectionInput): SpineInjection;
  injections(query: ListSpineInjectionsQuery & { member: string }): SpineInjection[];

  /** The authored row, or `null` when the member has never chosen for this contract. */
  subscription(member: string, contract: string): SpineSubscription | null;
  /** Every authored row for a contract — the candidate set class 2 works from. */
  subscriptionsForContract(contract: string): SpineSubscription[];
  subscriptionsOfMember(member: string): SpineSubscription[];
  setSubscription(
    member: string,
    contract: string,
    level: SpineSubscriptionLevel,
    updatedBy: string,
    now: number,
  ): SpineSubscription;

  /** Always answers. A member with no row runs the team defaults, and says so. */
  policy(member: string): SpineCuratorPolicy;
  setPolicy(
    member: string,
    patch: { leaseTtlMs?: number; nudgeMinIntervalMs?: number },
    updatedBy: string,
    now: number,
  ): SpineCuratorPolicy;
}

interface LeaseRow {
  member: string;
  ref: string;
  seq: number;
  granted_at: number;
  source: string;
  invalidated_at: number | null;
  invalidated_by: string | null;
  nudged_at: number | null;
  nudge_delivered: number | null;
}

interface ReceiptRow {
  member: string;
  seq: number;
  at: number;
  via: string;
}

interface InjectionRow {
  id: number;
  member: string;
  class: number;
  kind: string;
  refs: string;
  cursor: number;
  at: number;
  bytes: number;
  delivered: number;
}

interface SubscriptionRow {
  member: string;
  contract_id: string;
  level: string;
  updated_by: string;
  updated_at: number;
}

interface PolicyRow {
  member: string;
  lease_ttl_ms: number;
  nudge_min_interval_ms: number;
  updated_by: string;
  updated_at: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

class SqliteCuratorStore implements CuratorStore {
  private readonly db: DatabaseSyncInstance;

  constructor(db: DatabaseSyncInstance) {
    this.db = db;
    db.exec(SPINE_CURATOR_SCHEMA);
  }

  // ─── Leases ─────────────────────────────────────────────────────

  grantLeases(
    member: string,
    refs: readonly string[],
    seq: number,
    source: LeaseSource,
    now: number,
  ): void {
    if (refs.length === 0) return;
    // ON CONFLICT rather than delete-then-insert: the row IS the
    // standing claim, and a window in which it does not exist is a
    // window in which a concurrent sweep sees a member holding
    // nothing and nudges them about what they were just handed.
    const stmt = this.db.prepare(
      `INSERT INTO spine_leases
         (member, ref, seq, granted_at, source, invalidated_at, invalidated_by, nudged_at, nudge_delivered)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
       ON CONFLICT(member, ref) DO UPDATE SET
         seq = excluded.seq,
         granted_at = excluded.granted_at,
         source = excluded.source,
         invalidated_at = NULL,
         invalidated_by = NULL,
         nudged_at = NULL,
         nudge_delivered = NULL`,
    );
    for (const ref of new Set(refs)) stmt.run(member, ref, seq, now, source);
  }

  leases(member?: string): LeaseRecord[] {
    const rows = (member === undefined
      ? this.db.prepare('SELECT * FROM spine_leases ORDER BY member ASC, ref ASC').all()
      : this.db
          .prepare('SELECT * FROM spine_leases WHERE member = ? ORDER BY ref ASC')
          .all(member)) as unknown as LeaseRow[];
    return rows.map(rowToLease);
  }

  leaseState(lease: LeaseRecord, ttlMs: number, now: number): LeaseState {
    if (lease.invalidatedAt !== null) return 'invalidated';
    return now - lease.grantedAt >= ttlMs ? 'expired' : 'live';
  }

  invalidateLeases(member: string, by: string, now: number, ttlMs: number): number {
    // Counted BEFORE the write, and counted as LIVE leases only.
    // Reporting the row count of the UPDATE would report leases that
    // had already run out on their own clock, which would make a
    // signal look like it did work the clock had already done — the
    // exact inflation that would make "signals only buy latency"
    // unfalsifiable from the outside.
    const live = this.leases(member).filter(
      (lease) => this.leaseState(lease, ttlMs, now) === 'live',
    );
    this.db
      .prepare(
        `UPDATE spine_leases SET invalidated_at = ?, invalidated_by = ?
         WHERE member = ? AND invalidated_at IS NULL`,
      )
      .run(now, by, member);
    return live.length;
  }

  markNudged(member: string, refs: readonly string[], now: number, delivered: boolean): void {
    const stmt = this.db.prepare(
      'UPDATE spine_leases SET nudged_at = ?, nudge_delivered = ? WHERE member = ? AND ref = ?',
    );
    for (const ref of new Set(refs)) stmt.run(now, delivered ? 1 : 0, member, ref);
    // The cadence floor, stamped on the ATTEMPT and in its own table —
    // out of reach of `rearmNudges`, which is the whole point.
    this.db
      .prepare(
        `INSERT INTO spine_nudge_cadence (member, last_attempt_at) VALUES (?, ?)
         ON CONFLICT(member) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`,
      )
      .run(member, now);
  }

  lastNudgeAt(member: string): number | null {
    const row = this.db
      .prepare('SELECT last_attempt_at AS last FROM spine_nudge_cadence WHERE member = ?')
      .get(member) as { last: number | null } | undefined;
    return row?.last ?? null;
  }

  rearmNudges(member: string): void {
    this.db
      .prepare(
        `UPDATE spine_leases SET nudged_at = NULL, nudge_delivered = NULL
         WHERE member = ? AND nudged_at IS NOT NULL AND nudge_delivered = 0`,
      )
      .run(member);
  }

  // ─── Receipts ───────────────────────────────────────────────────

  advanceReceipt(member: string, seq: number, via: ReceiptVia, now: number): ReceiptRecord {
    const current = this.receipt(member);
    if (current !== null && seq <= current.seq) return current;
    this.db
      .prepare(
        `INSERT INTO spine_receipts (member, seq, at, via) VALUES (?, ?, ?, ?)
         ON CONFLICT(member) DO UPDATE SET seq = excluded.seq, at = excluded.at, via = excluded.via`,
      )
      .run(member, seq, now, via);
    return { member, seq, at: now, via };
  }

  receipt(member: string): ReceiptRecord | null {
    const row = this.db.prepare('SELECT * FROM spine_receipts WHERE member = ?').get(member) as
      | ReceiptRow
      | undefined;
    return row === undefined
      ? null
      : { member: row.member, seq: row.seq, at: row.at, via: row.via as ReceiptVia };
  }

  // ─── Injections ─────────────────────────────────────────────────

  logInjection(input: LogInjectionInput): SpineInjection {
    const refs = JSON.stringify([...input.refs]);
    const result = this.db
      .prepare(
        `INSERT INTO spine_injections (member, class, kind, refs, cursor, at, bytes, delivered)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.member,
        input.class,
        input.kind,
        refs,
        input.cursor,
        input.at,
        input.bytes,
        input.delivered ? 1 : 0,
      );
    return {
      id: Number(result.lastInsertRowid),
      member: input.member,
      class: input.class,
      kind: input.kind,
      refs: [...input.refs],
      cursor: input.cursor,
      at: iso(input.at),
      bytes: input.bytes,
      delivered: input.delivered,
    };
  }

  /**
   * The ledger, NEWEST FIRST, paged BACKWARD.
   *
   * The cursor has to run the same direction as the ordering or it is
   * not a cursor. This shipped as `id > since_id` under `ORDER BY id
   * DESC`, which reads plausibly and cannot page: every request
   * returns the newest rows above the cursor, so feeding back the last
   * id of a page returns a page entirely NEWER than the one you just
   * read, and the older rows are unreachable at any page size. The
   * field is `before_id` now because a name that says "since" over a
   * backward walk is how the defect got written in the first place.
   */
  injections(query: ListSpineInjectionsQuery & { member: string }): SpineInjection[] {
    const limit = query.limit ?? 100;
    const before = query.before_id;
    const rows = (before === undefined
      ? this.db
          .prepare('SELECT * FROM spine_injections WHERE member = ? ORDER BY id DESC LIMIT ?')
          .all(query.member, limit)
      : this.db
          .prepare(
            `SELECT * FROM spine_injections WHERE member = ? AND id < ?
               ORDER BY id DESC LIMIT ?`,
          )
          .all(query.member, before, limit)) as unknown as InjectionRow[];
    return rows.map(rowToInjection);
  }

  // ─── Subscriptions ──────────────────────────────────────────────

  subscription(member: string, contract: string): SpineSubscription | null {
    const row = this.db
      .prepare('SELECT * FROM spine_subscriptions WHERE member = ? AND contract_id = ?')
      .get(member, contract) as SubscriptionRow | undefined;
    return row === undefined ? null : rowToSubscription(row);
  }

  subscriptionsForContract(contract: string): SpineSubscription[] {
    const rows = this.db
      .prepare('SELECT * FROM spine_subscriptions WHERE contract_id = ? ORDER BY member ASC')
      .all(contract) as unknown as SubscriptionRow[];
    return rows.map(rowToSubscription);
  }

  subscriptionsOfMember(member: string): SpineSubscription[] {
    const rows = this.db
      .prepare('SELECT * FROM spine_subscriptions WHERE member = ? ORDER BY contract_id ASC')
      .all(member) as unknown as SubscriptionRow[];
    return rows.map(rowToSubscription);
  }

  setSubscription(
    member: string,
    contract: string,
    level: SpineSubscriptionLevel,
    updatedBy: string,
    now: number,
  ): SpineSubscription {
    this.db
      .prepare(
        `INSERT INTO spine_subscriptions (member, contract_id, level, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(member, contract_id) DO UPDATE SET
           level = excluded.level, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(member, contract, level, updatedBy, now);
    return {
      member,
      contract,
      level,
      explicit: true,
      updatedBy,
      updatedAt: iso(now),
    };
  }

  // ─── Cadence ────────────────────────────────────────────────────

  policy(member: string): SpineCuratorPolicy {
    const row = this.db
      .prepare('SELECT * FROM spine_curator_policy WHERE member = ?')
      .get(member) as PolicyRow | undefined;
    if (row === undefined) {
      return {
        member,
        leaseTtlMs: DEFAULT_LEASE_TTL_MS,
        nudgeMinIntervalMs: DEFAULT_NUDGE_MIN_INTERVAL_MS,
        explicit: false,
        updatedBy: null,
        updatedAt: null,
      };
    }
    return {
      member: row.member,
      leaseTtlMs: row.lease_ttl_ms,
      nudgeMinIntervalMs: row.nudge_min_interval_ms,
      explicit: true,
      updatedBy: row.updated_by,
      updatedAt: iso(row.updated_at),
    };
  }

  setPolicy(
    member: string,
    patch: { leaseTtlMs?: number; nudgeMinIntervalMs?: number },
    updatedBy: string,
    now: number,
  ): SpineCuratorPolicy {
    // Patch semantics against the EFFECTIVE policy, not against the
    // row: a member with no row who sets only a nudge interval must
    // keep the default TTL rather than acquire a zero.
    const current = this.policy(member);
    const next = {
      leaseTtlMs: patch.leaseTtlMs ?? current.leaseTtlMs,
      nudgeMinIntervalMs: patch.nudgeMinIntervalMs ?? current.nudgeMinIntervalMs,
    };
    this.db
      .prepare(
        `INSERT INTO spine_curator_policy (member, lease_ttl_ms, nudge_min_interval_ms, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(member) DO UPDATE SET
           lease_ttl_ms = excluded.lease_ttl_ms,
           nudge_min_interval_ms = excluded.nudge_min_interval_ms,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(member, next.leaseTtlMs, next.nudgeMinIntervalMs, updatedBy, now);
    return {
      member,
      leaseTtlMs: next.leaseTtlMs,
      nudgeMinIntervalMs: next.nudgeMinIntervalMs,
      explicit: true,
      updatedBy,
      updatedAt: iso(now),
    };
  }
}

function rowToLease(row: LeaseRow): LeaseRecord {
  return {
    member: row.member,
    ref: row.ref,
    seq: row.seq,
    grantedAt: row.granted_at,
    source: row.source as LeaseSource,
    invalidatedAt: row.invalidated_at,
    invalidatedBy: row.invalidated_by,
    nudgedAt: row.nudged_at,
    nudgeDelivered: row.nudge_delivered === null ? null : row.nudge_delivered === 1,
  };
}

function rowToInjection(row: InjectionRow): SpineInjection {
  return {
    id: row.id,
    member: row.member,
    class: row.class as 0 | 1 | 2,
    kind: row.kind as SpineInjectionKind,
    refs: JSON.parse(row.refs) as string[],
    cursor: row.cursor,
    at: iso(row.at),
    bytes: row.bytes,
    delivered: row.delivered === 1,
  };
}

function rowToSubscription(row: SubscriptionRow): SpineSubscription {
  return {
    member: row.member,
    contract: row.contract_id,
    level: row.level as SpineSubscriptionLevel,
    explicit: true,
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at),
  };
}

export function createSqliteCuratorStore(db: DatabaseSyncInstance): CuratorStore {
  return new SqliteCuratorStore(db);
}
