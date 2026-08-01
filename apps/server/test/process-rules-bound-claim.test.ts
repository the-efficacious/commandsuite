/**
 * Guards one specific false claim across every surface that makes it.
 *
 * WHY A TEST AND NOT A NOTE. The claim "the injected process-rules
 * block is bounded" was wrong in seven places. I corrected it, said
 * "corrected in all seven places", and three were still wrong — the
 * module header, an endpoint test comment, and the `process_rules_
 * history` tool description. That last one sits in every agent's
 * context and is the only spec an agent has for a tool it cannot read.
 *
 * The habit being guarded is restatement: writing the qualified
 * version and then a crisper unqualified one. A note asking people not
 * to do that is itself a restatement, so this is a check instead.
 *
 * WHAT IS ACTUALLY TRUE:
 *
 *   resident growth per amendment   0            <- holds
 *   per-rule text ceiling           4096
 *   number of rules                 unbounded
 *   total injected block            UNBOUNDED    <- no ceiling exists
 *
 * So any surface that explains the history/residency property must
 * also carry the qualification. Saying only the first line is how a
 * reader concludes there is a ceiling.
 *
 * WHAT THIS GUARD DOES AND DOES NOT DO. Stated exactly, because an
 * earlier version of this comment claimed the last line:
 *
 *   reintroduce a known phrasing into an enrolled file    CAUGHT
 *   strip the qualification out of an enrolled file       CAUGHT
 *   an enrolled file is renamed or deleted                CAUGHT (ENOENT)
 *   the enrolment list is emptied                         CAUGHT (tripwire)
 *   a NEW file nobody has enrolled                        NOT CAUGHT
 *
 * `SURFACES` is curated. Nothing detects an unenrolled file, so a new
 * doc asserting a ceiling tomorrow passes this suite green. Enrol new
 * surfaces by hand.
 *
 * Rune disproved the claim by writing that file and running the suite
 * rather than by reading this list. Both directions are now verified
 * with his exact case: unenrolled it passes 9/9, enrolled it fails
 * naming the phrasing.
 *
 * WHY NOT DISCOVER THE SET FROM THE TREE. Proposed and rejected.
 * "Files that explain residency" is a semantic criterion with no
 * closed set: a scan matching `process rule` + `resident` catches a
 * file saying "keeps the injected block bounded" and misses one saying
 * "the block stays small". It would buy coverage and pay with a
 * completeness claim that cannot be stated accurately — which is the
 * defect this file exists to guard. A curated list honest about being
 * curated beats a scan that is not.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);

/**
 * The ENROLLED surfaces — those known to document the residency
 * property, curated by hand.
 *
 * This list is the guard's boundary, not its coverage. A surface not
 * on it is not checked at all. If you add a file explaining
 * history-is-not-resident, add it here; nothing will tell you that you
 * forgot.
 */
const SURFACES = [
  'apps/server/src/process-rules.ts',
  'apps/server/src/app.ts',
  'packages/cli/src/runtime/fixed-context.ts',
  'packages/cli/src/runtime/tools.ts',
  'packages/sdk/src/client.ts',
  'docs/concepts/process-rules.mdx',
  'docs/reference/mcp-tools.mdx',
  'docs/reference/rest-api.mdx',
];

/**
 * Phrasings that assert a ceiling which does not exist. Each of these
 * was in the tree and shipped as true.
 */
const FALSE_CLAIMS = [
  'cannot grow without bound',
  'keeps the injected block bounded',
  'This is what keeps the injected block bounded',
  'bounded by the number of rules',
  'bounded by the number of times',
  'Keeping history out of the block is the bound',
  'nothing else would bound it',
];

/** Any of these present means the qualification survived. */
const QUALIFIERS = ['not a ceiling', 'not a total ceiling', 'unbounded', 'UNBOUNDED'];

function read(rel: string): string {
  return readFileSync(new URL(rel, ROOT), 'utf8');
}

describe('no ENROLLED surface describes the injected block as bounded', () => {
  for (const rel of SURFACES) {
    it(`${rel} makes no unqualified boundedness claim`, () => {
      const body = read(rel);
      const found = FALSE_CLAIMS.filter((claim) => body.includes(claim));
      expect(found, `${rel} asserts a ceiling that does not exist: ${found.join(' | ')}`).toEqual(
        [],
      );
    });
  }

  it('every ENROLLED surface that discusses residency carries the qualification', () => {
    // Scoped to enrolled surfaces that actually explain the property —
    // a file merely mentioning process rules need not restate it.
    // This does NOT reach unenrolled files; see the header.
    const discussesResidency = SURFACES.filter((rel) => {
      const body = read(rel);
      return body.includes('resident') && body.toLowerCase().includes('process rule');
    });
    // If this list ever empties, the check has stopped checking.
    expect(discussesResidency.length).toBeGreaterThan(3);

    const missing = discussesResidency.filter((rel) => {
      const body = read(rel);
      return !QUALIFIERS.some((q) => body.includes(q));
    });
    expect(
      missing,
      `these explain history-is-not-resident without saying the total is unbounded: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
