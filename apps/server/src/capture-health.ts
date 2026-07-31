/**
 * Capture-health detector.
 *
 * WHY THIS EXISTS
 * ---------------
 * A member can report activity all day while none of their verbatim
 * bodies reach the broker, and nothing says so. That happened: a remote
 * Claude runner produced 2,404 `llm_exchange` markers and zero
 * `raw_exchange` rows over a full day, and it surfaced only because
 * someone ran a member breakdown for an unrelated reason.
 *
 * `TracePanel` is not at fault and must not be made stricter. Its
 * coverage of the rich layer is deliberately BEST-EFFORT — a turn with
 * no matching record still renders its marker, so older brokers and
 * subagent work degrade gracefully. The consequence is that two facts
 * render identically:
 *
 *     this turn has no rich record       normal, expected
 *     this member has NO rich records    systematic capture failure
 *
 * Graceful degradation without a health signal is indistinguishable
 * from health. This module supplies the second signal; it does not
 * change how the first renders.
 *
 * WHAT IT ASKS
 * ------------
 * Per member, over the current session: do completed exchange markers
 * have their corresponding stored bodies? The domain is MARKERS, not
 * `gen_ai_inference` rows — a gen_ai denominator can only contain turns
 * that produced a gen_ai row, which structurally excludes the failure
 * being detected. That mistake was made and caught during design.
 *
 * ADAPTER ELIGIBILITY
 * -------------------
 * Claude markers carry `entry.response.responseId`; Codex markers carry
 * `null` because a Codex exchange aggregates a whole TURN across
 * possibly several Responses-API calls, so no single id exists to carry
 * (`codex/rollout-parser.ts`). Codex correlates by interval containment
 * instead.
 *
 * So exact-match eligibility is `responseId !== null`. Without that
 * rule every Codex marker reads as a gap while capture works perfectly
 * — 100% of two members, permanently, which is worse than the silence
 * it replaces because it trains people to ignore the surface.
 *
 * WHAT THE PREDICATE CLAIMS, AND WHAT IT DOES NOT
 * -----------------------------------------------
 * `EXISTS raw_blob` proves a blob row is present and addressable. It
 * does NOT prove the bytes are readable: `getBlob` also returns null on
 * gunzip failure and on a content-address mismatch, and this query
 * exercises neither path. The claim is STORED AND ADDRESSABLE. Missing
 * capture and stored-blob corruption are different failure modes and
 * are not conflated here.
 *
 * Hash correspondence is AVAILABILITY, not per-turn identity: content
 * addressing is many-to-one, so an older identical body could satisfy
 * an EXISTS. Member- and kind-scoping removes the cross-member case;
 * the residual is same-member repeats, bounded by measured content
 * reuse of 1 in 12,521 distinct hashes on the reference corpus. The
 * exact response-id join does the per-turn identity work — hashes only
 * verify availability behind an already-matched gen_ai row.
 */

import type { DatabaseSyncInstance, StatementInstance } from './db.js';

/** Marker age below which an unmatched marker is not yet evidence. */
export const CAPTURE_GRACE_MS = 15_000;

/**
 * Health of one member's capture pipeline.
 *
 * `pending` is deliberately NOT surfaced to callers as a warning.
 * Healthy correlation lag measured p50 4.211s / p99 4.679s / max
 * 10.248s over 11,047 exact-match pairs, so every normal turn spends
 * several seconds unmatched. A surface that showed "potential gap"
 * during that window would flicker on healthy traffic continuously.
 */
export type CaptureHealth =
  | { state: 'ok' }
  | { state: 'pending' }
  | { state: 'unevaluated'; reason: 'no-exact-match-adapter' }
  | { state: 'gap'; unmatchedMarkers: number; since: number };

export interface CaptureHealthOptions {
  /** Override the clock (tests). */
  now?: () => number;
  /** Override the grace window (tests). */
  graceMs?: number;
}

/**
 * A marker is SATISFIED when its exact gen_ai row exists AND both of
 * that row's bodies are stored and addressable.
 *
 * Every EXISTS is member- and kind-scoped. `request_sha256` and
 * `response_sha256` are BOTH required: a gen_ai row naming a response
 * hash does not prove a `raw_exchange` row for it survives, and the
 * write path is not one transaction (`appendBody` inserts blob and
 * exchange separately per side; gen_ai appends later), so the invariant
 * cannot be asserted in place of the joins.
 */
const UNMATCHED_PREDICATE = `
  FROM member_activity a
  WHERE a.member_name = ?
    AND a.kind = 'llm_exchange'
    AND a.created_at >= ?
    AND json_extract(a.event_json, '$.entry.response.responseId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM gen_ai_inference g
      WHERE g.member_name = a.member_name
        AND g.response_id = json_extract(a.event_json, '$.entry.response.responseId')
        AND EXISTS (
          SELECT 1 FROM raw_exchange r
          WHERE r.member_name = g.member_name
            AND r.kind = 'request'
            AND r.hash = g.request_sha256
        )
        AND EXISTS (
          SELECT 1 FROM raw_exchange r
          WHERE r.member_name = g.member_name
            AND r.kind = 'response'
            AND r.hash = g.response_sha256
        )
        AND EXISTS (SELECT 1 FROM raw_blob b WHERE b.hash = g.request_sha256)
        AND EXISTS (SELECT 1 FROM raw_blob b WHERE b.hash = g.response_sha256)
    )
`;

