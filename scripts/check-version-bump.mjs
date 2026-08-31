#!/usr/bin/env node
/**
 * Refuse a version change that did not come from the changesets Version
 * PR.
 *
 * Why this exists. `changeset publish` publishes any package whose
 * version is not yet on the registry, and the release workflow runs on
 * every push to `main`. So the trigger for an irreversible publish is
 * "a commit on main left a version npm doesn't have yet" — NOT a human
 * signature. Our process document says releases are the human gate;
 * without this check that sentence is a convention wearing the
 * appearance of a gate. An ordinary pull request that edited a version
 * field, reviewed and merged in the normal way, would publish on merge
 * with neither signer involved.
 *
 * The window this matters most is a release, because that is the only
 * time a `chore: version packages` PR exists — sitting on main, looking
 * like housekeeping, mergeable by any two reviewers.
 *
 * There is deliberately NO bypass. A guard people learn to wave through
 * is worse than the convention it replaces. The legitimate way to
 * change a version is a changeset, which produces the Version PR from
 * the release branch, and that PR passes this check by construction.
 *
 * CLI: node scripts/check-version-bump.mjs --base-ref origin/main \
 *        --head <sha> --head-ref <branch>
 */
import { spawnSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The branch the changesets action opens its Version PR from. */
export const RELEASE_BRANCH = 'changeset-release/main';

/**
 * Extract version-line changes from `git diff -U0` output.
 *
 * Deliberately dumb and anchored: `+++ b/<path>` names the file, and a
 * `+  "version": "x"` line inside a package.json is a version change.
 * A removal without an addition (deleting the field) counts too — it
 * changes what the registry comparison sees.
 */
export function versionChangesFrom(diff) {
  const changes = [];
  let file = null;
  for (const line of diff.split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = header[1];
      continue;
    }
    if (file === null || !file.endsWith('package.json')) continue;
    // A unified diff emits the removal BEFORE the addition, so the
    // pairing runs that way round: `-` opens the record, `+` completes
    // it. Doing it the other way produced two records for one bump.
    const removed = /^-\s*"version"\s*:\s*"([^"]*)"/.exec(line);
    if (removed) {
      changes.push({ file, from: removed[1] });
      continue;
    }
    const added = /^\+\s*"version"\s*:\s*"([^"]*)"/.exec(line);
    if (added) {
      const open = changes.find((c) => c.file === file && c.to === undefined);
      if (open) open.to = added[1];
      else changes.push({ file, to: added[1] });
    }
  }
  return changes;
}

/**
 * The judgement. Returns a list of human-readable problems; empty means
 * the change is allowed.
 */
export function checkVersionBump({ changes, headRef, releaseBranch = RELEASE_BRANCH }) {
  if (changes.length === 0) return [];
  if (headRef === releaseBranch) return [];
  return changes.map(
    (c) =>
      `${c.file}: version ${c.from ?? '(absent)'} → ${c.to ?? '(removed)'} on branch '${headRef}'`,
  );
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// ── CLI ─────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const baseRef = arg('base-ref');
  const head = arg('head');
  const headRef = arg('head-ref');
  // Refuse to pass vacuously. A guard invoked without the inputs it
  // needs must fail, not report that it found nothing to check --
  // that is how a broken workflow argument becomes a silent green.
  if (!baseRef || !head || !headRef) {
    console.error('check-version-bump: --base-ref, --head and --head-ref are all required');
    process.exit(2);
  }
  const diff = git(['diff', '-U0', `${baseRef}...${head}`, '--', '*package.json']);
  const problems = checkVersionBump({ changes: versionChangesFrom(diff), headRef });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    console.error(`
A package version changed outside the changesets Version PR.

Publishing is triggered by a version on main that npm does not have yet,
so merging this would publish -- irreversibly, and without the release
sign-off that is supposed to gate it.

If you meant to release:   add a changeset (pnpm changeset) and let the
                           Version PR carry the bump. It comes from
                           '${RELEASE_BRANCH}' and passes this check.
If you did not:            revert the version field.

There is no bypass, deliberately. See docs/dev/gates.mdx.`);
    process.exit(1);
  }
  console.log('no version changes outside the release branch');
}
