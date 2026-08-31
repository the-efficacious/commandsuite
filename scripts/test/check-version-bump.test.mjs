/**
 * The version guard proves it discriminates, in the fixtures that ship
 * with it and in the same CI job that enforces it.
 *
 * A guard degraded to allow-everything is the failure that matters here
 * — it would be silent, and the thing it stops is irreversible. So the
 * negative cases are the point of this file, and the positive ones stop
 * it from being "fail always", which would teach people to route around
 * it.
 */
import { describe, expect, it } from 'vitest';
import { checkVersionBump, RELEASE_BRANCH, versionChangesFrom } from '../check-version-bump.mjs';

const BUMP = `diff --git a/packages/core/package.json b/packages/core/package.json
--- a/packages/core/package.json
+++ b/packages/core/package.json
@@ -3 +3 @@
-  "version": "0.8.0",
+  "version": "0.9.0",
`;

const UNRELATED = `diff --git a/packages/core/package.json b/packages/core/package.json
--- a/packages/core/package.json
+++ b/packages/core/package.json
@@ -14 +14 @@
-    "test": "vitest run",
+    "test": "vitest run --reporter dot",
`;

describe('versionChangesFrom', () => {
  it('finds a version bump and reports both sides', () => {
    expect(versionChangesFrom(BUMP)).toEqual([
      { file: 'packages/core/package.json', from: '0.8.0', to: '0.9.0' },
    ]);
  });

  it('ignores package.json edits that are not the version', () => {
    expect(versionChangesFrom(UNRELATED)).toEqual([]);
  });

  it('ignores a version-looking line in a file that is not a package.json', () => {
    const diff = `diff --git a/docs/example.md b/docs/example.md
--- a/docs/example.md
+++ b/docs/example.md
@@ -1 +1 @@
+  "version": "9.9.9"
`;
    expect(versionChangesFrom(diff)).toEqual([]);
  });

  it('catches a version field being removed', () => {
    const diff = `diff --git a/packages/core/package.json b/packages/core/package.json
--- a/packages/core/package.json
+++ b/packages/core/package.json
@@ -3 +2 @@
-  "version": "0.8.0",
`;
    expect(versionChangesFrom(diff)).toEqual([
      { file: 'packages/core/package.json', from: '0.8.0' },
    ]);
  });
});

describe('checkVersionBump', () => {
  const changes = versionChangesFrom(BUMP);

  it('REFUSES a version bump on an ordinary branch', () => {
    const problems = checkVersionBump({ changes, headRef: 'feat/innocent-looking' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('packages/core/package.json');
    expect(problems[0]).toContain('0.8.0 → 0.9.0');
    expect(problems[0]).toContain('feat/innocent-looking');
  });

  it('REFUSES a bump on a branch merely named like the release branch', () => {
    // Substring-matching this would be a bypass anyone could take by
    // naming their branch conveniently.
    for (const headRef of [
      `${RELEASE_BRANCH}-2`,
      `not-${RELEASE_BRANCH}`,
      'changeset-release/main/x',
      'changeset-release',
    ]) {
      expect(checkVersionBump({ changes, headRef }), headRef).toHaveLength(1);
    }
  });

  it('allows the changesets Version PR, which is the sanctioned path', () => {
    expect(checkVersionBump({ changes, headRef: RELEASE_BRANCH })).toEqual([]);
  });

  it('allows an ordinary branch that changes no version', () => {
    expect(
      checkVersionBump({ changes: versionChangesFrom(UNRELATED), headRef: 'feat/ordinary' }),
    ).toEqual([]);
  });
});
