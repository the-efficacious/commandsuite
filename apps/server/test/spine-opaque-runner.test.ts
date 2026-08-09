/**
 * THE OPAQUE-RUNNER PROPERTY: kill every ceiling signal and the spine
 * stays correct — only slower to re-orient.
 *
 * Correctness may depend only on the FLOOR: delivered messages, tool
 * calls routed through the bridge, session lifecycle. The ceiling —
 * captured traces, token counts, compaction hooks — is a vendor
 * accident. Both runners happen to ship full request bodies today;
 * nothing guarantees the next release does, and a spine whose
 * correctness varies by vendor release is not a spine. The human seat
 * has always been an opaque runner, so this is also just "one contract
 * for every member".
 *
 * WHY A GREP AND NOT A BEHAVIOURAL TEST. The property is about a
 * DEPENDENCY, and a behavioural test can only show that the paths it
 * happened to drive did not need the ceiling. An import is the thing
 * that would make the dependency possible in the first place, and it
 * is checkable exhaustively, on every run, in milliseconds — the
 * fixture-beats-field-observation case from CONTRIBUTING, exactly.
 *
 * The scanner below is itself under test, in both directions: it must
 * find the real imports in `src/spine/` (so it is not passing on an
 * empty read), and it must FLAG a planted forbidden import (so it is
 * not a check whose answer was fixed before it ran).
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

const SPINE_DIR = fileURLToPath(new URL('../src/spine/', import.meta.url));

/**
 * Modules the spine may not reach for. Every one of them is ceiling:
 * it exists because a runner chose to reveal something about its own
 * context, and no correctness property may rest on that choice.
 */
const CEILING = [
  'trace',
  'capture',
  'genai',
  'gen-ai',
  'telemetry',
  'otlp',
  'raw-body',
  'transcript',
  'rollout',
  'context-watchdog',
];

interface ScannedImport {
  file: string;
  specifier: string;
}

/** Every `from '…'` and `import('…')` specifier in a source string. */
function importsIn(file: string, source: string): ScannedImport[] {
  const out: ScannedImport[] = [];
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (specifier !== undefined) out.push({ file, specifier });
  }
  return out;
}

function ceilingImports(imports: readonly ScannedImport[]): ScannedImport[] {
  return imports.filter((imp) =>
    CEILING.some((banned) => imp.specifier.toLowerCase().includes(banned)),
  );
}

/**
 * RECURSIVE, because a flat `readdirSync` is a hiding place.
 *
 * The module was five files when this scanner was written and the
 * check passed on all five — and would have gone on passing the day
 * someone added `src/spine/curator/leases.ts` importing the trace
 * layer, because the scanner would never have opened the directory. A
 * property enforced on part of a module is not enforced. The curator
 * landed three files later, which is the case this anticipated: its
 * whole job is scheduling against runner lifecycle, so it is the most
 * likely thing in the repo to reach for a compaction hook.
 */
function scanSpine(dir = SPINE_DIR, prefix = ''): { files: string[]; imports: ScannedImport[] } {
  const files: string[] = [];
  const imports: ScannedImport[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const label = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      const nested = scanSpine(join(dir, entry.name), `${label}/`);
      files.push(...nested.files);
      imports.push(...nested.imports);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    files.push(label);
    imports.push(...importsIn(label, readFileSync(join(dir, entry.name), 'utf8')));
  }
  return { files, imports };
}

describe('the opaque-runner property', () => {
  it('the spine imports no trace, capture, telemetry or genai module', () => {
    const { imports } = scanSpine();
    // Named, so a failure says WHICH file reached for WHICH module
    // rather than "the property broke".
    expect(ceilingImports(imports).map((i) => `${i.file} -> ${i.specifier}`)).toEqual([]);
  });

  it('reaches the code it names: the scan finds the real module and its real imports', () => {
    const { files, imports } = scanSpine();
    // A scanner pointed at an empty directory reports no violations
    // just as cheerfully as a clean one. These two assertions are what
    // separate those.
    //
    // The exact list is deliberate rather than a count: a file added to
    // the spine fails this until someone updates it, which is the
    // moment to ask whether the new file belongs behind this property.
    expect(files.sort()).toEqual([
      'append.ts',
      'checks.ts',
      'curator-schema.ts',
      'curator-store.ts',
      'curator.ts',
      'egress.ts',
      'errors.ts',
      'index.ts',
      'probe-schema.ts',
      'probe-store.ts',
      'probes.ts',
      'schema.ts',
      'store.ts',
      'ulid.ts',
    ]);
    expect(imports.length).toBeGreaterThan(5);
    expect(imports.map((i) => i.specifier)).toContain('csuite-sdk/types');
  });

  it('descends: a file in a subdirectory cannot hide from the scan', () => {
    const nested = mkdtempSync(join(tmpdir(), 'spine-scan-'));
    tmpDirs.push(nested);
    mkdirSync(join(nested, 'curator'));
    writeFileSync(join(nested, 'top.ts'), "import { x } from '../db.js';\n");
    writeFileSync(
      join(nested, 'curator', 'leases.ts'),
      "import { readTrace } from '../../trace/transcript-reader.js';\n",
    );
    const { files, imports } = scanSpine(nested);
    expect(files.sort()).toEqual(['curator/leases.ts', 'top.ts']);
    // The whole point: the violation is one directory down, and the
    // flat scanner this replaces reported the tree clean.
    expect(ceilingImports(imports).map((i) => i.file)).toEqual(['curator/leases.ts']);
  });

  it('can fail: a planted ceiling import is flagged, and a floor import is not', () => {
    const planted = importsIn(
      'planted.ts',
      "import { readTrace } from '../trace/transcript-reader.js';\n" +
        "import type { DatabaseSyncInstance } from '../db.js';\n",
    );
    // The positive control for the check itself. Run before trusting
    // the negative one: a check that cannot pass is as broken as one
    // that cannot fail, and the tell is that both cases look alike.
    expect(ceilingImports(planted).map((i) => i.specifier)).toEqual([
      '../trace/transcript-reader.js',
    ]);
  });
});
