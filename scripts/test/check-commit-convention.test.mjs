/**
 * Both-direction fixtures for the commit subject check.
 *
 * The failure this file is built against: **a check that rejects everything
 * satisfies every negative fixture.** A suite of "these subjects are
 * rejected" cases passes just as well against a validator that returns a
 * violation for its input unconditionally, so on its own it establishes
 * nothing about the check.
 *
 * So every fixture is run through the shipped implementation *and* through a
 * degenerate reference that must disagree with it, in both directions:
 *
 *   - `rejectEverything` must FAIL the positive fixtures. If it passed them,
 *     the positives are not discriminating and the suite would accept a
 *     check that blocks all work.
 *   - `acceptEverything` must FAIL the negative fixtures. If it passed them,
 *     the negatives are not discriminating and the suite would accept a
 *     check that enforces nothing.
 *
 * This is the pattern `fresh-dist.test.mjs` uses with its `mtimeCheck`
 * reference, for the same reason.
 *
 * The negative cases assert the specific rule id, not merely that something
 * failed — a rejection that does not name the rule broken is one people
 * route around, and a suite that only asserts "rejected" cannot tell a
 * correct diagnosis from a coincidental one.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkRecords,
  checkSubject,
  commitSubjectsInRange,
  formatViolation,
  MAX_SUBJECT_LENGTH,
  parseSubjectLines,
  subjectAsAuthored,
  TYPES,
} from '../check-commit-convention.mjs';

const REPO_ROOT = resolve(dirname(dirname(fileURLToPath(import.meta.url))), '..');

/** The two implementations the fixtures must discriminate against. */
const rejectEverything = () => ({ violations: [{ rule: 'nope', message: 'no' }] });
const acceptEverything = () => ({ violations: [] });

/**
 * Subjects that must pass. The first six are real subjects taken from this
 * repo's history, so the check is measured against work that actually
 * shipped rather than against specimens written to fit it.
 */
const COMPLIANT = [
  'docs(contributing): fixture arrival and finding polarity',
  'docs(contributing): make compile-negative claims executable',
  'fix(web-ui): keep failed exact markers unmatched',
  'chore: version packages',
  'chore: attribute CommandSuite to Efficacious',
  'fix(server): bound mime and enrollment source labels at the producer',
  'feat: add the thing',
  'feat!: drop the legacy enrollment route',
  'fix(web-ui)!: change the marker wire shape',
  'ci: check commit subjects on every pull request',
  'perf: cache the census scan',
  'build: pin the pnpm action',
  'refactor(core): fold the two roster paths together',
  'test(server): cover the diagnostics overflow fact',
  'docs(a/b-c.d): allow punctuation inside a scope',
  // Exactly at the limit — the boundary must be inclusive.
  `feat: ${'x'.repeat(MAX_SUBJECT_LENGTH - 'feat: '.length)}`,
];

/** Subjects that must fail, each with the rule it must be diagnosed as breaking. */
const VIOLATING = [
  // The real offenders from this repo's history. Every one is a PR title.
  {
    subject: 'Retain the completeness failures the broker already detects',
    rule: 'missing-prefix',
    note: 'PR #68 — 16 conventional branch commits, non-conventional squash subject',
  },
  {
    subject: 'Report a member whose verbatim capture has stopped arriving',
    rule: 'missing-prefix',
    note: 'PR #64',
  },
  {
    subject: 'Fix remote Claude verbatim capture',
    rule: 'missing-prefix',
    note: 'PR #61 — capitalised verb reads conventional but has no prefix',
  },
  {
    subject:
      'docs(contributing): verification practices for checks whose answer is fixed before they run',
    rule: 'length',
    note: 'PR #65 — 91 characters as authored, 97 as landed',
  },
  // Constructed cases, one per rule.
  { subject: `feat: ${'x'.repeat(MAX_SUBJECT_LENGTH - 'feat: '.length + 1)}`, rule: 'length' },
  { subject: 'feat: add the thing.', rule: 'trailing-period' },
  { subject: 'wip: something half done', rule: 'unknown-type' },
  { subject: 'Docs: capitalised type', rule: 'type-case' },
  { subject: 'FEAT(cli): shouting type', rule: 'type-case' },
  { subject: 'feat(): empty scope', rule: 'empty-scope' },
  { subject: 'feat:no space after colon', rule: 'missing-space' },
  { subject: 'feat:  two spaces after colon', rule: 'missing-space' },
  { subject: 'feat: ', rule: 'empty-description' },
  { subject: 'feat:', rule: 'missing-space' },
  { subject: '', rule: 'empty-subject' },
  { subject: '   ', rule: 'empty-subject' },
  { subject: 'just a sentence about what changed', rule: 'missing-prefix' },
];

