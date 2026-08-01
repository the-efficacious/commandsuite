/**
 * Team process rules — the standing instructions that bind how members
 * work, held as current state and injected into every briefing.
 *
 * WHY THIS EXISTS. Four process rules were adopted on 2026-07-31/08-01
 * and all four lived only in a director-to-lead DM and in broadcasts.
 * No member other than the lead knew any of them, and a member whose
 * context had cleared knew none — including the lead. The same evening,
 * a ruling silently re-scoped an acceptance criterion and produced a
 * circular dependency a director had to break.
 *
 * Both are one shape: the durable surface holds the stale version and
 * the correction is a message. `#79` closed that for contracts; this
 * closes it for the rules the contracts are executed under.
 *
 * INJECTED, NOT BROADCAST. Broadcast is the first thing compaction
 * discards. What a member receives has to be current state in fixed
 * context, which is why the rules reach the briefing composer rather
 * than a channel.
 *
 * THREE STORAGE DECISIONS THAT ARE NOT DECORATION:
 *
 *   `anchor` is immutable and is the identity a reader tracks across
 *   amendments. Text changes; the anchor does not. Without it a
 *   reversal and a rewording are the same prose diff — and this team's
 *   merge model changed twice in one evening.
 *
 *   `provenance` is required. "The director said this" and "the lead
 *   proposed it and nobody objected" bind differently, and a store
 *   that cannot express the difference presents both as settled. One
 *   of the four real rules is in the second category.
 *
 *   `status` has a `disputed` state. One of the four is recorded in a
 *   form its author cannot stand behind, and observed practice
 *   contradicts it. A store with only "in force" or absence would have
 *   to drop it or assert it, and both are false. Same reasoning as an
 *   unobservable capture projection: the third state exists because
 *   asserting either of the other two is a claim nobody can support.
 *
 * HISTORY IS RETRIEVABLE, NOT RESIDENT. Amendments live in an
 * append-only table and are served by their own endpoint. The injected
 * block carries only current text plus a version, so amendment churn
 * contributes ZERO resident growth — a rule amended fifty times costs
 * what one never touched costs.
 *
 * THAT IS NOT A CEILING, and this comment said it was. Per-rule text
 * caps at 4096; the number of rules does not cap; so the injected
 * block as a whole is UNBOUNDED. Moving rules out of `instructions`
 * escaped that field's cap deliberately and removed the only thing
 * that would ever have caught growth here. Nothing reports the total.
 * A future cap on composed output has to bound this field too, or it
 * will bound `instructions` and leave the rules outside it — which is
 * how they came to be outside in the first place.
 */

import { PROCESS_RULE_FIELDS } from 'csuite-sdk/schemas';
import type {
  AmendProcessRuleRequest,
  CreateProcessRuleRequest,
  ProcessRule,
  ProcessRuleAmendment,
  ProcessRuleField,
} from 'csuite-sdk/types';
import type { DatabaseSyncInstance, StatementInstance } from './db.js';

export class ProcessRulesError extends Error {
  readonly code: 'not_found' | 'invalid_input' | 'anchor_taken';
  constructor(code: ProcessRulesError['code'], message: string) {
    super(message);
    this.name = 'ProcessRulesError';
    this.code = code;
  }
}

/** The mutable half of a rule — what `create` builds and `amend` moves. */
type AmendableFields = Pick<
  ProcessRule,
  'title' | 'text' | 'status' | 'provenance' | 'attribution' | 'disputeReason'
>;

/**
 * Every invariant that must hold of a WHOLE rule, checked in one place
 * by both `create` and `amend`.
 *
 * It takes the fully constructed rule, never a delta. `amend`
 * originally checked only the fields the amendment supplied, which
 * cannot express an invariant about a whole rule: amending
 * `provenance` to `director` on a rule created as `unattributed`
 * passed, because the amendment did not mention `attribution` and the
 * check never looked at the row it was producing. The result rendered
 * as "stated by a director" for a rule no director stated — the exact
 * laundering `provenance` exists to prevent, reachable only by the two
 * members the field constrains.
 *
 * Any check that inspects only what changed will grow this defect
 * again, so this signature deliberately cannot see the delta.
 */
