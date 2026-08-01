/**
 * Fixed context — the block the runner hands the agent.
 *
 * The assertions that matter are about what a rule's rendering must
 * NOT let a reader conclude: that an uncontested proposal is a
 * director's instruction, that a disputed rule is settled, or that a
 * broker which sent no rules is one that could not send any.
 */

import type { BriefingResponse, ProcessRule } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { composeFixedContext, renderProcessRulesBlock } from '../../src/runtime/fixed-context.js';

function rule(over: Partial<ProcessRule>): ProcessRule {
  return {
    anchor: 'release-cadence',
    title: 'Release cadence',
    text: 'I can release patches mid sprint but minors end of sprint.',
    status: 'in_force',
    provenance: 'director',
    attribution: 'AndrewJon',
    disputeReason: null,
    version: 1,
    createdBy: 'lea',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('provenance is rendered, because it changes how a rule binds', () => {
  it('does not let an uncontested proposal read as a director instruction', () => {
    const block = renderProcessRulesBlock([
      rule({}),
      rule({
        anchor: 'conversation-scope',
        title: 'Scope',
        text: 'Anything creating an objective goes to the director first.',
        provenance: 'lead_uncontested',
        attribution: 'Lea',
      }),
    ]);
    if (block === null) throw new Error('expected a block');
    expect(block).toContain('stated by AndrewJon');
    expect(block).toContain('proposed by Lea and not contested');
    // The weaker one says it is weaker, in the same breath as the text.
    expect(block).toContain('weaker than adoption');
  });
});

describe('a disputed rule is never rendered as settled', () => {
  it('carries the dispute beside the text, not elsewhere', () => {
    const block = renderProcessRulesBlock([
      rule({
        anchor: 'merge-model',
        title: 'Who merges',
        text: 'Verifier merges; the director gates the release.',
        provenance: 'unattributed',
        attribution: null,
        status: 'disputed',
        disputeReason: 'Observed practice contradicts it; director to settle.',
      }),
    ]);
    if (block === null) throw new Error('expected a block');
    expect(block).toContain('DISPUTED');
    expect(block).toContain('director to settle');
    // Present, not omitted: hiding it conceals a rule people may follow.
    expect(block).toContain('Verifier merges');
  });

  it('retired rules are not rendered at all', () => {
    expect(renderProcessRulesBlock([rule({ status: 'retired' })])).toBeNull();
  });
});

describe('the anchor and version travel with the text', () => {
  it('lets a member tell v2 from v1 without diffing prose', () => {
    const block = renderProcessRulesBlock([rule({ version: 4 })]);
    expect(block).toContain('[release-cadence v4]');
  });
});

describe('no rules renders nothing, not an empty heading', () => {
  it('returns null rather than an empty section', () => {
    expect(renderProcessRulesBlock([])).toBeNull();
  });

  it('leaves the briefing untouched when there are no rules', () => {
    const briefing = {
      instructions: 'the briefing',
      processRules: [],
    } as unknown as BriefingResponse;
    expect(composeFixedContext(briefing)).toBe('the briefing');
  });

  it('appends after the briefing when there are rules', () => {
    const briefing = {
      instructions: 'the briefing',
      processRules: [rule({})],
    } as unknown as BriefingResponse;
    const out = composeFixedContext(briefing);
    expect(out.startsWith('the briefing')).toBe(true);
    expect(out).toContain('Release cadence');
  });

  it('tolerates a broker that predates process rules', () => {
    // An older broker sends no field at all. The runner must start and
    // simply carry no rules — the degraded case that exists precisely
    // so it is not the fatal one.
    const briefing = { instructions: 'the briefing' } as unknown as BriefingResponse;
    expect(composeFixedContext(briefing)).toBe('the briefing');
  });
});
