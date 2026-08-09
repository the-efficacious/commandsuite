/**
 * The annex — the spine's store, and the correctness core of the whole
 * system.
 *
 * Every guarantee the spine makes lives in the write path below:
 * staleness discovered rather than detected, idempotent recovery,
 * honest provenance, verdicts that cannot be self-issued, completion
 * that cannot outrun its evidence. It is deliberately assembled from
 * solved problems — an append-only table, an optimistic precondition,
 * and folds that can be thrown away and recomputed. That it is boring
 * is the design working, not the feature being small.
 *
 * FOUR THINGS THIS STORE WILL NOT DO, from §10:
 *
 *   never remove a photo        no update or delete touches
 *                               `spine_events`; corrections staple.
 *   never let a derived value   a revision is `{value, how, source,
 *   render bare                 at}` or it is not a revision.
 *   never retarget silently     a contract's subject and revision are
 *                               written once; supersession links a
 *                               successor and leaves the old one
 *                               terminal where it stood.
 *   never light the room        every read is "as of" a `seq`, and
 *                               staleness is reported, never repaired.
 *
 * AND ONE PROPERTY ENFORCED FROM OUTSIDE: nothing here imports the
 * trace, capture, or gen-ai layers. Correctness may depend only on the
 * floor — acts, not minds — so a runner that reveals nothing about its
 * context must get exactly the same answers as one that reveals
 * everything. `spine-opaque-runner.test.ts` holds that from the
 * outside, because a rule about imports is not something a reviewer
 * reliably notices.
 */

import {
  AppendSpineEventRequestSchema,
  RegisterSpineSubjectRequestSchema,
} from 'csuite-sdk/schemas';
import type {
  AppendSpineEventRequest,
  ListSpineContractsQuery,
  ListSpineEventsQuery,
  ListSpineEventsResponse,
  ListSpineSubjectsQuery,
  OrientContract,
  OrientPack,
  RegisterSpineSubjectRequest,
  SpineAmendmentBody,
  SpineAsk,
  SpineAskActionBody,
  SpineAskBody,
  SpineAskState,
  SpineBinding,
  SpineContract,
  SpineContractState,
  SpineCriterion,
  SpineCriterionStatus,
  SpineCriterionVerdictBody,
  SpineEvent,
  SpineEventBody,
  SpineEventClass,
  SpineEventKind,
  SpineLifecycleBody,
  SpineProceedingBody,
  SpineProvenance,
  SpineRevision,
  SpineRulingBody,
  SpineSpecificationBody,
  SpineSubject,
} from 'csuite-sdk/types';
import { SPINE_EVENT_CLASSES, SPINE_TERMINAL_STATES } from 'csuite-sdk/types';
import type { DatabaseSyncInstance } from '../db.js';
import { SpineError, staleStateRev } from './errors.js';
import { SPINE_PROJECTION_TABLES, SPINE_SCHEMA } from './schema.js';
import { eventId, revisionId } from './ulid.js';

/** Default page size for `events()`. The schema caps an explicit `limit` at 500. */
export const SPINE_EVENTS_DEFAULT_LIMIT = 100;

const TERMINAL: ReadonlySet<SpineContractState> = new Set(SPINE_TERMINAL_STATES);

export interface AppendContext {
  /** `member`, `probe:<id>`, or `integration:<id>`. */
  actor: string;
  /**
   * `legacy_projection` is permanent: an imported row never acquires
   * native status, because nobody ever took that photograph.
   */
  provenance?: SpineProvenance;
  now?: number;
}

export interface AppendResult {
  event: SpineEvent;
  /** The contract as it stands after the append, when the event named one. */
  contract: SpineContract | null;
  /** True when an `opId` replay resolved to an event that already existed. */
  replayed: boolean;
}

/**
 * The annex's public surface.
 *
 * There is exactly one write method for events and it only appends.
 * No update, no delete, no "fix this row" — the absence is the
 * architecture, and `spine-boundary.test-d.ts` puts the hostile calls
 * in front of the compiler so the absence cannot rot into a comment.
 */
export interface AnnexStore {
  /** The single append path. Every rule in the system is applied here. */
  append(input: AppendSpineEventRequest, ctx: AppendContext): AppendResult;
  event(id: string): SpineEvent | null;
  /** Cursor + filters, complete pages. `subject` resolves containment transitively. */
  events(query?: ListSpineEventsQuery): ListSpineEventsResponse;
  /** Idempotent on an identical re-registration; refuses a conflicting one. */
  registerSubject(
    input: RegisterSpineSubjectRequest,
    registeredBy: string,
    now?: number,
  ): SpineSubject;
  subject(id: string): SpineSubject | null;
  subjects(query?: ListSpineSubjectsQuery): SpineSubject[];
  revision(id: string): SpineRevision | null;
  contract(id: string): SpineContract | null;
  contracts(query?: ListSpineContractsQuery): SpineContract[];
  ask(id: string): SpineAsk | null;
  /** The Guaranteed Pack. The recovery call, and cheap by construction. */
  orient(member: string, now?: number): OrientPack;
  /** Drop every projection and refold the stream. The annex is the only truth. */
  rebuildProjections(): void;
}

// ─── Rows ─────────────────────────────────────────────────────────────

interface EventRow {
  seq: number;
  id: string;
  kind: string;
  class: string;
  subject_id: string | null;
  revision_id: string | null;
  actor: string;
  authored_by: string | null;
  at: string;
  provenance: string;
  op_id: string | null;
  cites: string;
  staples_to: string | null;
  body: string;
  contract_id?: string | null;
  state_rev?: number | null;
}

interface SubjectRow {
  id: string;
  type: string;
  parent: string | null;
  registered_by: string;
  at: string;
}

interface RevisionRow {
  id: string;
  subject_id: string;
  value: string;
  how: string;
  source: string;
  at: string;
}

interface ContractRow {
  id: string;
  title: string;
  state: string;
  state_rev: number;
  version: number;
  subject_id: string;
  revision_id: string | null;
  criteria: string;
  assignee: string;
  verifier: string | null;
  authority: string | null;
  constraints: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  waiting_on: string | null;
  waiting_for: string | null;
  preempted_by: string | null;
  result: string | null;
  reason: string | null;
  successor: string | null;
  spec_seq: number;
}

interface VerdictRow {
  contract_id: string;
  criterion_id: string;
  revision_id: string;
  decision: string;
  event_id: string;
  actor: string;
  seq: number;
  at: string;
}

interface WaiverRow {
  contract_id: string;
  criterion_id: string;
  revision_id: string;
  ruling_event_id: string;
}

