/**
 * Compile-time negatives for the annex's boundary.
 *
 * THREE ARCHITECTURAL CLAIMS, none of which a runtime test can
 * establish, because each is about what the surface DOES NOT OFFER:
 *
 *   1  an event cannot be appended without the captions its kind
 *      requires — no subject-less observation, no revision-less
 *      verdict, no staple-less correction, no precondition-less
 *      lifecycle act;
 *   2  a revision cannot be written bare — `{value}` with nobody
 *      saying how, from where, or when is unrepresentable rather than
 *      merely discouraged;
 *   3  history cannot be mutated — there is no update, no delete, no
 *      recovery hatch, and a correction is the only way a record ever
 *      changes.
 *
 * A comment claiming any of these is a one-time observation nobody
 * repeats. `@ts-expect-error` inverts it: while the boundary is
 * closed the directive is used and the fixture passes, and the moment
 * a refactor makes one of these calls legal, `tsc` fails the build
 * with `TS2578: Unused '@ts-expect-error' directive` — on the day
 * nobody is looking.
 *
 * Each route is enumerated separately. Closing one does not establish
 * that the boundary is closed, and a single hostile call would leave
 * the others unasserted.
 *
 * Type-only: no runtime assertions, checked by `tsc --noEmit`.
 */

import type { SpineEventKind } from 'csuite-sdk/types';
import type { ProbeAppendRequest, ProbeIdentity } from '../src/spine/append.js';
import type { AnnexStore, AnnexWritePath } from '../src/spine/index.js';
import type { AnnexWriter } from '../src/spine/store.js';

/**
 * The WRITE-CAPABLE handle. Every hostile call below is made against
 * it, because a negative asserted against a type with no `append` at
 * all would pass for the wrong reason — the boundary being tested is
 * "which appends the compiler accepts", not "is there an append".
 */
declare const annex: AnnexWriter;

/**
 * The read surface, and the fourth architectural claim (phase 4): the
 * handle every consumer of the annex receives CANNOT APPEND. The
 * curator, the probe engine and 6,000 lines of route layer all hold
 * this type, so a second write path is a type error at its call site
 * rather than a grep somebody has to keep current.
 */
declare const readOnly: AnnexStore;

// @ts-expect-error — no `append` on the read surface. There is exactly
// one way to obtain one (`spine/append.ts`), and it hooks the write.
readOnly.append({ kind: 'discussion', body: { body: 'hi' } }, { actor: 'lea' });

// The positive control for THAT claim: the read surface is a real,
// usable annex — the split removed one method, not the store.
const _readable = readOnly.contract('evt_1');
void _readable;

// ─── The positive control ────────────────────────────────────────────
// If the public surface stopped being usable, every negative below
// would pass vacuously. This is the shape everything else is a
// deviation from.

const _spec = annex.append(
  {
    kind: 'specification',
    subject: 'repo:acme',
    opId: 'op-1',
    body: {
      title: 'Ship the endpoint',
      criteria: [{ id: 'c1', text: 'returns 200' }],
      assignee: 'rune',
      verifier: 'lea',
    },
  },
  { actor: 'lea' },
);

const _verdict = annex.append(
  {
    kind: 'criterion_verdict',
    opId: 'op-2',
    expectedStateRev: 1,
    revision: {
      subject: 'repo:acme',
      value: 'sha-a',
      how: 'observed',
      source: 'integration:github',
    },
    body: { contract: _spec.event.id, criterion: 'c1', decision: 'met', evidence: 'green' },
  },
  { actor: 'lea' },
);

// Reads are open, and stay open.
const _events = annex.events({ since_seq: 0, limit: 10 });
const _contract = annex.contract(_spec.event.id);
const _pack = annex.orient('lea');
void [_verdict, _events, _contract, _pack];

// ─── 1. Captions a kind requires cannot be omitted ───────────────────

// @ts-expect-error a flash is always OF somewhere: an observation without a subject
annex.append({ kind: 'observation', body: { what: 'looked', output: 'saw' } }, { actor: 'rune' });

