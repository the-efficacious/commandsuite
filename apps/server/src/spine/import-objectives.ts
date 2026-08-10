/**
 * THE ONE-SHOT IMPORT of the legacy objectives record into the annex,
 * as `provenance: legacy_projection`, permanently.
 *
 * WHY THIS FILE IS WRITTEN THE WAY IT IS. #155's aggregate names the
 * migration as the highest-risk step in the whole design, and names the
 * reason: backfilling a TYPED field from an UNTYPED source manufactures
 * exactly the claim class the annex exists to remove. `revision: abc123`
 * reads identically whether it was observed from a review event or
 * scraped out of a sentence somebody typed at 3am, and once it is a
 * field nobody can tell which it was ever again.
 *
 * There is a concrete instance already in the record. A verdict that
 * found a real defect class across three files sits inside a CANCELLED
 * objective whose cancellation reason says its author never started —
 * because the cancellation raced the verdict by seven seconds. Reading
 * that objective's STATE gets the wrong answer. Reading its THREAD gets
 * the right one, from an untyped source. **Neither is safe to convert
 * into a field.** So both are imported exactly as they were recorded,
 * in their recorded order, and a member reads the contradiction.
 *
 * THE MAPPING IS DELIBERATELY LOSSY, IN THE DIRECTION OF HONESTY. Only
 * what was TYPED becomes typed. Everything else that was recorded is
 * carried as prose, which is what it always was. And where the spine's
 * own schema would require a field the legacy record simply does not
 * contain, the fact is left unimported and SAID SO — an empty field is
 * a true statement; a derived one is not. `ObjectivesImportSummary.
 * unimported` is that statement, and the CLI prints it.
 *
 * WHAT IS NEVER IMPORTED, and each is a rule rather than an omission:
 *
 *   REVISIONS. No SHA is scraped from a title, an outcome, or a thread.
 *   The spine has no revision for legacy work and that IS the honest
 *   state. A legacy objective never bound an observation point.
 *
 *   VERDICTS. A legacy completion had no verdict — there was no verifier
 *   role and no per-criterion decision — so there is no verdict to
 *   import, and inventing one is the exact laundering #155 forbids. The
 *   imported specification names NO verifier, which is true (nobody was
 *   named one) and which is also why the store's completion-coverage
 *   gate does not fire: a contract with no verifier completes on its
 *   result alone, and says so.
 *
 *   CRITERIA DECOMPOSITION. The outcome becomes ONE criterion carrying
 *   the outcome text verbatim. Splitting a sentence into criteria is
 *   derivation wearing a schema.
 *
 *   WATCHERS. The spine has no watchers; subscription is reader-side and
 *   a legacy watcher list cannot be turned into one. A watcher was told
 *   about everything, which is finding 1 — the thing the reader-side
 *   design replaced. Importing the list as subscriptions would recreate
 *   the fanout the spine exists to remove, on the reader's behalf,
 *   without the reader.
 *
 *   FOCUS, CURATOR STATE, RECEIPTS, LEASES. All of these are records of
 *   who read what and what the team chose to work on. Nobody chose any
 *   of it in the legacy system, because it had no such concept.
 *
 * SUBJECTS. A legacy objective has no subject. ONE synthetic subject is
 * registered per import — `legacy:objectives`, type `doc` — and every
 * imported specification binds to it. Per-objective subjects are not
 * invented and repo/PR names are not parsed out of prose: the spine's
 * own rule is that a subject is REGISTERED, not guessed.
 *
 * IDEMPOTENCY. Two mechanisms, because one of them cannot cover
 * everything. Authoritative events carry an `op_id` derived from the
 * legacy row identity, so the store itself refuses a second write. But
 * `discussion` is AMBIENT and the schema gives ambient kinds no `op_id`
 * at all — deliberately, since idempotency is a property of durable
 * writes. So the importer keeps its own ledger (`spine_legacy_import`)
 * mapping every legacy row it consumed to the event it produced. The
 * ledger is a record of what the IMPORTER did; it is not a claim about
 * the world, and nothing reads it but the importer.
 */

import type { DatabaseSyncInstance } from '../db.js';
import type { AnnexWritePath } from './append.js';
import { SpineError } from './errors.js';
import type { AppendResult } from './store.js';

