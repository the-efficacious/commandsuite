/**
 * The team's process, held as ONE authored document with an
 * append-only edit history.
 *
 * WHY A DOCUMENT AND NOT A LIST OF RULES. A list of rulings is a
 * changelog wearing the costume of a specification: it tells a reader
 * what four decisions were made and leaves them to compose "how we
 * work" from the pieces. It also only ever accumulates — nothing
 * removes a rule — so the injected block grows without bound. A
 * document gets *edited*: superseded content leaves rather than piling
 * up, and its size is bounded by whoever maintains it.
 *
 * WHY "TEAM PROCESS" AND NOT "PROCESS DOCUMENT". The domain concept is
 * the team's *process* — operational context a member consults —
 * and "document" is only the storage shape, which had leaked into the
 * identifier and framed the thing as a static artifact to fetch. The
 * permission leaf never carried the word (`process.manage`, now
 * `team_process.manage`) and neither did the first line of this
 * file. The qualifier is not optional: a module, type or variable
 * named bare `process` shadows Node's global — this tree has close to
 * two hundred `process.*` uses — and reads as the runtime process at
 * every call site. `team_process` rules that reading out on sight.
 * The tables, tools, routes, types and permission all carry the same
 * name so that one grep finds every surface.
 *
 * WHY THERE IS NO PROVENANCE HERE. Authority is the edit permission
 * and nothing else. The predecessor design carried per-rule
 * provenance, attribution and a disputed status so that "the process editor
 * said this" could not be laundered from "the lead proposed it and
 * nobody objected" — a real protection, but one that could only ever
 * check a field was non-null, never that anyone said anything. Under
 * one document that machinery buys less than it costs: the record says
 * who edited it, why, and what the text was before, and that is the
 * accountability the shape actually needs.
 *
 * THE SINGLETON AND ITS ABSENCE. At most one document exists. A team
 * that has never written one is a real state, not an error, and it
 * renders as an explicit line rather than as nothing — because
 * rendering nothing collapses three cases a member cannot then tell
 * apart:
 *
 *   no document exists                        member sees nothing
 *   a runner too old to read the field        member sees nothing
 *   a broker without the feature              member sees nothing
 *
 * The middle one is the silent-degradation class. Rendering nothing
 * makes the healthy case wear the costume of the broken one.
 *
 * THERE IS NO SEPARATE CREATE PATH. The first authorised write creates
 * version 1; every later write edits. One code path, so the invariant
 * validator below is exercised through the real endpoint rather than
 * only by a unit test calling it directly, and version 1 has a real
 * author and a real reason instead of being seeded by a migration that
 * would have to invent its text.
 *
 * IT RIDES IN ITS OWN FIELD ON THE INSTRUCTIONS RESPONSE, and the durable reason is not
 * the instruction cap — which has since been removed (#122, landed in
 * #129) without changing this decision at all. A member authors their
 * own `instructions`; this is authored by whoever holds
 * `team_process.manage`. One string collapses two authorities into one
 * field, and that is true at any cap or none.
 *
 * HISTORY IS RETRIEVED, NEVER RESIDENT. Superseded text lives in
 * `team_process_edits` and is served by its own endpoint. What is
 * injected is the current text and nothing else, so editing fifty
 * times costs exactly what editing once costs. The ceiling on the
 * injected size is `TEAM_PROCESS_MAX` — a real ceiling, unlike the
 * predecessor, which held N rules with nothing capping N.
 */

import { TEAM_PROCESS_FIELDS, TeamProcessEditSchema } from 'csuite-sdk/schemas';
import type { EditTeamProcessRequest, TeamProcess, TeamProcessEdit } from 'csuite-sdk/types';
import { runInTransaction, type SqlDriver, type SqlStatement } from './sql-driver.js';

export class TeamProcessError extends Error {
  readonly code: 'not_found' | 'invalid_input' | 'corrupt_history';
  constructor(code: TeamProcessError['code'], message: string) {
    super(message);
    this.name = 'TeamProcessError';
    this.code = code;
  }
}

/** The mutable half of the document — what a write produces. */
export type EditableFields = Pick<TeamProcess, 'text'>;

