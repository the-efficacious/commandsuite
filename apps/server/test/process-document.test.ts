/**
 * The process document store.
 *
 * Criteria 3–6 and 8 live here. Criteria 5 and 6 exist because a
 * partner found two real defects in the predecessor's amend path, and
 * both are properties of any create-or-edit path rather than of the
 * shape that had them:
 *
 *   - the request accepted fields the record had no column for, so
 *     editing them wrote the new value and recorded no prior one —
 *     silently, when paired with a field that WAS tracked
 *   - validation inspected only the fields an edit supplied, which
 *     cannot express an invariant about a whole record, so an edit
 *     could produce a document creation would have refused
 *
 * The tests below are written to fail if either returns.
 */

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createSqliteProcessDocumentStore, ProcessDocumentError } from '../src/process-document.js';

const AT = 1_700_000_000_000;

/** AndrewJon, verbatim — the shape this replaced four rules with. */
const V1 = [
  'Keep a conversation running before action until I say otherwise.',
  'Support all work with approved objectives; escalate patches to me.',
  'Squash-merge to main.',
].join('\n');

const V2 = [
  'Keep a conversation running before action until I say otherwise.',
  'Support all work with approved objectives; escalate patches to me.',
  'Merge commits to main.',
].join('\n');

function store() {
  return createSqliteProcessDocumentStore(openDatabase(':memory:'));
}

function seed(s: ReturnType<typeof store>, text = V1, actor = 'AndrewJon') {
  return s.write(
    { text, reason: 'Wrote down how we work.', disposition: 'scope_change' },
    actor,
    AT,
  );
}

// ─── criterion 1: absence is a state, not an error ───────────────────

describe('a team with no process document', () => {
  it('reports null rather than throwing or inventing one', () => {
    expect(store().get()).toBeNull();
  });

  it('has no history rather than a history of nothing', () => {
    expect(store().history()).toEqual([]);
  });

  it('refuses a first write that supplies no text, naming what is required', () => {
    const s = store();
    expect(() => s.write({ reason: 'r', disposition: 'correction' }, 'lea', AT)).toThrow(
      /first write must supply/,
    );
    // And nothing was created by the attempt.
    expect(s.get()).toBeNull();
    expect(s.history()).toEqual([]);
  });
});

// ─── criterion 3: author, reason, prior text ─────────────────────────

describe('the first write creates version 1 with a real author', () => {
  it('records the creator, the reason, and NO prior text', () => {
    const s = store();
    const { document, edit } = seed(s);

    expect(document.version).toBe(1);
    expect(document.createdBy).toBe('AndrewJon');
    expect(document.updatedBy).toBe('AndrewJon');
    expect(document.text).toBe(V1);

    expect(edit.version).toBe(1);
    expect(edit.actor).toBe('AndrewJon');
    expect(edit.reason).toBe('Wrote down how we work.');
    // Creation has no prior text — and the absence is explicit rather
    // than an empty string that would read as "it used to be blank".
    expect(edit.previous.text).toBeUndefined();
  });

  it('begins history at creation rather than at the first edit', () => {
    const s = store();
    seed(s);
    expect(s.history().map((e) => e.version)).toEqual([1]);
  });
});

describe('every edit records author, reason and prior text', () => {
  it('retains the superseded text in full, not a summary of it', () => {
    const s = store();
    seed(s);
    const { document, edit } = s.write(
      { text: V2, reason: 'The team moved to merge commits.', disposition: 'scope_change' },
      'Lea',
      AT + 1,
    );

    expect(document.version).toBe(2);
    expect(document.text).toBe(V2);
    // createdBy never moves; updatedBy is whoever wrote the current version.
    expect(document.createdBy).toBe('AndrewJon');
    expect(document.updatedBy).toBe('Lea');

    expect(edit.actor).toBe('Lea');
    expect(edit.reason).toBe('The team moved to merge commits.');
    // The WHOLE prior text, so the diff is derivable. A summary or a
    // cached diff would be a second copy that can drift from the text
    // it describes.
    expect(edit.previous.text).toBe(V1);
  });

  it('makes the diff derivable from stored strings alone', () => {
    const s = store();
    seed(s);
    s.write({ text: V2, reason: 'r', disposition: 'correction' }, 'Lea', AT + 1);
    const [, second] = s.history();
    const before = (second?.previous.text ?? '').split('\n');
    const after = (s.get()?.text ?? '').split('\n');
    // Nothing cached: the change is computed from prior + current.
    expect(before.filter((l) => !after.includes(l))).toEqual(['Squash-merge to main.']);
    expect(after.filter((l) => !before.includes(l))).toEqual(['Merge commits to main.']);
  });

  it('refuses an edit that changes nothing rather than recording a no-op version', () => {
    const s = store();
    seed(s);
    expect(() =>
      s.write({ text: V1, reason: 'r', disposition: 'correction' }, 'Lea', AT + 1),
    ).toThrow(/changes nothing/);
    expect(s.get()?.version).toBe(1);
  });
});

