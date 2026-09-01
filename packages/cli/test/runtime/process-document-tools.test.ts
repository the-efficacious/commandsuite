/**
 * The agent-facing surface for the process document.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE HTTP TESTS. The routes are
 * tested against `fetch`, which proves a human with a session cookie
 * can edit the document. It proves nothing about the member who
 * actually holds `process.manage` on a team like this one — an agent,
 * reaching the broker through MCP. A capability that is human-only by
 * accident of where it was built is the standing failure mode here.
 *
 * The description assertions are not decoration. A tool description is
 * the only specification an agent has for a tool it cannot read, and
 * the two things it must carry here are that the write REPLACES the
 * document and that the change reaches teammates at their next runner
 * start rather than immediately.
 */

import type { Client as BrokerClient } from 'csuite-sdk/client';
import type { InstructionsResponse, ProcessDocument, ProcessDocumentEdit } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { defineTools, handleToolCall } from '../../src/runtime/tools.js';

const PACKET: InstructionsResponse = {
  name: 'scout',
  role: { title: 'engineer', description: '' },
  permissions: [],
  instructions: '',
  team: { name: 'demo', context: '', permissionPresets: {} },
  teammates: [],
  openObjectives: [],
  toolSources: [],
  processDocument: null,
};

/** The same member, holding the edit authority. */
const AUTHORITY: InstructionsResponse = { ...PACKET, permissions: ['process.manage'] };

function makeBroker(overrides: Partial<BrokerClient> = {}): BrokerClient {
  return overrides as BrokerClient;
}

function getCallText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected text content');
  }
  return first.text;
}

const DOC: ProcessDocument = {
  text: 'Squash-merge to main.',
  version: 2,
  createdBy: 'AndrewJon',
  createdAt: 1,
  updatedBy: 'Lea',
  updatedAt: 2,
};

// ─── the gate ────────────────────────────────────────────────────────

describe('the write tool is gated on process.manage', () => {
  it('offers the read tools to a member with no permissions at all', () => {
    const names = defineTools(PACKET).map((t) => t.name);
    expect(names).toContain('process_document_get');
    expect(names).toContain('process_document_history');
  });

  it('withholds the write tool from a member without the leaf', () => {
    expect(defineTools(PACKET).map((t) => t.name)).not.toContain('process_document_write');
  });

  /**
   * The reason the leaf exists. `objectives.create` was the
   * predecessor's gate; holding it must not carry this authority.
   */
  it('withholds it from a holder of objectives.create', () => {
    const other: InstructionsResponse = {
      ...PACKET,
      permissions: ['objectives.create', 'members.manage', 'team.manage'],
    };
    expect(defineTools(other).map((t) => t.name)).not.toContain('process_document_write');
  });

  it('offers it to the holder of process.manage', () => {
    expect(defineTools(AUTHORITY).map((t) => t.name)).toContain('process_document_write');
  });
});

// ─── descriptions are the specification ──────────────────────────────

describe('the write description carries the two things an agent will otherwise get wrong', () => {
  const write = () => defineTools(AUTHORITY).find((t) => t.name === 'process_document_write');

  it('says the text REPLACES the document, and says to read it first', () => {
    // The expensive mistake: sending a paragraph and deleting the
    // rest of the team's process.
    expect(write()?.description).toMatch(/REPLACES the document/);
    expect(write()?.description).toMatch(/read it first/i);
    const props = write()?.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.text?.description).toMatch(/REPLACES the current text/);
    expect(props.text?.description).toMatch(/Not a patch/i);
  });

  it('states the delivery bound rather than implying the edit is live everywhere', () => {
    expect(write()?.description).toMatch(/next idle boundary/);
    // The restart is cold, and the description must say so: an agent
    // told its conversation survives the swap would plan around it.
    expect(write()?.description).toMatch(/restarts its agent cold/);
    expect(write()?.description).toMatch(/does not resume the prior conversation/);
    expect(write()?.description).not.toMatch(/resumes the same conversation/);
    expect(write()?.description).toMatch(/restart-pending/);
  });

  it('states the writer permission and retained history fields', () => {
    expect(write()?.description).toMatch(/Requires `process\.manage`/);
    expect(write()?.description).toMatch(/prior text, editor, reason, and disposition/);
  });

  it('explains both dispositions and what each binds', () => {
    const props = write()?.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.disposition?.description).toMatch(/retroactive/i);
    expect(props.disposition?.description).toMatch(/forward-only/i);
  });

  it('tells the reader that get is not how they learn what binds them', () => {
    const get = defineTools(PACKET).find((t) => t.name === 'process_document_get');
    expect(get?.description).toMatch(/already in your fixed context/i);
    // And that null is a state rather than a permission problem.
    expect(get?.description).toMatch(/not that you cannot see it/i);
  });
});

// ─── handlers ────────────────────────────────────────────────────────

describe('process_document_get', () => {
  it('distinguishes "nobody has written one" from an error', async () => {
    const broker = makeBroker({ getProcessDocument: async () => null });
    const text = getCallText(await handleToolCall('process_document_get', {}, broker, PACKET));
    expect(text).toMatch(/no process document has been set/i);
    expect(text).toMatch(/real state, not an error/i);
  });

  it('reports the version and both authors alongside the text', async () => {
    const broker = makeBroker({ getProcessDocument: async () => DOC });
    const text = getCallText(await handleToolCall('process_document_get', {}, broker, PACKET));
    expect(text).toMatch(/v2/);
    expect(text).toMatch(/last edited by Lea/);
    expect(text).toMatch(/Created by AndrewJon/);
    expect(text).toContain('Squash-merge to main.');
  });
});

