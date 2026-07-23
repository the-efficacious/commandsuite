/**
 * `computeInjectedClaudeArgs` tests.
 *
 * The runner auto-injects three flags into every claude invocation
 * unless the user passed them already:
 *
 *   --dangerously-skip-permissions
 *   --dangerously-load-development-channels server:csuite
 *   --append-system-prompt <briefing>
 *
 * The append-system-prompt one carries the most user-visible weight
 * because it's how role + personal instructions get pinned into
 * claude's system prompt for the whole session. Editing instructions
 * in the web UI without rerunning the agent is a common source of
 * "why didn't the change land?" confusion, so we lock down the
 * injection rules here.
 */

import { describe, expect, it } from 'vitest';
import { computeInjectedClaudeArgs } from '../../src/commands/claude.js';

const BRIEFING = 'You are scout, the team scout. Pin this guidance.';

describe('computeInjectedClaudeArgs — defaults (no user flags)', () => {
  it('injects all three flags when the user passed nothing', () => {
    const out = computeInjectedClaudeArgs([], BRIEFING);
    expect(out.injected).toEqual([
      '--dangerously-skip-permissions',
      '--dangerously-load-development-channels',
      'server:csuite',
      '--append-system-prompt',
      BRIEFING,
    ]);
  });

  it('summarizes the briefing as `<csuite briefing, N chars>` rather than dumping prose', () => {
    const out = computeInjectedClaudeArgs([], BRIEFING);
    expect(out.summary).toEqual([
      '--dangerously-skip-permissions',
      '--dangerously-load-development-channels server:csuite',
      `--append-system-prompt <csuite briefing, ${BRIEFING.length} chars>`,
    ]);
  });

  it('places injected flags before the user args in `final`', () => {
    const out = computeInjectedClaudeArgs(['--model', 'opus'], BRIEFING);
    expect(out.final).toEqual([
      '--dangerously-skip-permissions',
      '--dangerously-load-development-channels',
      'server:csuite',
      '--append-system-prompt',
      BRIEFING,
      '--model',
      'opus',
    ]);
  });
});

describe('computeInjectedClaudeArgs — user-supplied flags suppress injection', () => {
  it('does not re-inject --dangerously-skip-permissions', () => {
    const out = computeInjectedClaudeArgs(['--dangerously-skip-permissions'], BRIEFING);
    expect(out.injected).not.toContain('--dangerously-skip-permissions');
    expect(out.summary).not.toContain('--dangerously-skip-permissions');
    // Other auto-injects still happen.
    expect(out.injected).toContain('--dangerously-load-development-channels');
    expect(out.injected).toContain('--append-system-prompt');
  });

  it('does not re-inject --dangerously-load-development-channels', () => {
    const out = computeInjectedClaudeArgs(
      ['--dangerously-load-development-channels', 'server:other'],
      BRIEFING,
    );
    expect(out.injected).not.toContain('--dangerously-load-development-channels');
    expect(out.injected).toContain('--dangerously-skip-permissions');
    expect(out.injected).toContain('--append-system-prompt');
  });

  it('does not re-inject --append-system-prompt when the user provided their own', () => {
    const out = computeInjectedClaudeArgs(['--append-system-prompt', 'my own prompt'], BRIEFING);
    expect(out.injected).not.toContain('--append-system-prompt');
    expect(out.injected).not.toContain(BRIEFING);
    expect(out.summary.find((s) => s.startsWith('--append-system-prompt'))).toBeUndefined();
    // User's value survives in final args.
    expect(out.final).toContain('my own prompt');
  });

  it('preserves the user-supplied tail verbatim', () => {
    const userArgs = [
      '--dangerously-skip-permissions',
      '--model',
      'opus',
      '--continue',
      'session-42',
    ];
    const out = computeInjectedClaudeArgs(userArgs, BRIEFING);
    expect(out.final.slice(out.injected.length)).toEqual(userArgs);
  });

  it('injects nothing when the user passed all three flags', () => {
    const out = computeInjectedClaudeArgs(
      [
        '--dangerously-skip-permissions',
        '--dangerously-load-development-channels',
        'server:csuite',
        '--append-system-prompt',
        'mine',
      ],
      BRIEFING,
    );
    expect(out.injected).toEqual([]);
    expect(out.summary).toEqual([]);
  });
});

describe('computeInjectedClaudeArgs — empty briefing', () => {
  it('skips --append-system-prompt when the briefing is empty', () => {
    const out = computeInjectedClaudeArgs([], '');
    expect(out.injected).not.toContain('--append-system-prompt');
    expect(out.summary.find((s) => s.startsWith('--append-system-prompt'))).toBeUndefined();
    // The other two flags still inject.
    expect(out.injected).toContain('--dangerously-skip-permissions');
    expect(out.injected).toContain('--dangerously-load-development-channels');
  });

  it('still echoes user args even when nothing else is injected', () => {
    const out = computeInjectedClaudeArgs(
      [
        '--dangerously-skip-permissions',
        '--dangerously-load-development-channels',
        'server:csuite',
      ],
      '',
    );
    expect(out.injected).toEqual([]);
    expect(out.final).toEqual([
      '--dangerously-skip-permissions',
      '--dangerously-load-development-channels',
      'server:csuite',
    ]);
  });
});

describe('computeInjectedClaudeArgs — briefing char-count summary stays accurate', () => {
  it('reflects the actual briefing length in the banner summary', () => {
    const long = 'x'.repeat(8192);
    const out = computeInjectedClaudeArgs([], long);
    expect(out.summary).toContain('--append-system-prompt <csuite briefing, 8192 chars>');
  });
});