/** The one synthetic subject every imported specification binds to. */
export const LEGACY_SUBJECT_ID = 'legacy:objectives';

/**
 * The prefix on every sentence the IMPORTER wrote rather than a member.
 *
 * Legacy facts with no typed home in the spine are carried as prose,
 * which means the importer has to compose a sentence around a member's
 * verbatim text. A reader has to be able to tell the two apart at a
 * glance, or the projection has quietly put words in somebody's mouth
 * — a smaller version of the same failure as a manufactured field.
 */
export const IMPORT_NOTE = '[legacy objectives import]';

/** The single criterion id every imported contract carries. */
export const LEGACY_CRITERION_ID = 'outcome';

const LEDGER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS spine_legacy_import (
    legacy_kind TEXT NOT NULL,
    legacy_id   TEXT NOT NULL,
    event_id    TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    PRIMARY KEY (legacy_kind, legacy_id)
  );
`;

/** One legacy row that could not be imported, and the reason, in full. */
export interface UnimportedRow {
  /** `objective`, `objective_event`, or `message`. */
  source: string;
  /** The legacy row's own identity. */
  id: string;
  /** The legacy kind, where the row had one. */
  kind: string;
  /** Why it was not imported — a store refusal, or a rule in this file. */
  reason: string;
}

export interface ObjectivesImportSummary {
  /** Objectives read from the legacy store. */
  objectivesRead: number;
  /** Objectives whose specification landed on this run. */
  objectivesImported: number;
  /** Objectives the ledger showed as already imported; skipped whole. */
  objectivesAlreadyImported: number;
  /** Events appended on this run, by spine kind. */
  appended: Record<string, number>;
  /**
   * Legacy rows deliberately not imported, with the reason on each.
   * Never empty in practice: watcher rows always land here.
   */
  unimported: UnimportedRow[];
  /**
   * Legacy event rows carrying no `event_id` (they predate the column),
   * whose op ids therefore fall back to the SQLite rowid. Idempotency
   * across a VACUUM is guaranteed only for rows that carry an event_id;
   * this count is how many do not.
   */
  rowidFallbacks: number;
}

interface ObjectiveRow {
  id: string;
  title: string;
  body: string;
  outcome: string;
  status: string;
  assignee: string;
  originator: string;
  created_at: number;
  updated_at: number;
}

interface EventRow {
  rowid: number;
  event_id: string | null;
  objective_id: string;
  ts: number;
  actor: string;
  kind: string;
  payload: string;
}

interface MessageRow {
  id: string;
  ts: number;
  from_name: string | null;
  body: string;
  data: string;
}

/** The legacy amendment record, as `objectives.ts` wrote it. */
interface LegacyContractAmendment {
  target: 'contract';
  version: number;
  ts: number;
  actor: string;
  disposition: 'correction' | 'scope_change';
  reason: string;
  fields: ('title' | 'outcome' | 'body')[];
  previous?: Partial<Record<'title' | 'outcome' | 'body', string>>;
}

interface LegacyEventCorrection {
  target: 'event';
  ts: number;
  actor: string;
  reason: string;
  eventId: string;
  eventKind: string;
  eventTs: number;
  correction: string;
}

/** The contract text at one point in the amendment chain. */
interface ContractText {
  title: string;
  outcome: string;
  body: string;
}

export interface ImportObjectivesOptions {
  /** The legacy database — `objectives`, `objective_events`, and `events`. */
  db: DatabaseSyncInstance;
  /**
   * The hooked write path. Deliberately the write path and not a raw
   * writer: there is one append path into the annex and a migration is
   * not an exception to it.
   */
  spine: AnnexWritePath;
  /** Who registers the synthetic subject. Recorded on the subject row. */
  registeredBy?: string;
  /** The instant the SUBJECT is registered. Events carry legacy instants. */
  now?: number;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function tableExists(db: DatabaseSyncInstance, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

function reasonOf(err: unknown): string {
  if (err instanceof SpineError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Walk the amendment chain BACKWARDS from the current row to recover the
 * text at every point, including the original.
 *
 * A legacy `amended` event records the text as it was BEFORE it — the
 * `previous` map — and never the text after. So the state after the last
 * amendment is the objectives row as it stands, the state before an
 * amendment is that amendment's `previous` applied on top of the state
 * after it, and the whole chain unrolls from the end. This is a FOLD
 * OVER RECORDED VALUES, not an inference: every string it produces was
 * written down by somebody, either in the row or in a `previous` map.
 *
 * Returns the text BEFORE each amendment, indexed alongside the
 * amendment list, plus the original text at index 0.
 */
function unrollAmendments(
  current: ContractText,
  amendments: readonly LegacyContractAmendment[],
): { original: ContractText; before: ContractText[]; after: ContractText[] } {
  const after: ContractText[] = new Array(amendments.length);
  const before: ContractText[] = new Array(amendments.length);
  let cursor: ContractText = { ...current };
  for (let i = amendments.length - 1; i >= 0; i--) {
    after[i] = { ...cursor };
    const prev = amendments[i]?.previous ?? {};
    cursor = {
      title: prev.title ?? cursor.title,
      outcome: prev.outcome ?? cursor.outcome,
      body: prev.body ?? cursor.body,
    };
    before[i] = { ...cursor };
  }
  return { original: cursor, before, after };
}

/** One unit of work: a mapped append, in legacy order. */
interface Step {
  /** Legacy row identity, for the ledger. */
  source: 'objective' | 'objective_event' | 'message';
  id: string;
  kind: string;
  ts: number;
  run: () => Promise<AppendResult>;
}

class ObjectivesImporter {
  private readonly db: DatabaseSyncInstance;
  private readonly spine: AnnexWritePath;
  private readonly summary: ObjectivesImportSummary = {
    objectivesRead: 0,
    objectivesImported: 0,
    objectivesAlreadyImported: 0,
    appended: {},
    unimported: [],
    rowidFallbacks: 0,
  };
  /** legacy event id (or `row:<rowid>`) -> the spine event it became. */
  private readonly produced = new Map<string, string>();

  constructor(options: ImportObjectivesOptions) {
    this.db = options.db;
    this.spine = options.spine;
    this.db.exec(LEDGER_SCHEMA);
  }

  private ledgerGet(kind: string, id: string): string | null {
    const row = this.db
      .prepare('SELECT event_id FROM spine_legacy_import WHERE legacy_kind = ? AND legacy_id = ?')
      .get(kind, id) as { event_id: string } | undefined;
    return row?.event_id ?? null;
  }

  private ledgerPut(kind: string, id: string, eventId: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO spine_legacy_import (legacy_kind, legacy_id, event_id, imported_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(legacy_kind, legacy_id) DO NOTHING`,
      )
      .run(kind, id, eventId, at);
  }

  private count(kind: string): void {
    this.summary.appended[kind] = (this.summary.appended[kind] ?? 0) + 1;
  }

  private drop(source: string, id: string, kind: string, reason: string): void {
    this.summary.unimported.push({ source, id, kind, reason });
  }

  /**
   * Run one mapped step. A store refusal is RECORDED, never fatal:
   * legacy data was written under different rules (nothing stopped an
   * objective being amended after it was cancelled, for one), and a
   * migration that dies on the first row it cannot place imports
   * nothing. Every refusal lands in `unimported` with the store's own
   * message, which is the sentence a reader needs.
   */
  private async step(s: Step): Promise<AppendResult | null> {
    if (this.ledgerGet(s.source, s.id) !== null) return null;
    try {
      const result = await s.run();
      this.ledgerPut(s.source, s.id, result.event.id, s.ts);
      this.produced.set(s.id, result.event.id);
      if (!result.replayed) this.count(result.event.kind);
      return result;
    } catch (err) {
      this.drop(s.source, s.id, s.kind, reasonOf(err));
      return null;
    }
  }

  async run(registeredBy: string, now: number): Promise<ObjectivesImportSummary> {
    if (!tableExists(this.db, 'objectives')) return this.summary;

    // ONE subject, registered rather than guessed. `registerSubject` is
    // idempotent on a matching row, so a second run re-registers
    // nothing.
    this.spine.store.registerSubject({ id: LEGACY_SUBJECT_ID, type: 'doc' }, registeredBy, now);

    const objectives = this.db
      .prepare('SELECT * FROM objectives ORDER BY created_at, id')
      .all() as unknown as ObjectiveRow[];
    this.summary.objectivesRead = objectives.length;

    for (const objective of objectives) {
      await this.importOne(objective);
    }
    return this.summary;
  }

  private async importOne(row: ObjectiveRow): Promise<void> {
    const events = (
      this.db
        .prepare(
          'SELECT rowid AS rowid, * FROM objective_events WHERE objective_id = ? ORDER BY ts, rowid',
        )
        .all(row.id) as unknown as EventRow[]
    ).map((e) => {
      if (e.event_id === null || e.event_id === undefined) this.summary.rowidFallbacks += 1;
      return e;
    });

    const amendments = events
      .filter((e) => e.kind === 'amended')
      .map((e) => parseJson<LegacyContractAmendment | null>(e.payload, null))
      .filter((a): a is LegacyContractAmendment => a !== null && a.target === 'contract');

    const { original, after } = unrollAmendments(
      { title: row.title, outcome: row.outcome, body: row.body },
      amendments,
    );

    // ── The specification: the objective's own record ───────────────
    //
    // The ORIGINAL text, because a specification IS the creation and is
    // dated at it. The current text is not lost — the amendments below
    // carry it forward, and the projection lands on exactly the row's
    // present title and outcome, which is what the import test asserts.
    //
    // `assignee` is the CURRENT one, deliberately, and it is the one
    // place the current value beats the creation value: the assignee
    // field is a live binding (it decides whose `orient` the contract
    // lands in), not a historical claim, and the spine has no
    // reassignment act to move it later. Every assignment and
    // reassignment is carried in the thread besides, so both readings
    // are available and neither is invented.
    const specOp = `legacy:objective:${row.id}`;
    const spec = await this.step({
      source: 'objective',
      id: row.id,
      kind: 'objective',
      ts: row.created_at,
      run: () =>
        this.spine.append(
          {
            kind: 'specification',
            subject: LEGACY_SUBJECT_ID,
            opId: specOp,
            body: {
              title: original.title,
              // ONE criterion, carrying the outcome verbatim. Parsing an
              // outcome into criteria is derivation wearing a schema.
              criteria: [{ id: LEGACY_CRITERION_ID, text: original.outcome }],
              assignee: row.assignee,
              // NO verifier and NO authority: nobody held either role,
              // and naming the originator as authority would invent the
              // one relationship the citation lock is built on.
            },
          },
          {
            actor: row.originator,
            provenance: 'legacy_projection',
            now: row.created_at,
          },
        ),
    });

    if (spec === null) {
      const already = this.ledgerGet('objective', row.id);
      if (already !== null) this.summary.objectivesAlreadyImported += 1;
      // A specification that did not land leaves nothing to hang the
      // rest of the objective on, so the whole objective stops here
      // rather than scattering orphans.
      if (already === null) return;
    }
    const contract = spec?.event.id ?? (this.ledgerGet('objective', row.id) as string);
    if (spec !== null) this.summary.objectivesImported += 1;

    // ── EVERYTHING ELSE IS SORTED BY ITS RECORDED INSTANT ───────────
    //
    // The steps are COLLECTED here and executed below in `ts` order,
    // rather than executed as they are built, and that ordering is the
    // whole point rather than tidiness.
    //
    // Legacy discussion posts do not live in `objective_events` — they
    // are broker messages on thread `obj:<id>`, in a different table
    // entirely — so an importer that walked the typed rows and then the
    // messages would give every post a HIGHER `seq` than every lifecycle
    // event, whatever instant it was written at. `seq` is the stream
    // cursor: a reader paging a contract reads it in `seq` order.
    //
    // That is precisely the instance #155 names. A verdict-bearing post
    // arrived SEVEN SECONDS BEFORE the cancellation that talks past it;
    // appended in table order it would land after, and the record would
    // read as though the author was answering a decision that had
    // already been taken. The race is the fact. Sorting by the recorded
    // instant is what keeps it one.
    const steps: Step[] = [];

    // The original body: free prose, with no typed home on a spine
    // specification, so it stays prose and keeps its instant.
    if (original.body.trim().length > 0) {
      steps.push({
        source: 'objective_event',
        id: `body:${row.id}`,
        kind: 'body',
        ts: row.created_at,
        run: () =>
          this.spine.append(
            {
              kind: 'discussion',
              body: {
                contract,
                body: `${IMPORT_NOTE} the objective's body, as recorded:\n\n${original.body}`,
              },
            },
            { actor: row.originator, provenance: 'legacy_projection', now: row.created_at },
          ),
      });
    }

    // ── Every typed event, in recorded order ────────────────────────
    let amendIndex = 0;
    for (const event of events) {
      const legacyId =
        event.event_id !== null && event.event_id !== undefined
          ? event.event_id
          : `row:${event.rowid}`;
      const opId = `legacy:event:${legacyId}`;
      const payload = parseJson<Record<string, unknown>>(event.payload, {});
      switch (event.kind) {
        case 'assigned':
          // Fully carried by the specification above: its payload is the
          // title, outcome and assignee, all of which are on the spec.
          // A second event stating the same three facts would be the
          // record saying one thing twice.
          this.ledgerPut('objective_event', legacyId, contract, event.ts);
          break;

        case 'watcher_added':
        case 'watcher_removed':
          this.drop(
            'objective_event',
            legacyId,
            event.kind,
            'the spine has no watchers — subscription is reader-side and cannot be ' +
              'inferred from a legacy watcher list',
          );
          break;

        case 'reassigned':
          // The spine has NO reassignment act: `assignee` is written by
          // the specification fold and no event moves it. So the
          // reassignment cannot become a typed fact, and its recorded
          // values are carried whole instead.
          steps.push(
            this.discuss(
              legacyId,
              contract,
              event,
              `${IMPORT_NOTE} a reassignment was recorded: from ` +
                `${String(payload.from)} to ${String(payload.to)}` +
                (typeof payload.note === 'string'
                  ? `. The note, verbatim:\n\n${payload.note}`
                  : '.'),
            ),
          );
          break;

        case 'blocked':
          // NOT `waiting_on`. That state requires the MEMBER being
          // waited on and the legacy record names none; the reason is a
          // free sentence, and reading a name out of it is the 3am-
          // sentence scrape #155 forbids by name. NOT `waiting_for`
          // either — that needs an event and a check nobody authored.
          // So the block reason is carried whole, as the prose it is,
          // and the contract stays `active`.
          steps.push(
            this.discuss(
              legacyId,
              contract,
              event,
              `${IMPORT_NOTE} the objective was recorded as blocked. The reason, verbatim:\n\n` +
                `${typeof payload.reason === 'string' ? payload.reason : '(none recorded)'}`,
            ),
          );
          break;

        case 'unblocked':
          steps.push(
            this.discuss(
              legacyId,
              contract,
              event,
              `${IMPORT_NOTE} the objective was recorded as unblocked.`,
            ),
          );
          break;

        case 'completed':
          steps.push({
            source: 'objective_event',
            id: legacyId,
            kind: event.kind,
            ts: event.ts,
            run: () =>
              this.spine.append(
                {
                  kind: 'lifecycle',
                  opId,
                  expectedStateRev: this.stateRev(contract),
                  body: {
                    contract,
                    state: 'done',
                    // The result verbatim. NO revision and NO cited
                    // verdicts: a legacy completion had neither, the
                    // specification names no verifier, and the store's
                    // coverage gate therefore asks for neither.
                    result: this.prose(payload.result, 'the completion recorded no result'),
                  },
                },
                { actor: event.actor, provenance: 'legacy_projection', now: event.ts },
              ),
          });
          break;

        case 'cancelled':
          steps.push({
            source: 'objective_event',
            id: legacyId,
            kind: event.kind,
            ts: event.ts,
            run: () =>
              this.spine.append(
                {
                  kind: 'lifecycle',
                  opId,
                  expectedStateRev: this.stateRev(contract),
                  body: {
                    contract,
                    state: 'cancelled',
                    // Carried whole, INCLUDING a reason that later turned
                    // out to be false. The record said it; the thread
                    // beside it says otherwise; a member reads both.
                    reason: this.prose(payload.reason, 'the cancellation recorded no reason'),
                  },
                },
                { actor: event.actor, provenance: 'legacy_projection', now: event.ts },
              ),
          });
          break;

        case 'amended': {
          const index = amendIndex++;
          const amendment = amendments[index];
          const next = after[index];
          if (amendment === undefined || next === undefined) {
            this.drop('objective_event', legacyId, event.kind, 'unreadable amendment payload');
            break;
          }
          const previous = amendment.previous ?? {};
          const changed = amendment.fields;
          steps.push({
            source: 'objective_event',
            id: legacyId,
            kind: event.kind,
            ts: event.ts,
            run: () =>
              this.spine.append(
                {
                  kind: 'amendment',
                  opId,
                  expectedStateRev: this.stateRev(contract),
                  body: {
                    contract,
                    changes: `${IMPORT_NOTE} amended: ${changed.join(', ')}`,
                    reason: amendment.reason,
                    disposition: amendment.disposition,
                    // The prior text, PRESERVED AS RECORDED. This is
                    // what `disclosure` is for: §10 says contamination
                    // is disclosed, never erased.
                    disclosure:
                      `${IMPORT_NOTE} the text before this amendment, as recorded:\n\n` +
                      changed.map((f) => `${f}: ${previous[f] ?? '(not recorded)'}`).join('\n\n'),
                    ...(changed.includes('title') ? { title: next.title } : {}),
                    ...(changed.includes('outcome')
                      ? { criteria: [{ id: LEGACY_CRITERION_ID, text: next.outcome }] }
                      : {}),
                  },
                },
                { actor: event.actor, provenance: 'legacy_projection', now: event.ts },
              ),
          });
          // A changed body has no typed home either, so the new text
          // lands as prose, dated when it was written.
          if (changed.includes('body') && next.body.trim().length > 0) {
            steps.push({
              source: 'objective_event',
              id: `body:${legacyId}`,
              kind: 'body',
              ts: event.ts,
              run: () =>
                this.spine.append(
                  {
                    kind: 'discussion',
                    body: {
                      contract,
                      body: `${IMPORT_NOTE} the body, as amended here:\n\n${next.body}`,
                    },
                  },
                  { actor: event.actor, provenance: 'legacy_projection', now: event.ts },
                ),
            });
          }
          break;
        }

        case 'event_corrected': {
          const correction = parseJson<LegacyEventCorrection | null>(event.payload, null);
          if (correction === null) {
            this.drop('objective_event', legacyId, event.kind, 'unreadable correction payload');
            break;
          }
          steps.push({
            source: 'objective_event',
            id: legacyId,
            kind: event.kind,
            ts: event.ts,
            // The target is resolved INSIDE the step, not when it is
            // built: the event this correction staples to is produced by
            // an earlier step in the same sorted run, so at build time
            // it does not exist yet.
            run: () => {
              const target = this.produced.get(correction.eventId);
              if (target === undefined) {
                throw new SpineError(
                  'not_found',
                  `it corrects legacy event ${correction.eventId}, which was not imported — a ` +
                    'correction that staples to nothing is a second claim, not a correction',
                );
              }
              return this.spine.append(
                {
                  kind: 'correction',
                  opId,
                  staplesTo: target,
                  expectedStateRev: this.stateRev(contract),
                  body: {
                    correction: `${IMPORT_NOTE} ${correction.reason}\n\n${correction.correction}`,
                  },
                },
                { actor: event.actor, provenance: 'legacy_projection', now: event.ts },
              );
            },
          });
          break;
        }

        default:
          this.drop(
            'objective_event',
            legacyId,
            event.kind,
            'no mapping: the spine has no typed act for this legacy kind',
          );
          break;
      }
    }

    steps.push(...this.discussionSteps(row.id, contract));

    // ONE stable sort on the recorded instant, then straight through.
    // `Array.prototype.sort` is stable, so rows sharing an instant keep
    // the order they were read in — which is `objective_events` by
    // `(ts, rowid)`, then the thread by `(ts, id)`. Nothing here invents
    // an order the record does not have; it only stops the TABLE the
    // row happened to live in from deciding it.
    steps.sort((a, b) => a.ts - b.ts);
    for (const s of steps) await this.step(s);
  }

  /**
   * Discussion posts, from the broker's own event log.
   *
   * They are NOT in `objective_events`: a legacy discussion post is a
   * real team message on thread `obj:<id>`, and it lands in `events`
   * alongside chat. They are also the only place much of the real
   * reasoning lives, which is finding "recovery omits discussion" — so
   * an import that read only the typed tables would drop the half of
   * the record that explains the other half.
   */
  private discussionSteps(objectiveId: string, contract: string): Step[] {
    if (!tableExists(this.db, 'events')) return [];
    const rows = this.db
      .prepare(
        `SELECT id, ts, from_name, body, data FROM events
          WHERE json_extract(data, '$.kind') = 'objective_discuss'
            AND json_extract(data, '$.objective_id') = ?
          ORDER BY ts, id`,
      )
      .all(objectiveId) as unknown as MessageRow[];

    const steps: Step[] = [];
    for (const message of rows) {
      const author = message.from_name;
      if (author === null) {
        this.drop(
          'message',
          message.id,
          'objective_discuss',
          'the post records no author, and an unattributed post imported under any name ' +
            'would be the projection putting words in somebody’s mouth',
        );
        continue;
      }
      steps.push({
        source: 'message',
        id: message.id,
        kind: 'objective_discuss',
        ts: message.ts,
        run: () =>
          this.spine.append(
            // Carried WHOLE and unwrapped — this one is a member's own
            // text with nothing composed around it, so it gets no
            // import note.
            { kind: 'discussion', body: { contract, body: message.body } },
            { actor: author, provenance: 'legacy_projection', now: message.ts },
          ),
      });
    }
    return steps;
  }

  private discuss(legacyId: string, contract: string, event: EventRow, body: string): Step {
    return {
      source: 'objective_event',
      id: legacyId,
      kind: event.kind,
      ts: event.ts,
      run: () =>
        this.spine.append(
          { kind: 'discussion', body: { contract, body } },
          { actor: event.actor, provenance: 'legacy_projection', now: event.ts },
        ),
    };
  }

  /** The contract's counter, read fresh — every authoritative write moves it. */
  private stateRev(contract: string): number {
    return this.spine.store.contract(contract)?.stateRev ?? 0;
  }

  /**
   * A prose field the spine requires and the legacy record may not
   * carry.
   *
   * The sentinel is a statement about the RECORD ("no reason was
   * recorded"), verifiable against the record, and it is marked as the
   * importer's. That is a different object from a derived FACT about
   * the world, which is what the migration rule forbids: the forbidden
   * move manufactures a claim nobody made, this one reports an absence
   * nobody can mistake for a claim.
   *
   * The alternative was to drop the event, which would render a
   * cancelled objective as `active` — an ended thing shown as live
   * work, which is the falsehood in the direction that costs a member
   * their attention.
   */
  private prose(value: unknown, absence: string): string {
    if (typeof value === 'string' && value.trim().length > 0) return value;
    return `${IMPORT_NOTE} ${absence}`;
  }
}