interface AskRow {
  id: string;
  authority: string;
  asker: string;
  subject_id: string | null;
  contract_id: string | null;
  question: string;
  context: string;
  unblocks: string;
  state: string;
  resolved_by: string | null;
  at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Canonical JSON: object keys sorted, recursively.
 *
 * Payload identity has to be decided on bytes, because the alternative
 * is a hand-written deep comparison that is complete on the day it is
 * written and silently partial the day a field is added. Key order out
 * of `JSON.stringify` follows insertion order, so two semantically
 * identical retries can serialize differently — hence the sort.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The payload an `opId` is identity for.
 *
 * `expectedStateRev` is deliberately EXCLUDED. It is a precondition,
 * not content: a caller retrying a lost write after reading the
 * intervening events supplies a newer counter and means the same
 * write, and treating that as a different payload would refuse the one
 * retry the whole mechanism exists to make free.
 */
function opPayload(input: AppendSpineEventRequest, actor: string): string {
  return canonicalJson({
    // THE ACTOR IS PART OF THE IDENTITY.
    //
    // Without it an `op_id` was a bearer token for someone else's
    // write: any member who learned lea's id and payload got
    // `replayed: true` and lea's event back as their own success. The
    // worst shape was the structurally forbidden one — the assignee,
    // who may not post a verdict at all, could replay the verifier's
    // and be told it worked. An idempotency key answers "did MY write
    // land", and whose write it was is the first half of that question.
    actor,
    kind: input.kind,
    body: input.body,
    subject: input.subject ?? null,
    revision: input.revision ?? null,
    cites: input.cites ?? [],
    staplesTo: input.staplesTo ?? null,
    authoredBy: input.authoredBy ?? null,
  });
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

/**
 * "a ask_action" is the tell that a message was assembled rather than
 * written, and an agent reading a refusal is the consumer here.
 */
function indefiniteArticle(word: string): 'a' | 'an' {
  return /^[aeiou]/.test(word) ? 'an' : 'a';
}

function parseJson<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new SpineError(
      'invalid_input',
      `unreadable ${what} column in the annex: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function rowToEvent(row: EventRow): SpineEvent {
  return {
    seq: row.seq,
    id: row.id,
    kind: row.kind as SpineEventKind,
    class: row.class as SpineEventClass,
    subject: row.subject_id,
    revision: row.revision_id,
    actor: row.actor,
    authoredBy: row.authored_by,
    at: row.at,
    provenance: row.provenance as SpineProvenance,
    opId: row.op_id,
    cites: parseJson<string[]>(row.cites, 'cites'),
    staplesTo: row.staples_to,
    body: parseJson<SpineEventBody>(row.body, 'body'),
    contract: row.contract_id ?? null,
    stateRev: row.state_rev ?? null,
  };
}

function rowToSubject(row: SubjectRow): SpineSubject {
  return {
    id: row.id,
    type: row.type as SpineSubject['type'],
    parent: row.parent,
    registeredBy: row.registered_by,
    at: row.at,
  };
}

function rowToRevision(row: RevisionRow): SpineRevision {
  return {
    id: row.id,
    subject: row.subject_id,
    value: row.value,
    how: row.how as SpineRevision['how'],
    source: row.source,
    at: row.at,
  };
}

function rowToAsk(row: AskRow): SpineAsk {
  return {
    id: row.id,
    authority: row.authority,
    asker: row.asker,
    subject: row.subject_id,
    contract: row.contract_id,
    question: row.question,
    context: row.context,
    unblocks: row.unblocks,
    state: row.state as SpineAskState,
    resolvedBy: row.resolved_by,
    at: row.at,
  };
}

/** Only the body knows which contract it is about, and only for some kinds. */
function contractInBody(kind: SpineEventKind, body: SpineEventBody): string | null {
  switch (kind) {
    case 'amendment':
    case 'attempt':
    case 'criterion_verdict':
    case 'lifecycle':
      return (body as { contract: string }).contract;
    case 'ruling':
    case 'ask':
    case 'discussion':
      return (body as { contract?: string }).contract ?? null;
    default:
      return null;
  }
}

// ─── The store ────────────────────────────────────────────────────────

class SqliteAnnexStore implements AnnexStore {
  private readonly db: DatabaseSyncInstance;

  constructor(db: DatabaseSyncInstance) {
    this.db = db;
    db.exec(SPINE_SCHEMA);
  }

  // ─── Subjects ───────────────────────────────────────────────────

  registerSubject(
    input: RegisterSpineSubjectRequest,
    registeredBy: string,
    now: number = Date.now(),
  ): SpineSubject {
    const parsed = RegisterSpineSubjectRequestSchema.parse(input);
    const existing = this.subject(parsed.id);
    if (existing !== null) {
      // Integrations re-register the subjects their observations name
      // on every webhook, so an identical registration has to be a
      // no-op rather than a conflict. A DIFFERENT one is refused: a
      // subject whose type or containment moved under it would
      // silently change the scope of every rule declared on it.
      const sameParent = (parsed.parent ?? null) === existing.parent;
      if (existing.type === parsed.type && sameParent) return existing;
      throw new SpineError(
        'invalid_input',
        `subject ${parsed.id} is already registered as ${existing.type} under ` +
          `${existing.parent ?? '(root)'} — re-registering it as ${parsed.type} under ` +
          `${parsed.parent ?? '(root)'} would move every rule scoped to it`,
      );
    }
    if (parsed.parent !== undefined && this.subject(parsed.parent) === null) {
      throw new SpineError(
        'not_found',
        `parent subject ${parsed.parent} is not registered — containment is declared, ` +
          'not inferred, so the parent has to exist first',
      );
    }
    this.db
      .prepare(
        'INSERT INTO spine_subjects (id, type, parent, registered_by, at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(parsed.id, parsed.type, parsed.parent ?? null, registeredBy, iso(now));
    return this.subject(parsed.id) as SpineSubject;
  }

  subject(id: string): SpineSubject | null {
    const row = this.db.prepare('SELECT * FROM spine_subjects WHERE id = ?').get(id) as
      | SubjectRow
      | undefined;
    return row ? rowToSubject(row) : null;
  }

  subjects(query: ListSpineSubjectsQuery = {}): SpineSubject[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.type !== undefined) {
      where.push('type = ?');
      params.push(query.type);
    }
    if (query.parent !== undefined) {
      where.push('parent = ?');
      params.push(query.parent);
    }
    if (query.within !== undefined) {
      const contained = this.containedSubjects(query.within);
      where.push(`id IN (${contained.map(() => '?').join(',')})`);
      params.push(...contained);
    }
    const sql = `SELECT * FROM spine_subjects${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at ASC, id ASC`;
    const rows = this.db.prepare(sql).all(...(params as never[])) as unknown as SubjectRow[];
    return rows.map(rowToSubject);
  }

  /**
   * A subject and everything inside it, transitively.
   *
   * Transitive because a rule declared on a repo has to reach a file in
   * it — otherwise acting one level down bypasses a rule declared one
   * level up, which is the whole reason containment is declared at all.
   * Always returns at least the subject itself, so an unregistered id
   * yields a one-element list rather than an empty `IN ()`.
   */
  private containedSubjects(root: string): string[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE contained(id) AS (
           SELECT ?
           UNION
           SELECT s.id FROM spine_subjects s JOIN contained c ON s.parent = c.id
         )
         SELECT id FROM contained`,
      )
      .all(root) as unknown as { id: string }[];
    return rows.length > 0 ? rows.map((r) => r.id) : [root];
  }

  revision(id: string): SpineRevision | null {
    const row = this.db.prepare('SELECT * FROM spine_revisions WHERE id = ?').get(id) as
      | RevisionRow
      | undefined;
    return row ? rowToRevision(row) : null;
  }

  /**
   * The subject's head: its latest OBSERVED revision, by ARRIVAL.
   *
   * Asserted revisions deliberately do not move it. A member naming a
   * SHA by hand is saying what they believe; letting that flip every
   * other contract on the subject to stale would let one member's
   * belief rewrite everyone else's staleness.
   *
   * ORDERED BY `rowid`, NOT BY `at`. `at` is a CAPTION — supplied by
   * the caller, optional, and trusted only as a statement about when
   * the photo was taken. Ordering on it let one future-dated
   * observation (clock skew, or a backfill naming a real historical
   * instant) pin the head permanently: every later observation sorted
   * behind it, the whole subject's staleness became false, and nothing
   * could correct it because nothing removes a revision. The annex's
   * own monotonic counters are the only clock it may trust for
   * ordering, and `at` stays what it is — evidence about the world,
   * not an index into the store.
   */
  private headRevisions(subjectIds: readonly string[]): Map<string, RevisionRow> {
    const heads = new Map<string, RevisionRow>();
    if (subjectIds.length === 0) return heads;
    const rows = this.db
      .prepare(
        `SELECT * FROM spine_revisions
         WHERE how = 'observed' AND subject_id IN (${subjectIds.map(() => '?').join(',')})
         ORDER BY rowid ASC`,
      )
      .all(...(subjectIds as never[])) as unknown as RevisionRow[];
    // Ascending by arrival, so the last row per subject wins and the
    // map ends up holding the most recently observed.
    for (const row of rows) heads.set(row.subject_id, row);
    return heads;
  }

  // ─── Events ─────────────────────────────────────────────────────

  event(id: string): SpineEvent | null {
    const row = this.db
      .prepare(
        `SELECT e.*, i.contract_id, i.state_rev
         FROM spine_events e LEFT JOIN spine_event_index i ON i.seq = e.seq
         WHERE e.id = ?`,
      )
      .get(id) as EventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  events(query: ListSpineEventsQuery = {}): ListSpineEventsResponse {
    // Refused rather than defaulted. A zero page returns `nextCursor:
    // null`, which the published contract reads as "you have reached
    // the head" — so quietly substituting a default would be kinder
    // than the caller deserves, and answering honestly with an empty
    // page would tell a caller who has seen nothing that they are
    // fully caught up.
    if (query.limit !== undefined && query.limit < 1) {
      throw new SpineError(
        'invalid_input',
        `limit must be at least 1 (got ${query.limit}) — an empty page carries a null cursor, ` +
          'which means "you have reached the head", and that is not true of a page nobody read',
      );
    }
    const limit = query.limit ?? SPINE_EVENTS_DEFAULT_LIMIT;
    const where: string[] = ['e.seq > ?'];
    const params: unknown[] = [query.since_seq ?? 0];
    if (query.kind !== undefined) {
      where.push('e.kind = ?');
      params.push(query.kind);
    }
    if (query.subject !== undefined) {
      const contained = this.containedSubjects(query.subject);
      where.push(`e.subject_id IN (${contained.map(() => '?').join(',')})`);
      params.push(...contained);
    }
    if (query.contract !== undefined) {
      where.push('i.contract_id = ?');
      params.push(query.contract);
    }
    if (query.actor !== undefined) {
      where.push('e.actor = ?');
      params.push(query.actor);
    }
    const rows = this.db
      .prepare(
        `SELECT e.*, i.contract_id, i.state_rev
         FROM spine_events e LEFT JOIN spine_event_index i ON i.seq = e.seq
         WHERE ${where.join(' AND ')}
         ORDER BY e.seq ASC
         LIMIT ?`,
      )
      .all(...([...params, limit] as never[])) as unknown as EventRow[];
    const events = rows.map(rowToEvent);
    const head = this.headSeq();
    // A FULL page always carries a cursor and a short page never does.
    // The cheap alternative — "cursor when anything is left" — needs a
    // second count and gets it wrong in exactly the case that matters,
    // because a filter can leave rows behind that the page did not
    // reach.
    const last = events.at(-1);
    const nextCursor = events.length === limit && last !== undefined ? last.seq : null;
    return { events, nextCursor, headSeq: head };
  }

  private headSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS head FROM spine_events').get() as
      | { head: number | null }
      | undefined;
    return row?.head ?? 0;
  }

  // ─── Contracts ──────────────────────────────────────────────────

  contract(id: string): SpineContract | null {
    const row = this.db.prepare('SELECT * FROM spine_contracts WHERE id = ?').get(id) as
      | ContractRow
      | undefined;
    if (!row) return null;
    return this.decorateContracts([row])[0] as SpineContract;
  }

  contracts(query: ListSpineContractsQuery = {}): SpineContract[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.state !== undefined) {
      where.push('state = ?');
      params.push(query.state);
    }
    if (query.subject !== undefined) {
      const contained = this.containedSubjects(query.subject);
      where.push(`subject_id IN (${contained.map(() => '?').join(',')})`);
      params.push(...contained);
    }
    if (query.member !== undefined) {
      where.push('(assignee = ? OR verifier = ? OR authority = ?)');
      params.push(query.member, query.member, query.member);
    }
    const sql = `SELECT * FROM spine_contracts${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY spec_seq ASC`;
    const rows = this.db.prepare(sql).all(...(params as never[])) as unknown as ContractRow[];
    return this.decorateContracts(rows);
  }