annex.append(
  // @ts-expect-error a verdict is true of a revision or it is true of nothing
  {
    kind: 'criterion_verdict',
    opId: 'op-3',
    expectedStateRev: 1,
    body: { contract: 'evt_1', criterion: 'c1', decision: 'met', evidence: 'green' },
  },
  { actor: 'lea' },
);

annex.append(
  // @ts-expect-error a correction that staples to nothing is a second claim, not a correction
  { kind: 'correction', opId: 'op-4', body: { correction: 'that was wrong' } },
  { actor: 'lea' },
);

annex.append(
  // @ts-expect-error a durable write without an idempotency key cannot survive a lost response
  {
    kind: 'attempt',
    expectedStateRev: 1,
    body: { contract: 'evt_1', summary: 'pushed' },
  },
  { actor: 'rune' },
);

annex.append(
  // @ts-expect-error a state-changing write without a precondition can sneak past a verdict
  {
    kind: 'lifecycle',
    opId: 'op-5',
    body: { contract: 'evt_1', state: 'cancelled', reason: 'no longer wanted' },
  },
  { actor: 'lea' },
);

annex.append(
  // @ts-expect-error a specification creates the contract; there is no prior counter to expect
  {
    kind: 'specification',
    subject: 'repo:acme',
    opId: 'op-6',
    expectedStateRev: 0,
    body: { title: 'x', criteria: [{ id: 'c1', text: 't' }], assignee: 'rune' },
  },
  { actor: 'lea' },
);

// @ts-expect-error ambient chatter must not be dressed up as a durable write
annex.append({ kind: 'discussion', opId: 'op-7', body: { body: 'a thought' } }, { actor: 'cora' });

// @ts-expect-error an event with no actor has no author, and every photo has one
annex.append({
  kind: 'observation',
  subject: 'repo:acme',
  body: { what: 'looked', output: 'saw' },
});

// ─── 2. A revision cannot be written bare ────────────────────────────
//
// Three routes to the same lie, because closing one proves nothing
// about the others: a value alone, a value with a subject, and a value
// with everything except who looked.

annex.append(
  {
    kind: 'attempt',
    opId: 'op-8',
    expectedStateRev: 1,
    // @ts-expect-error "verified at sha-a" with nobody saying who looked or when
    revision: { value: 'sha-a' },
    body: { contract: 'evt_1', summary: 'pushed' },
  },
  { actor: 'rune' },
);

annex.append(
  {
    kind: 'attempt',
    opId: 'op-9',
    expectedStateRev: 1,
    // @ts-expect-error a subject and a value is still a derived value rendering bare
    revision: { subject: 'repo:acme', value: 'sha-a' },
    body: { contract: 'evt_1', summary: 'pushed' },
  },
  { actor: 'rune' },
);

annex.append(
  {
    kind: 'attempt',
    opId: 'op-10',
    expectedStateRev: 1,
    // @ts-expect-error `how` without `source` cannot say whose flash this was
    revision: { subject: 'repo:acme', value: 'sha-a', how: 'observed' },
    body: { contract: 'evt_1', summary: 'pushed' },
  },
  { actor: 'rune' },
);

// @ts-expect-error there is no revision-writing method at all — a revision exists only as a caption on an act
annex.registerRevision({
  subject: 'repo:acme',
  value: 'sha-a',
  how: 'observed',
  source: 'integration:github',
});

// ─── 3. History cannot be mutated ────────────────────────────────────
//
// Enumerated one route at a time. A generic update, a generic delete,
// a targeted edit of the field a correction exists to handle, and a
// direct write to the projection the events are supposed to produce.

// @ts-expect-error a photo seen cannot be unseen: nothing removes an event
annex.deleteEvent(_spec.event.id);

// @ts-expect-error corrections staple; nothing rewrites
annex.updateEvent(_spec.event.id, { body: { title: 'something else' } });

// @ts-expect-error amendments version the contract; nothing edits it in place
annex.updateContract(_spec.event.id, { title: 'something else' });

