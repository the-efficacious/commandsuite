/**
 * Team process rules store.
 *
 * Fixtures are the four rules this team actually adopted on
 * 2026-07-31/08-01, handed over by Lea with their provenance rather
 * than invented. Two of them exist specifically because a made-up
 * fixture would not have produced them:
 *
 *   - `conversation-before-action` was PROPOSED by the lead and not
 *     contested, which is weaker than a director stating it. A store
 *     that renders both identically presents an uncontested proposal
 *     as settled.
 *   - `merge-model` is recorded in a form its author cannot stand
 *     behind, and observed practice contradicts it. It must be
 *     holdable as DISPUTED — neither dropped nor asserted.
 *
 * Verbatim text is used where Lea had exact words and marked as
 * reconstruction where she did not; that distinction is itself part of
 * what the store has to carry.
 */

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createSqliteProcessRulesStore, ProcessRulesError } from '../src/process-rules.js';

const AT = 1_700_000_000_000;

/** AndrewJon, verbatim. */
const RELEASE_CADENCE_V1 = 'I can release patches mid sprint but minors end of sprint.';
/** AndrewJon, verbatim, 2026-08-01 — a tightening, NOT a reversal. */
const RELEASE_CADENCE_V2 =
  'The release happens when the work for the release is done, not when some work for the release is done.';

/** AndrewJon, verbatim. */
const CONVERSATION_BEFORE_ACTION =
  "Let's keep a conversation running before action until I say otherwise. I really do appreciate the eagerness, but we've gotta be organized.";

/** AndrewJon, verbatim. */
const APPROVED_OBJECTIVES =
  'Support all work with approved objectives, escalate things we need to patch to me. We wait for breaks between sprints to add any progressive non-patch work.';

/** AndrewJon, verbatim. "Approval may slide" is load-bearing. */
const STRICT_STAYS_ON =
  'I think we should keep it on and have the team operate accordingly. Approval may slide, but thats fine unless you think it poses significant issue the other way.';

function store() {
  return createSqliteProcessRulesStore(openDatabase(':memory:'));
}

function seedFour(s: ReturnType<typeof store>) {
  s.create(
    {
      anchor: 'release-cadence',
      title: 'Release cadence',
      text: RELEASE_CADENCE_V1,
      provenance: 'director',
      attribution: 'AndrewJon',
    },
    'lea',
    AT,
  );
  s.create(
    {
      anchor: 'conversation-before-action',
      title: 'Conversation before action',
      text: CONVERSATION_BEFORE_ACTION,
      provenance: 'director',
      attribution: 'AndrewJon',
    },
    'lea',
    AT,
  );
  s.create(
    {
      anchor: 'approved-objectives',
      title: 'Work is supported by approved objectives',
      text: APPROVED_OBJECTIVES,
      provenance: 'director',
      attribution: 'AndrewJon',
    },
    'lea',
    AT,
  );
  s.create(
    {
      anchor: 'strict-up-to-date',
      title: 'Strict / up-to-date stays on',
      text: STRICT_STAYS_ON,
      provenance: 'director',
      attribution: 'AndrewJon',
    },
    'lea',
    AT,
  );
  return s;
}