/**
 * Markers that are unmatched AND aged past the grace window. These are
 * the evidence: a definitive gap.
 */
const UNMATCHED_SQL = `
  SELECT COUNT(*) AS n, MIN(a.created_at) AS since
  ${UNMATCHED_PREDICATE}
    AND a.created_at <= ?
`;

/**
 * Markers that are unmatched but still INSIDE the grace window.
 *
 * This shares `UNMATCHED_PREDICATE` with the aged query and differs only
 * in the time bound, which is the whole point. An earlier version
 * counted every fresh marker regardless of correspondence, so a marker
 * whose gen_ai row and both bodies had already landed still reported
 * `pending` — criterion 4 says a match clears it, and it did not.
 *
 * That is the FALSE-POSITIVE direction, and it is the third time a
 * detector in this family has been one predicate away from flagging
 * healthy members: the polarity inversion, the Codex `ok`, and this.
 *
 * It also missed the session bound, so a marker from the previous
 * session could hold a fresh empty session in `pending`. Both found by
 * Rune with discriminating fixtures; the bound is now inherited from
 * the shared predicate rather than restated.
 */
const PENDING_UNMATCHED_SQL = `
  SELECT COUNT(*) AS n
  ${UNMATCHED_PREDICATE}
    AND a.created_at > ?
`;

/**
 * Marker census for the session, split by exact-match eligibility.
 *
 * A member with markers but NONE eligible is a Codex member: the
 * containment join that would assess them is not built, so the honest
 * answer is `unevaluated`, not `ok`. Reporting `ok` would assert a
 * property never evaluated — the same conflation this module exists to
 * remove, one layer up.
 *
 * A member with NO markers at all is a different case and stays `ok`:
 * nothing was produced, so nothing failed to be captured. Markers
 * failing to arrive is the activity path, not this one.
 */
const CENSUS_SQL = `
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN json_extract(a.event_json, '$.entry.response.responseId') IS NOT NULL
             THEN 1 ELSE 0 END) AS eligible
  FROM member_activity a
  WHERE a.member_name = ?
    AND a.kind = 'llm_exchange'
    AND a.created_at >= ?
`;

/**
 * Session boundary: the member's most recent `session_start`.
 *
 * All-time counts hide a fresh outage behind old success, so the window
 * is session-scoped. `session_start` carries no session id, so the
 * boundary is its `created_at` — broker receipt, single clock. Agent
 * clocks are not used anywhere here: agent-side deltas produce ~33%
 * negative lags across hosts, and every comparison below would inherit
 * that skew.
 */
const SESSION_START_SQL = `
  SELECT MAX(created_at) AS boundary
  FROM member_activity
  WHERE member_name = ? AND kind = 'session_start'
`;

export interface CaptureHealthStore {
  /** Health for one member over their current session. */
  forMember(name: string): CaptureHealth;
}

export function createCaptureHealthStore(
  db: DatabaseSyncInstance,
  options: CaptureHealthOptions = {},
): CaptureHealthStore {
  const now = options.now ?? (() => Date.now());
  const graceMs = options.graceMs ?? CAPTURE_GRACE_MS;

  const sessionStmt: StatementInstance = db.prepare(SESSION_START_SQL);
  const unmatchedStmt: StatementInstance = db.prepare(UNMATCHED_SQL);
  const pendingStmt: StatementInstance = db.prepare(PENDING_UNMATCHED_SQL);
  const censusStmt: StatementInstance = db.prepare(CENSUS_SQL);

  return {
    forMember(name: string): CaptureHealth {
      const boundaryRow = sessionStmt.get(name) as { boundary: number | null } | undefined;
      // No session_start on record — nothing to scope to, so no claim.
      const boundary = boundaryRow?.boundary ?? null;
      if (boundary === null) return { state: 'ok' };

      const cutoff = now() - graceMs;

      // Aged markers only: a marker younger than the grace window has
      // not yet earned the claim, and its body may still be in flight.
      const aged = unmatchedStmt.get(name, boundary, cutoff) as
        | { n: number; since: number | null }
        | undefined;
      const unmatched = aged?.n ?? 0;
      if (unmatched > 0) {
        return { state: 'gap', unmatchedMarkers: unmatched, since: aged?.since ?? boundary };
      }

      // Nothing aged and unmatched. If anything is still inside the
      // grace window, say so INTERNALLY — callers surface nothing.
      const fresh = pendingStmt.get(name, boundary, cutoff) as { n: number } | undefined;
      if ((fresh?.n ?? 0) > 0) return { state: 'pending' };

      // No gap found — but "found none" and "looked" are different
      // claims. A member whose markers are ALL ineligible for the exact
      // join was never assessed by anything above, and saying `ok` here
      // would be the detector asserting a property it did not evaluate.
      const census = censusStmt.get(name, boundary) as
        | { total: number | null; eligible: number | null }
        | undefined;
      const total = census?.total ?? 0;
      const eligible = census?.eligible ?? 0;
      if (total > 0 && eligible === 0) {
        return { state: 'unevaluated', reason: 'no-exact-match-adapter' };
      }

      return { state: 'ok' };
    },
  };
}
