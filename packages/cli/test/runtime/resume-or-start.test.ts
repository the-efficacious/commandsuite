/**
 * Bare `--resume` is resume-or-start (obj-mtfvz379-i's acceptance
 * finding): a fresh member under Restart=always must not loop on a
 * deterministic "nothing to resume" error — it starts fresh, loudly,
 * with `resumed: false` and a reason typed onto session_start.
 * Explicit ids stay strict. The cold no-session Codex case is the one
 * the stub-verb CI structurally could not expose.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityEventSchema } from 'csuite-sdk/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { hasClaudeSessionFor } from '../../src/runtime/agents/claude.js';
import { resolveCodexResume } from '../../src/runtime/agents/codex/adapter.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'csuite-resume-'));
  dirs.push(dir);
  return dir;
}

describe('codex bare --resume (resume-or-start)', () => {
  it('cold: an empty sessions dir starts fresh instead of throwing', () => {
    const resolved = resolveCodexResume(true, join(tmp(), 'does-not-even-exist'));
    expect(resolved).toEqual({ threadId: null, resumedFresh: true });
  });

  it('warm: the newest rollout resumes (positive control)', () => {
    const dir = tmp();
    writeFileSync(
      join(dir, 'rollout-2026-08-30T10-00-00-0197c9e1-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl'),
      '',
    );
    const resolved = resolveCodexResume(true, dir);
    expect(resolved.resumedFresh).toBe(false);
    expect(resolved.threadId).toBeTruthy();
  });

  it('explicit id stays strict: passed through untouched even when nothing exists', () => {
    const resolved = resolveCodexResume('0197c9e1-bbbb-4bbb-8bbb-bbbbbbbbbbbb', tmp());
    expect(resolved).toEqual({
      threadId: '0197c9e1-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      resumedFresh: false,
    });
  });

  it('no resume asked: fresh without the fallback marker', () => {
    expect(resolveCodexResume(undefined, tmp())).toEqual({ threadId: null, resumedFresh: false });
  });
});

describe('claude session detection (bare --resume fallback)', () => {
  it('finds a session only when a .jsonl exists under the cwd slug', () => {
    const home = tmp();
    const cwd = '/work/my.app';
    const slugDir = join(home, '.claude', 'projects', '-work-my-app');
    expect(hasClaudeSessionFor(cwd, home)).toBe(false);
    mkdirSync(slugDir, { recursive: true });
    expect(hasClaudeSessionFor(cwd, home)).toBe(false);
    writeFileSync(join(slugDir, 'not-a-session.txt'), '');
    expect(hasClaudeSessionFor(cwd, home)).toBe(false);
    writeFileSync(join(slugDir, 'aaaa.jsonl'), '');
    expect(hasClaudeSessionFor(cwd, home)).toBe(true);
  });
});

describe('session_start resume fields (one schema, shared with obj-mtfxwvbk-j)', () => {
  it('parses with the typed fallback marker and without it (old runners)', () => {
    const base = { kind: 'session_start', ts: 1, runner: 'codex' };
    expect(
      ActivityEventSchema.parse({
        ...base,
        resumed: false,
        resumeReason: 'no previous codex session found',
      }),
    ).toMatchObject({ resumed: false });
    expect(ActivityEventSchema.parse(base)).not.toHaveProperty('resumed');
  });
});
