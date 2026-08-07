/**
 * Both-direction fixtures for the release-PR state classifier.
 *
 * The defect this file is built against is a CONFLATION, not a
 * rejection: `held` (workflows parked awaiting "Approve and run") and
 * `failing` (workflows ran, something broke) both surface as
 * `BLOCKED` everywhere we look, and the remedies are opposite — click
 * versus debug. A classifier that collapsed them would be useless in
 * exactly the way the status quo is useless, and would still pass any
 * suite that only asserted "not passing".
 *
 * So, following `check-commit-convention.test.mjs`, every fixture runs
 * through the shipped classifier *and* through degenerate references
 * that must disagree with it:
 *
 *   - `collapseHeldIntoFailing` — the realistic wrong implementation
 *     (check `conclusion !== 'success'` first). It must FAIL the held
 *     fixtures. If it passed them, the fixtures do not discriminate
 *     the one distinction this script exists to draw.
 *   - `alwaysHeld` — must FAIL every non-held fixture. If it passed
 *     them, the suite would accept a script that cries "held" at a
 *     genuinely broken build.
 *
 * The ordering trap is real and not hypothetical: a held run reports
 * `conclusion: 'action_required'`, which is not `'success'`, so the
 * obvious predicate files every held release under failing.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyRuns,
  describe as describeState,
  exitCodeFor,
  STATES,
} from '../release-status.mjs';

const run = (over = {}) => ({
  name: 'CI',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  actor: 'github-actions[bot]',
  triggering_actor: 'github-actions[bot]',
  ...over,
});

/**
 * Measured shapes. The held fixture is the real one from the issue:
 * five bot-triggered runs on a `changeset-release/main` head, all
 * `action_required` at attempt 1.
 */
const FIXTURES = [
  {
    label: 'five bot runs awaiting approval (the measured #110 shape)',
    runs: ['CI', 'DCO', 'CodeQL', 'Dependency review', 'Commit convention'].map((name) =>
      run({ name, status: 'completed', conclusion: 'action_required' }),
    ),
    expected: STATES.held,
  },
  {
    label: 'one held among otherwise green runs',
    runs: [run(), run({ name: 'DCO', conclusion: 'action_required' })],
    expected: STATES.held,
  },
  {
    label: 'no runs at all',
    runs: [],
    expected: STATES.never_created,
  },
  {
    label: 'a genuine failure',
    runs: [run(), run({ name: 'DCO', conclusion: 'failure' })],
    expected: STATES.failing,
  },
  {
    label: 'a cancelled run is not a success',
    runs: [run({ conclusion: 'cancelled' })],
    expected: STATES.failing,
  },
  {
    label: 'in-flight runs are not failures despite a null conclusion',
    runs: [run(), run({ name: 'CodeQL', status: 'in_progress', conclusion: null })],
    expected: STATES.running,
  },
  {
    label: 'queued counts as running',
    runs: [run({ status: 'queued', conclusion: null })],
    expected: STATES.running,
  },
  {
    label: 'all green',
    runs: [run(), run({ name: 'DCO' }), run({ name: 'CodeQL', conclusion: 'skipped' })],
    expected: STATES.passing,
  },
];

/** The realistic wrong implementation: "not success" tested first. */
const collapseHeldIntoFailing = (runs) => {
  if (!Array.isArray(runs) || runs.length === 0) return STATES.never_created;
  if (runs.some((r) => r.conclusion !== 'success' && r.conclusion !== 'skipped')) {
    return STATES.failing;
  }
  return STATES.passing;
};

const alwaysHeld = () => STATES.held;

describe('classification', () => {
  for (const { label, runs, expected } of FIXTURES) {
    it(`classifies: ${label}`, () => {
      expect(classifyRuns(runs)).toBe(expected);
    });
  }
});

describe('the fixtures actually discriminate', () => {
  it('a classifier that collapses held into failing FAILS the held fixtures', () => {
    const held = FIXTURES.filter((f) => f.expected === STATES.held);
    expect(held.length).toBeGreaterThan(0);
    for (const f of held) {
      // If this ever agrees, the suite has stopped defending the one
      // distinction the script exists to make.
      expect(collapseHeldIntoFailing(f.runs), f.label).not.toBe(f.expected);
    }
  });

  it('a classifier that always says held FAILS every non-held fixture', () => {
    const others = FIXTURES.filter((f) => f.expected !== STATES.held);
    expect(others.length).toBeGreaterThan(0);
    for (const f of others) {
      expect(alwaysHeld(f.runs), f.label).not.toBe(f.expected);
    }
  });

  it('covers every state the script defines', () => {
    // A state with no fixture is a state nobody proved reachable.
    const covered = new Set(FIXTURES.map((f) => f.expected));
    expect([...Object.values(STATES)].filter((s) => !covered.has(s))).toEqual([]);
  });
});

describe('what the operator reads', () => {
  it('tells a held release to click and a failing one to debug', () => {
    const held = describeState(STATES.held, { runCount: 5, heldCount: 5 });
    const failing = describeState(STATES.failing, { runCount: 5, failedCount: 1 });

    // The two must not read alike — that similarity IS the defect.
    expect(held).not.toEqual(failing);
    expect(held).toMatch(/Approve and run/);
    // A held release must positively deny the three wrong readings
    // that actually happened, not merely omit them.
    expect(held).toMatch(/Nothing has failed/);
    expect(failing).toMatch(/real failure/);
    expect(failing).not.toMatch(/Approve and run/);
  });

  it('names a zero-run head as its own thing, not as held or passing', () => {
    const none = describeState(STATES.never_created, { runCount: 0 });
    expect(none).toMatch(/zero workflow runs/);
    expect(none).not.toMatch(/Approve and run/);
  });

  it('points at the documentation the step is written in', () => {
    // The runbook entry and this surface ship together; a message
    // citing a section that does not exist is worse than none.
    expect(describeState(STATES.held, {})).toMatch(/CONTRIBUTING\.md/);
  });
});

describe('exit codes', () => {
  it('gives held its own code, distinct from failing and from ready', () => {
    // Distinct because the action differs. A caller that only knew
    // "non-zero" would be back to the conflation this replaces.
    expect(exitCodeFor(STATES.held)).toBe(2);
    expect(exitCodeFor(STATES.never_created)).toBe(2);
    expect(exitCodeFor(STATES.failing)).toBe(1);
    expect(exitCodeFor(STATES.passing)).toBe(0);
    expect(exitCodeFor(STATES.running)).toBe(0);
  });

  it('keeps failing and held on different codes', () => {
    expect(exitCodeFor(STATES.failing)).not.toBe(exitCodeFor(STATES.held));
  });
});
