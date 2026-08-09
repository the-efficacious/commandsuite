/**
 * ONE WRITE PATH INTO THE ANNEX, held structurally.
 *
 * The curator's class-1 injection and the probe engine's arming both
 * hang off post-commit hooks on the append path. That arrangement is
 * only sound while there really is one path — a second write anywhere
 * in the server would be an event whose addressees are never told and
 * whose checks are never armed, and it would be INVISIBLE: the annex
 * would be perfectly correct, the event would be there, and the member
 * who needed to know would simply never hear. Silence has no error
 * message.
 *
 * WHAT THIS FILE USED TO DO, AND WHY IT STOPPED. Phase 3 grepped `src/`
 * for `.append(` on a list of plausible receiver names —
 * `spine|annex|store|annexStore|spineStore`. The verifier flagged it as
 * the condition of phase 4 for the reason the regex itself admits: the
 * failure it exists to catch is a NEW MODULE holding the store under a
 * NEW NAME, and an allowlist of names cannot see one. `this.writer`,
 * `deps.a`, or a destructured `{ append }` all walk straight past it.
 * The probe engine is that new module, so the heuristic had to go
 * before it landed.
 *
 * WHAT HOLDS IT NOW — two nets, and neither is a spelling.
 *
 *   THE COMPILER. `AnnexStore`, the type every consumer receives, has
 *   no `append`. `spine-boundary.test-d.ts` puts that in front of
 *   `tsc`. A new module cannot append by accident because the call does
 *   not typecheck, whatever it calls its variable.
 *
 *   THE IMPORT GRAPH, asserted below. A writer can also arrive as a
 *   parameter, which the compiler cannot trace, so the second net is
 *   about who can OBTAIN one: naming `AnnexWriter` or
 *   `createSqliteAnnexStore`. Those names appear in an import
 *   statement, which is fixed text in the importing file — an alias
 *   (`import { AnnexWriter as W }`) still contains the exported name —
 *   so the set of modules that can hold a writer is exactly the set
 *   this scan returns. One entry, and it is the write path itself.
 *
 * The two together are the property: you cannot call `append` without
 * the writer type, and you cannot reach the writer type without an
 * import this test reads.
 *
 * WHY A SCAN AT ALL, when the compiler does most of it. Because the
 * remaining hole is a parameter, and a behavioural test can only show
 * that the paths it happened to drive went through the hook. This is
 * checkable exhaustively, on every run, in milliseconds — and, like the
 * opaque-runner scanner beside it, it is tested in both directions.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * The two exported names that grant an append-capable annex, and the
 * only route to one. Kept as data rather than baked into a regex so a
 * third grant (there should never be one) is a one-line edit here and a
 * failing test everywhere else.
 */
const WRITE_GRANTS = ['AnnexWriter', 'createSqliteAnnexStore'] as const;

/**
 * The module allowed to hold a writer. The store defines it; the write
 * path is the single consumer, and it wraps it in the hooked surface
 * everything else receives.
 */
const ALLOWED = ['spine/append.ts', 'spine/store.ts'];

/**
 * Import statements, whole, including multi-line ones.
 *
 * Matching the STATEMENT rather than the bare name is what makes this
 * about the import graph instead of about prose: `AnnexWriter` written
 * in a comment (this file's own subject matter, and several of the
 * spine's headers) is not a grant, and a scan that counted it would
 * either be noisy or would train people to stop writing the comments.
 */
const IMPORT_STATEMENT = /^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?$/gm;

interface Hit {
  file: string;
  grant: string;
  statement: string;
}

/** Every `src/` module whose imports name a write grant. */
function scanImports(dir = SRC, prefix = ''): Hit[] {
  const hits: Hit[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const label = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      hits.push(...scanImports(join(dir, entry.name), `${label}/`));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    const source = readFileSync(join(dir, entry.name), 'utf8');
    for (const statement of source.match(IMPORT_STATEMENT) ?? []) {
      for (const grant of WRITE_GRANTS) {
        if (new RegExp(`\\b${grant}\\b`).test(statement)) {
          hits.push({ file: label, grant, statement: statement.trim() });
        }
      }
    }
  }
  return hits;
}

/**
 * Any `.append(` anywhere in `src/`, whatever the receiver.
 *
 * NO RECEIVER ALLOWLIST — that is the whole difference from what this
 * replaced, and it is why this is composed with the import scan rather
 * than used alone. Two things in this repo answer to `.append(`: the
 * annex writer (whose acquisition the import scan already fences) and
 * the hooked write path, which is the sanctioned way to write and which
 * the probe engine uses. A regex cannot tell them apart.
 *
 * So the property asserted is the COMPOSITION: every `.append(` call in
 * `src/` lives either in the two files allowed to hold a writer, or in
 * a file that imports no write grant at all — and a file that cannot
 * hold a writer can only be calling the hooked path. There is no third
 * possibility, which is what makes this exhaustive rather than
 * suggestive.
 */
const ANY_APPEND_CALL = /\.append\s*\(/;

function scanAppendCalls(dir = SRC, prefix = ''): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const label = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...scanAppendCalls(join(dir, entry.name), `${label}/`));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    const source = readFileSync(join(dir, entry.name), 'utf8');
    source.split('\n').forEach((text, i) => {
      if (ANY_APPEND_CALL.test(text)) out.push({ file: label, line: i + 1, text: text.trim() });
    });
  }
  return out;
}