/**
 * Every invariant that must hold of a WHOLE document, in one place,
 * applied by the only write path there is.
 *
 * It takes the fully constructed next document, never the delta. That
 * signature is deliberate and it is the point: on the predecessor,
 * validation inspected only the fields an edit supplied, which cannot
 * express an invariant about a whole record — an edit could set a
 * field to a value that was invalid *in combination* with fields it
 * did not mention, and the check never looked at the record it was
 * producing. Any validator that can see the delta will grow that
 * defect again, so this one cannot see it.
 */
export function assertDocumentInvariants(next: EditableFields): void {
  const text = next.text.trim();
  if (text.length === 0) {
    throw new TeamProcessError(
      'invalid_input',
      'the process document cannot be empty — delete is not an edit, and a blank document ' +
        'renders identically to a team that never wrote one',
    );
  }
}

const CREATE_SCHEMA = `
  -- Singleton. The id is pinned to 1 by the CHECK so a second row is a
  -- storage error rather than a silent second document that some
  -- queries would find and others would not.
  CREATE TABLE IF NOT EXISTS team_process (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    text TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Append-only. One row per version INCLUDING version 1, so history
  -- begins at creation with a real author and reason rather than the
  -- document appearing to have always existed.
  CREATE TABLE IF NOT EXISTS team_process_edits (
    version INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK(disposition IN ('correction','scope_change')),
    fields TEXT NOT NULL,
    previous TEXT NOT NULL
  );
`;

/**
 * The names these tables shipped under before the team-process rename.
 * Every deployment that wrote a process document before then has rows
 * under these names, and `process_document_edits` is an append-only
 * history — dropping it or leaving it behind would be data loss.
 */
const LEGACY_TABLES = [
  { from: 'process_document', to: 'team_process' },
  { from: 'process_document_edits', to: 'team_process_edits' },
] as const;

function tableExists(db: SqlDriver, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return row?.name === name;
}

function countRows(db: SqlDriver, table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number | bigint };
  return Number(row.n);
}

/**
 * Carry a pre-rename database forward, IN PLACE and ONCE.
 *
 * The repo's lazy `ALTER TABLE ... ADD COLUMN` idiom does not cover a
 * table rename, and the "try it and swallow the expected error" shape
 * that idiom relies on would be the wrong instrument here anyway: the
 * states that matter are which tables EXIST, and `sqlite_master`
 * answers that directly. So this decides from the catalogue rather
 * than from an error message, and it runs BEFORE `CREATE TABLE IF NOT
 * EXISTS` — after it, the new tables would always exist and the old
 * rows would sit stranded beside empty successors.
 *
 * Three states, three outcomes:
 *
 *   fresh database        neither name exists     no-op; CREATE_SCHEMA
 *                                                 builds `team_process`
 *   pre-rename database   only the old name       RENAME — every row,
 *                                                 every version, kept
 *   already migrated      only the new name       no-op; opening twice
 *                                                 is the same as once
 *
 * A fourth state arises only from a downgrade AFTER migration: an
 * older broker's CREATE TABLE IF NOT EXISTS recreates the old name,
 * empty, beside the renamed one. An empty shell is dropped as the
 * shell it is. If the shell holds rows, two histories exist and no
 * rename can say which one binds the team, so this refuses and names
 * both rather than guess. The pair is handled in one transaction so a
 * refusal on the second table also undoes whatever happened to the
 * first.
 */
function migrateLegacyTableNames(db: SqlDriver): void {
  const pending = LEGACY_TABLES.filter((t) => tableExists(db, t.from));
  if (pending.length === 0) return;
  runInTransaction(db, () => {
    for (const { from, to } of pending) {
      if (!tableExists(db, to)) {
        db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
        continue;
      }
      if (countRows(db, from) === 0) {
        db.exec(`DROP TABLE ${from}`);
        continue;
      }
      throw new Error(
        `both '${from}' and '${to}' exist and '${from}' holds rows — a downgraded broker ` +
          'wrote a second history after this database was migrated. Reconcile the two by ' +
          'hand; refusing to guess which one binds the team.',
      );
    }
  });
}

interface DocumentRow {
  text: string;
  version: number;
  created_by: string;
  created_at: number;
  updated_by: string;
  updated_at: number;
}

interface EditRow {
  version: number;
  ts: number;
  actor: string;
  reason: string;
  disposition: string;
  fields: string;
  previous: string;
}

