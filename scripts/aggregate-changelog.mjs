#!/usr/bin/env node
/**
 * Aggregate per-package changesets changelogs into one suite-level
 * CHANGELOG.md at the repo root.
 *
 * Why: the suite versions in lockstep (see `fixed` in
 * .changeset/config.json), so a release is ONE event across all
 * packages — but changesets writes per-package changelogs, most of
 * which carry nothing but "Updated dependencies" noise (and the
 * `csuite` meta-package never has meaningful entries at all). This
 * script builds the single page a human actually wants to read.
 *
 * Modes:
 *   node scripts/aggregate-changelog.mjs
 *     Run after `changeset version` (wired into the root
 *     `version-packages` script): reads the new suite version from
 *     packages/csuite, extracts that version's section from every
 *     package CHANGELOG.md, drops dependency-only noise, and
 *     prepends a merged section to the root CHANGELOG.md. The
 *     aggregate therefore lands inside the Version Packages PR,
 *     reviewable like everything else.
 *
 *   node scripts/aggregate-changelog.mjs --extract [version]
 *     Print the root CHANGELOG.md section for `version` (default:
 *     current suite version) without its heading — used by the
 *     release workflow as the body of the single `v<version>`
 *     GitHub release.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_CHANGELOG = join(ROOT, 'CHANGELOG.md');

/** Preferred display order; anything else follows alphabetically. */
const PACKAGE_ORDER = [
  'csuite-cli',
  'csuite-server',
  'csuite-core',
  'csuite-sdk',
  'csuite',
  'csuite-web-ui',
  'csuite-web-host',
];

const PACKAGE_DIRS = [
  'packages/cli',
  'apps/server',
  'packages/core',
  'packages/sdk',
  'packages/csuite',
  'packages/web-ui',
  'apps/web-host',
];

const HEADER = `# CommandSuite changelog

All notable changes to the suite, aggregated across its packages.
CommandSuite versions in lockstep — one version per release train —
so each section below is one release. Per-package \`CHANGELOG.md\`
files still ship inside every npm tarball.
`;

function suiteVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'packages/csuite/package.json'), 'utf8')).version;
}

/**
 * Extract the `## <version>` section body from a changelog. Matches
 * both bare headings (`## 0.0.2`, per-package changesets output) and
 * dated ones (`## 0.0.2 (2026-07-22)`, the root aggregate) with plain
 * string comparison — no RegExp built from input.
 */
function sectionFor(markdown, version) {
  const lines = markdown.split('\n');
  const head = `## ${version}`;
  const start = lines.findIndex((l) => {
    const t = l.trim();
    return t === head || t.startsWith(`${head} `);
  });
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}

/**
 * Drop "Updated dependencies" bullets (and their indented children),
 * then drop any bump-type heading left with no bullets under it.
 */
function stripDependencyNoise(section) {
  const lines = section.split('\n');
  const kept = [];
  let skippingBullet = false;
  for (const line of lines) {
    if (/^- Updated dependencies/.test(line)) {
      skippingBullet = true;
      continue;
    }
    if (skippingBullet) {
      // children of the dropped bullet are indented; a new top-level
      // line (bullet, heading, or blank-then-content) ends the skip
      if (/^\s+\S/.test(line)) continue;
      skippingBullet = false;
    }
    kept.push(line);
  }
  // remove bump-type headings with nothing under them
  const out = [];
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i];
    if (/^### /.test(line)) {
      const rest = kept.slice(i + 1);
      const next = rest.findIndex((l) => /^### /.test(l));
      const body = (next === -1 ? rest : rest.slice(0, next)).join('\n').trim();
      if (body === '') {
        if (next !== -1)
          i += next; // jump to just before next heading
        else i = kept.length;
        continue;
      }
    }
    out.push(line);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildAggregate(version) {
  const parts = [];
  const seen = new Map();
  for (const dir of PACKAGE_DIRS) {
    const pkgPath = join(ROOT, dir, 'package.json');
    const clPath = join(ROOT, dir, 'CHANGELOG.md');
    if (!existsSync(pkgPath) || !existsSync(clPath)) continue;
    const name = JSON.parse(readFileSync(pkgPath, 'utf8')).name;
    const section = sectionFor(readFileSync(clPath, 'utf8'), version);
    if (!section) continue;
    const cleaned = stripDependencyNoise(section);
    if (cleaned === '') continue;
    // demote bump-type headings one level so they nest under the package
    seen.set(name, cleaned.replace(/^### /gm, '#### '));
  }
  const ordered = [
    ...PACKAGE_ORDER.filter((n) => seen.has(n)),
    ...[...seen.keys()].filter((n) => !PACKAGE_ORDER.includes(n)).sort(),
  ];
  for (const name of ordered) {
    parts.push(`### ${name}\n\n${seen.get(name)}`);
  }
  if (parts.length === 0) {
    parts.push('_Version alignment release — no user-facing changes._');
  }
  const date = new Date().toISOString().slice(0, 10);
  return `## ${version} (${date})\n\n${parts.join('\n\n')}`;
}

function updateRootChangelog(version) {
  const aggregate = buildAggregate(version);
  let existing = existsSync(ROOT_CHANGELOG) ? readFileSync(ROOT_CHANGELOG, 'utf8') : HEADER;
  // replace an existing section for this version (idempotent re-runs)
  const lines = existing.split('\n');
  const start = lines.findIndex(
    (l) => l.trim().startsWith(`## ${version} `) || l.trim() === `## ${version}`,
  );
  if (start !== -1) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i])) {
        end = i;
        break;
      }
    }
    lines.splice(start, end - start, ...aggregate.split('\n'), '');
    existing = lines.join('\n');
  } else {
    const firstSection = lines.findIndex((l) => /^## /.test(l));
    if (firstSection === -1) {
      existing = `${existing.trimEnd()}\n\n${aggregate}\n`;
    } else {
      lines.splice(firstSection, 0, ...aggregate.split('\n'), '');
      existing = lines.join('\n');
    }
  }
  writeFileSync(ROOT_CHANGELOG, `${existing.trimEnd()}\n`);
  console.log(`[aggregate-changelog] wrote ${version} section to CHANGELOG.md`);
}

const args = process.argv.slice(2);
if (args[0] === '--extract') {
  const version = args[1] ?? suiteVersion();
  // sectionFor matches dated headings directly — no fallback needed.
  const section = sectionFor(readFileSync(ROOT_CHANGELOG, 'utf8'), version);
  if (!section) {
    console.error(`[aggregate-changelog] no CHANGELOG.md section for ${version}`);
    process.exit(1);
  }
  process.stdout.write(`${section}\n`);
} else {
  updateRootChangelog(suiteVersion());
}