describe('compliant subjects pass', () => {
  it.each(COMPLIANT)('accepts %j', (subject) => {
    expect(checkSubject(subject).violations).toEqual([]);
  });

  it('a reject-everything check fails all of them, so the positives discriminate', () => {
    const survivors = COMPLIANT.filter((s) => rejectEverything(s).violations.length === 0);
    expect(survivors).toEqual([]);
  });
});

describe('violating subjects fail, and are diagnosed by rule', () => {
  it.each(VIOLATING)('rejects %j as $rule', ({ subject, rule }) => {
    const rules = checkSubject(subject).violations.map((v) => v.rule);
    expect(rules).toContain(rule);
  });

  it('an accept-everything check passes all of them, so the negatives discriminate', () => {
    const caught = VIOLATING.filter(
      ({ subject }) => acceptEverything(subject).violations.length > 0,
    );
    expect(caught).toEqual([]);
  });
});

describe('the ` (#NN)` squash suffix', () => {
  it('is excluded from the measured length, so the documented limit is the real budget', () => {
    const authored = `feat: ${'x'.repeat(MAX_SUBJECT_LENGTH - 'feat: '.length)}`;
    expect(authored.length).toBe(MAX_SUBJECT_LENGTH);
    expect(checkSubject(authored).violations).toEqual([]);
    // The same subject after GitHub appends the PR number is 6 characters
    // longer and must still pass; measuring the landed form would have cut
    // the author's real budget to 66.
    const landed = `${authored} (#123)`;
    expect(landed.length).toBeGreaterThan(MAX_SUBJECT_LENGTH);
    expect(checkSubject(landed).violations).toEqual([]);
  });

  it('only strips a trailing PR number, not a parenthetical the author wrote', () => {
    expect(subjectAsAuthored('feat: add (#12)')).toBe('feat: add');
    expect(subjectAsAuthored('feat: add (#12) more')).toBe('feat: add (#12) more');
    expect(subjectAsAuthored('feat: add (see #12)')).toBe('feat: add (see #12)');
  });

  it('does not let the suffix hide a trailing period', () => {
    expect(checkSubject('feat: add the thing. (#12)').violations.map((v) => v.rule)).toContain(
      'trailing-period',
    );
  });
});

describe('every documented type is accepted and the set is closed', () => {
  it.each(TYPES)('accepts type %s', (type) => {
    expect(checkSubject(`${type}: do the thing`).violations).toEqual([]);
  });

  it.each(['wip', 'style', 'revert', 'hotfix', 'misc'])('rejects unlisted type %s', (type) => {
    expect(checkSubject(`${type}: do the thing`).violations.map((v) => v.rule)).toContain(
      'unknown-type',
    );
  });
});