// ─── criterion 7: disposition ────────────────────────────────────────

describe('disposition carries #79 semantics unchanged', () => {
  it('records correction and scope_change distinctly', () => {
    const s = store();
    seed(s);
    s.write({ text: V2, reason: 'a', disposition: 'correction' }, 'Lea', AT + 1);
    s.write({ text: V1, reason: 'b', disposition: 'scope_change' }, 'Lea', AT + 2);
    expect(s.history().map((e) => e.disposition)).toEqual([
      'scope_change',
      'correction',
      'scope_change',
    ]);
  });
});

// ─── criterion 6: the invariant sees the whole document ──────────────

describe('invariants are enforced on the constructed document', () => {
  it('refuses a blank document on CREATE', () => {
    expect(() =>
      store().write({ text: '   ', reason: 'r', disposition: 'correction' }, 'lea', AT),
    ).toThrow(ProcessDocumentError);
  });

  /**
   * The same validator, through the same path, on edit. On the
   * predecessor this branch did not exist: validation looked at the
   * delta, so an edit could produce a record creation would refuse.
   */
  it('refuses a blank document on EDIT, by the same validator', () => {
    const s = store();
    seed(s);
    expect(() =>
      s.write({ text: '  \n  ', reason: 'r', disposition: 'correction' }, 'Lea', AT + 1),
    ).toThrow(/cannot be empty/);
    // The document did not move.
    expect(s.get()?.text).toBe(V1);
    expect(s.get()?.version).toBe(1);
    expect(s.history()).toHaveLength(1);
  });
});

// ─── criterion 4: atomicity ──────────────────────────────────────────

describe('the write is atomic', () => {
  /**
   * Drives a real failure of the history append through the real
   * write path, rather than asserting a transaction is present.
   * Without one transaction the document moves and its prior text is
   * gone — recoverable by nobody, which is worse than immutability.
   */
  it('rolls the document back when the history append fails', () => {
    const db = openDatabase(':memory:');
    const s = createSqliteProcessDocumentStore(db);
    s.write({ text: V1, reason: 'r', disposition: 'correction' }, 'AndrewJon', AT);

    db.exec(`
      CREATE TRIGGER block_history BEFORE INSERT ON process_document_edits
      BEGIN SELECT RAISE(ABORT, 'history append failed'); END;
    `);

    expect(() =>
      s.write({ text: V2, reason: 'r', disposition: 'correction' }, 'Lea', AT + 1),
    ).toThrow(/history append failed/);

    // The contract did not move, and the prior text is still the text.
    expect(s.get()?.text).toBe(V1);
    expect(s.get()?.version).toBe(1);
    expect(s.history()).toHaveLength(1);
  });
});

// ─── criterion 8: history retrievable, not resident ──────────────────