function assertRuleInvariants(rule: Omit<AmendableFields, 'title' | 'text'>): void {
  // A disputed rule that does not say what is in dispute is worse than
  // an absent one: a reader cannot tell whether to follow it.
  if (rule.status === 'disputed' && !rule.disputeReason) {
    throw new ProcessRulesError(
      'invalid_input',
      'a disputed rule must state disputeReason — what is in dispute',
    );
  }
  if (rule.provenance !== 'unattributed' && !rule.attribution) {
    throw new ProcessRulesError(
      'invalid_input',
      `provenance '${rule.provenance}' requires an attribution — ` +
        'rendering an unattributed rule as one someone stated launders it',
    );
  }
}

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS process_rules (
    -- Immutable. The identity a reader tracks across amendments.
    anchor TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_force'
      CHECK(status IN ('in_force','disputed','retired')),
    provenance TEXT NOT NULL
      CHECK(provenance IN ('director','lead_uncontested','unattributed')),
    attribution TEXT,
    dispute_reason TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Append-only. Never updated, never deleted; the injected block
  -- reads none of it.
  CREATE TABLE IF NOT EXISTS process_rule_amendments (
    anchor TEXT NOT NULL,
    version INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK(disposition IN ('correction','scope_change')),
    change_kind TEXT NOT NULL CHECK(change_kind IN ('reversal','refinement','wording')),
    reason TEXT NOT NULL,
    fields TEXT NOT NULL,
    previous TEXT NOT NULL,
    PRIMARY KEY (anchor, version)
  );
  CREATE INDEX IF NOT EXISTS process_rule_amendments_anchor_idx
    ON process_rule_amendments (anchor, ts);
`;

interface RuleRow {
  anchor: string;
  title: string;
  text: string;
  status: string;
  provenance: string;
  attribution: string | null;
  dispute_reason: string | null;
  version: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface AmendmentRow {
  anchor: string;
  version: number;
  ts: number;
  actor: string;
  disposition: string;
  change_kind: string;
  reason: string;
  fields: string;
  previous: string;
}

export interface ProcessRulesStore {
  /**
   * Every rule, ordered by anchor. Includes `retired` and `disputed`;
   * the caller decides what to render, because "which rules exist" and
   * "which rules bind" are different questions and only one of them is
   * this store's to answer.
   */
  list(): ProcessRule[];
  get(anchor: string): ProcessRule | null;
  /**
   * The rules that go into a briefing: `in_force` and `disputed`, not
   * `retired`. A disputed rule IS injected — a member operating under
   * a rule whose status is unsettled needs to know both that it exists
   * and that it is unsettled.
   */
  listForInjection(): ProcessRule[];
  create(input: CreateProcessRuleRequest, creator: string, now?: number): ProcessRule;
  /**
   * Amend a rule. Rewrites the row and appends the superseded values,
   * in ONE transaction — a rule whose text moved without its prior
   * version being recorded is the defect this store exists to remove,
   * and it is strictly worse than immutability.
   */
  amend(
    anchor: string,
    input: AmendProcessRuleRequest,
    actor: string,
    now?: number,
  ): { rule: ProcessRule; amendment: ProcessRuleAmendment };
  /** Retrieved, never resident. */
  history(anchor: string): ProcessRuleAmendment[];
}

class SqliteProcessRulesStore implements ProcessRulesStore {
  private readonly db: DatabaseSyncInstance;
  private readonly selectAllStmt: StatementInstance;
  private readonly selectOneStmt: StatementInstance;
  private readonly insertStmt: StatementInstance;
  private readonly updateStmt: StatementInstance;
  private readonly insertAmendmentStmt: StatementInstance;
  private readonly selectHistoryStmt: StatementInstance;

  constructor(db: DatabaseSyncInstance) {
    this.db = db;
    this.db.exec(CREATE_SCHEMA);
    this.selectAllStmt = db.prepare('SELECT * FROM process_rules ORDER BY anchor ASC');
    this.selectOneStmt = db.prepare('SELECT * FROM process_rules WHERE anchor = ?');
    this.insertStmt = db.prepare(
      `INSERT INTO process_rules
        (anchor, title, text, status, provenance, attribution, dispute_reason,
         version, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    );
    this.updateStmt = db.prepare(
      `UPDATE process_rules
         SET title = ?, text = ?, status = ?, provenance = ?, attribution = ?,
             dispute_reason = ?, version = ?, updated_at = ?
       WHERE anchor = ?`,
    );
    this.insertAmendmentStmt = db.prepare(
      `INSERT INTO process_rule_amendments
        (anchor, version, ts, actor, disposition, change_kind, reason, fields, previous)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectHistoryStmt = db.prepare(
      'SELECT * FROM process_rule_amendments WHERE anchor = ? ORDER BY version ASC',
    );
  }

  list(): ProcessRule[] {
    return (this.selectAllStmt.all() as unknown as RuleRow[]).map(rowToRule);
  }

  get(anchor: string): ProcessRule | null {
    const row = this.selectOneStmt.get(anchor) as RuleRow | undefined;
    return row ? rowToRule(row) : null;
  }

  listForInjection(): ProcessRule[] {
    return this.list().filter((r) => r.status !== 'retired');
  }

  create(input: CreateProcessRuleRequest, creator: string, now: number = Date.now()): ProcessRule {
    if (this.get(input.anchor)) {
      throw new ProcessRulesError(
        'anchor_taken',
        `a rule anchored '${input.anchor}' already exists`,
      );
    }
    const status = input.status ?? 'in_force';
    assertRuleInvariants({
      status,
      provenance: input.provenance,
      attribution: input.attribution ?? null,
      disputeReason: input.disputeReason ?? null,
    });
    this.insertStmt.run(
      input.anchor,
      input.title,
      input.text,
      status,
      input.provenance,
      input.attribution ?? null,
      input.disputeReason ?? null,
      creator,
      now,
      now,
    );
    return this.get(input.anchor) as ProcessRule;
  }

  amend(
    anchor: string,
    input: AmendProcessRuleRequest,
    actor: string,
    now: number = Date.now(),
  ): { rule: ProcessRule; amendment: ProcessRuleAmendment } {
    const current = this.get(anchor);
    if (!current) throw new ProcessRulesError('not_found', `no rule anchored '${anchor}'`);

    // Change detection is driven by PROCESS_RULE_FIELDS, which is
    // derived from the one shape that also defines what `amend`
    // accepts and what `previous` can hold. A field cannot be
    // accepted here and go unrecorded: it is the same list.
    //
    // This loop replaced four hand-written `if` blocks plus two bare
    // assignments for `attribution` and `disputeReason` — the two
    // fields the request took and the record never kept. Paired with a
    // title change that loss was silent: the amendment looked
    // well-formed because `previous.title` was present.
    const fields: ProcessRuleField[] = [];
    const previous: ProcessRuleAmendment['previous'] = {};
    const next: AmendableFields = {
      title: current.title,
      text: current.text,
      status: current.status,
      provenance: current.provenance,
      attribution: current.attribution,
      disputeReason: current.disputeReason,
    };
    for (const field of PROCESS_RULE_FIELDS) {
      const incoming = input[field];
      // `undefined` means "leave alone". `null` is a real value on the
      // nullable fields and means "clear it", which is how a rule moves
      // back to `unattributed` without keeping a stale attribution.
      if (incoming === undefined) continue;
      if (incoming === current[field]) continue;
      fields.push(field);
      (previous as Record<string, unknown>)[field] = current[field];
      (next as Record<string, unknown>)[field] = incoming;
    }

    if (fields.length === 0) {
      throw new ProcessRulesError(
        'invalid_input',
        `amendment changes nothing — supply one of ${PROCESS_RULE_FIELDS.join(', ')} that differs`,
      );
    }

    // The SAME invariant `create` enforces, applied to the fully
    // constructed rule rather than to the amendment's own fields.
    // Checking only what the amendment supplied let an amendment
    // manufacture authority creation refuses: `unattributed` with no
    // attribution, amended to `director` without supplying one, left a
    // rule rendering as "stated by a director" that no director stated.
    assertRuleInvariants(next);

    const version = current.version + 1;
    const amendment: ProcessRuleAmendment = {
      anchor,
      version,
      ts: now,
      actor,
      disposition: input.disposition,
      changeKind: input.changeKind,
      reason: input.reason,
      fields,
      previous,
    };

    // One transaction. A rule whose text moved without its prior
    // version recorded is unrecoverable, and worse than immutability.
    this.db.prepare('BEGIN').run();
    try {
      this.updateStmt.run(
        next.title,
        next.text,
        next.status,
        next.provenance,
        next.attribution,
        next.disputeReason,
        version,
        now,
        anchor,
      );
      this.insertAmendmentStmt.run(
        anchor,
        version,
        now,
        actor,
        amendment.disposition,
        amendment.changeKind,
        amendment.reason,
        JSON.stringify(fields),
        JSON.stringify(previous),
      );
      this.db.prepare('COMMIT').run();
    } catch (err) {
      try {
        this.db.prepare('ROLLBACK').run();
      } catch {
        /* rollback of a failed tx can itself fail — nothing to do */
      }
      throw err;
    }

    return { rule: this.get(anchor) as ProcessRule, amendment };
  }

  history(anchor: string): ProcessRuleAmendment[] {
    return (this.selectHistoryStmt.all(anchor) as unknown as AmendmentRow[]).map((row) => ({
      anchor: row.anchor,
      version: row.version,
      ts: row.ts,
      actor: row.actor,
      disposition: row.disposition as ProcessRuleAmendment['disposition'],
      changeKind: row.change_kind as ProcessRuleAmendment['changeKind'],
      reason: row.reason,
      fields: safeParse<ProcessRuleField[]>(row.fields, []),
      previous: safeParse<ProcessRuleAmendment['previous']>(row.previous, {}),
    }));
  }
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToRule(row: RuleRow): ProcessRule {
  return {
    anchor: row.anchor,
    title: row.title,
    text: row.text,
    status: row.status as ProcessRule['status'],
    provenance: row.provenance as ProcessRule['provenance'],
    attribution: row.attribution,
    disputeReason: row.dispute_reason,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSqliteProcessRulesStore(db: DatabaseSyncInstance): ProcessRulesStore {
  return new SqliteProcessRulesStore(db);
}
