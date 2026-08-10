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

import { InstructionsResponseSchema } from 'csuite-sdk/schemas';
import type { InstructionsResponse, ProcessDocument } from 'csuite-sdk/types';
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

function instructions(over: Partial<InstructionsResponse> = {}): InstructionsResponse {
  return {
    name: 'cora',
    role: { title: 'engineer', description: '' },
    permissions: [],
    instructions: 'your standing instructions',
    team: { name: 'demo', context: '', permissionPresets: {} },
    teammates: [],
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
    const composed = composeFixedContext(instructions());
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
    const composed = composeFixedContext(instructions({ processDocument: DOC }));
    expect(composed.startsWith('your standing instructions')).toBe(true);
    expect(composed).toContain('Squash-merge to main.');
  });

  /**
   * The two authorities stay two strings. A member authors
   * `instructions`; whoever holds `process.manage` authors the
   * document. They are concatenated for the agent and never merged in
   * the record — which is the durable reason for the separate field.
   * The 8192 cap that also motivated it has since been removed (#122,
   * in #129) and this reason is unaffected, which is the point of it
   * being the durable one.
   */
  it('keeps the document out of the instructions string itself', () => {
    const b = instructions({ processDocument: DOC });
    expect(b.instructions).not.toContain('Squash-merge');
  });
});

describe('a instructions with no authored instructions', () => {
  it('still renders the process block, without leading blank lines', () => {
    const composed = composeFixedContext(instructions({ instructions: '', processDocument: DOC }));
    expect(composed.startsWith('Team process')).toBe(true);
    expect(composed).toContain('Squash-merge to main.');
  });
});

// ─── three states must survive PARSING, not just rendering ───────────
//
// Found by Rune. The renderer distinguishes absent from null, but
// `InstructionsResponseSchema` used `.default(null)` — so an older broker
// that omits the field had it turned into `null` before the renderer
// ever saw it, and a new runner confidently told its member "this team
// has no process document" when the truth was "this broker has no
// opinion."
//
// A renderer-only test cannot catch that. These go through the schema.

describe('the three states survive the parse', () => {
  const base = {
    name: 'cora',
    role: { title: 'engineer', description: '' },
    permissions: [],
    instructions: 'standing instructions',
    team: { name: 'demo', context: '', permissionPresets: {} },
    teammates: [],
    toolSources: [],
  };

  it('keeps an OMITTED field distinguishable from an explicit null', () => {
    // Exactly what an older broker sends: the key is not there.
    const parsed = InstructionsResponseSchema.parse({ ...base });
    expect(parsed.processDocument).toBeUndefined();

    const rendered = composeFixedContext(parsed as InstructionsResponse);
    expect(rendered).toMatch(/unavailable/i);
    expect(rendered).toMatch(/does not report a process document/i);
    // And crucially NOT the healthy empty state.
    expect(rendered).not.toMatch(/no process document has been set/i);
  });

  it('renders an explicit null as "none has been set"', () => {
    const parsed = InstructionsResponseSchema.parse({ ...base, processDocument: null });
    expect(parsed.processDocument).toBeNull();
    const rendered = composeFixedContext(parsed as InstructionsResponse);
    expect(rendered).toMatch(/no process document has been set/i);
    expect(rendered).not.toMatch(/unavailable/i);
  });

  it('renders a document when one is present', () => {
    const parsed = InstructionsResponseSchema.parse({ ...base, processDocument: DOC });
    const rendered = composeFixedContext(parsed as InstructionsResponse);
    expect(rendered).toContain('Squash-merge to main.');
    expect(rendered).not.toMatch(/unavailable/i);
    expect(rendered).not.toMatch(/no process document has been set/i);
  });

  it('gives all three states different renderings', () => {
    const render = (o: object) =>
      composeFixedContext(InstructionsResponseSchema.parse(o) as InstructionsResponse);
    const absent = render({ ...base });
    const empty = render({ ...base, processDocument: null });
    const present = render({ ...base, processDocument: DOC });
    expect(new Set([absent, empty, present]).size).toBe(3);
  });
});
