#!/usr/bin/env node
/**
 * Holds the docs to the vocabulary the code actually ships.
 *
 * The permission leaves were once enumerated three times in three
 * different documents, with eleven, twelve and thirteen entries, under
 * prose calling them "Twelve". Nothing was wrong with any single edit: a
 * page needed a list, the author wrote the list they knew, and no
 * instrument compared the three. `PERMISSIONS` in `csuite-sdk` is the only
 * authority, and exactly one document enumerates it.
 *
 * Three checks, in the order a reader would notice them failing:
 *
 *   1. The one enumerating table matches `PERMISSIONS` exactly.
 *   2. No other document enumerates the leaves. A route reference naming
 *      the leaf a route requires is not an enumeration; a contiguous run
 *      of five or more distinct leaves is.
 *   3. No prose counts the leaves. A number in a sentence is a second
 *      source of truth that drifts on its own — which is how one page came
 *      to say "Twelve" above a list of eleven.
 *
 * Usage: node scripts/check-vocabulary.mjs [repo-root]
 * Exits 0 when clean, 1 with a named failure otherwise. Takes a root so
 * its own negative fixtures can run it against a scratch tree.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..'));

/** The document allowed to enumerate the leaves. */
const CANONICAL = 'docs/concepts/permissions.mdx';
/** Where `PERMISSIONS` is declared. */
const SOURCE = 'packages/sdk/src/types.ts';

/**
 * A contiguous run of this many distinct leaves reads as an enumeration.
 * Five is above the largest legitimate cluster in the tree — `rest-api.mdx`
 * names at most three leaves within a window while documenting one route's
 * auth — and below the smallest real table, which is the full set.
 */
const ENUMERATION_THRESHOLD = 5;
const ENUMERATION_WINDOW = 15;

/**
 * A number modifying the leaves, directly: "twelve permission leaves",
 * "Twelve leaf permissions", "the thirteen leaves", "Four objective leaves".
 * Up to two words may sit between, which covers every adjective the docs use.
 *
 * Adjacency rather than "a number somewhere in the sentence", because
 * `leaves` is also an ordinary verb and the docs are full of sentences that
 * carry a number for an unrelated reason. `one` is excluded: it reads as an
 * article ("one permission leaf a member holds"), and no drift ever counted
 * a set as one.
 */
const COUNTED_LEAVES =
  /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+)\s+(?:[\w-]+\s+){0,2}(leaf permissions?|permission leaves|leaves)\b/i;

const failures = [];
const fail = (check, file, message) => failures.push({ check, file, message });

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** Every `.mdx` under `docs/`, excluding the site app's own sources. */
function docFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === 'site' || name === 'node_modules' || name === 'dist') continue;
        walk(full);
      } else if (name.endsWith('.mdx')) {
        out.push(relative(ROOT, full));
      }
    }
  };
  walk(join(ROOT, 'docs'));
  return out.sort();
}

/**
 * The declared leaves, parsed rather than imported: this runs before any
 * build, and importing `dist/` would check a stale copy of the very thing
 * the docs are being compared against.
 */
function declaredPermissions() {
  const src = read(SOURCE);
  const start = src.indexOf('export const PERMISSIONS = [');
  if (start === -1) throw new Error(`no PERMISSIONS array in ${SOURCE}`);
  const end = src.indexOf('] as const', start);
  if (end === -1) throw new Error(`unterminated PERMISSIONS array in ${SOURCE}`);
  const body = src.slice(start, end);
  // Only quoted entries at list depth — doc-comments in the array mention
  // leaf names in prose, and those are not entries.
  return [...body.matchAll(/^\s{2}'([a-z_]+\.[a-z_]+)',$/gm)].map((m) => m[1]);
}