describe('history is retrievable, not resident', () => {
  it('does not grow the current document as edits accumulate', () => {
    const s = store();
    seed(s, 'revision 0');
    for (let i = 1; i <= 5; i++) {
      s.write(
        { text: `revision ${i}`, reason: `edit ${i}`, disposition: 'correction' },
        'Lea',
        AT + i,
      );
    }
    // Six versions; the injected text is one of them and carries no
    // trace of the other five.
    expect(s.history()).toHaveLength(6);
    expect(s.get()?.text).toBe('revision 5');
    expect(s.get()?.text).not.toContain('revision 4');
    expect(s.get()?.text).not.toContain('revision 0');
    // Injected size is a function of the document, not of edit count.
    expect(s.get()?.text.length).toBe('revision 5'.length);
  });

  it('keeps every superseded version retrievable', () => {
    const s = store();
    seed(s, 'revision 0');
    for (let i = 1; i <= 3; i++) {
      s.write({ text: `revision ${i}`, reason: 'r', disposition: 'correction' }, 'Lea', AT + i);
    }
    expect(s.history().map((e) => e.previous.text)).toEqual([
      undefined,
      'revision 0',
      'revision 1',
      'revision 2',
    ]);
  });
});

// ─── corrupt history fails loud ──────────────────────────────────────
//
// Found by Rune. `history()` used to parse the two completeness-bearing
// JSON columns with fallbacks — malformed `fields` became `[]`,
// malformed `previous` became `{}`. A damaged row was then returned as
// "created — no prior text", telling the caller there had been nothing
// before rather than that the retained record is unreadable. Criterion
// 3 failing in the reassuring direction.
//
// The distinction that decides it: this store WRITES both columns. A
// fallback is appropriate for input you did not write; on your own
// writes it converts an invariant violation into a plausible record.

describe('a corrupt history row is an error, not an empty one', () => {
  function corrupt(column: 'previous' | 'fields') {
    const db = openDatabase(':memory:');
    const s = createSqliteProcessDocumentStore(db);
    s.write({ text: V1, reason: 'r', disposition: 'correction' }, 'AndrewJon', AT);
    s.write({ text: V2, reason: 'r', disposition: 'correction' }, 'Lea', AT + 1);
    db.exec(`UPDATE process_document_edits SET ${column} = '{not json' WHERE version = 2`);
    return s;
  }

  it('throws rather than reporting an unreadable prior text as absent', () => {
    const s = corrupt('previous');
    expect(() => s.history()).toThrow(/unreadable 'previous' column/);
    // The specific lie it used to tell.
    expect(() => s.history()).toThrow(/would say there was nothing before/);
  });

  it('throws on an unreadable fields column too', () => {
    expect(() => corrupt('fields').history()).toThrow(/unreadable 'fields' column/);
  });

  it('names the version, so the damaged row is findable', () => {
    expect(() => corrupt('previous').history()).toThrow(/v2/);
  });
});

// ─── valid JSON is not a valid record ────────────────────────────────
//
// Rune's second pass. The first fix caught only SYNTAX. The damaging
// corruptions are well-formed:
//
//   previous = '{}'   parses cleanly, renders "created — no prior text"
//   fields   = '{}'   parses to an object a cast then calls an array
//
// Both are the original lie wearing valid syntax. Three levels, and
// only the first was guarded:
//
//   syntax       is it JSON?                      JSON.parse
//   shape        is `fields` an array?            the schema
//   cross-field  a later edit claiming `text`
//                must have retained prior text    the refinement

describe('a well-formed but untrue history row is an error', () => {
  function seeded() {
    const db = openDatabase(':memory:');
    const s = createSqliteProcessDocumentStore(db);
    s.write({ text: V1, reason: 'r', disposition: 'correction' }, 'AndrewJon', AT);
    s.write({ text: V2, reason: 'r', disposition: 'correction' }, 'Lea', AT + 1);
    return { db, s };
  }

  it('rejects previous={} on an edit that claims to have changed text', () => {
    const { db, s } = seeded();
    // Valid JSON. Parses. Would have rendered "created — no prior text"
    // for an edit that demonstrably changed the document.
    db.exec("UPDATE process_document_edits SET previous = '{}' WHERE version = 2");
    expect(() => s.history()).toThrow(/retained no prior value/);
    expect(() => s.history()).toThrow(/v2/);
  });

  it('rejects fields={} — an object is not an array', () => {
    const { db, s } = seeded();
    db.exec("UPDATE process_document_edits SET fields = '{}' WHERE version = 2");
    expect(() => s.history()).toThrow(/not a valid history record/);
  });

  it('rejects prior text on version 1, which IS the creation', () => {
    const { db, s } = seeded();
    db.exec(`UPDATE process_document_edits SET previous = '{"text":"invented"}' WHERE version = 1`);
    expect(() => s.history()).toThrow(/version 1 is the creation/);
  });

  /**
   * Rune's third pass. `write()` rejects a no-op before it appends
   * history, so `fields = []` is a row the writer cannot produce — an
   * edit event claiming nothing changed. `z.array()` accepted it and
   * the refinement iterated zero fields and succeeded, so the record
   * passed every check while asserting something false.
   */
  it('rejects fields=[] — an edit that changed nothing cannot exist', () => {
    const { db, s } = seeded();
    db.exec("UPDATE process_document_edits SET fields = '[]' WHERE version = 2");
    expect(() => s.history()).toThrow(/changed nothing cannot exist/);
  });

  it('rejects a repeated field name, which the writer also cannot produce', () => {
    const { db, s } = seeded();
    db.exec(`UPDATE process_document_edits SET fields = '["text","text"]' WHERE version = 2`);
    expect(() => s.history()).toThrow(/same field twice/);
  });

  it('still reads a healthy history, so the guard is not refusing everything', () => {
    const { s } = seeded();
    const edits = s.history();
    expect(edits).toHaveLength(2);
    expect(edits[1]?.previous.text).toBe(V1);
  });
});

