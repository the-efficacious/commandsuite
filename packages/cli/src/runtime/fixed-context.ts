/**
 * Fixed context — what the runner hands the agent as its standing
 * instructions: the broker's composed briefing plus the team's process
 * rules in force.
 *
 * WHY THE RULES ARRIVE SEPARATELY. `BriefingResponse.instructions`
 * inherits `MemberSchema`'s 8192-character cap, which is sized for what
 * a human authors and also bounds what the server composes. On this
 * team the longest member's composed briefing sits six characters under
 * it. Rules inside that string would push a member over, and the
 * failure is not a truncated block — the client-side schema rejects the
 * response and the runner does not start.
 *
 * Carried in their own field, an old runner ignores them and starts
 * normally: the member operates without the rules rather than not at
 * all. Degraded beats fatal, and the degradation is diagnosable
 * broker-side because the broker knows the runner's version.
 *
 * WHAT THE BLOCK CARRIES, AND WHY EACH PART. A rule's text alone is not
 * enough to act on:
 *
 *   `provenance` — "the director said this" and "the lead proposed it
 *   and nobody objected" bind differently. Rendering them identically
 *   launders the second into the first.
 *
 *   `disputed` — one of this team's real rules is recorded in a form
 *   its author cannot stand behind, contradicted by observed practice.
 *   Presenting it as settled is false; omitting it hides a rule people
 *   may be following. It is rendered, and rendered as disputed.
 *
 *   `version` — an amendment changes what is injected, and a member who
 *   has seen v1 needs to be able to tell that this is v2 without
 *   diffing prose.
 *
 * HISTORY IS NOT HERE. Superseded text lives behind
 * `GET /process-rules/:anchor/history`. The block is bounded by the
 * number of rules, not by how often they have changed.
 *
 * KNOWN GAP, stated because a reader will otherwise assume otherwise:
 * `#103`'s context watchdog does NOT watch this block. Its projection
 * (`briefingCaptureBlocks`) selects blocks by substring-matching the
 * composed `instructions` string, and these rules are not in it — so a
 * rules block that falls out of an agent's context mid-session is not
 * detected or re-sent. Rules reach a member at their next runner start.
 */

import type { BriefingResponse, ProcessRule } from 'csuite-sdk/types';

/** Rules that are not `retired`. A disputed rule still binds enough to show. */
function inForce(rules: readonly ProcessRule[]): ProcessRule[] {
  return rules.filter((r) => r.status !== 'retired');
}

function renderRule(rule: ProcessRule): string {
  const lines: string[] = [];
  const attributed =
    rule.provenance === 'director'
      ? `stated by ${rule.attribution ?? 'a director'}`
      : rule.provenance === 'lead_uncontested'
        ? `proposed by ${rule.attribution ?? 'the lead'} and not contested — weaker than adoption`
        : 'no attributable origin';
  lines.push(`- ${rule.title} [${rule.anchor} v${rule.version}] (${attributed})`);
  lines.push(`  ${rule.text}`);
  if (rule.status === 'disputed') {
    // Never render a disputed rule as settled. A reader who cannot tell
    // it is unsettled will either follow it as binding or, worse,
    // discover the dispute from someone else mid-work.
    lines.push(
      `  DISPUTED — do not treat as settled: ${rule.disputeReason ?? 'reason not recorded'}`,
    );
  }
  return lines.join('\n');
}

/**
 * The process-rules block, or `null` when there are none to show.
 *
 * `null` rather than an empty heading: a member with no rules should
 * not be told a section exists, and an empty block is indistinguishable
 * from a broker that never sent any.
 */
export function renderProcessRulesBlock(rules: readonly ProcessRule[]): string | null {
  const active = inForce(rules);
  if (active.length === 0) return null;
  return [
    'Team process rules in force. These bind how you work and are current state —',
    'they are amended in place, so what you see here is what applies now. Ask the',
    'broker for a rule’s history rather than assuming the text has never moved.',
    '',
    ...active.map(renderRule),
  ].join('\n');
}

/**
 * Everything the agent receives as standing instructions.
 *
 * Both adapters previously read `briefing.instructions` directly; this
 * is the one place that knows the briefing is more than that string, so
 * a future block does not have to be added to each adapter separately.
 */
export function composeFixedContext(briefing: BriefingResponse): string {
  const block = renderProcessRulesBlock(briefing.processRules ?? []);
  if (block === null) return briefing.instructions;
  return briefing.instructions.length > 0 ? `${briefing.instructions}\n\n${block}` : block;
}
