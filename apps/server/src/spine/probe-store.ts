/**
 * The check registry's storage — rows, and the one atomic transition
 * the engine's correctness rests on.
 *
 * `claimForFiring` is the whole reason this is a store rather than a
 * few queries inline. "One fire per arming" is not a comment: two
 * webhook deliveries arriving in the same tick both read `armed`, and
 * on the second one the annex would hold two photographs of one thing,
 * an ask would be discharged twice, and "did the thing I armed actually
 * happen" would have two answers. The claim is a single conditional
 * UPDATE — `WHERE state = 'armed'` — so exactly one caller can win it,
 * and it is called before the engine's first `await`.
 */

import type { SpineCheck, SpineCheckCarrier, SpineCheckRecipe } from 'csuite-sdk/types';
import type { DatabaseSyncInstance } from '../db.js';
import { SPINE_CHECK_SCHEMA, SPINE_CHECK_TABLES } from './probe-schema.js';

interface CheckRow {
  id: string;
  source_event_id: string;
  carrier: SpineCheckCarrier;
  subject_id: string;
  contract_id: string | null;
  ask_id: string | null;
  recipe: string;
  authored_by: string;
  state: SpineCheck['state'];
  fired_event_id: string | null;
  fired_at: string | null;
  last_evaluated_at: string | null;
  disarmed_reason: string | null;
  at: string;
}

export interface ArmCheckInput {
  id: string;
  sourceEvent: string;
  carrier: SpineCheckCarrier;
  subject: string;
  contract: string | null;
  ask: string | null;
  recipe: SpineCheckRecipe;
  authoredBy: string;
  at: string;
}

export interface ListChecksFilter {
  state?: SpineCheck['state'];
  contract?: string;
  ask?: string;
  subject?: string;
  limit?: number;
}

export interface CheckStore {
  /**
   * Materialise a check. Idempotent on the carrier event, so a replayed
   * append arms nothing new and the second call returns the first
   * check.
   */
  arm(input: ArmCheckInput): SpineCheck;
  get(id: string): SpineCheck | null;
  list(filter?: ListChecksFilter): SpineCheck[];
  /** Every armed check on one webhook endpoint. The webhook tap's only query. */
  armedForEndpoint(endpoint: string): SpineCheck[];
  /** Every armed poll whose interval has elapsed since it was last evaluated. */
  duePolls(now: number): SpineCheck[];
  /**
   * Take the check out of `armed`, atomically. `true` iff this caller
   * won it — the ONE claim, and the reason the engine can be re-entered
   * by two deliveries without producing two photographs.
   */
  claimForFiring(id: string): boolean;
  /** The shutter closed and the evidence is in the annex. */
  recordFire(id: string, observation: string, at: string): void;
  /** A claim that could not produce evidence. Broken, not waiting. */
  failClaim(id: string, reason: string): void;
  /** The predicate was tested and said no. Bookkeeping only. */
  recordEvaluation(id: string, at: string): void;
  /** The carrier went away. Nothing was observed and nothing will be. */
  disarm(id: string, reason: string): void;
  /** Armed checks on an ask / a contract, for the disarm paths. */
  armedForAsk(ask: string): SpineCheck[];
  armedForContract(contract: string): SpineCheck[];
  /** Drop every row. The refold is the engine's; this only clears. */
  clear(): void;
}

function rowToCheck(row: CheckRow): SpineCheck {
  return {
    id: row.id,
    sourceEvent: row.source_event_id,
    carrier: row.carrier,
    subject: row.subject_id,
    contract: row.contract_id,
    ask: row.ask_id,
    recipe: JSON.parse(row.recipe) as SpineCheckRecipe,
    authoredBy: row.authored_by,
    state: row.state,
    firedEvent: row.fired_event_id,
    firedAt: row.fired_at,
    lastEvaluatedAt: row.last_evaluated_at,
    disarmedReason: row.disarmed_reason,
    at: row.at,
  };
}

class SqliteCheckStore implements CheckStore {
  private readonly db: DatabaseSyncInstance;

  constructor(db: DatabaseSyncInstance) {
    this.db = db;
    this.db.exec(SPINE_CHECK_SCHEMA);
  }

  arm(input: ArmCheckInput): SpineCheck {
    const existing = this.db
      .prepare('SELECT * FROM spine_checks WHERE source_event_id = ?')
      .get(input.sourceEvent) as CheckRow | undefined;
    if (existing !== undefined) return rowToCheck(existing);
    this.db
      .prepare(
        `INSERT INTO spine_checks
           (id, source_event_id, carrier, subject_id, contract_id, ask_id, recipe,
            authored_by, state, fired_event_id, fired_at, last_evaluated_at,
            disarmed_reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'armed', NULL, NULL, NULL, NULL, ?)`,
      )
      .run(
        input.id,
        input.sourceEvent,
        input.carrier,
        input.subject,
        input.contract,
        input.ask,
        JSON.stringify(input.recipe),
        input.authoredBy,
        input.at,
      );
    return this.get(input.id) as SpineCheck;
  }

