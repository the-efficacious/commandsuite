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
import {
  SPINE_CITATION_LOCKED_KINDS,
  SPINE_EVENT_CLASSES,
  SPINE_TERMINAL_STATES,
} from 'csuite-sdk/types';
import type { DatabaseSyncInstance } from '../db.js';
import { citationRequired, SpineError, staleStateRev } from './errors.js';
import { SPINE_PROJECTION_TABLES, SPINE_SCHEMA } from './schema.js';
import { eventId, revisionId } from './ulid.js';

/** Default page size for `events()`. The schema caps an explicit `limit` at 500. */
export const SPINE_EVENTS_DEFAULT_LIMIT = 100;

const TERMINAL: ReadonlySet<SpineContractState> = new Set(SPINE_TERMINAL_STATES);

/** The five state-changing kinds the citation lock binds. */
const CITATION_LOCKED: ReadonlySet<SpineEventKind> = new Set(SPINE_CITATION_LOCKED_KINDS);

/** An ask still awaiting its answer. Only these lock; a resolved ask binds nothing. */
const UNRESOLVED_ASK_STATES: readonly SpineAskState[] = ['open', 'deferred'];

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

/**
 * An event row as every read selects it: the event, its projected
 * contract, and its revision JOINED IN.
 *
 * The join is in the row rather than in a second lookup because an
 * event renders on the wire in four places — the stream, a stale
 * refusal's delta, orient's rulings, and an append's own response —
 * and a hydration step that each of them has to remember is a
 * hydration step three of them will eventually forget.
 */