describe('criterion 2 — a stable anchor distinguishes a reversal from a rewording', () => {
  it('carries a tightening as a refinement, keeping the anchor and the prior text', () => {
    // Lea's own framing: the second release-cadence statement is "a
    // tightening, not a reversal — a good test of whether your anchors
    // distinguish those."
    const s = seedFour(store());
    const { rule, amendment } = s.amend(
      'release-cadence',
      {
        text: RELEASE_CADENCE_V2,
        reason: 'Director tightened it after a sprint-end release was read as owed mid-sprint.',
        disposition: 'correction',
        changeKind: 'refinement',
      },
      'lea',
      AT + 1,
    );

    expect(rule.anchor).toBe('release-cadence'); // identity survives the rewrite
    expect(rule.version).toBe(2);
    expect(rule.text).toBe(RELEASE_CADENCE_V2);
    expect(amendment.changeKind).toBe('refinement');
    expect(amendment.previous.text).toBe(RELEASE_CADENCE_V1);
  });

  it('records a reversal as a reversal, not as another wording change', () => {
    const s = seedFour(store());
    s.amend(
      'release-cadence',
      {
        text: RELEASE_CADENCE_V2,
        reason: 'tightened',
        disposition: 'correction',
        changeKind: 'refinement',
      },
      'lea',
      AT + 1,
    );
    const { amendment } = s.amend(
      'release-cadence',
      {
        text: RELEASE_CADENCE_V1,
        reason: 'Reverted to the original cadence.',
        disposition: 'scope_change',
        changeKind: 'reversal',
      },
      'lea',
      AT + 2,
    );
    // Same anchor, same field, opposite meaning — and the record says so.
    expect(amendment.changeKind).toBe('reversal');
    expect(s.history('release-cadence').map((a) => a.changeKind)).toEqual([
      'refinement',
      'reversal',
    ]);
  });

  it('changeKind is orthogonal to disposition', () => {
    // A refinement can be retroactive and a reversal forward-only.
    // Collapsing them into one field would answer the wrong question.
    const s = seedFour(store());
    s.amend(
      'release-cadence',
      {
        text: RELEASE_CADENCE_V2,
        reason: 'r',
        disposition: 'correction',
        changeKind: 'refinement',
      },
      'lea',
      AT + 1,
    );
    const { amendment } = s.amend(
      'release-cadence',
      {
        text: RELEASE_CADENCE_V1,
        reason: 'r',
        disposition: 'scope_change',
        changeKind: 'reversal',
      },
      'lea',
      AT + 2,
    );
    expect(amendment.disposition).toBe('scope_change');
    expect(amendment.changeKind).toBe('reversal');
  });
});

describe('provenance — an uncontested proposal is not a director statement', () => {
  it('holds the weaker authority distinctly', () => {
    // Lea: "Proposed by the lead and not contested is a different thing
    // from stated by the director, and a process store that cannot
    // express the difference will present both as equally binding."
    const s = seedFour(store());
    s.create(
      {
        anchor: 'conversation-scope',
        title: 'Scope of conversation-before-action',
        text: 'Anything creating an objective, assigning someone, or changing sprint contents goes to the director first.',
        provenance: 'lead_uncontested',
        attribution: 'Lea',
      },
      'lea',
      AT,
    );
    const weak = s.get('conversation-scope');
    const strong = s.get('conversation-before-action');
    expect(weak?.provenance).toBe('lead_uncontested');
    expect(strong?.provenance).toBe('director');
    // Both are injected; only the provenance tells them apart.
    expect(s.listForInjection().map((r) => r.anchor)).toContain('conversation-scope');
  });

  it('refuses an attributed provenance with no attribution', () => {
    const s = store();
    expect(() =>
      s.create({ anchor: 'x', title: 't', text: 'x', provenance: 'director' }, 'lea', AT),
    ).toThrow(ProcessRulesError);
  });
});