// ─── the reader must not accept what the writer cannot emit ──────────
//
// Lea's general form of Rune's findings: every gap between the read
// schema's accepted set and the write path's producible set is a
// record that exists in the reader's model and not in reality — and
// each one renders as something plausible, which is why they have all
// been quiet rather than loud. Asked of the whole schema once, rather
// than closed instance by instance.

describe('records the writer cannot produce are rejected on read', () => {
  function seeded() {
    const db = openDatabase(':memory:');
    const s = createSqliteProcessDocumentStore(db);
    s.write({ text: V1, reason: 'r', disposition: 'correction' }, 'AndrewJon', AT);
    s.write({ text: V2, reason: 'r', disposition: 'correction' }, 'Lea', AT + 1);
    return { db, s };
  }

  /**
   * NOTE THE REASON THIS PASSES. It is the non-empty constraint, not
   * the subset check — verified by mutation: removing the
   * previous-keys-must-be-listed rule leaves all 27 tests green.
   *
   * That rule is UNREACHABLE at one editable field. The only ways to
   * hold a prior value for an unlisted field are `fields = []` (caught
   * first by the non-empty rule) or a second field (which does not
   * exist yet); an unknown key is stripped by the schema before the
   * refinement sees it. So the rule is correct, generalises, and
   * cannot be exercised — the same degeneracy as criterion 6, and
   * named here rather than left looking verified.
   */
  it('rejects fields=[] before the subset rule is ever reached', () => {
    const { db, s } = seeded();
    db.exec(`UPDATE process_document_edits SET fields = '[]' WHERE version = 2`);
    expect(() => s.history()).toThrow(/changed nothing cannot exist/);
  });

  /**
   * THE PAIRED CORRUPTION, which isolates `.min(1)`.
   *
   * The test above does not. Its row still carries `previous.text`, so
   * removing `.min(1)` leaves it failing via the SUBSET rule — a
   * prior value for a field the edit does not list. Two paths to one
   * failure, and the test is named for the path it does not exercise.
   * Redundancy absorbing a mutation, in a test I wrote about
   * redundancy absorbing mutations.
   *
   * `fields=[]` WITH `previous={}` is consistent with every other
   * refinement: nothing claimed, nothing retained, version 1 rule not
   * applicable. Only the non-empty constraint rejects it — and the
   * writer cannot emit it, because `write()` refuses a no-op before it
   * appends history.
   */
  it('rejects fields=[] paired with previous={}, which only min(1) catches', () => {
    const { db, s } = seeded();
    db.exec(`UPDATE process_document_edits SET fields = '[]', previous = '{}' WHERE version = 2`);
    expect(() => s.history()).toThrow(/changed nothing cannot exist/);
  });

  it('rejects any prior value on version 1, not just prior text', () => {
    const { db, s } = seeded();
    db.exec(`UPDATE process_document_edits SET previous = '{"text":"invented"}' WHERE version = 1`);
    expect(() => s.history()).toThrow(/cannot have prior values/);
  });

  /**
   * The cross-record one. Every surviving row is individually valid
   * and the list is ordered, so a deleted row reads as a complete
   * history unless something checks the sequence.
   */
  it('rejects a history with a version deleted out of the middle', () => {
    const db = openDatabase(':memory:');
    const s = createSqliteProcessDocumentStore(db);
    s.write({ text: 'one', reason: 'r', disposition: 'correction' }, 'a', AT);
    s.write({ text: 'two', reason: 'r', disposition: 'correction' }, 'b', AT + 1);
    s.write({ text: 'three', reason: 'r', disposition: 'correction' }, 'c', AT + 2);
    expect(s.history()).toHaveLength(3);

    db.exec('DELETE FROM process_document_edits WHERE version = 2');
    expect(() => s.history()).toThrow(/not contiguous/);
    expect(() => s.history()).toThrow(/truncated history being served as a complete one/);
  });

  it('rejects a history missing version 1', () => {
    const { db, s } = seeded();
    db.exec('DELETE FROM process_document_edits WHERE version = 1');
    expect(() => s.history()).toThrow(/not contiguous/);
  });
});

