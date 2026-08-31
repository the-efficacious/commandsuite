/**
 * The version guard proves it discriminates, in the fixtures that ship
 * with it and in the same CI job that enforces it.
 *
 * A guard degraded to allow-everything is the failure that matters
 * here — it would be silent, and the thing it stops is irreversible.
 * So the negative cases are the point of this file, and the positive
 * ones stop it from being "fail always", which would teach people to
 * route around it.
 *
 * Four bypasses were found in review rather than by the author, and
 * each has a fixture below. The progression is the lesson: a branch
 * name trusted without repo identity; a structured document parsed as
 * lines; a rename holding the version constant; and a package becoming
 * publishable without either field changing. **None would have been
 * found by hardening the previous fix** — each came from asking what
 * "new to the registry" actually means.
 */
import { describe, expect, it } from 'vitest';
import {
  checkVersionBump,
  identityChanges,
  publishIdentity,
  RELEASE_BRANCH,
  UNPARSEABLE,
} from '../check-version-bump.mjs';

const OURS = 'the-efficacious/commandsuite';
const pkg = (over = {}) => ({ name: 'csuite-core', version: '0.8.0', ...over });

describe('publishIdentity', () => {
  it('is (name, version) — the tuple npm publishes under', () => {
    expect(publishIdentity(pkg())).toBe('csuite-core@0.8.0');
  });

  it('is null for a manifest that cannot publish', () => {
    expect(publishIdentity(pkg({ private: true }))).toBeNull();
    expect(publishIdentity(null)).toBeNull();
    expect(publishIdentity(pkg({ name: undefined }))).toBeNull();
    expect(publishIdentity(pkg({ version: '' }))).toBeNull();
  });

  it('propagates unparseable rather than collapsing it to null', () => {
    // "could not establish it is safe" must never read as "safe".
    expect(publishIdentity(UNPARSEABLE)).toBe(UNPARSEABLE);
  });
});

describe('identityChanges', () => {
  it('REFUSES a version bump', () => {
    expect(
      identityChanges([
        { file: 'packages/core/package.json', base: pkg(), head: pkg({ version: '0.9.0' }) },
      ]),
    ).toEqual([
      { file: 'packages/core/package.json', from: 'csuite-core@0.8.0', to: 'csuite-core@0.9.0' },
    ]);
  });

  // Bypass 3 (Rune). Registry identity is (name, version): a rename at
  // a constant version publishes a package npm has never seen.
  it('REFUSES a rename at an unchanged version', () => {
    const out = identityChanges([
      { file: 'packages/core/package.json', base: pkg(), head: pkg({ name: 'csuite-core-2' }) },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].to).toBe('csuite-core-2@0.8.0');
  });

  // Bypass 3b (Lea). An added manifest has no base to compare against,
  // and a null path is exactly where that falls through silently.
  it('REFUSES an added publishable package — absent base fails closed', () => {
    const out = identityChanges([
      { file: 'packages/brand-new/package.json', base: null, head: pkg({ name: 'csuite-new' }) },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].from).toBe('(absent)');
  });

  // Bypass 4 (Rune). private → publishable is registry-new at an
  // IDENTICAL (name, version). The tuple did not change and npm has
  // still never seen it, so "the tuple changed" was the wrong test.
  it('REFUSES private becoming publishable at an unchanged tuple', () => {
    const out = identityChanges([
      { file: 'packages/core/package.json', base: pkg({ private: true }), head: pkg() },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].from).toBe('(not publishable)');
    expect(out[0].to).toBe('csuite-core@0.8.0');
  });

  it('REFUSES an unparseable head, and an unparseable base', () => {
    expect(
      identityChanges([{ file: 'a/package.json', base: pkg(), head: UNPARSEABLE }]),
    ).toHaveLength(1);
    expect(
      identityChanges([{ file: 'a/package.json', base: UNPARSEABLE, head: pkg() }]),
    ).toHaveLength(1);
  });

  // Positive controls. A guard that fires on safe changes gets waved
  // through, which is worse than no guard. Note the `private` field
  // carries both directions: its version moving must NOT fire, and it
  // becoming public MUST — both-directions discipline on one flag.
  it('allows edits that cannot reach the registry', () => {
    expect(
      identityChanges([
        { file: 'a/package.json', base: pkg(), head: pkg({ description: 'new' }) },
        {
          file: 'b/package.json',
          base: pkg({ private: true }),
          head: pkg({ private: true, version: '9.9.9' }),
        },
        { file: 'c/package.json', base: pkg(), head: null },
        { file: 'd/package.json', base: pkg(), head: pkg({ private: true }) },
      ]),
    ).toEqual([]);
  });
});

describe('checkVersionBump', () => {
  const changes = identityChanges([
    { file: 'packages/core/package.json', base: pkg(), head: pkg({ version: '0.9.0' }) },
  ]);

  it('REFUSES a registry-new identity on an ordinary branch', () => {
    const problems = checkVersionBump({
      changes,
      headRef: 'feat/innocent-looking',
      headRepo: OURS,
      baseRepo: OURS,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('csuite-core@0.8.0 → csuite-core@0.9.0');
    expect(problems[0]).toContain('feat/innocent-looking');
  });

  // Bypass 1 (mine, closed before review): substring matching would let
  // anyone pick a convenient branch name.
  it('REFUSES a branch merely named like the release branch', () => {
    for (const headRef of [
      `${RELEASE_BRANCH}-2`,
      `not-${RELEASE_BRANCH}`,
      'changeset-release/main/x',
      'changeset-release',
    ]) {
      expect(
        checkVersionBump({ changes, headRef, headRepo: OURS, baseRepo: OURS }),
        headRef,
      ).toHaveLength(1);
    }
  });

  // Bypass 2 (Rune). This repository is public, so the branch name is
  // attacker-controlled; head.ref carries no repository identity.
  it('REFUSES the release branch name from a FORK', () => {
    for (const headRepo of [
      'attacker/commandsuite',
      'the-efficacious/commandsuite-fork',
      'the-efficacious2/commandsuite',
    ]) {
      const problems = checkVersionBump({
        changes,
        headRef: RELEASE_BRANCH,
        headRepo,
        baseRepo: OURS,
      });
      expect(problems, headRepo).toHaveLength(1);
      expect(problems[0], headRepo).toContain(headRepo);
    }
  });

  it('REFUSES when the head repository is absent (deleted fork)', () => {
    for (const headRepo of [null, undefined, '']) {
      expect(
        checkVersionBump({ changes, headRef: RELEASE_BRANCH, headRepo, baseRepo: OURS }),
        String(headRepo),
      ).toHaveLength(1);
    }
  });

  it('allows the sanctioned Version PR — this repo, release branch', () => {
    expect(
      checkVersionBump({ changes, headRef: RELEASE_BRANCH, headRepo: OURS, baseRepo: OURS }),
    ).toEqual([]);
  });

  it('allows an ordinary branch that changes no identity', () => {
    expect(
      checkVersionBump({ changes: [], headRef: 'feat/ordinary', headRepo: OURS, baseRepo: OURS }),
    ).toEqual([]);
  });
});
