/**
 * Objectives store — SQLite-backed CRUD + state machine for the v1
 * objectives primitive. Lives alongside the event log, session store,
 * and push-subscription store, sharing the same `DatabaseSync` handle.
 *
 * Design notes:
 *
 * - **Push-assigned, single-assignee.** v1 objectives are created by an
 *   admin, operator, or lead-agent and immediately bound to one
 *   assignee. No unclaimed queue, no claim verb. Reassignment is an
 *   admin-only action.
 *
 * - **Four-state lifecycle.** `active | blocked | done | cancelled`.
 *   `done` and `cancelled` are terminal; `active ↔ blocked` is the only
 *   back-and-forth. The store enforces every transition so callers
 *   can't sneak an illegal state through.
 *
 * - **Outcome is contractual.** Every objective has a non-empty
 *   `outcome` field at creation — the tangible definition of done. The
 *   instructions composer and tool-description builder both surface it so
 *   the agent sees its acceptance criteria on every turn.
 *
 * - **Audit log via `objective_events`.** Every mutating call appends
 *   an event row in the same transaction as the state change. The
 *   table is append-only — there is no delete or update path.
 *
 * - **Discussion piggybacks on threads.** The store itself doesn't
 *   manage the auto-thread-per-objective; it just emits events that
 *   the app layer fans out as channel pushes on thread `obj:<id>`.
 *   Separation of concerns keeps the store free of broker knowledge.
 */

