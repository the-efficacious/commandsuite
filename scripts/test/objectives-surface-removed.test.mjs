/**
 * The objectives surface is gone from every package's `src/`.
 *
 * WHY A SCAN AND NOT THE COMPILER. The compiler already refuses
 * `objectives.create` (not a `Permission`) and `listObjectives` (not on
 * `Client`), and the whole suite is green. What neither reaches is
 * TEXT: a tool name in a description string, a route in a fetch, a
 * permission leaf in a JSON preset an operator copies out of a doc.
 * Those all compile perfectly and are the surface an agent or a member
 * actually meets. A rip-out that leaves one behind teaches a live agent
 * to call something that 404s, and the call is charged to a member's
 * context.
 *
 * It also covers the packages nothing else does at once. This runs at
 * the repo root — which is where the workspace's own properties belong
 * — so one run sees `apps/server`, `apps/web-host`, `packages/cli`,
 * `packages/core`, `packages/sdk` and `packages/web-ui` together. Six
 * per-package greps drift; one does not.
 *
 * COMMENTS ARE EXEMPT, AND THE EXEMPTION IS BOUNDED. Several files
 * explain what was removed and why — the files ACL that used to hang
 * off `/objectives/<id>/`, the `obj:` owner arm the SDK schema keeps
 * for rows still in deployed databases, the class of defect a tool
 * description once carried. Those sentences are the record of a
 * decision and deleting them to satisfy a grep would trade a real
 * explanation for a green check. So the scan reads CODE, and there is
 * a fixture below asserting the exemption is deliberate rather than a
 * hole someone can hide a live call in.
 *
 * BOTH DIRECTIONS. A scanner pointed at nothing reports no violations
 * exactly as cheerfully as a clean tree, and that is the failure this
 * repo has written down twice. So: the corpus is asserted non-empty and
 * to contain the files it should; a planted occurrence in each of the
 * three forms is found; and a planted occurrence inside a comment is
 * NOT found, which is the only way to tell the exemption from a bug.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Every package that ships code. Named, so a new one is a deliberate edit. */
const SRC_ROOTS = [
  'apps/server/src',
  'apps/web-host/src',
  'packages/cli/src',
  'packages/core/src',
  'packages/sdk/src',
  'packages/web-ui/src',
];

/**
 * The three shapes the surface took, as data.
 *
 * Each is the form a CONSUMER met it in — an agent reading a tool list,
 * a client building a URL, an operator writing a permission into a
 * preset — rather than an internal identifier. `Objective` the type is
 * deliberately not here: the compiler removes it and cannot be talked
 * out of it, and adding it would flag the word in ordinary English.
 */
const FORBIDDEN = [
  { id: 'tool name', re: /\bobjectives_[a-z_]+/ },
  { id: 'route', re: /['"`]\/objectives(?:[/?'"`]|$)/ },
  { id: 'permission leaf', re: /['"`]objectives\.(create|cancel|reassign|watch)['"`]/ },
];

/**
 * `true` for a line that is entirely comment.
 *
 * Line-based, and that is a choice with a cost worth naming: an
 * occurrence in a trailing comment after real code on the same line is
 * missed. It buys not having to parse TypeScript to run a grep, and the
 * planted-occurrence fixtures below are what establish the scan still
 * finds the forms that matter.
 */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/');
}

function walk(dir, prefix, files) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const label = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      walk(join(dir, entry.name), `${label}/`, files);
      continue;
    }
    if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) files.push(label);
  }
  return files;
}

/** Every code-line occurrence of a forbidden form, across every root. */
function scan(roots = SRC_ROOTS, base = REPO) {
  const hits = [];
  let scanned = 0;
  for (const root of roots) {
    for (const rel of walk(join(base, root), '', [])) {
      // The importer READS the legacy tables by name; it is the one
      // module whose whole job is the surface's removal, and its own
      // path contains the word.
      if (rel.includes('import-objectives')) continue;
      scanned += 1;
      const lines = readFileSync(join(base, root, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        for (const { id, re } of FORBIDDEN) {
          if (re.test(line))
            hits.push({ file: `${root}/${rel}`, line: i + 1, id, text: line.trim() });
        }
      });
    }
  }
  return { hits, scanned };
}

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway tree with one file, so a plant can be scanned in isolation. */
function plant(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'objectives-scan-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'pkg/src'), { recursive: true });
  writeFileSync(join(dir, 'pkg/src/thing.ts'), contents);
  return scan(['pkg/src'], dir);
}

describe('the objectives surface is gone', () => {
  it('appears nowhere in any package source', () => {
    const { hits } = scan();
    // Named, so a failure says WHICH file carries WHICH form rather
    // than "the property broke".
    expect(hits.map((h) => `${h.file}:${h.line} ${h.id} — ${h.text}`)).toEqual([]);
  });

  it('reaches the code it names: the scan finds the real packages', () => {
    // A scanner pointed at a mistyped path reports no violations just
    // as cheerfully as a clean tree. These two assertions separate
    // those, and they are the reason the roots are listed rather than
    // discovered.
    const { scanned } = scan();
    expect(scanned).toBeGreaterThan(200);
    for (const root of SRC_ROOTS) {
      const { scanned: n } = scan([root]);
      expect(n, `${root} contributed no files — is the path right?`).toBeGreaterThan(0);
    }
  });
});

describe('the scanner can fail — one planted occurrence per form', () => {
  it('finds a tool name', () => {
    const { hits } = plant("const t = { name: 'objectives_list' };\n");
    expect(hits.map((h) => h.id)).toEqual(['tool name']);
  });

  it('finds a route', () => {
    const { hits } = plant("await fetch('/objectives?status=active');\n");
    expect(hits.map((h) => h.id)).toEqual(['route']);
  });

  it('finds a permission leaf', () => {
    const { hits } = plant("if (p.includes('objectives.create')) grant();\n");
    expect(hits.map((h) => h.id)).toEqual(['permission leaf']);
  });

  it('finds all three at once, and reports each', () => {
    const { hits } = plant(
      ["const n = 'objectives_view';", "fetch('/objectives');", "check('objectives.watch');"].join(
        '\n',
      ),
    );
    expect(hits.map((h) => h.id).sort()).toEqual(['permission leaf', 'route', 'tool name']);
  });

  it('does NOT flag a comment — the exemption is deliberate, not a miss', () => {
    // Without this the comment exemption is indistinguishable from a
    // scanner that has quietly stopped matching. Paired with the four
    // above, which prove it still matches code.
    const { hits } = plant(
      [
        '/**',
        ' * The `/objectives/<id>/` namespace and `objectives.create` were',
        ' * removed; `objectives_list` went with them.',
        ' */',
        "// objectives_view is gone too, and '/objectives' with it",
        'export const x = 1;',
      ].join('\n'),
    );
    expect(hits).toEqual([]);
  });

  it('flags a live call on the line BELOW a comment about it', () => {
    // The nearest valid thing the exemption must still catch: an
    // explanation is fine, the call underneath it is not.
    const { hits } = plant(
      ['// this route was removed in the cut-over', "await fetch('/objectives');"].join('\n'),
    );
    expect(hits.map((h) => h.line)).toEqual([2]);
  });
});