describe('the annex has one write path, and the hooks are on it', () => {
  it('grants an append-capable annex to exactly one module', () => {
    const hits = scanImports();
    expect(
      [...new Set(hits.map((h) => h.file))].sort(),
      `a second module can obtain an annex writer: ${hits
        .map((h) => `${h.file} (${h.grant})`)
        .join(', ')}`,
    ).toEqual(['spine/append.ts']);
  });

  it('names both grants — neither route to a writer is unwatched', () => {
    // The assertion above passes just as happily if one of the two
    // names stopped being a grant (say `createSqliteAnnexStore` were
    // retyped to return the read surface and a third factory appeared).
    // Both have to be seen, from the one allowed module, for the set to
    // mean what it says.
    const grants = scanImports()
      .filter((h) => h.file === 'spine/append.ts')
      .map((h) => h.grant);
    expect(new Set(grants)).toEqual(new Set(WRITE_GRANTS));
  });

  it('every `.append(` is either in the two grant files or in a file with no grant', () => {
    const granted = new Set(scanImports().map((h) => h.file));
    const calls = scanAppendCalls().filter((c) => !ALLOWED.includes(c.file) && granted.has(c.file));
    expect(
      calls.map((c) => `${c.file}:${c.line}`),
      `a module that can hold an annex writer also calls append: ${calls
        .map((c) => `${c.file}:${c.line} — ${c.text}`)
        .join(' | ')}`,
    ).toEqual([]);
    // AND THE SCAN REACHED SOMETHING. The filter above returns an empty
    // list just as happily against a directory with no `.append(` in it
    // at all — including the day someone breaks the walk. The probe
    // engine's two calls are the ones that must be seen, because they
    // are the second writer this whole property exists for.
    const probeCalls = scanAppendCalls().filter((c) => c.file === 'spine/probes.ts');
    expect(
      probeCalls.length,
      'the probe engine writes through the hooked path; the scan must see those calls',
    ).toBeGreaterThanOrEqual(2);
  });

  it('runs the registered hooks on the one path, and the route awaits it', () => {
    // A single write path with no hooks on it satisfies everything
    // above just as happily. This is the half that makes it mean
    // something: the path dispatches to its hook list, and the append
    // route waits for that to finish before it answers.
    const path = readFileSync(join(SRC, 'spine/append.ts'), 'utf8');
    expect(path).toContain('for (const hook of this.hooks)');
    expect(path).toContain('await hook(result)');

    const app = readFileSync(join(SRC, 'app.ts'), 'utf8');
    expect(app).toContain('await spine.append(input, { actor: member.name })');
    expect(app, 'the curator must register itself on the write path').toContain(
      'spine.onAppend((result) => built.onAppend(result))',
    );
  });

  it('descends: a second write path one directory down cannot hide', () => {
    // The real tree has its only grant at `spine/append.ts`, so "does
    // the scan recurse" is invisible to the assertions above — a
    // mutation deleting the descent survived the whole suite last
    // phase. And the descent is exactly what phase 4 needed: the probe
    // engine arrives inside `src/spine/`, one directory down.
    const nested = mkdtempSync(join(tmpdir(), 'spine-append-scan-'));
    tmpDirs.push(nested);
    mkdirSync(join(nested, 'probes'));
    writeFileSync(join(nested, 'top.ts'), 'const x = 1;\n');
    writeFileSync(
      join(nested, 'probes', 'engine.ts'),
      "import { type AnnexWriter } from '../store.js';\nconst w: AnnexWriter = null as never;\n",
    );
    expect(scanImports(nested).map((h) => h.file)).toEqual(['probes/engine.ts']);
  });

  it('can fail: a planted grant is found, an aliased one is too, prose is not', () => {
    // The positive control on the scanner itself. Run before trusting
    // the negatives — a check that cannot pass is as broken as one that
    // cannot fail, and the tell is that both cases look alike.
    const planted = mkdtempSync(join(tmpdir(), 'spine-append-plant-'));
    tmpDirs.push(planted);
    writeFileSync(
      join(planted, 'sneaky.ts'),
      // Aliased on import: the local name is gone, the specifier is not.
      "import { createSqliteAnnexStore as build } from './spine/store.js';\nconst s = build(db);\n",
    );
    writeFileSync(
      join(planted, 'multiline.ts'),
      "import {\n  type AnnexWriter,\n  type AppendResult,\n} from './spine/store.js';\n",
    );
    writeFileSync(
      join(planted, 'prose.ts'),
      // The word in a comment and in a type position that came from
      // somewhere else. Neither is a grant, and a scanner that flagged
      // them would make the spine's headers unwritable.
      '/** Only `AnnexWriter` may append. */\nconst note = "createSqliteAnnexStore";\n',
    );
    const hits = scanImports(planted);
    expect(hits.map((h) => h.file).sort()).toEqual(['multiline.ts', 'sneaky.ts']);

    // And the `.append(` half, on receivers no allowlist would have had.
    expect(ANY_APPEND_CALL.test('const r = this.writer.append(evt, ctx);')).toBe(true);
    expect(ANY_APPEND_CALL.test('await engine.write.append(observation, ctx);')).toBe(true);
    expect(ANY_APPEND_CALL.test('const r = deps.a.append(evt, ctx);')).toBe(true);
    expect(ANY_APPEND_CALL.test('  append(input: AppendSpineEventRequest): AppendResult {')).toBe(
      false,
    );
  });
});