describe('disputed — the state that exists because both alternatives are false', () => {
  it('holds a rule whose record and observed practice disagree', () => {
    // The real one: Lea recorded the merge model as moving to
    // "verifier merges, director gates the release", cannot produce
    // the director's words for it, and the director merged #115 and
    // #116 himself the same night. Dropping it hides a rule people may
    // be following; asserting it states something unsupported.
    const s = seedFour(store());
    const rule = s.create(
      {
        anchor: 'merge-model',
        title: 'Who merges',
        text: 'Verifier merges after partner verification; the director gates the release.',
        provenance: 'unattributed',
        status: 'disputed',
        disputeReason:
          'Recorded by the lead, who cannot produce the director’s words for it, and observed practice contradicts it — the director merged #115 and #116 himself on 2026-08-01. Director to settle.',
      },
      'lea',
      AT,
    );
    expect(rule.status).toBe('disputed');
    expect(rule.disputeReason).toContain('observed practice contradicts it');

    // Injected, not silently dropped: a member operating under an
    // unsettled rule needs to know it exists AND that it is unsettled.
    expect(s.listForInjection().map((r) => r.anchor)).toContain('merge-model');
  });

  it('refuses a disputed rule that does not say what is disputed', () => {
    const s = store();
    expect(() =>
      s.create(
        {
          anchor: 'merge-model',
          title: 't',
          text: 'x',
          provenance: 'unattributed',
          status: 'disputed',
        },
        'lea',
        AT,
      ),
    ).toThrow(/disputeReason/);
  });

  it('refuses to amend a rule INTO disputed without a reason', () => {
    const s = seedFour(store());
    expect(() =>
      s.amend(
        'release-cadence',
        { status: 'disputed', reason: 'r', disposition: 'correction', changeKind: 'wording' },
        'lea',
        AT + 1,
      ),
    ).toThrow(/disputeReason/);
  });

  it('retired rules leave the injected set but stay in the record', () => {
    const s = seedFour(store());
    s.amend(
      'release-cadence',
      {
        status: 'retired',
        reason: 'superseded',
        disposition: 'scope_change',
        changeKind: 'reversal',
      },
      'lea',
      AT + 1,
    );
    expect(s.listForInjection().map((r) => r.anchor)).not.toContain('release-cadence');
    expect(s.list().map((r) => r.anchor)).toContain('release-cadence');
  });
});

describe('criterion 4 — history is retrievable, not resident', () => {
  it('the injected set does not grow with amendments', () => {
    const s = seedFour(store());
    const before = s.listForInjection();
    for (let i = 0; i < 20; i += 1) {
      s.amend(
        'release-cadence',
        {
          text: `revision ${i}`,
          reason: 'churn',
          disposition: 'correction',
          changeKind: 'wording',
        },
        'lea',
        AT + i + 1,
      );
    }
    const after = s.listForInjection();
    // Bounded by the number of RULES, not by the number of changes.
    expect(after).toHaveLength(before.length);
    expect(after.find((r) => r.anchor === 'release-cadence')?.version).toBe(21);
    // And the history is all there, off to one side.
    expect(s.history('release-cadence')).toHaveLength(20);
  });

  it('the current text carries no trace of superseded versions', () => {
    const s = seedFour(store());
    s.amend(
      'release-cadence',
      {
        text: RELEASE_CADENCE_V2,
        reason: 'r',
        disposition: 'correction',
        changeKind: 'refinement',
      },
      'lea',
      AT + 1,
    );
    const rule = s.get('release-cadence');
    expect(rule?.text).toBe(RELEASE_CADENCE_V2);
    expect(rule?.text).not.toContain('patches mid sprint');
  });
});

