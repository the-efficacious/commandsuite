/**
 * Both-direction fixtures for the vocabulary check.
 *
 * The failure this file is built against is the one in the artifact this
 * check replaces: **an instrument only ever run in the
 * direction where it agrees with its author has been tested in no
 * directions.** A suite that only runs the checker against a clean tree
 * passes identically against a checker that exits 0 unconditionally.
 *
 * So the tree is rebuilt per case and each mutation is asserted to be
 * caught *by name*. A rejection that does not say which rule broke is one
 * people route around, and a suite that asserts only "it failed" cannot
 * tell a correct diagnosis from a coincidental one.
 *
 * The discrimination cases matter most. The check has to reject a second
 * enumeration of the leaves while accepting the several tables that name a
 * leaf as a cross-reference — the MCP toolbox, the runner overview, every
 * route in the REST reference. A rule that fails those would be routed
 * around within a week, and a rule that cannot see the difference is the
 * rule that produced three drifted tables in the first place.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const CHECKER = join(REPO, 'scripts/check-vocabulary.mjs');
const CANONICAL = 'docs/concepts/permissions.mdx';
const SOURCE = 'packages/sdk/src/types.ts';

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(root) {
  const r = spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A scratch tree carrying only what the checker reads, copied from the repo. */
function tree(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'vocab-'));
  made.push(root);
  const files = {
    [SOURCE]: readFileSync(join(REPO, SOURCE), 'utf8'),
    [CANONICAL]: readFileSync(join(REPO, CANONICAL), 'utf8'),
  };
  mutate(files);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** The leaves the checker will parse, so fixtures can use real names. */
function leaves() {
  const src = readFileSync(join(REPO, SOURCE), 'utf8');
  const body = src.slice(
    src.indexOf('export const PERMISSIONS = ['),
    src.indexOf('] as const', src.indexOf('export const PERMISSIONS = [')),
  );
  return [...body.matchAll(/^ {2}'([a-z_]+\.[a-z_]+)',$/gm)].map((m) => m[1]);
}

describe('check-vocabulary', () => {
  it('passes against the repository as it stands', () => {
    const { code, out } = run(REPO);
    expect(out).toContain('docs agree');
    expect(code).toBe(0);
  });

  it('names every leaf it parsed, so a broken parser cannot pass silently', () => {
    const { out } = run(REPO);
    expect(out).toContain(`${leaves().length} permission leaves`);
    expect(leaves().length).toBeGreaterThan(0);
  });

  it('rejects a leaf declared in the SDK but missing from the table', () => {
    const dropped = leaves().at(-1);
    const root = tree((f) => {
      f[CANONICAL] = f[CANONICAL]
        .split('\n')
        .filter((l) => !l.startsWith(`| \`${dropped}\``))
        .join('\n');
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain('[table]');
    expect(out).toContain(dropped);
  });

  it('rejects a table row for a leaf the SDK does not declare', () => {
    const root = tree((f) => {
      f[CANONICAL] += '\n| `objectives.retire` | Retire an objective. |\n';
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain('[table]');
    expect(out).toContain('objectives.retire');
  });

  it('rejects a second document that enumerates the leaves', () => {
    const rows = leaves()
      .slice(0, 6)
      .map((p) => `| \`${p}\` | something |`)
      .join('\n');
    const root = tree((f) => {
      f['docs/dev/rival.mdx'] =
        `---\ntitle: Rival\n---\n\n| Permission | What |\n|---|---|\n${rows}\n`;
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain('[enumeration]');
    expect(out).toContain('docs/dev/rival.mdx');
  });

  it('rejects a comma-run of leaves in prose', () => {
    const root = tree((f) => {
      f['docs/dev/rival.mdx'] = `---\ntitle: Rival\n---\n\nPass any of ${leaves()
        .slice(0, 6)
        .map((p) => `\`${p}\``)
        .join(', ')}.\n`;
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain('[enumeration]');
  });

  it('accepts a cross-reference table that names the leaf each tool requires', () => {
    // The discrimination that matters: this shape must keep working, or the
    // MCP toolbox and runner overview pages cannot say what they are for.
    const rows = leaves()
      .slice(0, 8)
      .map((p) => `| \`some_tool\` | Does a thing | \`${p}\` |`)
      .join('\n');
    const root = tree((f) => {
      f['docs/dev/toolbox.mdx'] =
        `---\ntitle: Toolbox\n---\n\n| Tool | What | Requires |\n|---|---|---|\n${rows}\n`;
    });
    const { code, out } = run(root);
    expect(out).not.toContain('[enumeration]');
    expect(code).toBe(0);
  });

  it('rejects prose that counts the leaves', () => {
    const root = tree((f) => {
      f['docs/dev/rival.mdx'] =
        '---\ntitle: Rival\n---\n\nThere are seventeen permission leaves in all.\n';
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain('[count]');
  });

  it('accepts "leaves" used as an ordinary verb', () => {
    // `docs/concepts/tool-sources.mdx` says "a redirect ... that leaves it
    // fails the call", and `docs/deployment.mdx` says "`KEEP=1` leaves the
    // stack running". Both carry a number in the same sentence.
    const root = tree((f) => {
      f['docs/dev/rival.mdx'] =
        '---\ntitle: Rival\n---\n\nA redirect within the origin is followed, and one that leaves it fails.\n\n`KEEP=1` leaves the 2 containers running.\n';
    });
    const { code, out } = run(root);
    expect(out).not.toContain('[count]');
    expect(code).toBe(0);
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const root = tree((f) => {
      f[CANONICAL] = f[CANONICAL]
        .split('\n')
        .filter((l) => !l.startsWith(`| \`${leaves().at(-1)}\``))
        .join('\n');
      f['docs/dev/rival.mdx'] =
        '---\ntitle: Rival\n---\n\nThere are seventeen permission leaves in all.\n';
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain('[table]');
    expect(out).toContain('[count]');
    expect(out).toMatch(/2 problem\(s\)/);
  });
});