  /**
   * Attach the two fields that are not stored: `stale` and `head`.
   *
   * Computed on read rather than written on the contract, because
   * staleness is a RELATION between the contract and the world and the
   * world moves without the contract being touched. A stored flag
   * would need every observation to update every contract on the
   * subject, and would be wrong in between.
   *
   * Batched over the whole result set — one query for the heads and one
   * for the bound revision values — so a hundred contracts cost two
   * queries rather than two hundred.
   */
  private decorateContracts(rows: readonly ContractRow[]): SpineContract[] {
    if (rows.length === 0) return [];
    const heads = this.headRevisions([...new Set(rows.map((r) => r.subject_id))]);
    const boundIds = rows.map((r) => r.revision_id).filter((id): id is string => id !== null);
    const bound = new Map<string, RevisionRow>();
    if (boundIds.length > 0) {
      const revs = this.db
        .prepare(`SELECT * FROM spine_revisions WHERE id IN (${boundIds.map(() => '?').join(',')})`)
        .all(...(boundIds as never[])) as unknown as RevisionRow[];
      for (const rev of revs) bound.set(rev.id, rev);
    }
    return rows.map((row) => {
      const head = heads.get(row.subject_id) ?? null;
      const boundRev = row.revision_id === null ? null : (bound.get(row.revision_id) ?? null);
      // HYDRATED, both of them. `stale` is a claim about the relation
      // between two revisions, and serving it with two opaque ids
      // tells a member they are behind and nothing about what they are
      // behind — a derived value rendering bare, with no route that
      // would resolve it.
      // Compared by VALUE, not by row id. Two observations of the same
      // SHA are two observation points and one head; comparing ids
      // would report a contract stale against a re-observation of the
      // very revision it is bound to.
      const stale = boundRev !== null && head !== null && head.value !== boundRev.value;
      return {
        id: row.id,
        title: row.title,
        state: row.state as SpineContractState,
        stateRev: row.state_rev,
        version: row.version,
        subject: row.subject_id,
        revision: boundRev === null ? null : rowToRevision(boundRev),
        criteria: parseJson<SpineCriterion[]>(row.criteria, 'criteria'),
        assignee: row.assignee,
        verifier: row.verifier,
        authority: row.authority,
        constraints: parseJson<string[]>(row.constraints, 'constraints'),
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        waitingOn: row.waiting_on,
        waitingFor:
          row.waiting_for === null
            ? null
            : parseJson<{ event: string; check: string }>(row.waiting_for, 'waiting_for'),
        preemptedBy: row.preempted_by,
        result: row.result,
        reason: row.reason,
        successor: row.successor,
        stale,
        head: head === null ? null : rowToRevision(head),
      };
    });
  }

  ask(id: string): SpineAsk | null {
    const row = this.db.prepare('SELECT * FROM spine_asks WHERE id = ?').get(id) as
      | AskRow
      | undefined;
    return row ? rowToAsk(row) : null;
  }

  // ─── Append ─────────────────────────────────────────────────────