// ─── contiguity is not completeness ──────────────────────────────────
//
// Rune's third pass, and it is my own contiguity find one step
// further: `1,2,3` minus v3 leaves `[1,2]`, where every version still
// equals its index + 1. The sequence check passes and a truncated
// history is served as complete. I caught interior deletion and missed
// the suffix, which is the case an attacker or a bad migration would
// actually produce.

describe('history completeness is anchored to the document, not to itself', () => {
  function three() {
    const db = openDatabase(':memory:');
    const s = createSqliteProcessDocumentStore(db);
    s.write({ text: 'one', reason: 'r', disposition: 'correction' }, 'a', AT);
    s.write({ text: 'two', reason: 'r', disposition: 'correction' }, 'b', AT + 1);
    s.write({ text: 'three', reason: 'r', disposition: 'correction' }, 'c', AT + 2);
    return { db, s };
  }

  it('rejects deletion of the LAST edit, which contiguity alone cannot see', () => {
    const { db, s } = three();
    db.exec('DELETE FROM process_document_edits WHERE version = 3');
    // [1,2] is perfectly contiguous. Only the document's own version
    // says an edit is missing.
    expect(() => s.history()).toThrow(/at v3 but history holds 2 edit/);
    expect(() => s.history()).toThrow(/edits are missing/);
  });

  it('rejects deletion of the ENTIRE history while the document stands', () => {
    const { db, s } = three();
    db.exec('DELETE FROM process_document_edits');
    expect(() => s.history()).toThrow(/at v3 but history holds 0 edit/);
  });

  it('still returns an empty history for a team with no document', () => {
    const s = createSqliteProcessDocumentStore(openDatabase(':memory:'));
    expect(s.history()).toEqual([]);
  });

  it('reads a healthy three-edit history, so the anchor is not refusing everything', () => {
    expect(
      three()
        .s.history()
        .map((e) => e.version),
    ).toEqual([1, 2, 3]);
  });
});

// ─── the reader must not silently erase corruption ───────────────────

describe('previous is required and strict', () => {
  function seeded() {
    const db = openDatabase(':memory:');
    const s = createSqliteProcessDocumentStore(db);
    s.write({ text: V1, reason: 'r', disposition: 'correction' }, 'AndrewJon', AT);
    s.write({ text: V2, reason: 'r', disposition: 'correction' }, 'Lea', AT + 1);
    return { db, s };
  }

  it('rejects an unknown key rather than stripping it', () => {
    const { db, s } = seeded();
    // Valid JSON. Previously stripped to {} and, on version 1, passed
    // as a clean creation — the reader erasing the evidence.
    db.exec(`UPDATE process_document_edits SET previous = '{"unknown":"value"}' WHERE version = 1`);
    expect(() => s.history()).toThrow();
  });

  it('rejects an unknown key alongside a legitimate one', () => {
    const { db, s } = seeded();
    db.exec(
      `UPDATE process_document_edits SET previous = '{"text":"x","smuggled":"y"}' WHERE version = 2`,
    );
    expect(() => s.history()).toThrow();
  });
});