/**
 * Import the legacy objectives record into the annex. Explicitly run,
 * one shot, idempotent: a second run over the same database appends
 * nothing.
 */
export async function importObjectives(
  options: ImportObjectivesOptions,
): Promise<ObjectivesImportSummary> {
  const importer = new ObjectivesImporter(options);
  return importer.run(options.registeredBy ?? 'legacy-import', options.now ?? Date.now());
}

/** The summary as the sentence the CLI prints. */
export function formatImportSummary(summary: ObjectivesImportSummary): string {
  const lines = [
    `objectives read:             ${summary.objectivesRead}`,
    `objectives imported:         ${summary.objectivesImported}`,
    `already imported (skipped):  ${summary.objectivesAlreadyImported}`,
  ];
  const kinds = Object.keys(summary.appended).sort();
  lines.push(
    kinds.length === 0
      ? 'events appended:             none'
      : `events appended:             ${kinds.map((k) => `${k}=${summary.appended[k]}`).join(' ')}`,
  );
  if (summary.rowidFallbacks > 0) {
    lines.push(
      `legacy rows with no event_id: ${summary.rowidFallbacks} (op ids fall back to rowid, ` +
        'so idempotency across a VACUUM is not guaranteed for these)',
    );
  }
  lines.push('', 'NOT IMPORTED, and deliberately:');
  lines.push(
    '  revisions — no SHA is scraped from a title, an outcome, or a thread',
    '  verdicts  — a legacy completion had none, and inventing one would launder it',
    '  criteria  — the outcome is ONE criterion, carried verbatim, never decomposed',
    '  watchers  — the spine has no watchers; subscription is reader-side',
  );
  if (summary.unimported.length > 0) {
    lines.push('', `${summary.unimported.length} legacy rows left unimported:`);
    for (const row of summary.unimported) {
      lines.push(`  ${row.source} ${row.id} (${row.kind}): ${row.reason}`);
    }
  }
  return lines.join('\n');
}