// @ts-expect-error the projection is a fold, never a place to write
annex.setContractState(_spec.event.id, 'done');

// @ts-expect-error there is no truncation, no reset, no "start again"
annex.clear();

// ─── 5. A probe can author nothing but its two allowed shapes ────────
//
// §7 gives the probe engine exactly two writes: the observation a
// firing recipe produces, and the lifecycle back to `active` that
// re-lights a `waiting_for` contract citing it. Everything else in the
// registry is a JUDGEMENT, and §10 forbids the system to make one.
//
// The store refuses the rest at runtime and must, because it is
// reachable by callers no compiler saw — `spine-probes.test.ts` drives
// those refusals, including one over HTTP. These are the other half:
// inside the engine, a probe-authored verdict is not a refusal to
// handle, it is a call that does not compile.

declare const write: AnnexWritePath;
declare const probe: ProbeIdentity;

// The positive controls FIRST. Every negative below is a deviation from
// these, and a surface that accepted nothing would satisfy them all.
write.appendAsProbe(
  { kind: 'observation', subject: 'repo:acme', body: { what: 'ci went green', output: '{}' } },
  probe,
);
write.appendAsProbe(
  {
    kind: 'lifecycle',
    opId: 'probe-chk_1-relight',
    expectedStateRev: 3,
    cites: ['evt_obs'],
    body: { contract: 'evt_1', state: 'active' },
  },
  probe,
);

// @ts-expect-error a probe has no opinions to post
write.appendAsProbe({ kind: 'discussion', body: { body: 'looks green to me' } }, probe);

// @ts-expect-error the identity is not optional: an unattributed probe write is the system composing a shot
write.appendAsProbe({
  kind: 'observation',
  subject: 'repo:acme',
  body: { what: 'x', output: '{}' },
});

/**
 * EVERY KIND, one at a time, as a type-level assertion.
 *
 * `@ts-expect-error` on a hostile call cannot express this cleanly: a
 * verdict body on a probe request produces errors on several lines, and
 * a directive suppresses only the next one — so the fixture would pass
 * for a reason nobody chose. This form says the thing directly, and it
 * enumerates the whole registry rather than the four kinds somebody
 * thought of. Widening `ProbeAppendRequest` by one kind fails exactly
 * one line here, and names it.
 */
type ProbeMayNotAuthor<K extends SpineEventKind> =
  Extract<ProbeAppendRequest, { kind: K }> extends never ? true : false;

// The two allowed kinds resolve to `false` — the assertion runs in both
// directions, so a `ProbeAppendRequest` narrowed to nothing at all
// fails here rather than passing every negative below it.
const _mayObserve: ProbeMayNotAuthor<'observation'> = false;
const _mayRelight: ProbeMayNotAuthor<'lifecycle'> = false;
const _noTestimony: ProbeMayNotAuthor<'testimony'> = true;
const _noSpecification: ProbeMayNotAuthor<'specification'> = true;
const _noAmendment: ProbeMayNotAuthor<'amendment'> = true;
const _noAttempt: ProbeMayNotAuthor<'attempt'> = true;
const _noVerdict: ProbeMayNotAuthor<'criterion_verdict'> = true;
const _noRuling: ProbeMayNotAuthor<'ruling'> = true;
const _noAsk: ProbeMayNotAuthor<'ask'> = true;
const _noAskAction: ProbeMayNotAuthor<'ask_action'> = true;
const _noProceeding: ProbeMayNotAuthor<'proceeding'> = true;
const _noCorrection: ProbeMayNotAuthor<'correction'> = true;
const _noDiscussion: ProbeMayNotAuthor<'discussion'> = true;
const _noPromotion: ProbeMayNotAuthor<'promotion'> = true;
void [
  _mayObserve,
  _mayRelight,
  _noTestimony,
  _noSpecification,
  _noAmendment,
  _noAttempt,
  _noVerdict,
  _noRuling,
  _noAsk,
  _noAskAction,
  _noProceeding,
  _noCorrection,
  _noDiscussion,
  _noPromotion,
];