describe('the amendment write is atomic', () => {
  it('rolls back the rule when appending the amendment fails', () => {
    const db = openDatabase(':memory:');
    const s = createSqliteProcessRulesStore(db);
    s.create(
      {
        anchor: 'release-cadence',
        title: 'Release cadence',
        text: RELEASE_CADENCE_V1,
        provenance: 'director',
        attribution: 'AndrewJon',
      },
      'lea',
      AT,
    );
    db.exec(`CREATE TRIGGER block_amendment BEFORE INSERT ON process_rule_amendments
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);

    expect(() =>
      s.amend(
        'release-cadence',
        {
          text: RELEASE_CADENCE_V2,
          reason: 'r',
          disposition: 'correction',
          changeKind: 'refinement',
        },
        'lea',
        AT + 1,
      ),
    ).toThrow();

    // The rule did NOT move, and no version was consumed.
    const rule = s.get('release-cadence');
    expect(rule?.text).toBe(RELEASE_CADENCE_V1);
    expect(rule?.version).toBe(1);
    expect(s.history('release-cadence')).toHaveLength(0);
  });

  it('rejects an amendment that changes nothing', () => {
    const s = seedFour(store());
    expect(() =>
      s.amend(
        'release-cadence',
        { text: RELEASE_CADENCE_V1, reason: 'r', disposition: 'correction', changeKind: 'wording' },
        'lea',
        AT + 1,
      ),
    ).toThrow(/changes nothing/);
  });
});

describe('the four real rules round-trip verbatim', () => {
  it('keeps load-bearing clauses that summaries drop', () => {
    const s = seedFour(store());
    // Lea: "'Approval may slide' is load-bearing and I had dropped it
    // everywhere I summarised this rule." It is the clause that
    // anticipated exactly what happened on #115 and #116.
    expect(s.get('strict-up-to-date')?.text).toContain('Approval may slide');
    expect(s.get('approved-objectives')?.text).toContain('escalate things we need to patch');
    expect(s.get('conversation-before-action')?.text).toContain("we've gotta be organized");
    expect(s.listForInjection()).toHaveLength(4);
  });
});

// ─── every accepted field is a recoverable field ─────────────────────
//
// Found by Rune, driving the real store rather than reading the code.
// `AmendProcessRuleRequestSchema` accepted `attribution` and
// `disputeReason`; the field enum and `previous` held only the other
// four. So the row moved and no prior value was kept — and paired with
// a title change the loss was SILENT, because the amendment looked
// well-formed with `previous.title` present.

describe('an amendment can recover the prior value of every field it accepts', () => {
  function attributed() {
    const s = store();
    s.create(
      {
        anchor: 'merge-model',
        title: 'Merge model',
        text: 'Squash-merge to main.',
        provenance: 'director',
        attribution: 'AndrewJon',
      },
      'lea',
      AT,
    );
    return s;
  }

  it('accepts an amendment that changes only attribution', () => {
    const s = attributed();
    // Before the fix this threw "amendment changes nothing" — change
    // detection could not see a field the request accepted.
    const { amendment } = s.amend(
      'merge-model',
      {
        attribution: 'Lea',
        reason: 'Misattributed; Lea proposed it.',
        disposition: 'correction',
        changeKind: 'wording',
      },
      'lea',
      AT + 1,
    );
    expect(amendment.fields).toEqual(['attribution']);
    expect(amendment.previous.attribution).toBe('AndrewJon');
    expect(s.get('merge-model')?.attribution).toBe('Lea');
  });

  it('records BOTH priors when attribution moves paired with a tracked field', () => {
    // The silent case, and the one a reasonable person skips as
    // redundant with the one above. It is not: the amendment succeeded
    // before the fix, and dropped the attribution prior on the floor.
    const s = attributed();
    const { amendment } = s.amend(
      'merge-model',
      {
        title: 'How we merge',
        attribution: 'Lea',
        reason: 'Retitled and reattributed together.',
        disposition: 'correction',
        changeKind: 'wording',
      },
      'lea',
      AT + 1,
    );
    expect([...amendment.fields].sort()).toEqual(['attribution', 'title']);
    expect(amendment.previous.title).toBe('Merge model');
    expect(amendment.previous.attribution).toBe('AndrewJon');
  });

  it('recovers the prior disputeReason, not just the fact of a dispute', () => {
    const s = store();
    s.create(
      {
        anchor: 'merge-model',
        title: 'Merge model',
        text: 'Squash-merge to main.',
        provenance: 'director',
        attribution: 'AndrewJon',
        status: 'disputed',
        disputeReason: 'contradicted by observed practice',
      },
      'lea',
      AT,
    );
    const { amendment } = s.amend(
      'merge-model',
      {
        disputeReason: 'AndrewJon has not confirmed this wording',
        reason: 'Sharpen what is actually unsettled.',
        disposition: 'correction',
        changeKind: 'refinement',
      },
      'lea',
      AT + 1,
    );
    expect(amendment.fields).toEqual(['disputeReason']);
    expect(amendment.previous.disputeReason).toBe('contradicted by observed practice');
  });

  it('keeps "was null" distinct from "was not recorded"', () => {
    const s = store();
    s.create({ anchor: 'x', title: 'T', text: 'X', provenance: 'unattributed' }, 'lea', AT);
    const { amendment } = s.amend(
      'x',
      {
        provenance: 'director',
        attribution: 'AndrewJon',
        reason: 'AndrewJon stated this after all.',
        disposition: 'correction',
        changeKind: 'wording',
      },
      'lea',
      AT + 1,
    );
    // `null`, not absent — a reader must be able to tell the rule had
    // no attribution from the record failing to track one.
    expect(amendment.previous.attribution).toBeNull();
    expect('attribution' in amendment.previous).toBe(true);
  });
});

// ─── amend enforces create's invariant, on the whole rule ────────────
//
// Also Rune's. `create` refuses an attributed provenance with no
// attribution; `amend` checked only the fields the amendment supplied,
// so `unattributed` -> `director` with no attribution passed and the
// renderer produced "stated by a director" for a rule no director
// stated. That is precisely the laundering `provenance` exists to
// prevent, and the gate means only the two members the field
// constrains can reach it.

describe('amendment cannot manufacture authority creation refuses', () => {
  function unattributed() {
    const s = store();
    s.create(
      {
        anchor: 'merge-model',
        title: 'Merge model',
        text: 'Squash-merge.',
        provenance: 'unattributed',
      },
      'lea',
      AT,
    );
    return s;
  }

  it('refuses unattributed -> director with no attribution', () => {
    const s = unattributed();
    expect(() =>
      s.amend(
        'merge-model',
        {
          provenance: 'director',
          reason: 'Claiming director authority without naming one.',
          disposition: 'correction',
          changeKind: 'wording',
        },
        'lea',
        AT + 1,
      ),
    ).toThrow(ProcessRulesError);
    // And the rule did not move.
    expect(s.get('merge-model')?.provenance).toBe('unattributed');
    expect(s.history('merge-model')).toHaveLength(0);
  });

  it('accepts unattributed -> director WITH an attribution, and records both priors', () => {
    const s = unattributed();
    const { rule, amendment } = s.amend(
      'merge-model',
      {
        provenance: 'director',
        attribution: 'AndrewJon',
        reason: 'AndrewJon stated it; origin was recorded as unknown.',
        disposition: 'correction',
        changeKind: 'wording',
      },
      'lea',
      AT + 1,
    );
    expect(rule.provenance).toBe('director');
    expect(rule.attribution).toBe('AndrewJon');
    expect([...amendment.fields].sort()).toEqual(['attribution', 'provenance']);
    expect(amendment.previous.provenance).toBe('unattributed');
    expect(amendment.previous.attribution).toBeNull();
  });

  it('clears attribution when moving back to unattributed', () => {
    const s = store();
    s.create(
      {
        anchor: 'merge-model',
        title: 'Merge model',
        text: 'Squash-merge.',
        provenance: 'director',
        attribution: 'AndrewJon',
      },
      'lea',
      AT,
    );
    // The request must be able to say "set this to null". Without it a
    // downgrade keeps a stale attribution, which is the same laundering
    // in the other direction.
    const { rule, amendment } = s.amend(
      'merge-model',
      {
        provenance: 'unattributed',
        attribution: null,
        reason: 'Nobody can say where this came from.',
        disposition: 'correction',
        changeKind: 'wording',
      },
      'lea',
      AT + 1,
    );
    expect(rule.provenance).toBe('unattributed');
    expect(rule.attribution).toBeNull();
    expect(amendment.previous.attribution).toBe('AndrewJon');
  });

  it('still refuses a disputed rule with no reason, through amend', () => {
    const s = store();
    s.create({ anchor: 'x', title: 'T', text: 'X', provenance: 'unattributed' }, 'lea', AT);
    expect(() =>
      s.amend(
        'x',
        { status: 'disputed', reason: 'r', disposition: 'correction', changeKind: 'wording' },
        'lea',
        AT + 1,
      ),
    ).toThrow(/disputeReason/);
  });
});
