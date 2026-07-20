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
 *   briefing composer and tool-description builder both surface it so
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
  Attachment,
  CancelObjectiveRequest,
  CompleteObjectiveRequest,
  CreateObjectiveRequest,
  Objective,
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
    attachments TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS objectives_assignee_idx ON objectives (assignee);
  CREATE INDEX IF NOT EXISTS objectives_status_idx ON objectives (status);
  CREATE INDEX IF NOT EXISTS objectives_created_idx ON objectives (created_at);

  CREATE TABLE IF NOT EXISTS objective_events (
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

function rowToObjective(row: ObjectiveRow): Objective {
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
  };
}

function rowToEvent(row: ObjectiveEventRow): ObjectiveEvent {
  const kind = ObjectiveEventKindSchema.parse(row.kind);
  return {
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
    ]) {
      try {
        this.db.exec(alter);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (!msg.includes('duplicate column name')) throw err;
      }
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
      'INSERT INTO objective_events (objective_id, ts, actor, kind, payload) VALUES (?, ?, ?, ?, ?)',
    );
    this.listEventsStmt = db.prepare(
      'SELECT * FROM objective_events WHERE objective_id = ? ORDER BY ts ASC, ROWID ASC',
    );
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
    return rows.map(rowToObjective);
  }

  get(id: string): Objective | null {
    const row = this.getStmt.get(id) as unknown as ObjectiveRow | undefined;
    return row ? rowToObjective(row) : null;
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
          from: current.assignee,
          to: input.to,
          ...(input.note ? { note: input.note.trim() } : {}),
        }),
      );
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

  private appendEvent(
    id: string,
    ts: number,
    actor: string,
    kind: ObjectiveEventKind,
    payload: Record<string, unknown>,
  ): ObjectiveEvent {
    this.insertEventStmt.run(id, ts, actor, kind, JSON.stringify(payload));
    return { objectiveId: id, ts, actor, kind, payload };
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
