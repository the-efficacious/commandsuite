/**
 * The annex's refusals.
 *
 * THE REFUSAL IS THE RECOVERY CHANNEL, and that is why these carry a
 * `detail` rather than only a sentence. A dump is never detected; it is
 * discovered by the member at the first act where it matters — and the
 * act where it matters is a write that was made on stale beliefs. So
 * the refusal has to be complete enough to act on without a second
 * call: `stale_state_rev` returns the intervening authoritative events
 * in full, and `coverage_gap` names every criterion that is missing and
 * why.
 *
 * A refusal that says "you are out of date, go and look" has told the
 * caller there is a problem and not what it is, which on an agent
 * member costs an entire turn.
 */

import type {
  SpineAsk,
  SpineCitationRequiredDetail,
  SpineCoverageGapDetail,
  SpineEvent,
  SpineEventKind,
  SpineIdempotencyConflictDetail,
  SpinePreconditionDetail,
  SpineStaleStateRevDetail,
  SpineTerminalDetail,
} from 'csuite-sdk/types';

/**
 * Closed set. Every one maps to exactly one HTTP status at the route
 * layer, and the mapping is asserted there rather than inferred.
 */
export type SpineErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'stale_state_rev'
  | 'idempotency_conflict'
  | 'coverage_gap'
  | 'invalid_transition'
  | 'not_permitted'
  | 'citation_required';

export type SpineErrorDetail =
  | SpineStaleStateRevDetail
  | SpineCoverageGapDetail
  | SpineIdempotencyConflictDetail
  | SpinePreconditionDetail
  | SpineTerminalDetail
  | SpineCitationRequiredDetail;

export class SpineError extends Error {
  readonly code: SpineErrorCode;
  /** Everything the caller needs to retry deliberately. Absent only where nothing would help. */
  readonly detail?: SpineErrorDetail;

  constructor(code: SpineErrorCode, message: string, detail?: SpineErrorDetail) {
    super(message);
    this.name = 'SpineError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * The stale-write refusal, assembled in one place so the delta can
 * never be omitted by a caller who only had the counts to hand.
 */
export function staleStateRev(
  contract: string,
  expected: number,
  current: number,
  intervening: SpineEvent[],
): SpineError {
  const summary = intervening.map((e) => `${e.kind} (${e.id}) by ${e.actor}`).join('; ');
  return new SpineError(
    'stale_state_rev',
    `contract ${contract} is at state_rev ${current}, not ${expected}. ` +
      `${intervening.length} authoritative event(s) landed while you were away: ${summary}. ` +
      'They are in the refusal in full — read them and retry deliberately.',
    { contract, expectedStateRev: expected, currentStateRev: current, intervening },
  );
}

/**
 * The citation lock's refusal, and the one message in this file whose
 * exact wording is the feature.
 *
 * §5: "An agent that cannot cite a ruling is told, in the refusal, that
 * it does not have one." The failure being closed is a member acting on
 * remembered authorisation — the most confident-sounding sentence an
 * agent can produce is "I was told to go ahead", and it costs nothing
 * to produce whether or not anyone said it. So the refusal states the
 * absence FLATLY and first, before the remedies: not "cite a ruling",
 * which a member who believes they have one will read as a formality,
 * but "you do not have one", which contradicts the belief directly.
 *
 * Then both ways forward, because a lock with no exit is a lock members
 * route around: get the ruling, or proceed on the record. Proceeding is
 * legitimate — §5's whole point is that the annex refuses invented
 * authority, not deliberate action without it.
 *
 * WHAT THE FIRST EXIT ACTUALLY IS, stated precisely because the obvious
 * phrasing is false here. §5's prose says the call "must cite a ruling
 * id", and an earlier version of this message told members to get the
 * ruling AND CITE IT ON THIS WRITE. They cannot: a ruling resolves its
 * ask the instant it lands, and a resolved ask does not lock, so the
 * citation is never the thing that releases them. Instructing an agent
 * to perform a step that has already been made unnecessary is the
 * ceremony this design exists to remove, and worse, it implies a
 * citation could substitute for an answer. The exit is: get the ruling,
 * which resolves the ask and releases you. (The store still accepts a
 * cited ruling as cover — see `coveringCitation` — for the day an ask
 * outlives its ruling.)
 *
 * The asks ride whole in the detail (see `SpineCitationRequiredDetail`)
 * and are also summarised in the sentence, because a member reading
 * only the message still has to be able to act on it.
 */
export function citationRequired(
  kind: SpineEventKind,
  subject: string,
  contract: string | null,
  scope: readonly string[],
  asks: SpineAsk[],
): SpineError {
  const plural = asks.length === 1 ? '' : 's';
  const them = asks.length === 1 ? 'it' : 'them';
  const lines = asks
    .map((a) => {
      // An ask carrying only a contract is scoped by that contract's
      // subject, so naming the contract is what tells the reader why
      // this ask reached this act.
      const where = a.subject ?? (a.contract !== null ? `contract ${a.contract}` : '(no subject)');
      return (
        `${a.id} (${a.state}, to ${a.authority}, on ${where}): ` +
        `"${a.question}" — unblocks: ${a.unblocks}`
      );
    })
    .join('; ');
  // The scope is named only when it is doing work — that is, when an
  // ask reached this act from a subject the caller never mentioned. On
  // a same-subject ask it would restate the subject twice and read as
  // noise; on a repo-level ask reaching a file it is the only thing
  // that explains the refusal at all.
  const viaContainer = asks.some((a) => a.subject !== null && a.subject !== subject);
  const containment = viaContainer
    ? ` At least one of those asks was raised on a subject CONTAINING this one — the scope ` +
      `searched was ${scope.join(' ⊃ ')}, and a rule stated one level up is not escaped by ` +
      'acting one level down.'
    : '';
  return new SpineError(
    'citation_required',
    `this ${kind} on ${subject} is a state-changing act, and you have ${asks.length} ` +
      `unresolved ask${plural} covering it: ${lines}.${containment} ` +
      `YOU DO NOT HAVE A RULING ON ${them.toUpperCase()}. If you remember being authorised, ` +
      'that memory is not a ruling and the annex holds no record of one — remembered ' +
      'authorisation is exactly what this refusal exists to convert into looked-up ' +
      `authorisation. Two ways forward, both on the record: get the ruling from ` +
      `${[...new Set(asks.map((a) => a.authority))].join(' / ')} — that resolves the ask and ` +
      'releases you, with nothing further to cite — or append a `proceeding` citing the ask ' +
      'and saying why you are going ahead without one. Proceeding is a legitimate act, not a ' +
      'workaround: it covers your later acts on this subject until that ask resolves.',
    { subject, kind, contract, scope: [...scope], asks },
  );
}
