/**
 * Fixed context — what the runner hands the agent as its standing
 * instructions: the broker's composed briefing plus the team's process
 * document.
 *
 * WHY THE DOCUMENT ARRIVES IN ITS OWN FIELD: a member authors their
 * own `instructions`; the process document is authored by whoever
 * holds `process.manage`. One string collapses two authorities into
 * one field. (A wire cap once also motivated the split; every cap-era
 * reason is dead — the cap in #129, the legacy-runner accommodation
 * with the last pre-rename deployment — and the split stands on
 * authority separation alone. Do not merge them on the grounds that
 * the cap is gone; it was never the load-bearing argument.)
 *
 * WHY ABSENCE RENDERS AS A LINE RATHER THAN AS NOTHING. Three states
 * collapse into one if a missing document renders nothing:
 *
 *   no document has been written        member sees nothing
 *   runner too old to read the field    member sees nothing
 *   broker without the feature          member sees nothing
 *
 * The middle one is the silent-degradation case. Rendering nothing
 * makes the healthy state wear the costume of the broken one — a
 * member operating without a process document cannot tell whether the
 * team has none or their runner cannot read it. One short line costs
 * a sentence of context and separates them.
 *
 * HISTORY IS NOT HERE. Superseded text lives behind
 * `GET /process-document/history`. Editing fifty times costs exactly
 * what editing once costs, and the injected size is bounded by
 * `PROCESS_DOCUMENT_MAX` — a real ceiling, unlike the predecessor
 * design which held N rules with nothing capping N.
 *
 * THE WATCHDOG DOES WATCH THIS BLOCK. `#103` projects it alongside the
 * three authored blocks, so a document that falls out of an agent's
 * context mid-session is detected on an observable turn and re-sent —
 * it does not wait for the next runner start.
 *
 * Its membership test differs from theirs and has to. They are
 * composed into `instructions`, so the projection confirms them by
 * substring; this is never in that string, so a substring test could
 * only ever return false for it. Membership here is that it was SENT,
 * and the text projected is `doc.text` verbatim — the same bytes
 * rendered below, so the watchdog looks for exactly what the agent
 * received.
 *
 * Codex remains the exception: its system projection is unobservable,
 * so absence cannot be asserted and nothing is re-sent (`#118`).
 */

import type { InstructionsResponse, ProcessDocument } from 'csuite-sdk/types';

const HEADING = 'Team process. This is current state, edited in place — what you see here is';
const SUBHEAD = 'what applies now. Ask the broker for its history rather than assuming the text';
const SUBHEAD2 = 'has never moved.';

/**
 * The process-document block. Always a string — absence is rendered,
 * never omitted.
 */
export function renderProcessDocumentBlock(doc: ProcessDocument | null | undefined): string {
  if (doc === undefined) {
    // The broker did not send the field. That is NOT "no document" —
    // it is an older broker with no opinion, and telling a member the
    // team has no process when nobody asked the question is a
    // confident wrong answer.
    return 'Team process: unavailable — this broker does not report a process document.';
  }
  if (doc === null) {
    // Deliberately says what IS true rather than staying silent, so a
    // member can tell this apart from a runner that cannot read the
    // field. It also tells an agent the capability exists, which
    // silence does not.
    return 'Team process: no process document has been set for this team.';
  }
  return [
    HEADING,
    SUBHEAD,
    SUBHEAD2,
    '',
    `[process document v${doc.version}, last edited by ${doc.updatedBy}]`,
    '',
    doc.text,
  ].join('\n');
}

/**
 * Everything the agent receives as standing instructions.
 *
 * Both adapters previously read `briefing.instructions` directly; this
 * is the one place that knows the briefing is more than that string,
 * so a future block does not have to be added to each adapter
 * separately.
 */
export function composeFixedContext(briefing: InstructionsResponse): string {
  // No `?? null` — that would re-collapse absent into null here after
  // the schema went to the trouble of keeping them apart.
  const block = renderProcessDocumentBlock(briefing.processDocument);
  return briefing.instructions.length > 0 ? `${briefing.instructions}\n\n${block}` : block;
}