describe('process_document_history', () => {
  const edit = (over: Partial<ProcessDocumentEdit> = {}): ProcessDocumentEdit => ({
    version: 2,
    ts: 2,
    actor: 'Lea',
    reason: 'the team moved to merge commits',
    disposition: 'scope_change',
    fields: ['text'],
    previous: { text: 'Squash-merge to main.' },
    ...over,
  });

  it('marks creation as having no prior text rather than showing an empty one', async () => {
    const broker = makeBroker({
      processDocumentHistory: async () => [
        edit({ version: 1, actor: 'AndrewJon', previous: {} }),
        edit(),
      ],
    });
    const text = getCallText(await handleToolCall('process_document_history', {}, broker, PACKET));
    expect(text).toMatch(/created — no prior text/);
    expect(text).toMatch(/v2 by Lea/);
    expect(text).toMatch(/work already underway finished under the prior text/);
  });

  /**
   * The content assertion, not a wording one.
   *
   * This tool IS the fetch — there is no fetch-by-version — so an
   * agent holding `process.manage` can only see what changed if the
   * prior text appears in what the tool actually prints. An earlier
   * version rendered a character count instead, and the test above
   * passed on that loss because it asserted the surrounding wording.
   * Assert the bytes.
   */
  it('prints the FULL prior text, which is the whole point of the fetch', async () => {
    const priorText = 'Squash-merge to main.\nEscalate patches to AndrewJon.';
    const broker = makeBroker({
      processDocumentHistory: async () => [edit({ version: 2, previous: { text: priorText } })],
    });
    const text = getCallText(await handleToolCall('process_document_history', {}, broker, PACKET));
    // Every line of the superseded document, verbatim.
    for (const line of priorText.split('\n')) {
      expect(text).toContain(line);
    }
    // And delimited, so a reader can tell where the old text ends.
    expect(text).toMatch(/text before v2/);
    expect(text).toMatch(/end text before v2/);
  });

  it('says there is no history when no document has been set', async () => {
    const broker = makeBroker({ processDocumentHistory: async () => [] });
    const text = getCallText(await handleToolCall('process_document_history', {}, broker, PACKET));
    expect(text).toMatch(/no process document has been set/i);
  });
});

describe('process_document_write', () => {
  it('reports creation and edit differently, and never announces', async () => {
    const announced: unknown[] = [];
    const broker = makeBroker({
      push: async (payload: unknown) => {
        announced.push(payload);
        return {} as never;
      },
      writeProcessDocument: async () => ({
        document: { ...DOC, version: 1 },
        edit: {
          version: 1,
          ts: 1,
          actor: 'lea',
          reason: 'first',
          disposition: 'scope_change' as const,
          fields: ['text' as const],
          previous: {},
        },
      }),
    });
    const text = getCallText(
      await handleToolCall(
        'process_document_write',
        { text: 'x', reason: 'first', disposition: 'scope_change' },
        broker,
        AUTHORITY,
      ),
    );
    expect(text).toMatch(/created the process document at v1/);
    expect(text).toMatch(/History begins here/);
    expect(text).toMatch(/next idle boundary/);
    expect(text).toMatch(/restart their agents cold/);
    expect(text).toMatch(/not resuming the prior conversation/);
    expect(text).not.toMatch(/resume the same conversation/);
    expect(text).toMatch(/restart-pending/);
    expect(text).toMatch(/No broadcast is needed and none was sent/);

    // POSITIVE CONTROL, before the absence assertion. Prove the
    // observer fires by driving a real announcement through the same
    // broker — otherwise a misnamed stub passes this vacuously.
    await handleToolCall('broadcast', { body: 'a real announcement' }, broker, AUTHORITY);
    expect(announced).toHaveLength(1);
    const before = announced.length;
    await handleToolCall(
      'process_document_write',
      { text: 'y', reason: 'again', disposition: 'correction' },
      broker,
      AUTHORITY,
    );
    expect(announced).toHaveLength(before);
  });

  it('refuses an empty text with the reason a caller most needs to hear', async () => {
    const broker = makeBroker({
      writeProcessDocument: async () => {
        throw new Error('must not be called');
      },
    });
    const text = getCallText(
      await handleToolCall(
        'process_document_write',
        { reason: 'r', disposition: 'correction' },
        broker,
        AUTHORITY,
      ),
    );
    expect(text).toMatch(/REPLACES the whole document/);
    expect(text).toMatch(/process_document_get/);
  });

  it('refuses a disposition outside the two rather than defaulting', async () => {
    const broker = makeBroker({
      writeProcessDocument: async () => {
        throw new Error('must not be called');
      },
    });
    const text = getCallText(
      await handleToolCall(
        'process_document_write',
        { text: 'x', reason: 'r', disposition: 'whatever' },
        broker,
        AUTHORITY,
      ),
    );
    expect(text).toMatch(/`disposition` must be "correction".*"scope_change"/s);
  });
});
