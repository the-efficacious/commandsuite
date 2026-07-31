/**
 * Enforce the commit subject convention on a pull request.
 *
 * Two objects are checked, and checking only one of them is the mistake
 * this script exists because of:
 *
 *   1. Every commit in the PR that is not already on the base branch.
 *   2. **The pull request title.**
 *
 * (2) is the important one. This repo squash-merges with
 * `squash_merge_commit_title = COMMIT_OR_PR_TITLE`, so the subject that
 * actually lands on `main` is the PR title whenever the PR has more than
 * one commit. Measured on the twelve commits preceding this script, every
 * subject that violated the convention — the three with no prefix and the
 * one at 97 characters — arrived that way:
 *
 *     #68  16 commits -> PR title used   "Retain the completeness failures ..."
 *     #64   6 commits -> PR title used   "Report a member whose verbatim ..."
 *     #61   3 commits -> PR title used   "Fix remote Claude verbatim capture"
 *     #65   7 commits -> PR title used   97 characters
 *
 * A check that walked only the commit range would have gone green on all
 * four and they would have landed unchanged. #68's sixteen branch commits
 * are individually conventional; the branch was never the problem.
 *
 * The title is also mutable after a green run, which is why the workflow
 * subscribes to `edited` — the 97-character subject was produced by
 * retitling a PR that had already passed.
 *
 * ## What this decides, and what it does not
 *
 * Mechanically decided here: the `type(scope): subject` shape, the type
 * vocabulary, the 72-character limit, and the absence of a trailing
 * period. Every one of these has a single unarguable answer.
 *
 * Deliberately NOT decided here: **imperative mood**, and the rule that a
 * body explains why rather than what. Both are in the written convention;
 * neither is a gate. Imperative mood had zero violations in the measured
 * window, would need a hand-maintained allowlist of imperatives that end
 * in `-ed`/`-ing` (`embed the schema` is a false positive on the obvious
 * heuristic), and produces rejections a contributor can reasonably argue
 * with. A check people can dispute is how the whole check gets routed
 * around, so review carries these two and CI does not.
 *
 * ## The ` (#NN)` suffix
 *
 * GitHub appends ` (#69)` to the squash subject — characters the author
 * never typed. The limit is measured on the subject **as authored**, with
 * a trailing ` (#NN)` stripped first. Measuring the landed form instead
 * would silently reduce the author's real budget to about 65 characters,
 * making the documented limit of 72 a lie about itself.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The type vocabulary. Closed set — an unlisted type is a failure, not a warning. */
export const TYPES = Object.freeze([
  'feat',
  'fix',
  'docs',
  'chore',
  'refactor',
  'test',
  'ci',
  'perf',
  'build',
]);

/** Maximum subject length, **including** the `type(scope): ` prefix. */
export const MAX_SUBJECT_LENGTH = 72;