export interface TeamProcessStore {
  /** The current document, or `null` when none has ever been written. */
  get(): TeamProcess | null;
  /**
   * Create or edit, in one transaction. The first write produces
   * version 1 and records an edit with no prior text.
   */
  write(
    input: EditTeamProcessRequest,
    actor: string,
    now?: number,
  ): { document: TeamProcess; edit: TeamProcessEdit };
  /** Oldest first. Empty when no document has been written. */
  history(): TeamProcessEdit[];
}

class SqliteTeamProcessStore implements TeamProcessStore {
  private readonly db: SqlDriver;
  private readonly selectStmt: SqlStatement;
  private readonly selectHistoryStmt: SqlStatement;

  constructor(db: SqlDriver) {
    this.db = db;
    // BEFORE CREATE_SCHEMA — see migrateLegacyTableNames for why the
    // order is load-bearing.
    migrateLegacyTableNames(db);
    db.exec(CREATE_SCHEMA);
    this.selectStmt = db.prepare('SELECT * FROM team_process WHERE id = 1');
    this.selectHistoryStmt = db.prepare('SELECT * FROM team_process_edits ORDER BY version ASC');
  }

  get(): TeamProcess | null {
    const row = this.selectStmt.get() as DocumentRow | undefined;
    return row ? rowToDocument(row) : null;
  }

