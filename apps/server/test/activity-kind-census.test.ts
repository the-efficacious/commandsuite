/**
 * Activity-kind census — the guard for prose that enumerates
 * `ActivityEvent`.
 *
 * WHY A TEST AND NOT A CONVENTION
 * -------------------------------
 * `ActivityEvent` grew from four kinds to nine one addition at a time,
 * and every prose enumeration of it was written against the union as
 * it stood that day. At 4a2aac2 the core store header said four, the
 * web UI header said five, the concepts page listed five categories,
 * the trace-pipeline page listed seven, and the REST reference
 * advertised seven filterable values on a route that accepts nine.
 * None of them was wrong when it was written; all of them were wrong
 * at once, because nothing tied them to the union. Fixing five lists
 * by hand fixes them for today.
 *
 * WHAT IT ASSERTS
 * ---------------
 * `ActivityKindSchema` is the authority. Each entry in `SITES` names a
 * file plus the two markers bounding the passage in it that enumerates
 * kinds for a reader, and every kind in the schema must appear inside
 * that passage. A tenth kind therefore fails every site at once, which
 * is the moment the census exists for. A missing marker is a hard
 * failure too: a rewrite that dissolves the enumeration must be a
 * deliberate act, not a silent pass over an empty slice.
 *
 * THE LIMIT OF IT
 * ---------------
 * It cannot see a kind REMOVED from the union and left in the prose —
 * a stale name is still a name — and it does not check that a site
 * says anything TRUE about a kind, only that it names it.
 * `packages/core/src/member-activity.ts` is deliberately absent: that
 * store treats `event.kind` as an opaque column and its header takes
 * the other option, enumerating nothing and pointing at the union, so
 * requiring it to name all nine would be requiring the drift back.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActivityKindSchema } from 'csuite-sdk/schemas';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Passages that enumerate the activity kinds for a reader. */
const SITES: ReadonlyArray<{ file: string; from: string; to: string }> = [
  {
    file: 'packages/core/src/activity-store.ts',
    from: 'captures nine kinds of event',
    to: '\n *\n * Objective "traces"',
  },
  {
    file: 'packages/web-ui/src/components/AgentTimeline.tsx',
    from: 'carries nine event kinds',
    to: 'THE TURN IS THE SPINE',
  },
  {
    file: 'docs/concepts/activity-and-traces.mdx',
    from: 'It contains:',
    to: "## Reading a member's timeline",
  },
  {
    file: 'docs/dev/trace-pipeline.mdx',
    from: 'authoritative kinds in',
    to: 'Per-objective "traces"',
  },
  {
    file: 'docs/dev/rest-api.mdx',
    from: '`kind` filter\naccepts a single value',
    to: '`cursor_ts` +',
  },
];

describe('activity-kind census', () => {
  it('pins the union at the nine kinds the prose was reconciled against', () => {
    expect(ActivityKindSchema.options).toEqual([
      'session_start',
      'session_end',
      'objective_open',
      'objective_close',
      'llm_exchange',
      'tool_action',
      'user_prompt',
      'context_control',
      'auth_state',
    ]);
  });

  it.each(SITES)('$file enumerates every activity kind', ({ file, from, to }) => {
    const text = readFileSync(join(REPO, file), 'utf8');
    const start = text.indexOf(from);
    expect(start, `enumeration start marker not found in ${file}`).toBeGreaterThanOrEqual(0);
    const end = text.indexOf(to, start);
    expect(end, `enumeration end marker not found in ${file}`).toBeGreaterThan(start);
    const passage = text.slice(start, end);
    const named = ActivityKindSchema.options.filter((kind) => passage.includes(kind));
    expect(named).toEqual([...ActivityKindSchema.options]);
  });
});