interface EventRow {
  seq: number;
  id: string;
  kind: string;
  class: string;
  subject_id: string | null;
  revision_id: string | null;
  rev_id?: string | null;
  rev_subject?: string | null;
  rev_value?: string | null;
  rev_how?: string | null;
  rev_source?: string | null;
  rev_at?: string | null;
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

/**
 * The columns every event read selects. One constant, so "the stream
 * hydrates and the delta does not" is not a state this store can reach.
 */
const EVENT_SELECT = `e.*, i.contract_id, i.state_rev,
         r.id AS rev_id, r.subject_id AS rev_subject, r.value AS rev_value,
         r.how AS rev_how, r.source AS rev_source, r.at AS rev_at`;
const EVENT_FROM = `FROM spine_events e
       LEFT JOIN spine_event_index i ON i.seq = e.seq
       LEFT JOIN spine_revisions r ON r.id = e.revision_id`;

function rowToEvent(row: EventRow): SpineEvent {
  return {
    seq: row.seq,
    id: row.id,
    kind: row.kind as SpineEventKind,
    class: row.class as SpineEventClass,
    subject: row.subject_id,
    revision:
      row.rev_id == null
        ? null
        : {
            id: row.rev_id,
            subject: row.rev_subject as string,
            value: row.rev_value as string,
            how: row.rev_how as SpineRevision['how'],
            source: row.rev_source as string,
            at: row.rev_at as string,
          },
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
    const row = this.db.prepare(`SELECT ${EVENT_SELECT} ${EVENT_FROM} WHERE e.id = ?`).get(id) as
      | EventRow
      | undefined;
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
        `SELECT ${EVENT_SELECT} ${EVENT_FROM}
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

    // ── A CONTRACT-BOUND EVENT IS ABOUT ITS CONTRACT'S SUBJECT ──
    //
    // `subject` is optional on the four contract-bound locked kinds and
    // was, until this check existed, never compared against the
    // contract's own. That was a HOLE IN THE CITATION LOCK, not a
    // caption nicety: the lock scopes on the event's subject, so an
    // attempt or a `lifecycle{cancelled}` on a contract about
    // `repo:acme` carrying `subject: repo:other` was evaluated in a
    // scope where the actor had no asks, and landed. Every text in this
    // repo promising that promotion is not a way around the lock was
    // false, because `promote` defaults the caption to the origin
    // post's subject and hands the caller the field besides.
    //
    // The rule is the honest one rather than a patch on the lock: an
    // act on a contract IS an act on that contract's part of the world.
    // A NARROWER caption is true and useful — an attempt on one file
    // inside the repo the contract is about — so containment is
    // allowed downward. A caption pointing anywhere else is a false
    // statement about what was touched, and it also drops the event off
    // its own contract's subject page, where the members watching that
    // region are looking.
    if (contract !== null && parsed.subject !== undefined) {
      const within = this.containingSubjects(parsed.subject);
      if (!within.includes(contract.subject)) {
        throw new SpineError(
          'invalid_input',
          `this ${kind} names contract ${contract.id}, which is about ${contract.subject}, but ` +
            `captions itself ${parsed.subject} — a subject that is neither ${contract.subject} ` +
            'nor contained in it. An act on a contract is an act on that contract’s part of ' +
            'the world: caption it with the contract’s own subject, or with something ' +
            'inside it, or leave `subject` off and it is taken from the contract. (Scoped rules ' +
            'are resolved through this caption, so a caption pointing elsewhere would move the ' +
            'act out of the scope of every rule declared where the work actually is.)',
        );
      }
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
            state: contract.state,
            currentStateRev: contract.stateRev,
            // NULL when they sent none. Echoing the contract's own
            // counter back at a caller who supplied nothing invents a
            // belief they never held.
            suppliedStateRev: parsed.expectedStateRev ?? null,
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
    // THE LOCK RUNS LAST, AND THE ORDER IS A DECISION, NOT AN ACCIDENT.
    // Every refusal above it beats it, for two different reasons:
    //
    //   THE PRECONDITION WINS because its refusal CARRIES A DELTA and
    //   this one does not. §6 makes the refusal the re-injection, so
    //   when a caller is both behind and locked, the answer that hands
    //   back the events they missed is strictly the more useful one —
    //   and reading them may well be what removes the act. Answering
    //   "you have no ruling" to a member whose contract moved under
    //   them spends their turn on the smaller of two problems.
    //
    //   LEGITIMACY WINS because a structurally impossible act — a
    //   verdict from the assignee, a ruling from a bystander — is not
    //   something any ruling could make legal. Refusing it as
    //   unauthorised would send the member to ask for permission that
    //   nobody, including the authority, is able to give.
    //
    // Both orderings are pinned by tests rather than left to this
    // comment: a reordering here passes 141 spine tests without them.
    this.assertCitationLock(kind, parsed, ctx.actor, contract);

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
    const row = this.db.prepare(`SELECT ${EVENT_SELECT} ${EVENT_FROM} WHERE e.id = ?`).get(id) as
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
        `SELECT ${EVENT_SELECT} ${EVENT_FROM}
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

    if (kind === 'ask') {
      // D7, VERBATIM: "some choices belong to ANOTHER member." An ask
      // that names its own asker is not a request for a ruling, it is
      // a member manufacturing an authority to cite — and citing your
      // own ruling is the hallucinated-authorisation failure with a
      // real row behind it, which is worse than the hallucination.
      const body = input.body as SpineAskBody;
      if (body.authority === actor) {
        throw new SpineError(
          'invalid_input',
          `${actor} cannot be the authority on their own ask. An ask is a request for a ` +
            'choice that belongs to somebody else; naming yourself makes a ruling you can ' +
            'cite without anyone having decided anything.',
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
      // A redirect leaves the ask OPEN with a new authority, so it can
      // reach the same place the self-ask rule closes at authoring
      // time: redirected to the asker, the ask becomes one whose
      // authority may rule on it and cite that ruling — a decision
      // nobody outside the asker ever took, with a real row behind it.
      // The rule is stated in one place at authoring and has to be
      // stated again wherever authority can move.
      if (body.action === 'redirect' && body.redirectTo === ask.asker) {
        throw new SpineError(
          'invalid_input',
          `ask ${ask.id} cannot be redirected to ${ask.asker}, who raised it. A redirect moves ` +
            'the question to somebody else; pointing it back at the asker would make a ruling ' +
            'they can cite without anyone having decided anything.',
        );
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
      const target = contract as SpineContract;
      this.assertAmendmentDiscloses(input.body as SpineAmendmentBody, target);
      this.assertAmendmentCitesOrphans(input, target);
    }

    if (kind === 'lifecycle') {
      this.assertLifecycleLegal(input, contract as SpineContract);
    }
  }

  /**
   * THE CITATION LOCK — the one hard gate in a warn-never-lock design.
   *
   * A member who has asked someone else to decide something, and has
   * not been answered, may not then act as though they were. Not
   * because acting is forbidden — it is not, and `proceeding` is the
   * legal way to do it — but because "I was told to go ahead" is the
   * cheapest sentence an agent can produce and costs the same whether
   * or not anyone said it. This converts remembered authorisation into
   * looked-up authorisation, and it is the only refusal in the system
   * that exists to catch a member being confidently wrong about their
   * own past rather than about the world.
   *
   * WHY THIS ONE GATE AND NOT THE OTHERS. §5's reversibility test:
   * every other collision here is warned about and left to the members,
   * because the acts are walk-back-able. Acting on a ruling that does
   * not exist is not — the work is done, the members who read the
   * record believe a decision was taken, and the correction has to
   * unwind belief rather than state.
   *
   * FOUR THINGS IT DOES NOT DO, each one a decision:
   *
   *   it does not bind other members     the ask is the ASKER's. lea's
   *                                      open question never slows rune
   *                                      down, and a lock that spread
   *                                      by subject would be a lock on
   *                                      the team's throughput.
   *   it does not survive resolution     a ruled, declined or withdrawn
   *                                      ask binds nothing. The question
   *                                      has been answered, or taken
   *                                      back; there is nothing left to
   *                                      confabulate. A REDIRECT is not
   *                                      a resolution — see
   *                                      `foldAskAction`.
   *   it does not toll every write       one `proceeding` per ask
   *                                      covers the actor until that
   *                                      ask resolves (settled scope,
   *                                      §5). A per-write toll is what
   *                                      members route around, and a
   *                                      routed-around record measures
   *                                      nothing.
   *   it does not reach ambient acts     see SPINE_CITATION_LOCKED_KINDS.
   *                                      Talking about the problem is
   *                                      never the act that needs
   *                                      authorising.
   *
   * CONTAINMENT IS THE POINT OF THE WALK. An ask raised on the repo
   * reaches an act on a file inside it. Without that, the lock is
   * escaped by naming a narrower subject — which is precisely what an
   * agent looking for the path of least resistance would find, and
   * §4 declares containment so that scoped rules cannot be stepped
   * around one level down.
   *
   * AND THE SCOPE IS A UNION, WHICH IS BELT AND BRACES. The caption
   * check in `append` already guarantees that a contract-bound event's
   * subject sits at or under its contract's, so the contract's ancestry
   * is a subset of the caption's and this union is exactly the
   * caption's walk. It is written as a union anyway because the hole
   * this closes was ONE FIELD-ORDERING DECISION — `input.subject ??
   * contract.subject`, where a caller-supplied caption won — and a
   * rule that depends on which of two fields is read first will be
   * reopened by the next person who reorders them. Taking both costs
   * one walk and cannot be reopened that way at all.
   */
  private assertCitationLock(
    kind: SpineEventKind,
    input: AppendSpineEventRequest,
    actor: string,
    contract: SpineContract | null,
  ): void {
    if (!CITATION_LOCKED.has(kind)) return;
    // The narrowest true statement about where the act landed: its own
    // caption when it has one (a specification always does), otherwise
    // its contract's subject — an attempt or a verdict names a
    // contract, and the contract is what says which part of the world
    // is being changed. Reading only the event's `subject` would leave
    // four of the five locked kinds permanently unlocked, since none of
    // them is required to carry one.
    const subject = input.subject ?? contract?.subject ?? null;
    if (subject === null) return;

    // Contract's ancestry first, so the rendered scope reads outermost
    // to innermost even in the impossible case where the two walks
    // diverge.
    const scope = [
      ...new Set([
        ...(contract === null ? [] : this.containingSubjects(contract.subject)),
        ...this.containingSubjects(subject),
      ]),
    ];
    const asks = this.unresolvedAsksBy(actor, scope);
    if (asks.length === 0) return;

    const uncovered = asks.filter((ask) => this.coveringCitation(ask, input, actor) === null);
    if (uncovered.length === 0) return;
    throw citationRequired(kind, subject, contract?.id ?? null, scope, uncovered);
  }

  /**
   * A subject and every subject containing it, outermost first.
   *
   * The mirror of `containedSubjects`, and it walks the other way for a
   * reason: the question here is "which declared scopes cover this
   * act", and answering it by expanding every ask's subtree would cost
   * one subtree walk per ask instead of one ancestry walk per write.
   */
  private containingSubjects(leaf: string): string[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE ancestry(id, parent) AS (
           SELECT id, parent FROM spine_subjects WHERE id = ?
           UNION
           SELECT s.id, s.parent FROM spine_subjects s JOIN ancestry a ON s.id = a.parent
         )
         SELECT id FROM ancestry`,
      )
      .all(leaf) as unknown as { id: string }[];
    // Outermost first, so the rendered scope reads `repo ⊃ file` the
    // way containment is spoken. The CTE yields the leaf first and its
    // ancestors after it.
    const ids = rows.map((r) => r.id);
    return ids.length > 0 ? ids.reverse() : [leaf];
  }

  /**
   * This actor's own asks, still awaiting an answer, anywhere in the
   * given scope.
   *
   * AN ASK THAT NAMES ONLY A CONTRACT IS SCOPED BY THAT CONTRACT'S
   * SUBJECT. §5's required fields for `ask_author` are authority,
   * question, context and unblocks — a subject is optional — so the
   * commonest ask there is names a contract and nothing else. Matching
   * on `subject_id` alone would have left exactly that shape binding
   * nothing, and the lock would have been reachable only by members who
   * happened to caption their ask with a region of the world.
   *
   * `asker`, not `authority`. The ask belongs to whoever raised it, and
   * it is their own subsequent acts that risk being taken on an answer
   * nobody gave. An authority's pending queue must never slow down
   * their own work — a lock that spread that way would make asking
   * someone a way to stop them.
   */
  private unresolvedAsksBy(actor: string, scope: readonly string[]): SpineAsk[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM spine_asks a
         LEFT JOIN spine_contracts c ON c.id = a.contract_id
         WHERE a.asker = ?
           AND a.state IN (${UNRESOLVED_ASK_STATES.map(() => '?').join(',')})
           AND COALESCE(a.subject_id, c.subject_id) IN (${scope.map(() => '?').join(',')})
         ORDER BY a.at ASC, a.id ASC`,
      )
      .all(...([actor, ...UNRESOLVED_ASK_STATES, ...scope] as never[])) as unknown as AskRow[];
    return rows.map(rowToAsk);
  }

  /**
   * What lets this write past that ask, or `null`.
   *
   * TWO ROUTES, and they are not equally travelled. A `proceeding` is
   * the one that fires: it is a durable act of record by this actor
   * naming this ask, and it covers everything they do on the subject
   * until the ask resolves.
   *
   * The cited-ruling route is the primary one in §5's prose — "the call
   * must cite a `ruling` id" — and it is UNREACHABLE BY CONSTRUCTION
   * TODAY, not merely unused: `foldRuling` marks an ask `ruled` the
   * instant its ruling lands, and a resolved ask does not lock, so no
   * input can arrive here holding both an unresolved ask and a ruling
   * on it. Every member-facing text has been reworded to say what is
   * true instead — get the ruling, which RESOLVES the ask and releases
   * you, with nothing further to cite.
   *
   * The branch stays because the fact that makes it dead is scheduled
   * to change: phase 4 arms deferred asks with a probe that re-raises
   * them, at which point an ask can outlive a ruling that only partly
   * answered it, and the branch's absence would be a silent hole rather
   * than a failing test. It is one lookup over a list the caller
   * already supplied. Recorded as a decision rather than left to be
   * discovered — a branch nothing can reach is a claim no test can
   * check, and it should be either explained or deleted.
   *
   * Keyed on the ASK, not on the proceeding's subject. The ask carries
   * the scope — it is only in the locking set because its subject
   * covers this act — so re-deriving scope from the proceeding would
   * check the same containment twice and let the two answers disagree.
   */
  private coveringCitation(
    ask: SpineAsk,
    input: AppendSpineEventRequest,
    actor: string,
  ): string | null {
    for (const citedId of input.cites ?? []) {
      const cited = this.event(citedId);
      if (
        cited !== null &&
        cited.kind === 'ruling' &&
        (cited.body as SpineRulingBody).ask === ask.id
      ) {
        return cited.id;
      }
    }
    const row = this.db
      .prepare(
        `SELECT id FROM spine_events
         WHERE kind = 'proceeding' AND actor = ? AND json_extract(body, '$.ask') = ?
         ORDER BY seq ASC LIMIT 1`,
      )
      .get(actor, ask.id) as { id: string } | undefined;
    return row?.id ?? null;
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
   * SO WHAT THIS FREES IS APPENDS AND ADDITIONS, AND NOTHING ELSE.
   * Adding a criterion, adding a constraint, appending a clarification
   * to existing text, and changing nothing textual are accepted without
   * a disclosure. Rewording, dropping and truncating all require one.
   *
   * Two limits, stated because the rule reads more forgiving than it
   * is and because neither is a defect the store can close:
   *
   *   A TYPO FIX IS REFUSED. "endpont" → "endpoint" removes the
   *   original characters, so it needs a disclosure like any other
   *   rewrite. That is a real cost and it is not what containment was
   *   chosen for — it was chosen over a length heuristic because it is
   *   exact, not because it spares corrections.
   *
   *   MEANING CAN BE INVERTED BY WRAPPING. "IGNORE THIS: <old text> —
   *   no longer required" contains the original and is therefore free.
   *   No syntactic rule reaches that; it needs a reader, which is the
   *   tool surface's job in phase 2, not the store's.
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

  /**
   * Dropping a criterion that has been JUDGED must cite the verdicts it
   * orphans.
   *
   * A CITATION, NOT A PERMISSION. Nothing here decides whether the drop
   * is allowed — an author who wants it gets it, in one extra field.
   * What it removes is the shape where "we dropped the criterion the
   * verifier could not pass" is a fact recoverable only by somebody
   * paging the annex and noticing. Cited, the orphaned verdicts land in
   * the amendment's own `cites`, where every reader of the amendment
   * sees them.
   *
   * This is the backstop under a real hole: the completion gate reads
   * the CURRENT criteria list, so dropping a criterion also drops its
   * verdicts from the gate. That is correct behaviour — a criterion no
   * longer in the contract cannot block it — which is exactly why the
   * drop must not be quiet.
   *
   * A criterion nobody ever judged orphans nothing and needs no
   * citation.
   */
  private assertAmendmentCitesOrphans(
    input: AppendSpineEventRequest,
    contract: SpineContract,
  ): void {
    const body = input.body as SpineAmendmentBody;
    if (body.criteria === undefined) return;
    const kept = new Set(body.criteria.map((c) => c.id));
    const dropped = contract.criteria.filter((c) => !kept.has(c.id)).map((c) => c.id);
    if (dropped.length === 0) return;

    const rows = this.db
      .prepare(
        `SELECT * FROM spine_contract_verdicts
         WHERE contract_id = ? AND criterion_id IN (${dropped.map(() => '?').join(',')})
         ORDER BY seq ASC`,
      )
      .all(...([contract.id, ...dropped] as never[])) as unknown as VerdictRow[];
    if (rows.length === 0) return;

    const cites = new Set(input.cites ?? []);
    const uncited = rows.filter((r) => !cites.has(r.event_id));
    if (uncited.length === 0) return;

    throw new SpineError(
      'invalid_input',
      `this amendment drops ${dropped.map((d) => `'${d}'`).join(', ')}, which ${
        uncited.length === 1 ? 'carries a verdict' : 'carry verdicts'
      } the contract would silently lose: ` +
        uncited
          .map((r) => `${r.event_id} (${r.decision} on '${r.criterion_id}' by ${r.actor})`)
          .join('; ') +
        '. Cite them on the amendment. Nothing here refuses the drop — this only makes the ' +
        'record say that a judged criterion was removed, rather than leaving it to be found.',
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
      // AUTHORITY's ruling, citing THAT verdict, and itself cited here.
      //
      // WHO RULED IS THE WHOLE CHECK. Without it the assignee could
      // raise an ask, answer it, cite his own answer, and complete:
      // every event legitimate on its own, the contract's declared
      // authority never consulted, and the record showing a waiver
      // that reads exactly like a real one. The ask-side clause above
      // closes the self-ask; this closes the case where somebody else
      // rules on a waiver that was not theirs to give.
      const waiver = cited.find((e) => e.kind === 'ruling' && e.cites.includes(verdict.event_id));
      if (waiver !== undefined) {
        const illegitimate =
          waiver.actor === contract.assignee
            ? `${waiver.actor} is the assignee of this contract and cannot waive its criteria`
            : contract.authority !== null && waiver.actor !== contract.authority
              ? `ruling ${waiver.id} is by ${waiver.actor}, and this contract names ` +
                `${contract.authority} as its authority`
              : null;
        if (illegitimate === null) continue;
        missing.push({
          criterion: criterion.id,
          text: criterion.text,
          why: `the cited waiver does not bind: ${illegitimate}`,
        });
        continue;
      }
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
   * The CURRENT verdict per criterion AT ONE REVISION VALUE.
   *
   * By value rather than by revision id, because revisions are never
   * deduplicated: a verdict reached at one observation of `sha-a` and
   * a completion naming another observation of `sha-a` are about the
   * same state of the world and two different rows. Latest by `seq`
   * wins within a value.
   *
   * THE EXACT PROPERTY THIS BUYS, stated narrowly because a wider
   * claim was wrong: at a GIVEN revision, the gate and `orient` read
   * the same latest-wins answer, so a completion cannot cite a verdict
   * that a later verdict AT THAT REVISION superseded. It does NOT
   * follow that the gate and the display always agree. `orient` shows
   * the latest verdict across ALL revisions, so `met@sha-a` then
   * `unmet@sha-b` leaves a completion at sha-a legitimately covered
   * while the pack headlines `unmet`.
   *
   * That divergence is correct — a verdict is true OF a revision, and
   * an `unmet` at a revision the contract never completed against does
   * not un-complete it — but it is a real thing a reader can be
   * confused by, so `orient` discloses it rather than leaving it to be
   * inferred: see `atBoundRevision`.
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
        this.touchContract(contractId as string, stateRev, event, {
          revision: event.revision?.id ?? null,
        });
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
        event.revision?.id ?? null,
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
        event.revision?.id as string,
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
        bindsRevision ? (event.revision?.id ?? null) : null,
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
        .run(vb.contract, vb.criterion, target.revision.id, event.id);
    }
  }

  /**
   * A REDIRECT IS A RE-ADDRESSING, NOT A RESOLUTION.
   *
   * The other three actions end the ask: withdrawn takes the question
   * back, declined and ruled answer it. A redirect does none of those —
   * the question is unchanged, unanswered, and now in front of somebody
   * else — so it leaves the ask OPEN with a new authority, and the
   * asker stays bound by the citation lock exactly as before. Treating
   * it as a resolution silently released the asker the moment their
   * authority said "not me, ask her", which is the one moment the lock
   * is most obviously still needed.
   *
   * ONE DURABLE ASK, NOT A CHAIN. No successor row and no new id: the
   * `ask_action` event carries who moved it, to whom, and why, so the
   * lineage is in the stream where every other fact about the ask is.
   * A successor ask would fork the identity that everything else cites
   * — the proceeding that covers it, the ruling that will answer it —
   * and leave the asker's own proceeding covering a dead id.
   *
   * `resolved_by` therefore stays NULL. It names the event that ENDED
   * an ask, and nothing has ended.
   */
  private foldAskAction(event: SpineEvent): void {
    const body = event.body as SpineAskActionBody;
    if (body.action === 'redirect') {
      this.db
        .prepare("UPDATE spine_asks SET authority = ?, state = 'open' WHERE id = ?")
        .run(body.redirectTo as string, body.ask);
      return;
    }
    const next: Record<string, SpineAskState> = {
      withdraw: 'withdrawn',
      decline: 'declined',
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
        .prepare(`SELECT ${EVENT_SELECT} ${EVENT_FROM} ORDER BY e.seq ASC`)
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
              `SELECT ${EVENT_SELECT} ${EVENT_FROM}
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
        const at = latest === undefined ? null : (revisions.get(latest.revision_id) ?? null);
        return {
          criterion: criterion.id,
          text: criterion.text,
          decision: (latest?.decision as SpineCriterionStatus['decision']) ?? null,
          // The relation, stated. A headline `unmet` reached at a
          // revision the contract has moved off is a different claim
          // from an `unmet` where the contract is sitting, and both
          // render as "unmet" unless something says which.
          atBoundRevision:
            at !== null && contract.revision !== null && at.value === contract.revision.value,
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
