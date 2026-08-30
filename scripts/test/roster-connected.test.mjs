import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../roster-connected.mjs');

function check(connected) {
  return spawnSync(process.execPath, [SCRIPT, 'builder'], {
    input: JSON.stringify({ connected }),
    encoding: 'utf8',
  });
}

describe('bootstrap roster readiness', () => {
  it('refuses a disconnected row regardless of adjacent human fields', () => {
    expect(
      check([{ name: 'builder', connected: 0, auth: 'ok', title: 'stub runner' }]).status,
    ).toBe(1);
  });

  it('accepts only the named member with connected >= 1', () => {
    expect(
      check([
        { name: 'other', connected: 2 },
        { name: 'builder', connected: 1 },
      ]).status,
    ).toBe(0);
    expect(check([{ name: 'other', connected: 2 }]).status).toBe(1);
  });

  it('fails causally on malformed input', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'builder'], {
      input: 'not json',
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid roster response');
  });
});