import { ObjectiveEventKindSchema, ObjectiveStatusSchema } from 'csuite-sdk/schemas';
import type {
  AmendableField,
  AmendObjectiveRequest,
  Attachment,
  CancelObjectiveRequest,
  CompleteObjectiveRequest,
  CorrectObjectiveEventRequest,
  CreateObjectiveRequest,
  Objective,
  ObjectiveAmendment,
  ObjectiveEvent,
  ObjectiveEventKind,
  ObjectiveStatus,
  ReassignObjectiveRequest,
  UpdateObjectiveRequest,
  UpdateWatchersRequest,
} from 'csuite-sdk/types';
import type { DatabaseSyncInstance, StatementInstance } from './db.js';

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS objectives (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','blocked','done','cancelled')),
    assignee TEXT NOT NULL,
    originator TEXT NOT NULL,
    watchers TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    result TEXT,
    block_reason TEXT,
    attachments TEXT NOT NULL DEFAULT '[]',
    -- The contract version the title/outcome/body columns represent.
    -- 1 on creation; each contract amendment increments it. Every
    -- lifecycle event records the version current when it fired, so
    -- "which contract was this built against" is a stored fact rather
    -- than a reconstruction from timestamps.
    outcome_version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS objectives_assignee_idx ON objectives (assignee);
  CREATE INDEX IF NOT EXISTS objectives_status_idx ON objectives (status);
  CREATE INDEX IF NOT EXISTS objectives_created_idx ON objectives (created_at);

  CREATE TABLE IF NOT EXISTS objective_events (
    -- Durable, unique per event. A timestamp is NOT an identity: create
    -- emits assigned and watcher_added in the same millisecond, and a
    -- watcher batch emits several of one kind. A correction has to name
    -- exactly one event, and a selector that is only USUALLY unique is
    -- the shape this store exists to remove.
    event_id TEXT,
    objective_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    FOREIGN KEY (objective_id) REFERENCES objectives(id)
  );
  CREATE INDEX IF NOT EXISTS objective_events_id_idx ON objective_events (objective_id, ts);
`;

interface ObjectiveRow {
  id: string;
  title: string;
  body: string;
  outcome: string;
  outcome_version?: number;
  status: string;
  assignee: string;
  originator: string;
  watchers: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  result: string | null;
  block_reason: string | null;
  attachments: string;
}

interface ObjectiveEventRow {
  event_id?: string | null;
  objective_id: string;
  ts: number;
  actor: string;
  kind: string;
  payload: string;
}

function parseWatchers(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === 'string');
    }
  } catch {
    /* malformed — default to empty */
  }
  return [];
}

function parseAttachments(raw: string): Attachment[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as Attachment[];
  } catch {
    /* malformed — fall through */
  }
  return [];
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed — treat as empty object */
  }
  return {};
}

function rowToObjective(row: ObjectiveRow, amendments: ObjectiveAmendment[] = []): Objective {
  const status = ObjectiveStatusSchema.parse(row.status);
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    outcome: row.outcome,
    status,
    assignee: row.assignee,
    originator: row.originator,
    watchers: parseWatchers(row.watchers),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    result: row.result,
    blockReason: row.block_reason,
    attachments: parseAttachments(row.attachments ?? '[]'),
    // Rows written before this column existed are version 1 by
    // definition: they have never been amended.
    outcomeVersion: row.outcome_version ?? 1,
    amendments,
  };
}

function rowToEvent(row: ObjectiveEventRow): ObjectiveEvent {
  const kind = ObjectiveEventKindSchema.parse(row.kind);
  return {
    id: row.event_id ?? '',
    objectiveId: row.objective_id,
    ts: row.ts,
    actor: row.actor,
    kind,
    payload: parsePayload(row.payload),
  };
}

/**
 * Thrown when the store rejects a state transition or a caller-supplied
 * value. The server layer maps these to 400/409 HTTP responses.
 */
export class ObjectivesError extends Error {
  readonly code: 'not_found' | 'invalid_transition' | 'invalid_input' | 'terminal';
  constructor(code: ObjectivesError['code'], message: string) {
    super(message);
    this.name = 'ObjectivesError';
    this.code = code;
  }
}

/**
 * Result of a mutating store call. Every mutation returns the updated
 * objective plus the list of events it appended in this call — one or
 * more, depending on the operation. The app layer iterates over
 * `events` when publishing channel pushes so the outbound notification
 * per-event matches the audit log entry-per-event exactly.
 *
 * Most operations emit a single event; `update` can emit up to two
 * (a status transition plus a note). A no-op update (status equals
 * current status, no note, no block reason change) emits zero events
 * and returns `events: []` — callers should treat empty-events as
 * "nothing worth broadcasting."
 */
export interface ObjectivesMutationResult {
  objective: Objective;
  events: ObjectiveEvent[];
}

export interface ObjectivesStore {
  /** List objectives filtered by assignee + status. Newest first. */
  list(filter?: { assignee?: string; status?: ObjectiveStatus }): Objective[];
  /** Fetch a single objective or null if unknown. */
  get(id: string): Objective | null;
  /** Fetch the full append-only event history for an objective. */
  events(id: string): ObjectiveEvent[];
  /**
   * Create and assign an objective. The originator is the creating
   * caller's name. Emits an `assigned` event.
   */
  create(input: CreateObjectiveRequest, originator: string, now?: number): ObjectivesMutationResult;
  /**
   * Update status / note on an active or blocked objective. Never
   * transitions to `done` — use `complete` for that. Emits 0-2 events
   * depending on what actually changed.
   */
  update(
    id: string,
    input: UpdateObjectiveRequest,
    actor: string,
    now?: number,
  ): ObjectivesMutationResult;
  /** Mark done with a required result. Assignee-only (enforced upstream). */
  complete(
    id: string,
    input: CompleteObjectiveRequest,
    actor: string,
    now?: number,
  ): ObjectivesMutationResult;
  /** Terminally cancel. */
  cancel(
    id: string,
    input: CancelObjectiveRequest,
    actor: string,
    now?: number,
  ): ObjectivesMutationResult;
  /**
   * Amend the contract text. The caller must hold `objectives.create`
   * (enforced upstream) — the contract is not the executor's to
   * rewrite, and the gate is the permission rather than the role.
   *
   * Rewrites the row and appends an `amended` event carrying the
   * superseded values. Rejects an amendment that changes nothing.
   */
  amend(
    id: string,
    input: AmendObjectiveRequest,
    actor: string,
    now?: number,
  ): ObjectivesMutationResult;
  /**
   * Correct an earlier lifecycle event by superseding it. The target
   * event stays in the log unrewritten; the contract version is
   * untouched, because correcting the record of what happened is not
   * a change to the contract work was built against.
   */
  correctEvent(
    id: string,
    input: CorrectObjectiveEventRequest,
    actor: string,
    now?: number,
  ): ObjectivesMutationResult;
  /** Reassign to a different slot. */
  reassign(
    id: string,
    input: ReassignObjectiveRequest,
    actor: string,
    now?: number,
  ): ObjectivesMutationResult;
  /**
   * Add or remove watchers on an existing objective. Appends one
   * `watcher_added` event per new name and one `watcher_removed`
   * per removed name. No-op additions/removals are silently
   * dropped (deduped against the current list). Returns `events: []`
   * if the net change is empty.
   */
  updateWatchers(
    id: string,
    input: UpdateWatchersRequest,
    actor: string,
    now?: number,
  ): ObjectivesMutationResult;
  /**
   * Replace the `attachments` JSON column without producing an audit
   * event. Used by the server route after `create` to swap the
   * originally-claimed attachment paths (in member homes) for their
   * mirrored copies in the `/objectives/<id>/...` namespace. Returns
   * the updated objective.
   */
  setAttachments(id: string, attachments: Attachment[], now?: number): Objective;
}

class SqliteObjectivesStore implements ObjectivesStore {
  private readonly db: DatabaseSyncInstance;
  private readonly listAllStmt: StatementInstance;
  private readonly listByAssigneeStmt: StatementInstance;
  private readonly listByStatusStmt: StatementInstance;
  private readonly listByAssigneeAndStatusStmt: StatementInstance;
  private readonly getStmt: StatementInstance;
  private readonly insertStmt: StatementInstance;
  private readonly updateRowStmt: StatementInstance;
  private readonly updateWatchersStmt: StatementInstance;
  private readonly updateAttachmentsStmt: StatementInstance;
  private readonly insertEventStmt: StatementInstance;
  private readonly listEventsStmt: StatementInstance;

  constructor(db: DatabaseSyncInstance) {
    this.db = db;
    this.db.exec(CREATE_SCHEMA);
    // Best-effort schema migrations for databases that predate the
    // current column set. Each ALTER is wrapped individually so a
    // partial success doesn't skip the remaining ones. We swallow
    // only the specific "duplicate column name" error that fresh DBs
    // throw because CREATE_SCHEMA already created the column.
    for (const alter of [
      "ALTER TABLE objectives ADD COLUMN watchers TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE objectives ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
      'ALTER TABLE objective_events ADD COLUMN event_id TEXT',
      'ALTER TABLE objectives ADD COLUMN outcome_version INTEGER NOT NULL DEFAULT 1',
    ]) {
      try {
        this.db.exec(alter);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (!msg.includes('duplicate column name')) throw err;
      }
    }
    // Give every event a durable, UNIQUE id — one transaction, and it
    // FAILS LOUDLY rather than booting degraded.
    //
    // Best-effort was wrong here and it was the shape we rejected on
    // #105: a swallowed failure boots with `event_id = ''` on every
    // pre-existing event, which makes exactly the historical events a
    // correction surface exists for uncorrectable — and a later
    // restart might silently heal it, so the reporter cannot
    // reproduce what the next person sees.
    //
    // The unique index is what makes the selector unambiguous BY
    // STORAGE rather than by the probability that two UUIDs differ.
    // The ambiguity guard in `correctEvent` stays: it is now
    // unreachable, and a guard on an unreachable state is cheap and
    // fails loudly if this assumption ever stops holding.
    //
    // ROWID is stable for an append-only table that never deletes, so
    // the backfill is deterministic and runs once.
    this.db.prepare('BEGIN').run();
    try {
      this.db.exec(
        "UPDATE objective_events SET event_id = 'ev-' || ROWID WHERE event_id IS NULL OR event_id = ''",
      );
      const leftover = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM objective_events WHERE event_id IS NULL OR event_id = ''",
        )
        .get() as { n: number } | undefined;
      if ((leftover?.n ?? 0) > 0) {
        throw new Error(
          `${leftover?.n} objective_events rows still have no event_id after backfill`,
        );
      }
      this.db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS objective_events_event_id_idx ON objective_events (event_id)',
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
    this.listAllStmt = db.prepare('SELECT * FROM objectives ORDER BY created_at DESC, id DESC');
    this.listByAssigneeStmt = db.prepare(
      'SELECT * FROM objectives WHERE assignee = ? ORDER BY created_at DESC, id DESC',
    );
    this.listByStatusStmt = db.prepare(
      'SELECT * FROM objectives WHERE status = ? ORDER BY created_at DESC, id DESC',
    );
    this.listByAssigneeAndStatusStmt = db.prepare(
      'SELECT * FROM objectives WHERE assignee = ? AND status = ? ORDER BY created_at DESC, id DESC',
    );
    this.getStmt = db.prepare('SELECT * FROM objectives WHERE id = ?');
    this.insertStmt = db.prepare(
      `INSERT INTO objectives (
         id, title, body, outcome, status, assignee, originator, watchers,
         created_at, updated_at, completed_at, result, block_reason, attachments
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    );
    this.updateRowStmt = db.prepare(
      `UPDATE objectives
         SET status = ?, assignee = ?, updated_at = ?, completed_at = ?, result = ?, block_reason = ?
       WHERE id = ?`,
    );
    this.updateWatchersStmt = db.prepare(
      'UPDATE objectives SET watchers = ?, updated_at = ? WHERE id = ?',
    );
    this.updateAttachmentsStmt = db.prepare(
      'UPDATE objectives SET attachments = ?, updated_at = ? WHERE id = ?',
    );
    this.insertEventStmt = db.prepare(
      'INSERT INTO objective_events (event_id, objective_id, ts, actor, kind, payload) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.listEventsStmt = db.prepare(
      'SELECT * FROM objective_events WHERE objective_id = ? ORDER BY ts ASC, ROWID ASC',
    );
  }

  /**
   * Amendment record for a set of objectives, read from the event log.
   *
   * Derived rather than cached: the events ARE the append-only record,
   * and a materialised column could drift from them. Batched so
   * `list()` costs one extra query rather than one per row.
   */
  private amendmentsFor(ids: string[]): Map<string, ObjectiveAmendment[]> {
    const out = new Map<string, ObjectiveAmendment[]>();
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT objective_id, ts, actor, kind, payload FROM objective_events
          WHERE objective_id IN (${placeholders})
            AND kind IN ('amended', 'event_corrected')
          ORDER BY ts ASC`,
      )
      .all(...ids) as unknown as ObjectiveEventRow[];
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        // A malformed payload must not take out the whole read path.
        continue;
      }
      const list = out.get(row.objective_id) ?? [];
      list.push(payload as unknown as ObjectiveAmendment);
      out.set(row.objective_id, list);
    }
    return out;
  }

  list(filter: { assignee?: string; status?: ObjectiveStatus } = {}): Objective[] {
    let rows: ObjectiveRow[];
    if (filter.assignee && filter.status) {
      rows = this.listByAssigneeAndStatusStmt.all(
        filter.assignee,
        filter.status,
      ) as unknown as ObjectiveRow[];
    } else if (filter.assignee) {
      rows = this.listByAssigneeStmt.all(filter.assignee) as unknown as ObjectiveRow[];
    } else if (filter.status) {
      rows = this.listByStatusStmt.all(filter.status) as unknown as ObjectiveRow[];
    } else {
      rows = this.listAllStmt.all() as unknown as ObjectiveRow[];
    }
    const amendments = this.amendmentsFor(rows.map((r) => r.id));
    return rows.map((r) => rowToObjective(r, amendments.get(r.id) ?? []));
  }

  get(id: string): Objective | null {
    const row = this.getStmt.get(id) as unknown as ObjectiveRow | undefined;
    if (!row) return null;
    return rowToObjective(row, this.amendmentsFor([row.id]).get(row.id) ?? []);
  }

  events(id: string): ObjectiveEvent[] {
    const rows = this.listEventsStmt.all(id) as unknown as ObjectiveEventRow[];
    return rows.map(rowToEvent);
  }

  create(
    input: CreateObjectiveRequest,
    originator: string,
    now = Date.now(),
  ): ObjectivesMutationResult {
    const title = input.title.trim();
    const outcome = input.outcome.trim();
    const body = (input.body ?? '').trim();
    if (title.length === 0) throw new ObjectivesError('invalid_input', 'title is required');
    if (outcome.length === 0) throw new ObjectivesError('invalid_input', 'outcome is required');

    // Normalize initial watchers: dedupe, drop assignee + originator
    // (they're implicit thread members), drop empty strings. Order
    // is preserved so the first-added watcher appears first in the list.
    const rawWatchers = Array.isArray(input.watchers) ? input.watchers : [];
    const watchers: string[] = [];
    const seen = new Set<string>([input.assignee, originator]);
    for (const w of rawWatchers) {
      if (typeof w !== 'string' || w.length === 0) continue;
      if (seen.has(w)) continue;
      seen.add(w);
      watchers.push(w);
    }

    const id = generateObjectiveId();
    const events: ObjectiveEvent[] = [];
    const tx = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');
    tx.run();
    try {
      const attachments = Array.isArray(input.attachments) ? input.attachments : [];
      this.insertStmt.run(
        id,
        title,
        body,
        outcome,
        'active',
        input.assignee,
        originator,
        JSON.stringify(watchers),
        now,
        now,
        JSON.stringify(attachments),
      );
      events.push(
        this.appendEvent(id, now, originator, 'assigned', {
          title,
          outcome,
          assignee: input.assignee,
          ...(watchers.length > 0 ? { watchers } : {}),
        }),
      );
      // Emit one `watcher_added` per initial watcher so the audit log
      // records each addition individually. Fanout happens at the app
      // layer, which loops over events.
      for (const w of watchers) {
        events.push(this.appendEvent(id, now, originator, 'watcher_added', { name: w }));
      }
      commit.run();
    } catch (err) {
      rollback.run();
      throw err;
    }

    const created = this.get(id);
    if (!created) {
      throw new ObjectivesError('not_found', `objective ${id} vanished after creation`);
    }
    return { objective: created, events };
  }

  update(
    id: string,
    input: UpdateObjectiveRequest,
    actor: string,
    now = Date.now(),
  ): ObjectivesMutationResult {
    const current = this.get(id);
    if (!current) throw new ObjectivesError('not_found', `objective ${id} not found`);
    if (current.status === 'done' || current.status === 'cancelled') {
      throw new ObjectivesError(
        'terminal',
        `objective ${id} is ${current.status} and cannot be updated`,
      );
    }

    let nextStatus: ObjectiveStatus = current.status;
    let nextBlockReason: string | null = current.blockReason;

    if (input.status === 'blocked') {
      if (!input.blockReason || input.blockReason.trim().length === 0) {
        throw new ObjectivesError(
          'invalid_input',
          'blockReason is required when transitioning to blocked',
        );
      }
      nextStatus = 'blocked';
      nextBlockReason = input.blockReason.trim();
    } else if (input.status === 'active') {
      nextStatus = 'active';
      nextBlockReason = null;
    }

    // No-op detection: status equal to current with no block-reason
    // change means nothing lifecycle-level happened. Return empty
    // events so the app layer skips the channel push. Discussion is
    // not the store's concern anymore — it flows through the
    // `/objectives/:id/discuss` endpoint directly to the broker.
    const statusChanged = nextStatus !== current.status;
    const blockReasonChanged = nextBlockReason !== current.blockReason;

    if (!statusChanged && !blockReasonChanged) {
      return { objective: current, events: [] };
    }

    const events: ObjectiveEvent[] = [];
    const tx = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');
    tx.run();
    try {
      this.updateRowStmt.run(
        nextStatus,
        current.assignee,
        now,
        current.completedAt,
        current.result,
        nextBlockReason,
        id,
      );
      if (input.status === 'blocked' && current.status !== 'blocked') {
        events.push(this.appendEvent(id, now, actor, 'blocked', { reason: nextBlockReason }));
      } else if (input.status === 'active' && current.status === 'blocked') {
        events.push(this.appendEvent(id, now, actor, 'unblocked', {}));
      }
      commit.run();
    } catch (err) {
      rollback.run();
      throw err;
    }

    const updated = this.get(id);
    if (!updated) throw new ObjectivesError('not_found', `objective ${id} not found`);
    return { objective: updated, events };
  }

  complete(
    id: string,
    input: CompleteObjectiveRequest,
    actor: string,
    now = Date.now(),
  ): ObjectivesMutationResult {
    const current = this.get(id);
    if (!current) throw new ObjectivesError('not_found', `objective ${id} not found`);
    if (current.status === 'done' || current.status === 'cancelled') {
      throw new ObjectivesError('terminal', `objective ${id} is already ${current.status}`);
    }
    const result = input.result.trim();
    if (result.length === 0) {
      throw new ObjectivesError('invalid_input', 'result is required to complete an objective');
    }

    const events: ObjectiveEvent[] = [];
    const tx = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');
    tx.run();
    try {
      this.updateRowStmt.run('done', current.assignee, now, now, result, null, id);
      events.push(this.appendEvent(id, now, actor, 'completed', { result }));
      commit.run();
    } catch (err) {
      rollback.run();
      throw err;
    }

    const updated = this.get(id);
    if (!updated) throw new ObjectivesError('not_found', `objective ${id} not found`);
    return { objective: updated, events };
  }

  cancel(
    id: string,
    input: CancelObjectiveRequest,
    actor: string,
    now = Date.now(),
  ): ObjectivesMutationResult {
    const current = this.get(id);
    if (!current) throw new ObjectivesError('not_found', `objective ${id} not found`);
    if (current.status === 'done' || current.status === 'cancelled') {
      throw new ObjectivesError('terminal', `objective ${id} is already ${current.status}`);
    }
    const reason = input.reason?.trim() || null;

    const events: ObjectiveEvent[] = [];
    const tx = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');
    tx.run();
    try {
      this.updateRowStmt.run(
        'cancelled',
        current.assignee,
        now,
        current.completedAt,
        current.result,
        current.blockReason,
        id,
      );
      events.push(this.appendEvent(id, now, actor, 'cancelled', reason ? { reason } : {}));
      commit.run();
    } catch (err) {
      rollback.run();
      throw err;
    }

    const updated = this.get(id);
    if (!updated) throw new ObjectivesError('not_found', `objective ${id} not found`);
    return { objective: updated, events };
  }

  reassign(
    id: string,
    input: ReassignObjectiveRequest,
    actor: string,
    now = Date.now(),
  ): ObjectivesMutationResult {
    const current = this.get(id);
    if (!current) throw new ObjectivesError('not_found', `objective ${id} not found`);
    if (current.status === 'done' || current.status === 'cancelled') {
      throw new ObjectivesError(
        'terminal',
        `objective ${id} is ${current.status} and cannot be reassigned`,
      );
    }
    if (input.to === current.assignee) {
      throw new ObjectivesError(
        'invalid_input',
        `objective ${id} is already assigned to ${input.to}`,
      );
    }

    // Thread membership is COMPUTED, not stored — it's derived from the
    // current assignee + originator + watchers + admins. So reassignment
    // doesn't revoke anything; the assignee term simply stops matching,
    // and the previous assignee falls out of their own objective's thread
    // the moment it leaves their plate. That is exactly when they need to
    // hand over what they were doing.
    //
    // The only fix the model can express is a DURABLE grant, and
    // `watchers` already is one. Promote the previous assignee to watcher
    // in the same transaction, with its own `watcher_added` event so the
    // audit log shows why they're on the list. Skip when they're the
    // originator (membership already derives from that) or somehow
    // already a watcher.
    //
    // The visible cost, accepted deliberately: repeated reassignment
    // grows the watcher list. A visible grant that says who has a stake
    // beats an invisible one, and it is true — they worked on it.
    const previousAssignee = current.assignee;
    const promoteToWatcher =
      previousAssignee !== current.originator && !current.watchers.includes(previousAssignee);
    const nextWatchers = promoteToWatcher
      ? [...current.watchers, previousAssignee]
      : current.watchers;

    const events: ObjectiveEvent[] = [];
    const tx = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');
    tx.run();
    try {
      this.updateRowStmt.run(
        current.status,
        input.to,
        now,
        current.completedAt,
        current.result,
        current.blockReason,
        id,
      );
      events.push(
        this.appendEvent(id, now, actor, 'reassigned', {
          from: previousAssignee,
          to: input.to,
          ...(input.note ? { note: input.note.trim() } : {}),
        }),
      );
      if (promoteToWatcher) {
        this.updateWatchersStmt.run(JSON.stringify(nextWatchers), now, id);
        events.push(
          this.appendEvent(id, now, actor, 'watcher_added', {
            name: previousAssignee,
            reason: 'reassigned-from',
          }),
        );
      }
      commit.run();
    } catch (err) {
      rollback.run();
      throw err;
    }

    const updated = this.get(id);
    if (!updated) throw new ObjectivesError('not_found', `objective ${id} not found`);
    return { objective: updated, events };
  }

  updateWatchers(
    id: string,
    input: UpdateWatchersRequest,
    actor: string,
    now = Date.now(),
  ): ObjectivesMutationResult {
    const current = this.get(id);
    if (!current) throw new ObjectivesError('not_found', `objective ${id} not found`);
    // We allow watcher changes on terminal objectives too — a
    // completed objective might still want a reviewer looped in to
    // read the result. If that turns out to be wrong, tighten here.

    const currentSet = new Set(current.watchers);
    const assignee = current.assignee;
    const originator = current.originator;

    // Compute the net-new additions: entries in `add` that aren't
    // already watchers and aren't the assignee/originator (they're
    // implicit members; we don't track them in the explicit list).
    const toAdd: string[] = [];
    if (Array.isArray(input.add)) {
      for (const cs of input.add) {
        if (typeof cs !== 'string' || cs.length === 0) continue;
        if (cs === assignee || cs === originator) continue;
        if (currentSet.has(cs)) continue;
        if (toAdd.includes(cs)) continue;
        toAdd.push(cs);
      }
    }

    // Compute the net removals: entries in `remove` that actually are
    // current watchers. Entries that aren't currently watchers are
    // silently dropped.
    const toRemove: string[] = [];
    if (Array.isArray(input.remove)) {
      for (const cs of input.remove) {
        if (typeof cs !== 'string' || cs.length === 0) continue;
        if (!currentSet.has(cs)) continue;
        if (toRemove.includes(cs)) continue;
        toRemove.push(cs);
      }
    }

    if (toAdd.length === 0 && toRemove.length === 0) {
      return { objective: current, events: [] };
    }

    // Build the new watchers list: start from current, add new, remove
    // removed. Preserve original order for stability, append new at end.
    const removeSet = new Set(toRemove);
    const nextWatchers = current.watchers.filter((w) => !removeSet.has(w));
    for (const w of toAdd) nextWatchers.push(w);

    const events: ObjectiveEvent[] = [];
    const tx = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');
    tx.run();
    try {
      this.updateWatchersStmt.run(JSON.stringify(nextWatchers), now, id);
      for (const w of toAdd) {
        events.push(this.appendEvent(id, now, actor, 'watcher_added', { name: w }));
      }
      for (const w of toRemove) {
        events.push(this.appendEvent(id, now, actor, 'watcher_removed', { name: w }));
      }
      commit.run();
    } catch (err) {
      rollback.run();
      throw err;
    }

    const updated = this.get(id);
    if (!updated) throw new ObjectivesError('not_found', `objective ${id} not found`);
    return { objective: updated, events };
  }

  setAttachments(id: string, attachments: Attachment[], now = Date.now()): Objective {
    const current = this.get(id);
    if (!current) throw new ObjectivesError('not_found', `objective ${id} not found`);
    this.updateAttachmentsStmt.run(JSON.stringify(attachments), now, id);
    const updated = this.get(id);
    if (!updated) throw new ObjectivesError('not_found', `objective ${id} vanished after update`);
    return updated;
  }

  /**
   * Amend the contract. Requires `objectives.create` upstream.
   *
   * Writes the new text to the row AND appends an `amended` event
   * carrying the superseded values. One write satisfies two criteria:
   * a reader gets current text directly from the row, and prior
   * versions stay recoverable from the append-only log — with no diff
   * to replay for either.
   *
   * An amendment that changes nothing is REJECTED rather than
   * recorded. A no-op version bump would make the record say a
   * contract moved when it did not, which is the same class of lie
   * this exists to remove.
   */
  amend(
    id: string,
    input: AmendObjectiveRequest,
    actor: string,
    now: number = Date.now(),
  ): ObjectivesMutationResult {
    const row = this.getStmt.get(id) as unknown as ObjectiveRow | undefined;
    if (!row) throw new ObjectivesError('not_found', `objective ${id} not found`);

    const fields: AmendableField[] = [];
    const previous: Partial<Record<AmendableField, string>> = {};
    const next = { title: row.title, outcome: row.outcome, body: row.body };
    if (input.title !== undefined && input.title !== row.title) {
      fields.push('title');
      previous.title = row.title;
      next.title = input.title;
    }
    if (input.outcome !== undefined && input.outcome !== row.outcome) {
      fields.push('outcome');
      previous.outcome = row.outcome;
      next.outcome = input.outcome;
    }
    if (input.body !== undefined && input.body !== row.body) {
      fields.push('body');
      previous.body = row.body;
      next.body = input.body;
    }
    if (fields.length === 0) {
      throw new ObjectivesError(
        'invalid_input',
        'amendment changes nothing — supply a title, outcome or body that differs',
      );
    }

    const version = (row.outcome_version ?? 1) + 1;
    const amendment: ObjectiveAmendment = {
      target: 'contract',
      version,
      ts: now,
      actor,
      disposition: input.disposition,
      reason: input.reason,
      fields,
      previous,
    };

    // ONE TRANSACTION, and it is the whole invariant. Two writes:
    // the row moves to the new text, and the append-only log gains the
    // superseded text. If the second fails and the first stands, the
    // contract has changed and its prior text and reason are
    // unrecoverable — precisely the state this store exists to make
    // impossible, and worse than the immutability it replaces.
    //
    // The caller also sees a 500 in that case, so they are told the
    // amendment failed while the contract actually moved.
    let event: ObjectiveEvent;
    this.db.prepare('BEGIN').run();
    try {
      this.db
        .prepare(
          `UPDATE objectives SET title = ?, outcome = ?, body = ?, outcome_version = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(next.title, next.outcome, next.body, version, now, id);
      event = this.appendEvent(id, now, actor, 'amended', {
        ...amendment,
      } as unknown as Record<string, unknown>);
      this.db.prepare('COMMIT').run();
    } catch (err) {
      try {
        this.db.prepare('ROLLBACK').run();
      } catch {
        /* rollback of a failed tx can itself fail — nothing to do */
      }
      throw err;
    }

    return { objective: this.get(id) as Objective, events: [event] };
  }

  /**
   * Correct an earlier lifecycle event.
   *
   * The target event is NEVER rewritten — this appends a superseding
   * record naming it by timestamp. The motivating case is a
   * completion recorded at a PR head rather than the merge SHA, where
   * the author could only mark it "provisional" in prose.
   *
   * Does not touch `outcome_version`: correcting the record of what
   * happened is not a change to the contract that work was built
   * against.
   */
  correctEvent(
    id: string,
    input: CorrectObjectiveEventRequest,
    actor: string,
    now: number = Date.now(),
  ): ObjectivesMutationResult {
    const row = this.getStmt.get(id) as unknown as ObjectiveRow | undefined;
    if (!row) throw new ObjectivesError('not_found', `objective ${id} not found`);

    // Selected by durable id, so the target is unambiguous by
    // construction rather than by validation. The ambiguity guard below
    // should be unreachable; it is kept because a guard on an
    // unreachable state is cheap and fails loudly if the assumption
    // stops holding.
    const candidates = (this.listEventsStmt.all(id) as unknown as ObjectiveEventRow[]).filter(
      (e) => e.event_id === input.eventId && e.kind !== 'event_corrected',
    );
    if (candidates.length === 0) {
      throw new ObjectivesError(
        'not_found',
        `no correctable event '${input.eventId}' on objective ${id}`,
      );
    }
    if (candidates.length > 1) {
      throw new ObjectivesError(
        'invalid_transition',
        `event id '${input.eventId}' matches ${candidates.length} events on objective ${id}`,
      );
    }
    const target = candidates[0] as ObjectiveEventRow;

    const amendment: ObjectiveAmendment = {
      target: 'event',
      ts: now,
      actor,
      reason: input.reason,
      eventId: input.eventId,
      eventKind: ObjectiveEventKindSchema.parse(target.kind),
      eventTs: target.ts,
      correction: input.correction,
    };
    const event = this.appendEvent(id, now, actor, 'event_corrected', {
      ...amendment,
    } as unknown as Record<string, unknown>);
    return { objective: this.get(id) as Objective, events: [event] };
  }

  private appendEvent(
    id: string,
    ts: number,
    actor: string,
    kind: ObjectiveEventKind,
    payload: Record<string, unknown>,
  ): ObjectiveEvent {
    // Stamp the contract version current at emission onto every
    // lifecycle event. This is what makes "which contract was this
    // work built against" a field on the completion rather than a
    // reconstruction from timestamps — and it is what stops an
    // amendment landing mid-flight from silently moving goalposts.
    //
    // Amendment records carry their own `version`, so they are left
    // alone.
    let stamped = payload;
    if (kind !== 'amended' && kind !== 'event_corrected') {
      const row = this.getStmt.get(id) as unknown as ObjectiveRow | undefined;
      stamped = { ...payload, contractVersion: row?.outcome_version ?? 1 };
    }
    const eventId = `ev-${globalThis.crypto.randomUUID()}`;
    this.insertEventStmt.run(eventId, id, ts, actor, kind, JSON.stringify(stamped));
    return { id: eventId, objectiveId: id, ts, actor, kind, payload: stamped };
  }
}

export function createSqliteObjectivesStore(db: DatabaseSyncInstance): ObjectivesStore {
  return new SqliteObjectivesStore(db);
}

let objectiveCounter = 0;
function generateObjectiveId(): string {
  // Human-readable ids: obj-<ms>-<counter>. Unique within a process
  // even when two creations land in the same millisecond. Not globally
  // unique across processes — objectives are team-scoped and the
  // server is single-process, so this is fine.
  objectiveCounter = (objectiveCounter + 1) & 0xffff;
  return `obj-${Date.now().toString(36)}-${objectiveCounter.toString(36)}`;
}