  get(id: string): SpineCheck | null {
    const row = this.db.prepare('SELECT * FROM spine_checks WHERE id = ?').get(id) as
      | CheckRow
      | undefined;
    return row === undefined ? null : rowToCheck(row);
  }

  list(filter: ListChecksFilter = {}): SpineCheck[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.state !== undefined) {
      where.push('state = ?');
      args.push(filter.state);
    }
    if (filter.contract !== undefined) {
      where.push('contract_id = ?');
      args.push(filter.contract);
    }
    if (filter.ask !== undefined) {
      where.push('ask_id = ?');
      args.push(filter.ask);
    }
    if (filter.subject !== undefined) {
      where.push('subject_id = ?');
      args.push(filter.subject);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM spine_checks ${clause} ORDER BY at ASC, id ASC LIMIT ?`)
      .all(...([...args, filter.limit ?? 200] as never[])) as unknown as CheckRow[];
    return rows.map(rowToCheck);
  }

  armedForEndpoint(endpoint: string): SpineCheck[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM spine_checks
         WHERE state = 'armed'
           AND json_extract(recipe, '$.kind') = 'webhook'
           AND json_extract(recipe, '$.endpoint') = ?
         ORDER BY at ASC, id ASC`,
      )
      .all(endpoint) as unknown as CheckRow[];
    return rows.map(rowToCheck);
  }

  duePolls(now: number): SpineCheck[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM spine_checks
         WHERE state = 'armed' AND json_extract(recipe, '$.kind') = 'http_poll'
         ORDER BY at ASC, id ASC`,
      )
      .all() as unknown as CheckRow[];
    return rows.map(rowToCheck).filter((check) => {
      if (check.recipe.kind !== 'http_poll') return false;
      // NEVER EVALUATED means due now. A check armed at 09:00 with a
      // five-minute interval must not sit idle until 09:05 — the
      // member armed it because they expect the world to be looked at.
      const since = check.lastEvaluatedAt ?? check.at;
      return now - Date.parse(since) >= check.recipe.intervalMs;
    });
  }

  claimForFiring(id: string): boolean {
    // ONE STATEMENT, and the `WHERE state = 'armed'` is the claim. A
    // read-then-write would leave a window between them, and the window
    // is exactly a tick of the event loop — which is exactly how long
    // two inbound deliveries take to interleave.
    const result = this.db
      .prepare("UPDATE spine_checks SET state = 'fired' WHERE id = ? AND state = 'armed'")
      .run(id);
    return Number(result.changes) === 1;
  }

  recordFire(id: string, observation: string, at: string): void {
    this.db
      .prepare(
        `UPDATE spine_checks
         SET state = 'fired', fired_event_id = ?, fired_at = ?, last_evaluated_at = ?
         WHERE id = ?`,
      )
      .run(observation, at, at, id);
  }

  failClaim(id: string, reason: string): void {
    // DISARMED, NOT RE-ARMED. A check that claimed the shutter and
    // could not record what it saw is not waiting for another chance —
    // it is a camera that failed, and re-arming it would let the same
    // failure produce a duplicate photograph the moment it stopped
    // failing. Re-arming takes a new carrier event, which is the same
    // rule the whole registry runs on.
    this.db
      .prepare("UPDATE spine_checks SET state = 'disarmed', disarmed_reason = ? WHERE id = ?")
      .run(reason, id);
  }

  recordEvaluation(id: string, at: string): void {
    this.db.prepare('UPDATE spine_checks SET last_evaluated_at = ? WHERE id = ?').run(at, id);
  }

  disarm(id: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE spine_checks SET state = 'disarmed', disarmed_reason = ?
         WHERE id = ? AND state = 'armed'`,
      )
      .run(reason, id);
  }

  armedForAsk(ask: string): SpineCheck[] {
    const rows = this.db
      .prepare("SELECT * FROM spine_checks WHERE ask_id = ? AND state = 'armed'")
      .all(ask) as unknown as CheckRow[];
    return rows.map(rowToCheck);
  }

  armedForContract(contract: string): SpineCheck[] {
    const rows = this.db
      .prepare("SELECT * FROM spine_checks WHERE contract_id = ? AND state = 'armed'")
      .all(contract) as unknown as CheckRow[];
    return rows.map(rowToCheck);
  }

  clear(): void {
    for (const table of SPINE_CHECK_TABLES) this.db.exec(`DELETE FROM ${table}`);
  }
}

export function createSqliteCheckStore(db: DatabaseSyncInstance): CheckStore {
  return new SqliteCheckStore(db);
}