  write(
    input: EditTeamProcessRequest,
    actor: string,
    now: number = Date.now(),
  ): { document: TeamProcess; edit: TeamProcessEdit } {
    const current = this.get();

    // Change detection is driven by TEAM_PROCESS_FIELDS, derived
    // from the one shape that also defines what the request accepts
    // and what `previous` can hold. A field cannot be accepted here
    // and go unrecorded, because it is the same list.
    const fields: TeamProcessEdit['fields'] = [];
    const previous: TeamProcessEdit['previous'] = {};
    const next: EditableFields = { text: current?.text ?? '' };

    for (const field of TEAM_PROCESS_FIELDS) {
      const incoming = input[field];
      if (incoming === undefined) continue;
      if (current !== null && incoming === current[field]) continue;
      fields.push(field);
      if (current !== null) previous[field] = current[field];
      next[field] = incoming;
    }

    if (current === null && fields.length === 0) {
      throw new TeamProcessError(
        'invalid_input',
        `no process document exists — the first write must supply ${TEAM_PROCESS_FIELDS.join(', ')}`,
      );
    }
    if (current !== null && fields.length === 0) {
      throw new TeamProcessError(
        'invalid_input',
        `edit changes nothing — supply ${TEAM_PROCESS_FIELDS.join(', ')} that differs from the current text`,
      );
    }

    // The same invariant on creation and on edit, applied to the
    // document this write will produce rather than to what it supplied.
    assertDocumentInvariants(next);

    const version = (current?.version ?? 0) + 1;
    const edit: TeamProcessEdit = {
      version,
      ts: now,
      actor,
      reason: input.reason,
      disposition: input.disposition,
      fields,
      previous,
    };

    // ONE transaction. A document whose text moved without its prior
    // version recorded is unrecoverable, and worse than immutability —
    // this is the defect the predecessor shipped and a partner caught
    // by driving a failing history append through the real route.
    runInTransaction(this.db, () => {
      if (current === null) {
        this.db
          .prepare(
            `INSERT INTO team_process
             (id, text, version, created_by, created_at, updated_by, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?)`,
          )
          .run(next.text, version, actor, now, actor, now);
      } else {
        this.db
          .prepare(
            'UPDATE team_process SET text = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = 1',
          )
          .run(next.text, version, actor, now);
      }
      this.db
        .prepare(
          `INSERT INTO team_process_edits
           (version, ts, actor, reason, disposition, fields, previous)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          version,
          now,
          actor,
          input.reason,
          input.disposition,
          JSON.stringify(fields),
          JSON.stringify(previous),
        );
    });

    return { document: this.get() as TeamProcess, edit };
  }

  /**
   * THREE LEVELS, and only the first is a parse.
   *
   *   syntax       is it JSON?                    JSON.parse throws
   *   shape        is `fields` actually an array? a cast is not a check
   *   cross-field  a later edit claiming to have
   *                changed `text` must have
   *                retained the prior `text`      the record-level rule
   *
   * `JSON.parse` succeeding proves the bytes are JSON. It proves
   * nothing about the record being the record. The damaging
   * corruptions are WELL-FORMED: `previous = '{}'` parses cleanly and
   * renders as "created — no prior text", telling a caller there was
   * nothing before; `fields = '{}'` parses to an object a cast then
   * calls an array. Both are the original lie wearing valid syntax,
   * and an earlier fix here caught only level 1.
   *
   * So the reconstructed record goes through the schema, whose
   * refinement carries the relationship shape cannot express. This is
   * the read path criterion 3's "retained, not reconstructed" promise
   * is made on, so it is validated here rather than trusted.
   *
   * No fallback at any level: this store writes both columns itself,
   * so a failure is corruption or a broken invariant, never optional
   * input.
   */
  history(): TeamProcessEdit[] {
    const rows = this.selectHistoryStmt.all() as unknown as EditRow[];
    const edits = rows.map((row, i) => {
      const candidate = {
        version: row.version,
        ts: row.ts,
        actor: row.actor,
        reason: row.reason,
        disposition: row.disposition,
        fields: parseColumn<unknown>(row.fields, row.version, 'fields'),
        previous: parseColumn<unknown>(row.previous, row.version, 'previous'),
      };
      const parsed = TeamProcessEditSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new TeamProcessError(
          'corrupt_history',
          `process document edit v${row.version} is not a valid history record ` +
            `(row ${i + 1} of ${rows.length}): ` +
            parsed.error.issues
              .map((iss) => `${iss.path.join('.') || '(root)'} — ${iss.message}`)
              .join('; '),
        );
      }
      return parsed.data;
    });

    // CROSS-RECORD, because per-record validity is not history.
    //
    // `write()` emits versions 1, 2, 3 … with no gaps — the next
    // version is always `current.version + 1`. So a gap is a DELETED
    // row, and without this check a truncated history reads as a
    // complete one: every surviving record is individually valid, the
    // list is ordered, and nothing says a version is missing. That is
    // the append-only claim failing silently, which is the same
    // reader-accepts-what-the-writer-cannot-emit shape as the record
    // checks above, one level up.
    edits.forEach((edit, i) => {
      if (edit.version !== i + 1) {
        throw new TeamProcessError(
          'corrupt_history',
          `process document history is not contiguous — expected v${i + 1} at position ` +
            `${i + 1} and found v${edit.version}. A version is missing, so this is a ` +
            'truncated history being served as a complete one.',
        );
      }
    });

    // CONTIGUITY IS NOT COMPLETENESS. `1,2,3` minus v3 leaves `[1,2]`,
    // where every version still equals its index + 1 — so the check
    // above passes and a truncated history is served as a complete
    // one. Deleting every row returns `[]` just as cleanly while the
    // document itself still sits at v3.
    //
    // The document row is the authority: `write()` moves it and
    // appends history in ONE transaction, so the current version is
    // exactly the number of edits that must exist. Anchoring to it
    // catches suffix deletion and total deletion, which counting
    // relative to the surviving rows never can.
    const document = this.get();
    const expected = document?.version ?? 0;
    if (edits.length !== expected) {
      throw new TeamProcessError(
        'corrupt_history',
        `process document is at v${expected} but history holds ${edits.length} edit(s) — ` +
          `${expected > edits.length ? 'edits are missing' : 'there are more edits than versions'}. ` +
          'Serving this as the complete history would understate what has changed.',
      );
    }

    return edits;
  }
}

function rowToDocument(row: DocumentRow): TeamProcess {
  return {
    text: row.text,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/**
 * Parses a column this store wrote. Throws rather than degrading.
 *
 * "Retained, not reconstructed" is only true if an unreadable record
 * says so. A fallback here would answer a question about history with
 * a confident wrong answer.
 */
function parseColumn<T>(raw: string, version: number, column: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new TeamProcessError(
      'corrupt_history',
      `process document edit v${version} has an unreadable '${column}' column — ` +
        'the retained prior text cannot be trusted, and reporting it as absent would ' +
        `say there was nothing before. Underlying: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function createSqliteTeamProcessStore(db: SqlDriver): TeamProcessStore {
  return new SqliteTeamProcessStore(db);
}