describe('reporting', () => {
  it('names both the object and the rule', () => {
    const [failure] = checkRecords([
      { ref: 'PR title', subject: 'Fix remote Claude verbatim capture' },
    ]).failures;
    const line = formatViolation(failure.ref, failure.subject, failure.violation);
    expect(line).toContain('PR title');
    expect(line).toContain('Fix remote Claude verbatim capture');
    expect(line).toContain('[missing-prefix]');
  });

  /**
   * The rule id is only half of criterion 5. A mutation that replaced the
   * missing-prefix message with the literal "ok" survived the whole suite,
   * because every other test asserts the `rule` field and nothing asserted
   * what the author actually reads. An opaque message is the failure the
   * criterion is about, and it was invisible here.
   */
  it('every message states the rule, rather than naming it', () => {
    for (const { subject, rule } of VIOLATING) {
      const v = checkSubject(subject).violations.find((x) => x.rule === rule);
      expect(v, `no ${rule} violation for ${JSON.stringify(subject)}`).toBeDefined();
      expect(v.message.length, `${rule} message is too short to be useful`).toBeGreaterThan(15);
      // The message must not simply restate the id, which is what an
      // "invalid"-class message does.
      expect(v.message.toLowerCase()).not.toBe(rule);
      expect(v.message).toMatch(/\s/);
    }
  });

  it('messages carry the specifics an author needs to act', () => {
    const length = checkSubject(`feat: ${'x'.repeat(90)}`).violations.find(
      (v) => v.rule === 'length',
    );
    // The observed count and the limit, not just "too long".
    expect(length.message).toContain('96');
    expect(length.message).toContain(String(MAX_SUBJECT_LENGTH));

    const missing = checkSubject('Fix remote Claude verbatim capture').violations.find(
      (v) => v.rule === 'missing-prefix',
    );
    // The expected form and the vocabulary, so the fix needs no second lookup.
    expect(missing.message).toContain('type(scope): ');
    for (const type of TYPES) expect(missing.message).toContain(type);

    const unknown = checkSubject('wip: half done').violations.find(
      (v) => v.rule === 'unknown-type',
    );
    expect(unknown.message).toContain('wip');
    for (const type of TYPES) expect(unknown.message).toContain(type);

    const cased = checkSubject('Docs: capitalised').violations.find((v) => v.rule === 'type-case');
    expect(cased.message).toContain('Docs');
    expect(cased.message).toContain('docs');
  });

  it('reports every rule a subject breaks, not just the first', () => {
    const rules = checkSubject(`Broken: ${'x'.repeat(80)}.`).violations.map((v) => v.rule);
    expect(rules).toContain('length');
    expect(rules).toContain('trailing-period');
    expect(rules).toContain('unknown-type');
  });

  it('checkRecords counts what it checked and passes a clean set', () => {
    const records = COMPLIANT.map((subject, i) => ({ ref: `c${i}`, subject }));
    const result = checkRecords(records);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(COMPLIANT.length);
    expect(result.failures).toEqual([]);
  });
});

/**
 * `--stdin` exists so a claim about a stretch of history is re-runnable by
 * the person reading it rather than taken on trust. The PR description says
 * six of `main`'s last twelve subjects fail this check; that number came
 * from this path, and a reviewer reproduces it with one pipe.
 */
describe('subject lines from stdin', () => {
  it('splits on the first tab, so a subject may contain one', () => {
    expect(parseSubjectLines('abc1234\tfeat: a\tb\n')).toEqual([
      { ref: 'abc1234', subject: 'feat: a\tb' },
    ]);
  });

  it('accepts a bare subject with no ref', () => {
    expect(parseSubjectLines('feat: no ref here\n')).toEqual([
      { ref: '(stdin)', subject: 'feat: no ref here' },
    ]);
  });

  it('ignores blank lines rather than reporting them as empty subjects', () => {
    expect(parseSubjectLines('a\tfeat: one\n\n\nb\tfeat: two\n')).toHaveLength(2);
  });

  it('reproduces the measurement the PR description reports', () => {
    // Not "6 of 12" as a hard number — that moves as main advances, and a
    // test that fails because someone landed a commit is a test that fails
    // for the wrong reason. What is asserted is that the path works and that
    // the historical subjects it was measured on still fail.
    const historical = [
      '676f315\tRetain the completeness failures the broker already detects',
      '5f638aa\tReport a member whose verbatim capture has stopped arriving',
      '40e5513\tFix remote Claude verbatim capture',
      '1d0a0a2\tdocs(contributing): verification practices for checks whose answer is fixed before they run',
    ].join('\n');
    const result = checkRecords(parseSubjectLines(historical));
    expect(result.checked).toBe(4);
    expect(result.ok).toBe(false);
    expect(new Set(result.failures.map((f) => f.violation.rule))).toEqual(
      new Set(['missing-prefix', 'length']),
    );
  });
});

