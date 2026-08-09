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

import type { AnnexStore } from '../src/spine/index.js';

declare const annex: AnnexStore;

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
