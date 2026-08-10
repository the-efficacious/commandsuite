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
 * off the objectives namespace, the `obj:` owner arm the SDK schema
 * keeps for rows still in deployed databases, the class of defect a
 * tool description once carried. Those sentences are the record of a
 * decision and deleting them to satisfy a grep would trade a real
 * explanation for a green check. So the scan reads CODE.
 *
 * IT STRIPS COMMENTS RATHER THAN SKIPPING COMMENT-LOOKING LINES, and
 * the difference was a hole that got measured rather than reasoned
 * about. The first version asked whether a line STARTED with `//`, `*`
 * or `/*`. A tool description is a multi-line template literal, and a
 * continuation line inside one very often starts with `*` — a markdown
 * bullet. So a tool name planted inside a template literal, on a line
 * beginning with `*`, scored ZERO hits: exactly the "tool name in a
 * description string" case this exists to catch, exempted for looking
 * like prose. The same shape mis-fired the other way too, flagging a
 * trailing comment written after real code.
 *
 * So it tracks block comments, line comments, strings and template
 * literals, and blanks out only what is genuinely a comment. Both
 * directions have fixtures below.
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
 * Blank out every comment, leaving code and its line structure intact.
 *
 * One pass tracking the four states that decide whether a `//` or a
 * `/*` opens a comment at all: inside a string, inside a template
 * literal, inside a line comment, inside a block comment. Comment
 * characters become spaces rather than vanishing, so line numbers
 * still point where a reader expects.
 *
 * Regex literals are NOT tracked, and that is the one known gap. A
 * quote character inside a regex could desynchronise the string state
 * — and the failure direction is a FALSE POSITIVE (code read as
 * string, or a comment read as code), which is noisy and visible,
 * rather than a false negative, which is silent. That is the right way
 * round for a guard.
 */
function stripComments(source) {
  let out = '';
  let state = 'code';
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i++;
      } else if (c === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i++;
      } else if (c === "'" || c === '"' || c === '`') {
        state = c === '`' ? 'template' : 'string';
        quote = c;
        out += c;
      } else {
        out += c;
      }
    } else if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      } else out += ' ';
    } else if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i++;
      } else out += c === '\n' ? c : ' ';
    } else {
      out += c;
      if (c === '\\') {
        out += source[i + 1] ?? '';
        i++;
      } else if (c === quote) {
        state = 'code';
        quote = '';
      }
    }
  }
  return out;
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
      scanned += 1;
      // NO FILE IS EXEMPT. An earlier version skipped the importer,
      // whose own path contains the word — removed after measuring
      // that the scan is clean without the exemption. It bought
      // nothing and blinded a whole module permanently, which is a
      // standing invitation for the surface to come back inside the
      // one file nobody is watching.
      const lines = stripComments(readFileSync(join(base, root, rel), 'utf8')).split('\n');
      lines.forEach((line, i) => {
        for (const { id, re } of FORBIDDEN) {
          if (re.test(line)) {
            hits.push({ file: `${root}/${rel}`, line: i + 1, id, text: line.trim() });
          }
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

  it('finds a tool name inside a TEMPLATE LITERAL, on a line that looks like prose', () => {
    // THE HOLE THAT WAS MEASURED. A tool description is a multi-line
    // template literal and its continuation lines routinely start with
    // `*` — a markdown bullet. The line-based comment test exempted
    // them, so a tool name in a description string — the single case
    // this scanner exists for — scored zero hits.
    const { hits } = plant(
      [
        'export const tool = {',
        '  description: `Your current plate.',
        '',
        '   * call objectives_list to see it',
        '   * it is cheap',
        '  `,',
        '};',
      ].join('\n'),
    );
    expect(hits.map((h) => h.id)).toEqual(['tool name']);
    expect(hits[0]?.line, 'and it points at the right line').toBe(4);
  });

  it('does NOT flag a trailing comment written after real code', () => {
    // The other direction of the same defect: the line-based version
    // flagged this, because the line does not START with a comment
    // marker. A false positive trains people to widen the exemption.
    const { hits } = plant('export const x = 1; // objectives_list is gone\n');
    expect(hits).toEqual([]);
  });

  it('scans the importer too — no file is exempt', () => {
    // The file exemption was removed after measuring that the real
    // scan is clean without it. A permanently blinded module is a
    // standing invitation for the surface to come back inside the one
    // file nobody is watching.
    const dir = mkdtempSync(join(tmpdir(), 'objectives-scan-'));
    tmpDirs.push(dir);
    mkdirSync(join(dir, 'pkg/src/spine'), { recursive: true });
    writeFileSync(
      join(dir, 'pkg/src/spine/import-objectives.ts'),
      "const t = 'objectives_list';\n",
    );
    const { hits } = scan(['pkg/src'], dir);
    expect(hits.map((h) => h.id)).toEqual(['tool name']);
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