/** The ` (#123)` GitHub appends when it squashes. Stripped before measuring. */
const PR_NUMBER_SUFFIX = / \(#\d+\)$/;

/**
 * Loose prefix shape. Intentionally permissive about the type token and the
 * scope body so that a near-miss is reported as the specific thing that is
 * wrong (`unknown-type`, `empty-scope`) rather than collapsing into a single
 * "invalid" that tells the author nothing about what to change.
 *
 * The optional `!` is Conventional Commits' breaking-change marker. It is not
 * named in the team standard, which says `type(scope): subject`; it is
 * accepted here because refusing the one piece of syntax the upstream
 * convention is known for is a rule people route around. Noted rather than
 * silently permitted.
 */
const PREFIX = /^(?<type>[A-Za-z]+)(?:\((?<scope>[^()]*)\))?(?<bang>!)?:(?<rest>.*)$/;

/** Strip the squash suffix. Exported so tests can assert the rule, not the regex. */
export function subjectAsAuthored(raw) {
  return String(raw)
    .replace(/\r?\n[\s\S]*$/, '')
    .replace(PR_NUMBER_SUFFIX, '');
}

/**
 * Check one subject. Returns every rule it breaks, not the first — an author
 * who is over length *and* missing a prefix should learn both in one run
 * rather than discovering the second after fixing the first.
 *
 * Each violation carries a stable `rule` id and a message that states the
 * rule and the observed value, because "invalid" is a failure people route
 * around and a rule id is a thing they can look up.
 */
export function checkSubject(raw) {
  const subject = subjectAsAuthored(raw);
  const violations = [];

  const fail = (rule, message) => violations.push({ rule, message });

  if (subject.trim() === '') {
    fail('empty-subject', 'subject is empty');
    return { subject, violations };
  }

  // Length and trailing punctuation are independent of the prefix shape, so
  // they are evaluated even when the prefix is unparseable.
  if (subject.length > MAX_SUBJECT_LENGTH) {
    fail(
      'length',
      `subject is ${subject.length} characters, limit is ${MAX_SUBJECT_LENGTH} including the "type(scope): " prefix`,
    );
  }

  if (/\.$/.test(subject)) {
    fail('trailing-period', 'subject ends with a period');
  }

  const m = PREFIX.exec(subject);
  if (!m) {
    fail(
      'missing-prefix',
      `subject has no "type(scope): " prefix; expected one of: ${TYPES.join(', ')}`,
    );
    return { subject, violations };
  }

  const { type, scope, rest } = m.groups;

  if (scope !== undefined && scope.trim() === '') {
    fail(
      'empty-scope',
      'scope parentheses are empty; write "type: subject" or "type(scope): subject"',
    );
  }

  if (!TYPES.includes(type)) {
    // Reported distinctly from the lowercase case: "Docs" is a formatting slip
    // and "wip" is a vocabulary error, and the fix differs.
    if (TYPES.includes(type.toLowerCase())) {
      fail('type-case', `type "${type}" must be lowercase: "${type.toLowerCase()}"`);
    } else {
      fail('unknown-type', `type "${type}" is not one of: ${TYPES.join(', ')}`);
    }
  }

  if (!rest.startsWith(' ')) {
    fail('missing-space', 'the colon must be followed by exactly one space');
  } else if (rest.slice(1).trim() === '') {
    fail('empty-description', 'subject has a prefix but no description after it');
  } else if (rest.startsWith('  ')) {
    fail('missing-space', 'the colon must be followed by exactly one space');
  }

  return { subject, violations };
}

/** One line per violation, naming the object and the rule. Criterion 5's shape. */
export function formatViolation(ref, subject, violation) {
  return `${ref}: "${subject}" — [${violation.rule}] ${violation.message}`;
}

/**
 * Commit subjects reachable from `head` but **not** from `notRef`.
 *
 * `--not <base-branch>` rather than `dco.yml`'s `BASE..HEAD`, and the
 * difference is load-bearing. `BASE..HEAD` uses `pull_request.base.sha`,
 * the base branch head at event time, not the merge base — so when an
 * author merges `main` into their branch, main's own commits enter the
 * range. `dco.yml` survives that flaw because DCO compliance is 100% and
 * those commits pass anyway. Subject compliance is 0% historically, so the
 * identical range would fail a PR over commits that are already on `main`.
 * The model this script is copied from survives a flaw this case does not.
 *
 * Excluding everything reachable from the base branch is also what makes
 * "does not run on existing commits" true by construction rather than by
 * timing.
 */
export function commitSubjectsInRange({ head, notRef, repoDir = process.cwd() }) {
  const out = execFileSync(
    'git',
    ['log', '--no-merges', '--format=%h%x09%s', head, '--not', notRef],
    { cwd: repoDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return parseSubjectLines(out);
}

/**
 * `ref<TAB>subject` lines into records. Split on the *first* tab only — a
 * subject may contain one, and everything after the first belongs to it.
 */
export function parseSubjectLines(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const tab = line.indexOf('\t');
      if (tab === -1) return { ref: '(stdin)', subject: line };
      return { ref: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
}

/** Check a list of `{ ref, subject }`. Pure — the unit under test. */
export function checkRecords(records) {
  const failures = [];
  for (const { ref, subject } of records) {
    for (const violation of checkSubject(subject).violations) {
      failures.push({ ref, subject: subjectAsAuthored(subject), violation });
    }
  }
  return { ok: failures.length === 0, failures, checked: records.length };
}

/** Flags that take no value. Listed rather than inferred: a value-taking flag
 *  whose value happens to begin with `--` must not be mistaken for one of
 *  these, and a PR title is arbitrary contributor text. */
const BOOLEAN_FLAGS = new Set(['stdin']);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      args[name] = true;
      continue;
    }
    args[name] = argv[i + 1];
    i += 1;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const records = [];

  // The PR title is checked first because it is the subject that lands.
  //
  // An empty value here is an error rather than a skip. The workflow always
  // passes the title from the event payload, so empty means the payload did
  // not arrive — and silently checking only the commit range would restore
  // exactly the blind spot this script exists to close, while still
  // reporting a pass.
  if (args['pr-title'] !== undefined) {
    if (args['pr-title'].trim() === '') {
      console.error(
        '::error::--pr-title was passed but is empty; refusing to check only the commit range.',
      );
      return 1;
    }
    records.push({ ref: 'PR title', subject: args['pr-title'] });
  }

  if (args.head && args['base-ref']) {
    records.push(...commitSubjectsInRange({ head: args.head, notRef: args['base-ref'] }));
  }

  // `--stdin` reads `ref<TAB>subject` lines, the format `git log
  // --format=%h%x09%s` produces. It exists so that claims about a range of
  // history are re-runnable by whoever reads them:
  //
  //     git log -12 --format='%h%x09%s' main | node scripts/check-commit-convention.mjs --stdin
  //
  // Not used by the workflow. The measurement in this PR's description came
  // from it, and a reviewer should be able to reproduce that in one command
  // rather than take the number on trust.
  if (args.stdin) {
    records.push(...parseSubjectLines(readFileSync(0, 'utf8')));
  }

  if (records.length === 0) {
    console.error('Nothing to check: pass --pr-title and/or --head with --base-ref.');
    return 1;
  }

  const { ok, failures, checked } = checkRecords(records);

  for (const { ref, subject, violation } of failures) {
    console.log(`::error::${formatViolation(ref, subject, violation)}`);
  }

  if (!ok) {
    console.log('');
    console.log(`${failures.length} problem(s) across ${checked} subject(s).`);
    console.log('');
    console.log('The convention is:  type(scope): subject');
    console.log(`  types:    ${TYPES.join(' ')}`);
    console.log(
      `  subject:  <= ${MAX_SUBJECT_LENGTH} characters including the prefix, no trailing period`,
    );
    console.log('');
    console.log(
      'Fix the PR title:   edit it on the PR page — it is the subject that lands on main.',
    );
    console.log('Fix a commit:       git commit --amend  (then git push --force-with-lease)');
    console.log('Fix several:        git rebase -i --autosquash main');
    console.log('');
    console.log('See CONTRIBUTING.md, "Commit message conventions".');
    return 1;
  }

  console.log(`All ${checked} subject(s) follow the convention.`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main(process.argv.slice(2)));
}