  append(input: AppendSpineEventRequest, ctx: AppendContext): AppendResult {
    // Parsed HERE and not only at the route. The store is the
    // guarantee point: a migration, a probe, or a future tool handler
    // reaches this method without passing a Hono handler, and an
    // append-only table keeps whatever it is given forever.
    const parsed = AppendSpineEventRequestSchema.parse(input) as AppendSpineEventRequest;
    const now = ctx.now ?? Date.now();
    const at = iso(now);
    const provenance = ctx.provenance ?? 'native';
    const kind = parsed.kind;
    const klass = SPINE_EVENT_CLASSES[kind];

    // ── Idempotency, before anything else has a side effect ──
    if (parsed.opId !== undefined) {
      const prior = this.db.prepare('SELECT * FROM spine_ops WHERE op_id = ?').get(parsed.opId) as
        | { op_id: string; event_id: string; payload: string }
        | undefined;
      if (prior !== undefined) {
        if (prior.payload === opPayload(parsed, ctx.actor)) {
          const original = this.event(prior.event_id);
          if (original === null) {
            throw new SpineError(
              'invalid_input',
              `op ${parsed.opId} names event ${prior.event_id}, which is not in the annex`,
            );
          }
          return {
            event: original,
            contract: original.contract === null ? null : this.contract(original.contract),
            replayed: true,
          };
        }
        throw new SpineError(
          'idempotency_conflict',
          `op_id ${parsed.opId} was already used for a different actor or payload (event ` +
            `${prior.event_id}). Reusing it would either duplicate that event or hand you ` +
            "somebody else's; pick a new op_id for a new write.",
          { opId: parsed.opId, originalEvent: prior.event_id },
        );
      }
    }

    // ── Captions must resolve ──
    if (parsed.subject !== undefined && this.subject(parsed.subject) === null) {
      throw new SpineError(
        'not_found',
        `subject ${parsed.subject} is not registered — register it before saying anything about it`,
      );
    }
    for (const cited of parsed.cites ?? []) {
      if (this.event(cited) === null) {
        throw new SpineError(
          'not_found',
          `cited event ${cited} is not in the annex. A citation to an event that does not ` +
            'exist is exactly the remembered-authorisation failure the annex is here to remove.',
        );
      }
    }
    if (parsed.staplesTo !== undefined && this.event(parsed.staplesTo) === null) {
      throw new SpineError('not_found', `cannot staple to ${parsed.staplesTo}: no such event`);
    }
    if (parsed.revision !== undefined && this.subject(parsed.revision.subject) === null) {
      throw new SpineError(
        'not_found',
        `revision names subject ${parsed.revision.subject}, which is not registered`,
      );
    }

    // ── The contract this write touches, if any ──
    const contractId = this.resolveContractId(kind, parsed.body, parsed);
    const contract = contractId === null ? null : this.contract(contractId);
    if (contractId !== null && contract === null && kind !== 'specification') {
      throw new SpineError('not_found', `no such contract: ${contractId}`);
    }

    if (contract !== null && klass === 'authoritative' && kind !== 'correction') {
      if (TERMINAL.has(contract.state)) {
        // A TERMINAL REFUSAL CARRIES ITS DELTA TOO.
        //
        // This is the one case where staleness is not suspected but
        // PROVEN — the caller is writing to a contract that has since
        // ended — and it used to be the only refusal that told them
        // nothing about what they missed. §6 says the refusal IS the
        // re-injection; a caller who has to make a second call to
        // discover the contract is over has been re-injected with
        // nothing. The delta includes the event that terminated it,
        // which is precisely the thing they need to read.
        const behind =
          parsed.expectedStateRev !== undefined && parsed.expectedStateRev < contract.stateRev;
        throw new SpineError(
          'invalid_transition',
          `contract ${contract.id} is ${contract.state} and terminal, at state_rev ` +
            `${contract.stateRev}. ` +
            (behind
              ? `You wrote against ${parsed.expectedStateRev as number}; the ` +
                'authoritative events you missed are in this refusal in full, and no retry ' +
                'against a newer counter will succeed — the contract has ended. '
              : '') +
            'A correction can still be stapled to any event on it, including a terminal one — ' +
            'that is the only way a terminal record changes, and it never rewrites what it ' +
            'corrects.',
          {
            contract: contract.id,
            expectedStateRev: parsed.expectedStateRev ?? contract.stateRev,
            currentStateRev: contract.stateRev,
            intervening: behind
              ? this.interveningEvents(contract.id, parsed.expectedStateRev as number)
              : [],
          },
        );
      }
    }

    // ── The precondition ──
    if (contract !== null && klass === 'authoritative') {
      if (parsed.expectedStateRev === undefined) {
        throw new SpineError(
          'invalid_input',
          `${indefiniteArticle(kind)} ${kind} on contract ${contract.id} is a state-changing ` +
            'write and must carry ' +
            `expectedStateRev (currently ${contract.stateRev})`,
          {
            contract: contract.id,
            path: ['expectedStateRev'],
            currentStateRev: contract.stateRev,
            problem: 'missing',
            suppliedStateRev: null,
          },
        );
      }
      // AHEAD OF THE HEAD IS NOT STALENESS.
      //
      // A precondition above the contract's counter names a revision
      // that has never existed, so there is no delta and never will
      // be. Routing it through the stale refusal produced a message
      // that contradicted itself — "0 events landed while you were
      // away… they are in the refusal in full" — and a caller cannot
      // act on a contradiction.
      if (parsed.expectedStateRev > contract.stateRev) {
        throw new SpineError(
          'invalid_input',
          `expectedStateRev ${parsed.expectedStateRev} is ahead of contract ${contract.id}, ` +
            `which is at ${contract.stateRev}. You cannot have seen a state this contract has ` +
            'never reached, so there is no delta to return — re-read the contract.',
          {
            contract: contract.id,
            path: ['expectedStateRev'],
            currentStateRev: contract.stateRev,
            problem: 'ahead',
            suppliedStateRev: parsed.expectedStateRev,
          },
        );
      }
      if (parsed.expectedStateRev !== contract.stateRev) {
        throw staleStateRev(
          contract.id,
          parsed.expectedStateRev,
          contract.stateRev,
          this.interveningEvents(contract.id, parsed.expectedStateRev),
        );
      }
    }

    this.assertStructurallyLegitimate(kind, parsed, ctx.actor, contract);

    // ── Write ──
    const id = eventId(now);
    this.db.prepare('BEGIN').run();
    try {
      let resolvedRevision: string | null = null;
      if (parsed.revision !== undefined) {
        // A revision row per reference. Two observations of the same
        // value ARE two observation points — different instants,
        // possibly different sources — and collapsing them would lose
        // the second one's caption, which is the only thing that makes
        // it evidence.
        resolvedRevision = revisionId(now);
        this.db
          .prepare(
            'INSERT INTO spine_revisions (id, subject_id, value, how, source, at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            resolvedRevision,
            parsed.revision.subject,
            parsed.revision.value,
            parsed.revision.how,
            parsed.revision.source,
            parsed.revision.at ?? at,
          );
      }
      this.db
        .prepare(
          `INSERT INTO spine_events
             (id, kind, class, subject_id, revision_id, actor, authored_by, at, provenance,
              op_id, cites, staples_to, body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          kind,
          klass,
          parsed.subject ?? null,
          resolvedRevision,
          ctx.actor,
          parsed.authoredBy ?? null,
          at,
          provenance,
          parsed.opId ?? null,
          JSON.stringify(parsed.cites ?? []),
          parsed.staplesTo ?? null,
          JSON.stringify(parsed.body),
        );
      if (parsed.opId !== undefined) {
        this.db
          .prepare('INSERT INTO spine_ops (op_id, event_id, payload, at) VALUES (?, ?, ?, ?)')
          .run(parsed.opId, id, opPayload(parsed, ctx.actor), at);
      }
      const stored = this.rawEvent(id);
      this.applyToProjections(stored);
      this.db.prepare('COMMIT').run();
    } catch (err) {
      this.db.prepare('ROLLBACK').run();
      throw err;
    }

    const event = this.event(id) as SpineEvent;
    return {
      event,
      contract: event.contract === null ? null : this.contract(event.contract),
      replayed: false,
    };
  }

  /** The stored row, before the projection has an opinion about it. */
  private rawEvent(id: string): SpineEvent {
    const row = this.db.prepare('SELECT * FROM spine_events WHERE id = ?').get(id) as
      | EventRow
      | undefined;
    if (row === undefined) throw new SpineError('not_found', `event ${id} vanished mid-write`);
    return rowToEvent(row);
  }

  /**
   * Which contract an event is about.
   *
   * Three routes, and only the first is in the body. A correction
   * reaches a contract through the event it staples to and a promotion
   * through the post it cites, so a correction to a verdict advances
   * the contract's counter exactly as the verdict did — which is what
   * makes a stale caller notice that the record moved under them.
   */
  private resolveContractId(
    kind: SpineEventKind,
    body: SpineEventBody,
    input: AppendSpineEventRequest,
  ): string | null {
    const inBody = contractInBody(kind, body);
    if (inBody !== null) return inBody;
    if (kind === 'correction' && input.staplesTo !== undefined) {
      return this.event(input.staplesTo)?.contract ?? null;
    }
    if (kind === 'promotion') {
      const origin = input.cites?.[0];
      return origin === undefined ? null : (this.event(origin)?.contract ?? null);
    }
    if (kind === 'ask_action' || kind === 'proceeding') {
      const askId = (body as SpineAskActionBody | SpineProceedingBody).ask;
      return this.ask(askId)?.contract ?? null;
    }
    return null;
  }

  /** The authoritative events on a contract the caller has not seen. In full. */
  private interveningEvents(contractId: string, sinceStateRev: number): SpineEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, i.contract_id, i.state_rev
         FROM spine_events e JOIN spine_event_index i ON i.seq = e.seq
         WHERE i.contract_id = ? AND i.state_rev > ? AND e.class = 'authoritative'
         ORDER BY e.seq ASC`,
      )
      .all(contractId, sinceStateRev) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Legitimacy that no permission leaf grants and none can grant away.
   *
   * These are not authorisation checks with the gate moved into the
   * store; they are properties of what the event MEANS. A verdict is an
   * independent member's observation, so one from the assignee is not a
   * weakly-authorised verdict, it is not a verdict. A ruling is the
   * named authority's declaration, so one from anybody else is not a
   * ruling. Modelling either as a permission would imply the refusal
   * could be granted away, and it cannot be.
   */
  private assertStructurallyLegitimate(
    kind: SpineEventKind,
    input: AppendSpineEventRequest,
    actor: string,
    contract: SpineContract | null,
  ): void {
    if (kind === 'criterion_verdict') {
      const body = input.body as SpineCriterionVerdictBody;
      const target = contract as SpineContract;
      if (actor === target.assignee) {
        throw new SpineError(
          'not_permitted',
          `${actor} is the assignee of ${target.id}. Arrival cannot be declared from the ` +
            "traveller's own album — a verdict is an independent member's fresh observation.",
        );
      }
      if (!target.criteria.some((c) => c.id === body.criterion)) {
        throw new SpineError(
          'invalid_input',
          `contract ${target.id} has no criterion '${body.criterion}' (it has: ` +
            `${target.criteria.map((c) => c.id).join(', ')})`,
        );
      }
    }

    if (kind === 'ruling') {
      const body = input.body as SpineRulingBody;
      const ask = this.ask(body.ask);
      if (ask === null) throw new SpineError('not_found', `no such ask: ${body.ask}`);
      if (ask.authority !== actor) {
        throw new SpineError(
          'not_permitted',
          `ask ${ask.id} names ${ask.authority} as its authority, not ${actor}. A ruling from ` +
            'anyone else is not a weaker ruling; it is not a ruling.',
        );
      }
      if (ask.state !== 'open' && ask.state !== 'deferred') {
        throw new SpineError(
          'invalid_transition',
          `ask ${ask.id} is ${ask.state} and is no longer awaiting a ruling`,
        );
      }
    }

    if (kind === 'ask_action') {
      const body = input.body as SpineAskActionBody;
      const ask = this.ask(body.ask);
      if (ask === null) throw new SpineError('not_found', `no such ask: ${body.ask}`);
      // Withdrawal belongs to whoever asked; the other three are the
      // authority answering, which is a different act with a different
      // owner.
      const owner = body.action === 'withdraw' ? ask.asker : ask.authority;
      if (owner !== actor) {
        throw new SpineError('not_permitted', `only ${owner} can ${body.action} ask ${ask.id}`);
      }
      if (ask.state !== 'open' && ask.state !== 'deferred') {
        throw new SpineError('invalid_transition', `ask ${ask.id} is already ${ask.state}`);
      }
    }

    if (kind === 'proceeding') {
      const body = input.body as SpineProceedingBody;
      const ask = this.ask(body.ask);
      if (ask === null) throw new SpineError('not_found', `no such ask: ${body.ask}`);
      if (ask.state !== 'open' && ask.state !== 'deferred') {
        throw new SpineError(
          'invalid_transition',
          `ask ${ask.id} is ${ask.state}; there is nothing to proceed past`,
        );
      }
    }

    if (kind === 'promotion') {
      const origin = input.cites?.[0];
      const cited = origin === undefined ? null : this.event(origin);
      if (cited === null) throw new SpineError('not_found', `no such event: ${origin}`);
      if (cited.kind !== 'discussion') {
        throw new SpineError(
          'invalid_input',
          `promotion cites ${cited.id}, which is a ${cited.kind}. Promotion turns CHATTER into ` +
            'a typed event; a typed event is already what it is.',
        );
      }
    }

    if (kind === 'amendment') {
      this.assertAmendmentDiscloses(input.body as SpineAmendmentBody, contract as SpineContract);
    }

    if (kind === 'lifecycle') {
      this.assertLifecycleLegal(input, contract as SpineContract);
    }
  }

  /**
   * §5's one stated amendment refusal: removing text without a
   * `disclosure`.
   *
   * WHY IT NEEDS ENFORCING AT ALL. Finding 4 of #155 was "amendments
   * can't undo contamination". A photo seen cannot be unseen, so an
   * amendment that quietly drops a criterion leaves every member who
   * already read it working to a requirement the record no longer
   * admits existed. The prior text survives in the event stream, but
   * "recoverable by whoever thinks to page the annex" is not the same
   * as "disclosed", and the difference is the whole finding.
   *
   * WHAT COUNTS AS REMOVAL, precisely, because a rule this cheap to
   * trip has to be predictable:
   *
   *   a criterion whose id is gone                      removal
   *   a constraint no longer in the list                removal
   *   title or criterion text that is no longer
   *   CONTAINED in its replacement                      removal
   *
   * Containment rather than a length heuristic, so the common honest
   * edits stay free: adding a criterion, adding a constraint,
   * appending a clarification to existing text, and changing nothing
   * textual are all accepted without a disclosure. Rewording is a
   * removal, because a reworded criterion is one that somebody read in
   * a form that is now gone.
   *
   * A SIDE EFFECT WORTH NAMING: dropping a criterion also drops its
   * verdicts from `orient` and from the completion gate, since both
   * read the CURRENT criteria list. That is correct — a criterion that
   * is no longer in the contract cannot block completing it — and it is
   * exactly why the removal itself has to be disclosed rather than
   * merely permitted.
   */
  private assertAmendmentDiscloses(body: SpineAmendmentBody, contract: SpineContract): void {
    if (body.disclosure !== undefined) return;
    const removed: string[] = [];

    if (body.title !== undefined && !body.title.includes(contract.title)) {
      removed.push(`the title "${contract.title}"`);
    }
    if (body.criteria !== undefined) {
      const next = new Map(body.criteria.map((c) => [c.id, c.text]));
      for (const prior of contract.criteria) {
        const replacement = next.get(prior.id);
        if (replacement === undefined) {
          removed.push(`criterion '${prior.id}'`);
        } else if (!replacement.includes(prior.text)) {
          removed.push(`the wording of criterion '${prior.id}'`);
        }
      }
    }
    if (body.constraints !== undefined) {
      const next = body.constraints;
      for (const prior of contract.constraints) {
        if (!next.some((c) => c.includes(prior))) removed.push(`the constraint "${prior}"`);
      }
    }

    if (removed.length === 0) return;
    throw new SpineError(
      'invalid_input',
      `this amendment removes ${removed.join(', ')} from contract ${contract.id} and carries no ` +
        'disclosure. Text that members have already read cannot be made to have never existed — ' +
        'say what was removed and why anyone working to it should know, and the amendment lands. ' +
        'Adding criteria or constraints, and appending to existing text, need no disclosure.',
    );
  }

  private assertLifecycleLegal(input: AppendSpineEventRequest, contract: SpineContract): void {
    const body = input.body as SpineLifecycleBody;

    if (body.state === 'superseded') {
      const successor = body.successor as string;
      if (successor === contract.id) {
        throw new SpineError('invalid_input', 'a contract cannot supersede itself');
      }
      if (this.contract(successor) === null) {
        throw new SpineError(
          'not_found',
          `successor contract ${successor} does not exist. Supersession LINKS a successor; ` +
            'it never retargets this one, so the successor has to have been authored first.',
        );
      }
    }

    if (body.state !== 'done') return;

    // Completion, and the one gate in a warn-never-lock design that
    // refuses rather than warns.
    if (contract.verifier === null) {
      // No verifier named: the result stands alone AND SAYS SO. There
      // is nothing to check, and inventing a check here would be the
      // system taking a photograph.
      return;
    }

    const criteria = contract.criteria;
    const revision = input.revision;
    if (revision === undefined) {
      throw new SpineError(
        'coverage_gap',
        `contract ${contract.id} names ${contract.verifier} as verifier, so completion has to ` +
          'name the revision the verdicts were reached at. A verdict is true of a revision or ' +
          'it is true of nothing.',
        {
          contract: contract.id,
          // Genuinely null here: the completion named no revision, so
          // there is no caption to hand back.
          revision: null,
          missing: criteria.map((c) => ({
            criterion: c.id,
            text: c.text,
            why: 'completion named no revision, so no verdict can cover this criterion',
          })),
        },
      );
    }

    const cited = (input.cites ?? []).map((id) => this.event(id)).filter((e) => e !== null);
    const citedIds = new Set(cited.map((e) => e.id));
    // THE PROJECTION DECIDES, THE CITATION PROVES IT WAS SEEN.
    //
    // Reading only `cites` was a real hole and it is the one the
    // changeset's "completion cannot outrun its evidence" claim rests
    // on: a verifier who posts `met` and then `unmet` at the same
    // revision leaves the contract unmet, and a completion that cites
    // only the superseded `met` used to pass while `orient` reported
    // unmet to everyone looking at it. The cite list is caller-supplied
    // and a caller may cite whatever it likes; the projection is the
    // team's answer. So coverage is read off the projection, and the
    // cite list is used for exactly one thing — proving the completer
    // had the CURRENT verdict in hand.
    const current = this.currentVerdictsAt(contract.id, revision.value);
    const missing: { criterion: string; text: string; why: string }[] = [];
    for (const criterion of criteria) {
      const verdict = current.get(criterion.id);
      if (verdict === undefined) {
        missing.push({
          criterion: criterion.id,
          text: criterion.text,
          why: `no verdict has been reached on this criterion at ${revision.value}`,
        });
        continue;
      }
      if (!citedIds.has(verdict.event_id)) {
        missing.push({
          criterion: criterion.id,
          text: criterion.text,
          why:
            `the current verdict at ${revision.value} is ${verdict.event_id} ` +
            `(${verdict.decision}) and the completion does not cite it` +
            (cited.some(
              (e) =>
                e.kind === 'criterion_verdict' &&
                (e.body as SpineCriterionVerdictBody).criterion === criterion.id,
            )
              ? ' — the verdict cited for this criterion has been superseded'
              : ''),
        });
        continue;
      }
      if (verdict.decision === 'met') continue;
      if (verdict.decision === 'unmet') {
        missing.push({
          criterion: criterion.id,
          text: criterion.text,
          why: `the current verdict ${verdict.event_id} says unmet at ${revision.value}`,
        });
        continue;
      }
      // `cannot_verify`: covered only by the third legal move — the
      // authority's ruling, citing THAT verdict, and itself cited here.
      const waiver = cited.find((e) => e.kind === 'ruling' && e.cites.includes(verdict.event_id));
      if (waiver !== undefined) continue;
      missing.push({
        criterion: criterion.id,
        text: criterion.text,
        why:
          `the current verdict ${verdict.event_id} says cannot_verify at ${revision.value} ` +
          'and no cited ruling waives it',
      });
    }

    if (missing.length > 0) {
      throw new SpineError(
        'coverage_gap',
        `contract ${contract.id} cannot complete at ${revision.value}: ` +
          `${missing.length} of ${criteria.length} criteria are not covered — ` +
          missing.map((m) => `'${m.criterion}' (${m.why})`).join('; '),
        { contract: contract.id, revision, missing },
      );
    }
  }

  /**
   * The CURRENT verdict per criterion at one revision VALUE.
   *
   * By value rather than by revision id, because revisions are never
   * deduplicated: a verdict reached at one observation of `sha-a` and
   * a completion naming another observation of `sha-a` are about the
   * same state of the world and two different rows. Latest by `seq`
   * wins within a value, which is the same latest-wins rule `orient`
   * renders — so the gate and the display can never disagree, and that
   * is the property that broke.
   */
  private currentVerdictsAt(contractId: string, value: string): Map<string, VerdictRow> {
    const rows = this.db
      .prepare(
        `SELECT v.* FROM spine_contract_verdicts v
         JOIN spine_revisions r ON r.id = v.revision_id
         WHERE v.contract_id = ? AND r.value = ?
         ORDER BY v.seq ASC`,
      )
      .all(contractId, value) as unknown as VerdictRow[];
    const latest = new Map<string, VerdictRow>();
    for (const row of rows) latest.set(row.criterion_id, row);
    return latest;
  }

  // ─── The fold ───────────────────────────────────────────────────

  /**
   * THE ONLY WRITER OF PROJECTION STATE.
   *
   * `append` inserts the event and then calls this; `rebuildProjections`
   * replays the whole stream through the same function. Nothing else
   * may touch a projection table — including the `state_rev` bump,
   * which is the field it would be most natural to advance in the
   * write path.
   *
   * That constraint is what makes the rebuild test worth running: if
   * any projection state were maintained outside this function, a
   * rebuilt projection and an incrementally maintained one would
   * disagree, and the test would say so. Keep it that way.
   */
  private applyToProjections(event: SpineEvent): void {
    const contractId =
      event.kind === 'specification' ? event.id : this.resolveContractIdForFold(event);
    let stateRev: number | null = null;

    if (contractId !== null && event.class === 'authoritative') {
      if (event.kind === 'specification') {
        stateRev = 1;
      } else {
        const row = this.db
          .prepare('SELECT state_rev FROM spine_contracts WHERE id = ?')
          .get(contractId) as { state_rev: number } | undefined;
        stateRev = (row?.state_rev ?? 0) + 1;
      }
    }

    this.db
      .prepare('INSERT INTO spine_event_index (seq, contract_id, state_rev) VALUES (?, ?, ?)')
      .run(event.seq, contractId, stateRev);

    switch (event.kind) {
      case 'specification':
        this.foldSpecification(event, stateRev as number);
        break;
      case 'amendment':
        this.foldAmendment(event, contractId as string, stateRev as number);
        break;
      case 'attempt':
        this.touchContract(contractId as string, stateRev, event, { revision: event.revision });
        break;
      case 'criterion_verdict':
        this.foldVerdict(event, contractId as string, stateRev);
        break;
      case 'lifecycle':
        this.foldLifecycle(event, contractId as string, stateRev);
        break;
      case 'ask':
        this.foldAsk(event, contractId);
        this.touchContract(contractId, stateRev, event, {});
        break;
      case 'ruling':
        this.foldRuling(event);
        this.touchContract(contractId, stateRev, event, {});
        break;
      case 'ask_action':
        this.foldAskAction(event);
        this.touchContract(contractId, stateRev, event, {});
        break;
      default:
        this.touchContract(contractId, stateRev, event, {});
        break;
    }
  }

  /** Same three routes as `resolveContractId`, reading a stored event rather than a request. */
  private resolveContractIdForFold(event: SpineEvent): string | null {
    const inBody = contractInBody(event.kind, event.body);
    if (inBody !== null) return inBody;
    if (event.kind === 'correction' && event.staplesTo !== null) {
      return this.contractOfSeq(event.staplesTo);
    }
    if (event.kind === 'promotion') {
      const origin = event.cites[0];
      return origin === undefined ? null : this.contractOfSeq(origin);
    }
    if (event.kind === 'ask_action' || event.kind === 'proceeding') {
      return (
        this.ask((event.body as SpineAskActionBody | SpineProceedingBody).ask)?.contract ?? null
      );
    }
    return null;
  }

  private contractOfSeq(eventIdent: string): string | null {
    const row = this.db
      .prepare(
        `SELECT i.contract_id AS contract_id
         FROM spine_events e JOIN spine_event_index i ON i.seq = e.seq
         WHERE e.id = ?`,
      )
      .get(eventIdent) as { contract_id: string | null } | undefined;
    return row?.contract_id ?? null;
  }

  private foldSpecification(event: SpineEvent, stateRev: number): void {
    const body = event.body as SpineSpecificationBody;
    this.db
      .prepare(
        `INSERT INTO spine_contracts
           (id, title, state, state_rev, version, subject_id, revision_id, criteria, assignee,
            verifier, authority, constraints, created_by, created_at, updated_at,
            waiting_on, waiting_for, preempted_by, result, reason, successor, spec_seq)
         VALUES (?, ?, 'active', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      )
      .run(
        event.id,
        body.title,
        stateRev,
        event.subject as string,
        event.revision,
        JSON.stringify(body.criteria),
        body.assignee,
        body.verifier ?? null,
        body.authority ?? null,
        JSON.stringify(body.constraints ?? []),
        event.actor,
        event.at,
        event.at,
        event.seq,
      );
  }

  private foldAmendment(event: SpineEvent, contractId: string, stateRev: number): void {
    const body = event.body as SpineAmendmentBody;
    const row = this.db.prepare('SELECT * FROM spine_contracts WHERE id = ?').get(contractId) as
      | ContractRow
      | undefined;
    if (row === undefined) return;
    this.db
      .prepare(
        `UPDATE spine_contracts
         SET title = ?, criteria = ?, constraints = ?, version = version + 1,
             state_rev = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        body.title ?? row.title,
        body.criteria === undefined ? row.criteria : JSON.stringify(body.criteria),
        body.constraints === undefined ? row.constraints : JSON.stringify(body.constraints),
        stateRev,
        event.at,
        contractId,
      );
  }

  private foldVerdict(event: SpineEvent, contractId: string, stateRev: number | null): void {
    const body = event.body as SpineCriterionVerdictBody;
    // Keyed by revision, so a verdict at a NEW revision never
    // overwrites the record of what was true at the old one. That is
    // what keeps a superseded contract terminal at its own revision
    // with its verdicts intact.
    this.db
      .prepare(
        `INSERT INTO spine_contract_verdicts
           (contract_id, criterion_id, revision_id, decision, event_id, actor, seq, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(contract_id, criterion_id, revision_id) DO UPDATE SET
           decision = excluded.decision, event_id = excluded.event_id,
           actor = excluded.actor, seq = excluded.seq, at = excluded.at`,
      )
      .run(
        contractId,
        body.criterion,
        event.revision as string,
        body.decision,
        event.id,
        event.actor,
        event.seq,
        event.at,
      );
    this.touchContract(contractId, stateRev, event, {});
  }

  /**
   * States that may move a contract's bound revision. `done(revision)`
   * and nothing else.
   *
   * This list exists because `COALESCE(?, revision_id)` applied to
   * EVERY state, and a `superseded` event that happened to carry the
   * optional revision retargeted the contract it was terminating —
   * flipping `stale` back to false and claiming verdicts reached at the
   * old revision for the new one. That is the silent retargeting §10
   * forbids and the exact incident acceptance 2 is named after,
   * committed by the code meant to prevent it.
   */
  private static readonly REVISION_BINDING_STATES: ReadonlySet<SpineContractState> = new Set([
    'done',
  ]);

  private foldLifecycle(event: SpineEvent, contractId: string, stateRev: number | null): void {
    const body = event.body as SpineLifecycleBody;
    const bindsRevision = SqliteAnnexStore.REVISION_BINDING_STATES.has(body.state);
    this.db
      .prepare(
        `UPDATE spine_contracts
         SET state = ?, state_rev = ?, updated_at = ?,
             waiting_on = ?, waiting_for = ?, preempted_by = ?,
             result = COALESCE(?, result), reason = COALESCE(?, reason),
             successor = COALESCE(?, successor),
             revision_id = COALESCE(?, revision_id)
         WHERE id = ?`,
      )
      .run(
        body.state,
        stateRev ?? 0,
        event.at,
        body.member ?? null,
        body.event !== undefined && body.check !== undefined
          ? JSON.stringify({ event: body.event, check: body.check })
          : null,
        body.preemptedBy ?? null,
        body.result ?? null,
        body.reason ?? null,
        body.successor ?? null,
        bindsRevision ? event.revision : null,
        contractId,
      );
  }

  private foldAsk(event: SpineEvent, contractId: string | null): void {
    const body = event.body as SpineAskBody;
    this.db
      .prepare(
        `INSERT INTO spine_asks
           (id, authority, asker, subject_id, contract_id, question, context, unblocks,
            state, resolved_by, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?)`,
      )
      .run(
        event.id,
        body.authority,
        event.actor,
        event.subject,
        contractId,
        body.question,
        body.context,
        body.unblocks,
        event.at,
      );
  }

  private foldRuling(event: SpineEvent): void {
    const body = event.body as SpineRulingBody;
    this.db
      .prepare("UPDATE spine_asks SET state = 'ruled', resolved_by = ? WHERE id = ?")
      .run(event.id, body.ask);
    // A ruling that cites a `cannot_verify` verdict WAIVES that
    // criterion at that revision — the third legal move after a
    // verifier says they cannot tell.
    for (const citedId of event.cites) {
      const target = this.event(citedId);
      if (target === null || target.kind !== 'criterion_verdict') continue;
      const vb = target.body as SpineCriterionVerdictBody;
      if (vb.decision !== 'cannot_verify') continue;
      if (target.revision === null) continue;
      this.db
        .prepare(
          `INSERT INTO spine_contract_waivers
             (contract_id, criterion_id, revision_id, ruling_event_id)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(contract_id, criterion_id, revision_id)
           DO UPDATE SET ruling_event_id = excluded.ruling_event_id`,
        )
        .run(vb.contract, vb.criterion, target.revision, event.id);
    }
  }

  private foldAskAction(event: SpineEvent): void {
    const body = event.body as SpineAskActionBody;
    const next: Record<string, SpineAskState> = {
      withdraw: 'withdrawn',
      decline: 'declined',
      redirect: 'redirected',
      defer: 'deferred',
    };
    const state = next[body.action] ?? 'open';
    this.db
      .prepare('UPDATE spine_asks SET state = ?, resolved_by = ? WHERE id = ?')
      .run(state, event.id, body.ask);
  }

  /** Advance the counter and the clock on a contract an event touched but did not reshape. */
  private touchContract(
    contractId: string | null,
    stateRev: number | null,
    event: SpineEvent,
    patch: { revision?: string | null },
  ): void {
    if (contractId === null) return;
    if (stateRev === null && patch.revision === undefined) {
      // Ambient event on a contract: the clock moves, the counter does
      // not. Chatter must never be able to invalidate a lifecycle act.
      this.db
        .prepare('UPDATE spine_contracts SET updated_at = ? WHERE id = ?')
        .run(event.at, contractId);
      return;
    }
    this.db
      .prepare(
        `UPDATE spine_contracts
         SET state_rev = COALESCE(?, state_rev), updated_at = ?,
             revision_id = COALESCE(?, revision_id)
         WHERE id = ?`,
      )
      .run(stateRev, event.at, patch.revision ?? null, contractId);
  }

  // ─── Rebuild ────────────────────────────────────────────────────

  rebuildProjections(): void {
    this.db.prepare('BEGIN').run();
    try {
      for (const table of SPINE_PROJECTION_TABLES) this.db.exec(`DELETE FROM ${table}`);
      const rows = this.db
        .prepare('SELECT * FROM spine_events ORDER BY seq ASC')
        .all() as unknown as EventRow[];
      for (const row of rows) this.applyToProjections(rowToEvent(row));
      this.db.prepare('COMMIT').run();
    } catch (err) {
      this.db.prepare('ROLLBACK').run();
      throw err;
    }
  }

  // ─── Orient ─────────────────────────────────────────────────────

  /**
   * The Guaranteed Pack, v0.
   *
   * The recovery call, so it is CHEAP BY CONSTRUCTION: a fixed number
   * of queries whatever the member's plate looks like. Six here, one
   * per relation, each fetching a whole set at once. A per-contract
   * loop would make recovery cost grow with the thing recovery exists
   * to rescue you from, which is exactly backwards.
   */
  orient(member: string, now: number = Date.now()): OrientPack {
    const cursor = this.headSeq();
    const rows = this.db
      .prepare(
        `SELECT * FROM spine_contracts
         WHERE assignee = ? OR verifier = ? OR authority = ?
         ORDER BY spec_seq ASC`,
      )
      .all(member, member, member) as unknown as ContractRow[];
    const contracts = this.decorateContracts(rows);
    const ids = contracts.map((c) => c.id);

    const verdicts = this.rowsIn<VerdictRow>('spine_contract_verdicts', 'contract_id', ids);
    const waivers = this.rowsIn<WaiverRow>('spine_contract_waivers', 'contract_id', ids);
    const subjects = new Map(
      this.rowsIn<SubjectRow>('spine_subjects', 'id', [
        ...new Set(contracts.map((c) => c.subject)),
      ]).map((s) => [s.id, rowToSubject(s)]),
    );
    // The contracts already carry their bound revision and head whole.
    // What still needs hydrating is the revision each VERDICT was
    // reached at — one batched lookup, so the cost stays flat in the
    // size of the member's plate.
    const verdictRevisionIds = [...new Set(verdicts.map((v) => v.revision_id))];
    const revisions = new Map(
      this.rowsIn<RevisionRow>('spine_revisions', 'id', verdictRevisionIds).map((r) => [
        r.id,
        rowToRevision(r),
      ]),
    );
    const rulings =
      ids.length === 0
        ? []
        : (this.db
            .prepare(
              `SELECT e.*, i.contract_id, i.state_rev
               FROM spine_events e JOIN spine_event_index i ON i.seq = e.seq
               WHERE e.kind = 'ruling' AND i.contract_id IN (${ids.map(() => '?').join(',')})
               ORDER BY e.seq ASC`,
            )
            .all(...(ids as never[])) as unknown as EventRow[]);
    const askRows = this.db
      .prepare(
        `SELECT * FROM spine_asks
         WHERE (authority = ? AND state IN ('open','deferred')) OR (asker = ? AND state = 'open')
         ORDER BY at ASC`,
      )
      .all(member, member) as unknown as AskRow[];

    const orientContracts: OrientContract[] = contracts.map((contract) => {
      const bindings: SpineBinding[] = [];
      if (contract.assignee === member) bindings.push('assignee');
      if (contract.verifier === member) bindings.push('verifier');
      if (contract.authority === member) bindings.push('authority');
      const criteria: SpineCriterionStatus[] = contract.criteria.map((criterion) => {
        // Newest verdict wins for the headline, and it discloses which
        // revision it was reached at rather than implying "now".
        const mine = verdicts
          .filter((v) => v.contract_id === contract.id && v.criterion_id === criterion.id)
          .sort((a, b) => a.seq - b.seq);
        const latest = mine.at(-1);
        const waiver = waivers.find(
          (w) =>
            w.contract_id === contract.id &&
            w.criterion_id === criterion.id &&
            w.revision_id === latest?.revision_id,
        );
        return {
          criterion: criterion.id,
          text: criterion.text,
          decision: (latest?.decision as SpineCriterionStatus['decision']) ?? null,
          // WHOLE, for the same reason the contract's own revision is:
          // "met at rev_01H…" is a verdict a member cannot check.
          revision: latest === undefined ? null : (revisions.get(latest.revision_id) ?? null),
          event: latest?.event_id ?? null,
          waivedBy: waiver?.ruling_event_id ?? null,
        };
      });
      return {
        bindings,
        contract: contract.id,
        title: contract.title,
        state: contract.state,
        stateRev: contract.stateRev,
        criteria,
        subject: subjects.get(contract.subject) as SpineSubject,
        revision: contract.revision,
        stale: contract.stale,
        head: contract.head,
        rulings: rulings.filter((r) => r.contract_id === contract.id).map(rowToEvent),
      };
    });

    const asks = askRows.map(rowToAsk);
    return {
      member,
      at: iso(now),
      cursor,
      contracts: orientContracts,
      asksForMe: asks.filter((a) => a.authority === member),
      myOpenAsks: asks.filter((a) => a.asker === member && a.state === 'open'),
    };
  }

  private rowsIn<T>(table: string, column: string, values: readonly string[]): T[] {
    if (values.length === 0) return [];
    return this.db
      .prepare(`SELECT * FROM ${table} WHERE ${column} IN (${values.map(() => '?').join(',')})`)
      .all(...(values as never[])) as unknown as T[];
  }
}

export function createSqliteAnnexStore(db: DatabaseSyncInstance): AnnexStore {
  return new SqliteAnnexStore(db);
}
