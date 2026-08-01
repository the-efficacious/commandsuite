/**
 * What the runner actually hands the agent.
 *
 * The load-bearing case here is the EMPTY one. Rendering nothing when
 * no document exists collapses three states a member cannot then tell
 * apart:
 *
 *   no document has been written        member sees nothing
 *   runner too old to read the field    member sees nothing
 *   broker without the feature          member sees nothing
 *
 * The middle one is the silent-degradation case, so rendering nothing
 * makes the healthy state wear the costume of the broken one. One line
 * separates them, and that line is what these tests pin.
 */

import type { BriefingResponse, ProcessDocument } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import {
  composeFixedContext,
  renderProcessDocumentBlock,
} from '../../src/runtime/fixed-context.js';

const DOC: ProcessDocument = {
  text: 'Keep a conversation running before action.\nSquash-merge to main.',
  version: 3,
  createdBy: 'AndrewJon',
  createdAt: 1_700_000_000_000,
  updatedBy: 'Lea',
  updatedAt: 1_700_000_100_000,
};

function briefing(over: Partial<BriefingResponse> = {}): BriefingResponse {
  return {
    name: 'cora',
    role: { title: 'engineer', description: '' },
    permissions: [],
    instructions: 'your standing instructions',
    team: { name: 'demo', context: '', permissionPresets: {} },
    teammates: [],
    openObjectives: [],
    toolSources: [],
    processDocument: null,
    ...over,
  };
}

describe('no document is rendered as a state, not as silence', () => {
  it('says so explicitly rather than returning nothing', () => {
    const block = renderProcessDocumentBlock(null);
    expect(block).not.toBe('');
    expect(block).toMatch(/no process document has been set/i);
  });

  it('reaches the agent, so absence is distinguishable from a field it cannot read', () => {
    const composed = composeFixedContext(briefing());
    expect(composed).toContain('your standing instructions');
    expect(composed).toMatch(/no process document has been set/i);
  });
});

describe('a document is rendered as current state', () => {
  it('carries the text, the version, and who last edited it', () => {
    const block = renderProcessDocumentBlock(DOC);
    expect(block).toContain('Squash-merge to main.');
    // The version is what lets a member who saw v2 tell this is v3
    // without diffing prose.
    expect(block).toContain('v3');
    expect(block).toContain('Lea');
  });

  it('tells the reader it is amended in place, so they ask for history', () => {
    const block = renderProcessDocumentBlock(DOC);
    expect(block).toMatch(/current state/i);
    expect(block).toMatch(/history/i);
  });

  it('carries no superseded text — history is retrieved, not resident', () => {
    // The renderer only ever sees the current document; there is no
    // path by which prior text could reach the agent's context.
    const block = renderProcessDocumentBlock(DOC);
    expect(block).not.toContain('Merge commits');
    expect(block.length).toBeLessThan(DOC.text.length + 300);
  });

  it('appends to the instructions rather than replacing them', () => {
    const composed = composeFixedContext(briefing({ processDocument: DOC }));
    expect(composed.startsWith('your standing instructions')).toBe(true);
    expect(composed).toContain('Squash-merge to main.');
  });

  /**
   * The two authorities stay two strings. A member authors
   * `instructions`; whoever holds `process.manage` authors the
   * document. They are concatenated for the agent and never merged in
   * the record — which is the durable reason for the separate field,
   * outliving the 8192 cap that also motivates it today.
   */
  it('keeps the document out of the instructions string itself', () => {
    const b = briefing({ processDocument: DOC });
    expect(b.instructions).not.toContain('Squash-merge');
  });
});

describe('a briefing with no authored instructions', () => {
  it('still renders the process block, without leading blank lines', () => {
    const composed = composeFixedContext(briefing({ instructions: '', processDocument: DOC }));
    expect(composed.startsWith('Team process')).toBe(true);
    expect(composed).toContain('Squash-merge to main.');
  });
});
