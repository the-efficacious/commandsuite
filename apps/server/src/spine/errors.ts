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
  SpineCoverageGapDetail,
  SpineEvent,
  SpineIdempotencyConflictDetail,
  SpineStaleStateRevDetail,
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
  | 'not_permitted';

export type SpineErrorDetail =
  | SpineStaleStateRevDetail
  | SpineCoverageGapDetail
  | SpineIdempotencyConflictDetail;

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
