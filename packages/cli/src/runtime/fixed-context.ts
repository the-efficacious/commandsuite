/**
 * Fixed context — what the runner hands the agent as its standing
 * instructions: the broker's composed briefing plus the team's process
 * document.
 *
 * WHY THE DOCUMENT ARRIVES IN ITS OWN FIELD. Three reasons, and only
 * the last one is durable:
 *
 *   1. `BriefingResponse.instructions` inherits `MemberSchema`'s 8192
 *      cap. On this team the longest composed briefing sits 20
 *      characters under it, so a process document inside that string
 *      does not truncate — the client-side schema rejects the response
 *      and the runner does not start. Expires when #122 lands.
 *   2. A deployed runner keeps validating that cap locally whatever
 *      the broker does. Expires when every runner upgrades.
 *   3. A member authors their own `instructions`; the process document
 *      is authored by whoever holds `process.manage`. One string
 *      collapses two authorities into one field. Never expires.
 *
 * Build to reason 3. If you are reading this because #122 removed the
 * cap: reason 1 has evaporated and the decision still holds.
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
 * KNOWN GAP, stated because a reader will otherwise assume otherwise:
 * `#103`'s context watchdog does NOT watch this block. Its projection
 * selects blocks by substring-matching the composed `instructions`
 * string, and this is not in it — so a process document that falls out
 * of an agent's context mid-session is not detected or re-sent. It
 * returns at the next runner start.
 */

import type { BriefingResponse, ProcessDocument } from 'csuite-sdk/types';

const HEADING = 'Team process. This is current state, edited in place — what you see here is';
const SUBHEAD = 'what applies now. Ask the broker for its history rather than assuming the text';
const SUBHEAD2 = 'has never moved.';

/**
 * The process-document block. Always a string — absence is rendered,
 * never omitted.
 */
export function renderProcessDocumentBlock(doc: ProcessDocument | null): string {
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
export function composeFixedContext(briefing: BriefingResponse): string {
  const block = renderProcessDocumentBlock(briefing.processDocument ?? null);
  return briefing.instructions.length > 0 ? `${briefing.instructions}\n\n${block}` : block;
}