/**
 * The command line itself, driven as a subprocess. Everything above tests
 * exported functions; none of it establishes that `node
 * check-commit-convention.mjs ...` exits non-zero, which is the only thing
 * CI actually observes. A validator that diagnoses correctly and exits 0 is
 * a green check.
 */
describe('the command line', () => {
  const SCRIPT = join(REPO_ROOT, 'scripts/check-commit-convention.mjs');
  const run = (args, input = '') =>
    spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' });

  it('exits 0 on a compliant title', () => {
    const r = run(['--pr-title', 'ci: add the check']);
    expect(r.status).toBe(0);
  });

  it('exits 1 on a violating title, and says which rule on stdout', () => {
    const r = run(['--pr-title', 'Adds the check.']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[missing-prefix]');
    expect(r.stdout).toContain('[trailing-period]');
    expect(r.stdout).toContain('PR title');
  });

  it('exits 1 when given nothing to check, rather than passing vacuously', () => {
    const r = run([]);
    expect(r.status).toBe(1);
  });

  it('exits 1 when --pr-title is present but empty', () => {
    const r = run(['--pr-title', '']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing to check only the commit range');
  });

  it('reads stdin and exits on what it finds there', () => {
    expect(run(['--stdin'], 'abc1234\tfeat: fine\n').status).toBe(0);
    const bad = run(['--stdin'], 'abc1234\tNot conventional\n');
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('abc1234');
  });

  it('does not let a valueless flag swallow the flag after it', () => {
    // `--stdin` takes no value. If it consumed the next argument, the title
    // would go unchecked and a violating one would exit 0.
    const r = run(['--stdin', '--pr-title', 'Adds the check.'], 'abc\tfeat: fine\n');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('PR title');
  });
});

/**
 * Three of this check's decisions live in the workflow file, not in the
 * script, and every test above passes with all three of them wrong: the
 * validator is correct in isolation while the thing CI actually runs
 * checks the wrong objects. So the workflow is asserted directly.
 *
 * Each of these is a live regression, not a hypothetical. Dropping
 * `--pr-title` restores the blind spot that let every non-conforming
 * subject in this repo's history through. Dropping `edited` lets a title
 * be rewritten after a green run — how the longest subject in the history
 * was produced. Passing the base *sha* instead of the base *branch*
 * reintroduces `dco.yml`'s range, which the git fixtures below show would
 * fail a PR over commits already on `main`.
 */
describe('the workflow checks what the script can check', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/commit-convention.yml'), 'utf8');

  const lines = workflow.split('\n');
  /** The file with `#` comment lines removed — what the runner actually acts on. */
  const directives = lines.filter((l) => !/^\s*#/.test(l)).join('\n');

  /**
   * The body of every `run:` step. A `run:` body is the one place in a
   * workflow where an expansion becomes executable text, so it is extracted
   * rather than pattern-matched across the whole file — the `env:` block
   * legitimately contains the very expression the body must not.
   */
  const runBodies = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(?<indent>\s*)-? ?run: (?<inline>.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m.groups.inline !== '|' && m.groups.inline !== '>') {
      runBodies.push(m.groups.inline);
      continue;
    }
    const bodyIndent = m.groups.indent.length + 2;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() !== '' && lines[j].search(/\S/) < bodyIndent) break;
      body.push(lines[j]);
    }
    runBodies.push(body.join('\n'));
  }

  it('passes the PR title, which is the subject that lands on main', () => {
    expect(workflow).toMatch(/--pr-title "\$PR_TITLE"/);
    expect(workflow).toMatch(/PR_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/);
  });

  it('re-runs when the title is edited', () => {
    const types = /types: \[(?<types>[^\]]*)\]/.exec(workflow)?.groups?.types ?? '';
    expect(types.split(',').map((t) => t.trim())).toContain('edited');
  });

  it('excludes the base branch by name, not by the sha from the event payload', () => {
    expect(workflow).toMatch(/--base-ref "origin\/\$BASE_REF"/);
    // `pull_request.base.sha` is the range dco.yml uses, and the fixtures
    // below show it is wrong for this check. Asserted over directives only —
    // the prose above names it deliberately, to say why it is not used.
    expect(directives).not.toMatch(/base\.sha/);
  });

  it('fetches the base branch, so the ref it excludes by name exists', () => {
    expect(workflow).toMatch(
      /git fetch .*refs\/heads\/\$BASE_REF:refs\/remotes\/origin\/\$BASE_REF/,
    );
  });

  it('keeps the PR title out of the shell body, where it is attacker-controlled', () => {
    // The title must reach the script through the environment. A `${{ ... }}`
    // expression expanded inside a `run:` body is script injection on any
    // fork PR — the title is contributor-supplied text.
    expect(runBodies.length).toBeGreaterThan(0);
    for (const body of runBodies) {
      expect(body).not.toContain('${{');
    }
    // The env: binding is the correct channel, and it must actually be there.
    expect(workflow).toMatch(/PR_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/);
  });
});

