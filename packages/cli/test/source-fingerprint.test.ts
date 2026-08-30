import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareCodeUnits, sourceFingerprint } from '../../../scripts/source-fingerprint.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  mkdirSync(join(root, 'apps', 'server', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'cli', 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"private":true}\n');
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(join(root, 'apps', 'server', 'package.json'), '{"name":"server"}\n');
  writeFileSync(join(root, 'apps', 'server', 'src', 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'packages', 'cli', 'package.json'), '{"name":"cli"}\n');
  writeFileSync(join(root, 'packages', 'cli', 'src', 'index.ts'), 'export const y = 2;\n');
  return root;
}

describe('sourceFingerprint', () => {
  it('orders paths by code units, independent of the host locale', () => {
    expect(['ä', 'z', 'A'].sort(compareCodeUnits)).toEqual(['A', 'z', 'ä']);
  });

  it('is deterministic across checkout paths and repeated builds', () => {
    const a = fixture('csuite-source-a-');
    const b = fixture('csuite-source-b-');
    expect(sourceFingerprint(a)).toBe(sourceFingerprint(a));
    expect(sourceFingerprint(a)).toBe(sourceFingerprint(b));
  });

  it('changes when a production source input changes', () => {
    const root = fixture('csuite-source-change-');
    const before = sourceFingerprint(root);
    writeFileSync(join(root, 'packages', 'cli', 'src', 'index.ts'), 'export const y = 3;\n');
    expect(sourceFingerprint(root)).not.toBe(before);
  });
});
