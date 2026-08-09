/**
 * ONE CALLER OF `AnnexStore.append`, and the curator hook hangs off it.
 *
 * The class-1 injection fires from a post-commit hook on the single
 * append route. That arrangement is only sound while the route really
 * is the single append path — a second caller anywhere in the server
 * would be a write whose addressees are never told, and it would be
 * invisible: the annex would be perfectly correct, the event would be
 * there, and the member who needed to know would simply never hear.
 * Silence has no error message.
 *
 * The next phase makes this live rather than theoretical. The probe
 * engine writes `observation` events, and a probe discharging a
 * `waiting_for` contract without telling its assignee is precisely the
 * failure class 1 exists to prevent. So the invariant is enforced
 * from outside now, before there is anything to break it.
 *
 * WHY A GREP. The property is about the SHAPE OF THE CALL GRAPH, and a
 * behavioural test can only show that the paths it happened to drive
 * went through the hook. This is checkable exhaustively, on every run,
 * in milliseconds — and, like the opaque-runner scanner beside it, it
 * is itself tested in both directions.
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
 * `<something>.append(` where `<something>` is a plausible annex
 * handle. Deliberately loose on the receiver name and tight on the
 * method: the failure mode is a new module holding the store under a
 * new name, so matching only the exact spelling `spine.append(` would
 * miss the case this exists for.
 */
const APPEND_CALL = /\b(spine|annex|store|annexStore|spineStore)\.append\s*\(/g;

interface Hit {
  file: string;
  line: number;
  text: string;
}

function scan(dir = SRC, prefix = ''): Hit[] {
  const hits: Hit[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const label = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      hits.push(...scan(join(dir, entry.name), `${label}/`));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    // The store's own file defines `append`; it is the callee, not a
    // caller, and excluding it by path keeps the rule readable.
    if (label === 'spine/store.ts') continue;
    const source = readFileSync(join(dir, entry.name), 'utf8');
    source.split('\n').forEach((text, i) => {
      APPEND_CALL.lastIndex = 0;
      if (APPEND_CALL.test(text)) hits.push({ file: label, line: i + 1, text: text.trim() });
    });
  }
  return hits;
}

describe('the annex has one append caller, and the curator hook is on it', () => {
  it('finds exactly one call site, in app.ts', () => {
    const hits = scan();
    // FILES, not line numbers. A line pin fails on every edit above it
    // and teaches people to update the number without reading why —
    // and the property is "one caller, and it is the route", which a
    // line number does not express any better than a filename does.
    // The `line` field is carried anyway so a failure can say where.
    expect(
      hits.map((h) => h.file),
      `a second annex write path appeared: ${hits.map((h) => `${h.file}:${h.line}`).join(', ')}`,
    ).toEqual(['app.ts']);
  });

  it('has the curator hook on that same call site', () => {
    // A single call site with no hook on it satisfies the test above
    // just as happily. This is the half that makes it mean something.
    const source = readFileSync(join(SRC, 'app.ts'), 'utf8');
    const call = source.indexOf('spine.append(');
    expect(call, 'the append call must exist to hang a hook off').toBeGreaterThan(0);
    const window = source.slice(call, call + 1600);
    expect(window).toContain('curator.onAppend(result)');
  });

  it('descends: a second write path one directory down cannot hide', () => {
    // The real tree has its only caller at the top level, so "does the
    // scan recurse" is invisible to the assertion above — a mutation
    // deleting the descent survived the whole suite. And the descent is
    // exactly what phase 4 needs: a probe engine arrives as
    // `src/spine/probes/…` or `src/probes/…`, one directory down, and
    // that is where the second append path will actually appear.
    const nested = mkdtempSync(join(tmpdir(), 'spine-append-scan-'));
    tmpDirs.push(nested);
    mkdirSync(join(nested, 'probes'));
    writeFileSync(join(nested, 'top.ts'), 'const x = 1;\n');
    writeFileSync(
      join(nested, 'probes', 'engine.ts'),
      "const result = spine.append(observation, { actor: 'probe:' + id });\n",
    );
    const hits = scan(nested);
    expect(hits.map((h) => h.file)).toEqual(['probes/engine.ts']);
  });

  it('can fail: a planted second caller is found, and a definition is not', () => {
    // The positive control on the scanner itself. Run before trusting
    // the negative one — a check that cannot pass is as broken as one
    // that cannot fail, and the tell is that both cases look alike.
    const planted = [
      'const result = spine.append(input, { actor: probe });',
      'const r = annexStore.append(evt, ctx);',
    ].filter((line) => {
      APPEND_CALL.lastIndex = 0;
      return APPEND_CALL.test(line);
    });
    expect(planted).toHaveLength(2);

    const notCalls = [
      '  append(input: AppendSpineEventRequest, ctx: AppendContext): AppendResult {',
    ];
    expect(
      notCalls.filter((line) => {
        APPEND_CALL.lastIndex = 0;
        return APPEND_CALL.test(line);
      }),
    ).toEqual([]);
  });
});
