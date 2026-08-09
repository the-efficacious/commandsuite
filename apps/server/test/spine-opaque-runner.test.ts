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

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

function scanSpine(): { files: string[]; imports: ScannedImport[] } {
  const files = readdirSync(SPINE_DIR).filter((f) => f.endsWith('.ts'));
  const imports = files.flatMap((f) => importsIn(f, readFileSync(join(SPINE_DIR, f), 'utf8')));
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
    expect(files.sort()).toEqual(['errors.ts', 'index.ts', 'schema.ts', 'store.ts', 'ulid.ts']);
    expect(imports.length).toBeGreaterThan(5);
    expect(imports.map((i) => i.specifier)).toContain('csuite-sdk/types');
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