/**
 * Leaf tokens a file ENUMERATES, with the line each was found on.
 *
 * Enumerating means the leaf is the subject: the first cell of a table row,
 * a list item, or one of a comma-run in prose. A table keyed by something
 * else that names the leaf it requires — the MCP toolbox, the runner
 * overview, every route in the REST reference — is a cross-reference, and
 * those must keep naming leaves or they say nothing.
 */
function leafHits(text, leaves) {
  const hits = [];
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    const onLine = leaves.filter((leaf) => line.includes(`\`${leaf}\``));
    // Three leaves on one line is a list however it is introduced. A
    // cross-reference row names exactly one, in a cell of its own.
    const runOfLeaves = onLine.length >= 3;
    for (const leaf of onLine) {
      const before = line.slice(0, line.indexOf(`\`${leaf}\``));
      const subject =
        runOfLeaves ||
        /^\|\s*$/.test(before) || // first cell of a table row
        /^\s*[-*]\s*$/.test(before); // a list item
      if (subject) hits.push({ leaf, line: i + 1 });
    }
  }
  return hits;
}

const PERMISSIONS = declaredPermissions();
if (PERMISSIONS.length === 0) {
  console.error(`check-vocabulary: parsed zero leaves from ${SOURCE} — the parser is broken`);
  process.exit(1);
}

// ── 1. the canonical table matches PERMISSIONS ─────────────────────────
{
  const text = read(CANONICAL);
  const rows = [...text.matchAll(/^\| `([a-z_]+\.[a-z_]+)` \|/gm)].map((m) => m[1]);
  const declared = new Set(PERMISSIONS);
  const listed = new Set(rows);
  const missing = PERMISSIONS.filter((p) => !listed.has(p));
  const extra = rows.filter((p) => !declared.has(p));
  if (missing.length)
    fail('table', CANONICAL, `does not list ${missing.join(', ')} — declared in ${SOURCE}`);
  if (extra.length) fail('table', CANONICAL, `lists ${extra.join(', ')}, which no longer exist`);
  if (rows.length !== new Set(rows).size) fail('table', CANONICAL, 'lists a leaf twice');
}

// ── 2. nothing else enumerates them ────────────────────────────────────
for (const file of docFiles()) {
  if (file === CANONICAL) continue;
  const hits = leafHits(read(file), PERMISSIONS);
  if (hits.length < ENUMERATION_THRESHOLD) continue;
  for (let i = 0; i + ENUMERATION_THRESHOLD - 1 < hits.length; i++) {
    const window = hits.slice(i).filter((h) => h.line - hits[i].line <= ENUMERATION_WINDOW);
    const distinct = new Set(window.map((h) => h.leaf));
    if (distinct.size >= ENUMERATION_THRESHOLD) {
      fail(
        'enumeration',
        file,
        `enumerates ${distinct.size} leaves near line ${hits[i].line}. ` +
          `Only ${CANONICAL} enumerates them; link to it instead.`,
      );
      break;
    }
  }
}

// ── 3. no prose counts them ────────────────────────────────────────────
for (const file of [...docFiles(), 'README.md']) {
  let text;
  try {
    text = read(file);
  } catch {
    continue;
  }
  for (const [i, line] of text.split('\n').entries()) {
    // A number inside a code span is a line number in a citation, never
    // prose counting a set.
    const m = COUNTED_LEAVES.exec(line.replace(/`[^`]*`/g, ''));
    if (m) {
      fail(
        'count',
        file,
        `line ${i + 1} counts the permission leaves: "${m[0].trim()}". ` +
          `The count drifts independently of the list; name no number.`,
      );
    }
  }
}

if (failures.length === 0) {
  console.error(`check-vocabulary: ${PERMISSIONS.length} permission leaves, docs agree`);
  process.exit(0);
}

console.error(`check-vocabulary: ${failures.length} problem(s)\n`);
for (const f of failures) console.error(`  [${f.check}] ${f.file}: ${f.message}`);
console.error(
  `\nThe permission leaves are declared in ${SOURCE} and enumerated only in ${CANONICAL}.`,
);
process.exit(1);