/**
 * Criterion 6 — "the check does not run on existing commits" — is a property
 * of the revision range, so it is tested against a real git repository
 * rather than asserted in prose.
 *
 * The scenario is the one that breaks the range `dco.yml` uses: the base
 * branch advances after the PR is opened, and the author merges it in.
 * `BASE..HEAD` with `pull_request.base.sha` then contains a commit that is
 * already on `main`. DCO survives this because every commit is signed off
 * anyway; a subject check would fail the PR over someone else's history.
 */
describe('the revision range excludes commits already on the base branch', () => {
  const repos = [];
  afterEach(() => {
    for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  function buildRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'commit-convention-'));
    repos.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Fixture');
    git(dir, 'config', 'user.email', 'fixture@example.com');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const commit = (subject) => git(dir, 'commit', '-q', '--allow-empty', '-m', subject);

    // Pre-existing history, in the style this convention is replacing.
    commit('Retain the completeness failures the broker already detects');
    const baseAtOpen = git(dir, 'rev-parse', 'HEAD');

    git(dir, 'checkout', '-q', '-b', 'feature');
    commit('feat(server): add the new thing');

    // main advances while the PR is open, with another non-compliant subject.
    git(dir, 'checkout', '-q', 'main');
    commit('Report a member whose verbatim capture has stopped arriving');

    // The author merges main into the branch — routine, and the trap.
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'chore: merge main', 'main');
    commit('fix(server): follow-up fix');

    return { dir, baseAtOpen };
  }

  it('returns only the commits the PR author wrote', () => {
    const { dir } = buildRepo();
    const subjects = commitSubjectsInRange({
      head: 'feature',
      notRef: 'main',
      repoDir: dir,
    }).map((r) => r.subject);

    expect(subjects.sort()).toEqual(
      ['feat(server): add the new thing', 'fix(server): follow-up fix'].sort(),
    );
    expect(checkRecords(subjects.map((s, i) => ({ ref: `c${i}`, subject: s }))).ok).toBe(true);
  });

  it("the range dco.yml uses would fail this PR over main's own commit", () => {
    const { dir, baseAtOpen } = buildRepo();
    // Exactly `dco.yml`'s traversal: BASE..HEAD from the base sha at open.
    const dcoStyle = execFileSync('git', ['rev-list', '--no-merges', `${baseAtOpen}..feature`], {
      cwd: dir,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map((sha) =>
        execFileSync('git', ['show', '-s', '--format=%s', sha], {
          cwd: dir,
          encoding: 'utf8',
        }).trim(),
      );

    expect(dcoStyle).toContain('Report a member whose verbatim capture has stopped arriving');
    expect(checkRecords(dcoStyle.map((s, i) => ({ ref: `c${i}`, subject: s }))).ok).toBe(false);
  });
});
