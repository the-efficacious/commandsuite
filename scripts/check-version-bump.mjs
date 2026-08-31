#!/usr/bin/env node
/**
 * Refuse a registry-new package identity that did not come from the
 * changesets Version PR.
 *
 * Why this exists. `changeset publish` publishes any package whose
 * `(name, version)` is not yet on the registry, and the release
 * workflow runs on every push to `main`. So the trigger for an
 * irreversible publish is "a commit on main left an identity npm does
 * not have yet" — NOT a human signature. Our process document says
 * releases are the human gate; without this check that sentence is a
 * convention wearing the appearance of a gate.
 *
 * Two review findings shaped what this checks, and both are recorded
 * because the reasoning is the load-bearing part:
 *
 *  1. **Identity, not the branch name.** `head.ref` carries no
 *     repository identity and this repo is public, so anyone may fork
 *     it, name a branch `changeset-release/main`, and open a pull
 *     request. The sanctioned path is the release branch **in this
 *     repository**; a missing head repo (deleted fork) fails closed.
 *
 *  2. **Parse, don't regex.** This previously matched `"version"` on
 *     unified-diff lines — a line-oriented tool applied to a
 *     structured document. That misses a key split across lines, odd
 *     whitespace, a unicode-escaped key, an added manifest with no
 *     diff context, and a `name` change at constant version. Parsing
 *     base and head manifests retires all of those at once, which is
 *     why this is a class fix rather than another hole plugged.
 *
 * The registry's identity is `(name, version)` — **renaming a package
 * while holding the version constant publishes something npm has
 * never seen**, so a version-only check was never sufficient.
 *
 * There is deliberately NO bypass. The legitimate way to change a
 * published identity is a changeset, which produces the Version PR
 * from the release branch in this repository, and that passes by
 * construction.
 *
 * CLI: node scripts/check-version-bump.mjs --base-ref origin/main \
 *        --head <sha> --head-ref <branch> \
 *        --head-repo <owner/repo> --base-repo <owner/repo>
 */
import { spawnSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The branch the changesets action opens its Version PR from. */
export const RELEASE_BRANCH = 'changeset-release/main';

/** Marker for a manifest that exists but could not be parsed. */
export const UNPARSEABLE = Symbol('unparseable manifest');

/**
 * The identity npm would publish under, or `null` when this manifest
 * cannot publish at all.
 *
 * `private: true` packages are skipped by `changeset publish`, so a
 * version moving on one cannot reach the registry — flagging it would
 * make the guard fire on work incapable of publishing, and a guard
 * that fires on safe changes is one people learn to wave through.
 *
 * An unparseable manifest returns the marker rather than `null`: we
 * could not establish that it is safe, and "could not establish" must
 * never read the same as "established safe".
 */
export function publishIdentity(manifest) {
  if (manifest === null || manifest === undefined) return null;
  if (manifest === UNPARSEABLE) return UNPARSEABLE;
  if (manifest.private === true) return null;
  const { name, version } = manifest;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof version !== 'string' || version.length === 0) return null;
  return `${name}@${version}`;
}

/**
 * Given `{file, base, head}` triples — parsed manifests, `null` for
 * absent, `UNPARSEABLE` for present-but-unreadable — return the
 * identities that would be new to the registry.
 */
export function identityChanges(manifests) {
  const changes = [];
  for (const { file, base, head } of manifests) {
    const to = publishIdentity(head);
    if (to === null) continue; // head cannot publish: deleted, or private
    if (to === UNPARSEABLE) {
      changes.push({ file, from: '(unknown)', to: '(unparseable manifest)' });
      continue;
    }
    const from = publishIdentity(base);
    if (from === UNPARSEABLE) {
      // Base unreadable: we cannot show the identity is unchanged.
      changes.push({ file, from: '(unparseable base)', to });
      continue;
    }
    if (from === to) continue; // identity unchanged — nothing to publish
    // `from` is null for two different reasons and the operator needs
    // to know which: the manifest did not exist, or it existed and
    // could not publish. `private: true` flipping to publishable is
    // registry-new at an UNCHANGED (name, version) -- the tuple is
    // identical and npm has still never seen it.
    const wasAbsent = base === null || base === undefined;
    changes.push({ file, from: from ?? (wasAbsent ? '(absent)' : '(not publishable)'), to });
  }
  return changes;
}

/**
 * The judgement. Returns human-readable problems; empty means allowed.
 */
export function checkVersionBump({
  changes,
  headRef,
  headRepo,
  baseRepo,
  releaseBranch = RELEASE_BRANCH,
}) {
  if (changes.length === 0) return [];
  const fromThisRepo = typeof headRepo === 'string' && headRepo.length > 0 && headRepo === baseRepo;
  if (fromThisRepo && headRef === releaseBranch) return [];
  const origin = `${headRepo ?? '(unknown repo)'}:${headRef}`;
  return changes.map((c) => `${c.file}: ${c.from} → ${c.to} from '${origin}'`);
}

// ── git plumbing ────────────────────────────────────────────────────

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Parsed manifest at a ref, `null` if absent, UNPARSEABLE if broken. */
export function manifestAt(ref, path) {
  const raw = git(['show', `${ref}:${path}`], { allowFailure: true });
  if (raw === null) return null; // did not exist at this ref
  try {
    return JSON.parse(raw);
  } catch {
    return UNPARSEABLE;
  }
}

/** Every package.json touched between base and head, in either state. */
export function changedManifests(baseRef, head) {
  const listed = git(['diff', '--name-only', `${baseRef}...${head}`, '--', '*package.json']);
  const files = listed.split('\n').filter((f) => f.trim().length > 0);
  return files.map((file) => ({
    file,
    base: manifestAt(baseRef, file),
    head: manifestAt(head, file),
  }));
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
  const headRepo = arg('head-repo');
  const baseRepo = arg('base-repo');
  // Refuse to pass vacuously. A guard invoked without the inputs it
  // needs must fail, not report that it found nothing to check --
  // that is how a broken workflow argument becomes a silent green.
  if (!baseRef || !head || !headRef || !baseRepo) {
    console.error(
      'check-version-bump: --base-ref, --head, --head-ref and --base-repo are all required',
    );
    process.exit(2);
  }
  const problems = checkVersionBump({
    changes: identityChanges(changedManifests(baseRef, head)),
    headRef,
    headRepo,
    baseRepo,
  });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    console.error(`
A package identity new to the registry changed outside the Version PR.

npm identity is (name, version): a rename at a constant version
publishes just as a version bump does. Publishing is triggered by an
identity on main that npm does not have yet, so merging this would
publish -- irreversibly, and without the release sign-off that is
supposed to gate it.

If you meant to release:   add a changeset (pnpm changeset) and let the
                           Version PR carry it. It comes from
                           '${RELEASE_BRANCH}' IN THIS REPOSITORY and
                           passes this check. A fork branch of the same
                           name does not -- a branch name is not an
                           identity.
If you did not:            revert the name/version change, or mark the
                           package private if it should not publish.

There is no bypass, deliberately. See docs/dev/gates.mdx.`);
    process.exit(1);
  }
  console.log('no registry-new package identities outside the release branch');
}
