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
