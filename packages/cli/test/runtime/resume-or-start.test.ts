/**
 * Bare `--resume` is the AGENT's decision, not the runner's. The runner
 * used to predict it from the filesystem (`~/.claude/projects/<slug>/`
 * for claude, the newest rollout in the sessions dir for codex) and
 * stamp the prediction onto session_start. Both probes are gone:
 * claude receives the SDK's `continue` and decides for itself (measured
 * with the bundled Claude Code 2.1.220: an empty HOME starts fresh, no
 * error — so no Restart=always loop either), and codex, which has no
 * native most-recent-thread resume, opens a new thread loudly. Explicit
 * ids stay strict on both. What the runner stamps is only what it
 * itself decided.
 */

import { ActivityEventSchema } from 'csuite-sdk/schemas';
import { describe, expect, it } from 'vitest';
import type { AgentSessionContext } from '../../src/runtime/agents/adapter.js';
import { createClaudeAdapter } from '../../src/runtime/agents/claude-agent.js';
import { resolveCodexResume } from '../../src/runtime/agents/codex/adapter.js';
import {
  createCodexAdapter,
  threadBannerLine,
} from '../../src/runtime/agents/codex/codex-agent.js';

// Neither plan reads the context any more — the whole point — so an
// empty object is the honest fixture: a plan that reached for `cwd` or
// the member name would throw here rather than quietly probe.
const NO_CONTEXT = {} as unknown as AgentSessionContext;

describe('codex --resume resolution (no sessions-dir probe)', () => {
  it('bare: starts a new thread, loudly — whatever is on disk', () => {
    expect(resolveCodexResume(true)).toEqual({ threadId: null, resumedFresh: true });
  });

  it('explicit id stays strict: passed through untouched', () => {
    expect(resolveCodexResume('0197c9e1-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toEqual({
      threadId: '0197c9e1-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      resumedFresh: false,
    });
  });

  it('no resume asked: fresh without the loud marker', () => {
    expect(resolveCodexResume(undefined)).toEqual({ threadId: null, resumedFresh: false });
  });
});

describe('initial resume plan — only what the runner decided is stamped', () => {
  it('claude: explicit id resumes, no flag starts fresh, bare --resume is undecided', () => {
    expect(createClaudeAdapter({ resume: 'sess-1' }).initialResumePlan?.(NO_CONTEXT)).toEqual({
      resumed: true,
    });
    expect(createClaudeAdapter({}).initialResumePlan?.(NO_CONTEXT)).toEqual({ resumed: false });
    // Undecided: the agent continues or starts fresh on its own, and
    // the session_start carries no verdict rather than a guess.
    expect(createClaudeAdapter({ resume: true }).initialResumePlan?.(NO_CONTEXT)).toBeNull();
  });

  it('codex: explicit id resumes, no flag starts fresh, bare --resume is a reasoned fresh start', () => {
    expect(createCodexAdapter({ resume: 'thread-1' }).initialResumePlan?.(NO_CONTEXT)).toEqual({
      resumed: true,
    });
    expect(createCodexAdapter({}).initialResumePlan?.(NO_CONTEXT)).toEqual({ resumed: false });
    const bare = createCodexAdapter({ resume: true }).initialResumePlan?.(NO_CONTEXT);
    expect(bare?.resumed).toBe(false);
    expect(bare?.reason).toMatch(/bare --resume/);
  });
});

describe('session_start resume fields (one schema, shared with obj-mtfxwvbk-j)', () => {
  it('parses with the typed cold-restart marker and without it (old runners, undecided starts)', () => {
    const base = { kind: 'session_start', ts: 1, runner: 'claude' };
    expect(
      ActivityEventSchema.parse({
        ...base,
        resumed: false,
        resumeReason: 'instructions changed',
      }),
    ).toMatchObject({ resumed: false, resumeReason: 'instructions changed' });
    expect(ActivityEventSchema.parse(base)).not.toHaveProperty('resumed');
  });
});

describe('codex thread banner tells the truth', () => {
  it('bare --resume never says (resumed) beside a fresh thread', () => {
    expect(threadBannerLine('01a05389-x', true, true)).not.toContain('(resumed)');
  });
  it('an explicit resume says (resumed) (positive control)', () => {
    expect(threadBannerLine('01a05389-x', '01a05389-x', false)).toContain('(resumed)');
  });
  it('a plain fresh start has no resume claim', () => {
    expect(threadBannerLine('01a05389-x', undefined, false)).not.toContain('(resumed)');
  });
});
