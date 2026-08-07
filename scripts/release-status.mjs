#!/usr/bin/env node

/**
 * Release-PR status, with "the checks never ran" as its own answer.
 *
 * THE DEFECT THIS EXISTS FOR. A release PR whose workflows are held
 * awaiting "Approve and run" reports `mergeStateStatus: BLOCKED` and
 * carries ZERO check-runs. A release PR whose checks ran and failed
 * also reports `BLOCKED`. `gh pr view`, the PR merge box, and the
 * project board render the two identically, so a held release is
 * indistinguishable from a failing one — and, in the measured
 * instance, from a pending human decision. PR #110 sat for ~2h being
 * read three different wrong ways while finished work queued behind
 * it.
 *
 * `check-runs: 0` is cheaply queryable and discriminates exactly.
 * Nothing we used reported it. That is the whole gap.
 *
 * WHAT THIS IS NOT. It does not approve anything, and it must not.
 * The approval gate is a security control someone configured
 * deliberately; making it inconvenient to observe is the bug, and
 * bypassing it because it is inconvenient is what makes such controls
 * worthless. This reads and reports.
 *
 * Usage:
 *   node scripts/release-status.mjs            # find the open release PR
 *   node scripts/release-status.mjs 110        # a specific PR
 *   node scripts/release-status.mjs --json     # machine-readable
 *
 * Exit codes are for humans and CI alike: 0 when the PR is genuinely
 * ready or genuinely absent, 1 when a real check is failing, and 2
 * when the answer is "nobody has run them" — a distinct code because
 * it is a distinct situation needing a distinct action (click, don't
 * debug).
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_BRANCH = 'changeset-release/main';

/**
 * Every state a release PR's checks can be in, and what each one asks
 * the reader to DO. The verbs are the point: the states this
 * collapses into one another are ones whose remedies differ.
 */
export const STATES = {
  /** Workflows exist but are parked in `action_required`. Click. */
  held: 'held',
  /** No workflows at all on this head. Neither held nor passing. */
  never_created: 'never_created',
  /** Checks ran; at least one failed. Debug. */
  failing: 'failing',
  /** Checks ran; some still going. Wait. */
  running: 'running',
  /** Checks ran and passed. Merge. */
  passing: 'passing',
};

/**
 * Classify a head's workflow runs. PURE — takes the run list, returns
 * a state — so the discrimination this whole script exists for is
 * testable without a network or a repo.
 *
 * Order matters. `held` is tested BEFORE `failing` because a held run
 * reports `conclusion: 'action_required'`, and a classifier that
 * checked "not success" first would file every held release under
 * failing — recreating the exact conflation this replaces.
 */
export function classifyRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return STATES.never_created;
  const held = runs.filter((r) => r.conclusion === 'action_required');
  if (held.length > 0) return STATES.held;
  // `status` outranks `conclusion` for in-flight runs: a queued or
  // in_progress run has a null conclusion, which is not a failure.
  if (runs.some((r) => r.status === 'queued' || r.status === 'in_progress')) {
    return STATES.running;
  }
  if (runs.some((r) => r.conclusion !== 'success' && r.conclusion !== 'skipped')) {
    return STATES.failing;
  }
  return STATES.passing;
}

/**
 * The operator-facing line for a state. Held and failing must never
 * read alike — that similarity is the defect — so each names its own
 * remedy rather than sharing a generic "not ready".
 */
export function describe(state, ctx = {}) {
  const n = ctx.runCount ?? 0;
  switch (state) {
    case STATES.held:
      return [
        `HELD — ${ctx.heldCount ?? n} workflow run(s) are awaiting "Approve and run".`,
        '  Nothing has failed. Nothing is running. No one is deliberating.',
        '  A maintainer must approve the runs on the Actions tab before any',
        '  check can report. See CONTRIBUTING.md → "Approve and run".',
      ].join('\n');
    case STATES.never_created:
      return [
        'NO RUNS — this head has zero workflow runs.',
        '  Not held and not passing: nothing was ever created for it.',
        '  Check that the workflows target this branch at all.',
      ].join('\n');
    case STATES.failing:
      return `FAILING — ${ctx.failedCount ?? 0} of ${n} run(s) did not succeed. This one is a real failure; read the logs.`;
    case STATES.running:
      return `RUNNING — checks are in flight (${n} run(s)). Wait.`;
    case STATES.passing:
      return `PASSING — all ${n} run(s) succeeded.`;
    default:
      return `UNKNOWN state: ${state}`;
  }
}

/** Exit code per state — see the header for why held gets its own. */
export function exitCodeFor(state) {
  if (state === STATES.failing) return 1;
  if (state === STATES.held || state === STATES.never_created) return 2;
  return 0;
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${result.stderr?.trim() ?? 'unknown error'}`);
  }
  return result.stdout;
}

function findReleasePr() {
  const out = gh([
    'pr',
    'list',
    '--head',
    RELEASE_BRANCH,
    '--state',
    'open',
    '--json',
    'number,title,headRefOid',
  ]);
  const prs = JSON.parse(out);
  return prs.length > 0 ? prs[0] : null;
}

function prByNumber(number) {
  const out = gh(['pr', 'view', String(number), '--json', 'number,title,headRefOid']);
  return JSON.parse(out);
}

function runsForHead(headSha) {
  const out = gh([
    'api',
    `repos/{owner}/{repo}/actions/runs?head_sha=${headSha}&per_page=100`,
    '--jq',
    '[.workflow_runs[] | {name, status, conclusion, run_attempt, actor: .actor.login, triggering_actor: .triggering_actor.login}]',
  ]);
  return JSON.parse(out);
}

function main(argv) {
  const asJson = argv.includes('--json');
  const positional = argv.filter((a) => !a.startsWith('--'));

  let pr;
  try {
    pr = positional.length > 0 ? prByNumber(positional[0]) : findReleasePr();
  } catch (err) {
    process.stderr.write(`release-status: ${err.message}\n`);
    return 2;
  }

  if (pr === null) {
    const msg = `No open release PR on ${RELEASE_BRANCH}.`;
    process.stdout.write(
      asJson ? `${JSON.stringify({ state: null, message: msg })}\n` : `${msg}\n`,
    );
    return 0;
  }

  let runs;
  try {
    runs = runsForHead(pr.headRefOid);
  } catch (err) {
    process.stderr.write(`release-status: ${err.message}\n`);
    return 2;
  }

  const state = classifyRuns(runs);
  const ctx = {
    runCount: runs.length,
    heldCount: runs.filter((r) => r.conclusion === 'action_required').length,
    failedCount: runs.filter(
      (r) =>
        r.conclusion !== null &&
        r.conclusion !== 'success' &&
        r.conclusion !== 'skipped' &&
        r.conclusion !== 'action_required',
    ).length,
  };

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          pr: pr.number,
          title: pr.title,
          head: pr.headRefOid,
          state,
          checkRuns: runs.length,
          ...ctx,
          runs,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `PR #${pr.number}  ${pr.title}\n` +
        `head ${pr.headRefOid.slice(0, 8)}  check-runs: ${runs.length}\n\n` +
        `${describe(state, ctx)}\n`,
    );
  }
  return exitCodeFor(state);
}

// Only run when invoked directly, so the classifier can be imported by
// tests without firing a network call. Compared as resolved paths
// rather than by basename: a basename match would also fire for any
// other `release-status.mjs` a runner happened to have as argv[1].
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
