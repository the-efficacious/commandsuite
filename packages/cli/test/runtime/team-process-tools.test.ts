/**
 * The agent-facing surface for the process document.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE HTTP TESTS. The routes are
 * tested against `fetch`, which proves a human with a session cookie
 * can edit the document. It proves nothing about the member who
 * actually holds `team_process.manage` on a team like this one — an agent,
 * reaching the broker through MCP. A capability that is human-only by
 * accident of where it was built is the standing failure mode here.
 *
 * The description assertions are not decoration. A tool description is
 * the only specification an agent has for a tool it cannot read, and
 * the two things it must carry here are that the write REPLACES the
 * document and that the change reaches teammates at their next runner
 * start rather than immediately.
 */

import { createLogger, type LogRecord } from 'csuite-core';
import type { Client as BrokerClient } from 'csuite-sdk/client';
import type { InstructionsResponse, TeamProcess, TeamProcessEdit } from 'csuite-sdk/types';
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
  teamProcess: null,
};

/** The same member, holding the edit authority. */
const AUTHORITY: InstructionsResponse = { ...PACKET, permissions: ['team_process.manage'] };

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

const DOC: TeamProcess = {
  text: 'Squash-merge to main.',
  version: 2,
  createdBy: 'AndrewJon',
  createdAt: 1,
  updatedBy: 'Lea',
  updatedAt: 2,
};

// ─── the gate ────────────────────────────────────────────────────────

describe('the write tool is gated on team_process.manage', () => {
  it('offers the read tools to a member with no permissions at all', () => {
    const names = defineTools(PACKET).map((t) => t.name);
    expect(names).toContain('team_process_get');
    expect(names).toContain('team_process_history');
  });

  it('withholds the write tool from a member without the leaf', () => {
    expect(defineTools(PACKET).map((t) => t.name)).not.toContain('team_process_write');
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
    expect(defineTools(other).map((t) => t.name)).not.toContain('team_process_write');
  });

  it('offers it to the holder of team_process.manage', () => {
    expect(defineTools(AUTHORITY).map((t) => t.name)).toContain('team_process_write');
  });
});

// ─── descriptions are the specification ──────────────────────────────

describe('the write description carries the two things an agent will otherwise get wrong', () => {
  const write = () => defineTools(AUTHORITY).find((t) => t.name === 'team_process_write');

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
    expect(write()?.description).toMatch(/Requires `team_process\.manage`/);
    expect(write()?.description).toMatch(/prior text, editor, reason, and disposition/);
  });

  it('explains both dispositions and what each binds', () => {
    const props = write()?.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.disposition?.description).toMatch(/retroactive/i);
    expect(props.disposition?.description).toMatch(/forward-only/i);
  });

  it('tells the reader that get is not how they learn what binds them', () => {
    const get = defineTools(PACKET).find((t) => t.name === 'team_process_get');
    expect(get?.description).toMatch(/already in your fixed context/i);
    // And that null is a state rather than a permission problem.
    expect(get?.description).toMatch(/not that you cannot see it/i);
  });
});

// ─── handlers ────────────────────────────────────────────────────────

describe('team_process_get', () => {
  it('distinguishes "nobody has written one" from an error', async () => {
    const broker = makeBroker({ getTeamProcess: async () => null });
    const text = getCallText(await handleToolCall('team_process_get', {}, broker, PACKET));
    expect(text).toMatch(/no process document has been set/i);
    expect(text).toMatch(/real state, not an error/i);
  });

  it('reports the version and both authors alongside the text', async () => {
    const broker = makeBroker({ getTeamProcess: async () => DOC });
    const text = getCallText(await handleToolCall('team_process_get', {}, broker, PACKET));
    expect(text).toMatch(/v2/);
    expect(text).toMatch(/last edited by Lea/);
    expect(text).toMatch(/Created by AndrewJon/);
    expect(text).toContain('Squash-merge to main.');
  });
});

describe('team_process_history', () => {
  const edit = (over: Partial<TeamProcessEdit> = {}): TeamProcessEdit => ({
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
      teamProcessHistory: async () => [
        edit({ version: 1, actor: 'AndrewJon', previous: {} }),
        edit(),
      ],
    });
    const text = getCallText(await handleToolCall('team_process_history', {}, broker, PACKET));
    expect(text).toMatch(/created — no prior text/);
    expect(text).toMatch(/v2 by Lea/);
    expect(text).toMatch(/work already underway finished under the prior text/);
  });

  /**
   * The content assertion, not a wording one.
   *
   * This tool IS the fetch — there is no fetch-by-version — so an
   * agent holding `team_process.manage` can only see what changed if the
   * prior text appears in what the tool actually prints. An earlier
   * version rendered a character count instead, and the test above
   * passed on that loss because it asserted the surrounding wording.
   * Assert the bytes.
   */
  it('prints the FULL prior text, which is the whole point of the fetch', async () => {
    const priorText = 'Squash-merge to main.\nEscalate patches to AndrewJon.';
    const broker = makeBroker({
      teamProcessHistory: async () => [edit({ version: 2, previous: { text: priorText } })],
    });
    const text = getCallText(await handleToolCall('team_process_history', {}, broker, PACKET));
    // Every line of the superseded document, verbatim.
    for (const line of priorText.split('\n')) {
      expect(text).toContain(line);
    }
    // And delimited, so a reader can tell where the old text ends.
    expect(text).toMatch(/text before v2/);
    expect(text).toMatch(/end text before v2/);
  });

  it('says there is no history when no document has been set', async () => {
    const broker = makeBroker({ teamProcessHistory: async () => [] });
    const text = getCallText(await handleToolCall('team_process_history', {}, broker, PACKET));
    expect(text).toMatch(/no process document has been set/i);
  });
});

describe('team_process_write', () => {
  it('reports creation and edit differently, and never announces', async () => {
    const announced: unknown[] = [];
    const broker = makeBroker({
      push: async (payload: unknown) => {
        announced.push(payload);
        return {} as never;
      },
      writeTeamProcess: async () => ({
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
        'team_process_write',
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
      'team_process_write',
      { text: 'y', reason: 'again', disposition: 'correction' },
      broker,
      AUTHORITY,
    );
    expect(announced).toHaveLength(before);
  });

  it('refuses an empty text with the reason a caller most needs to hear', async () => {
    const broker = makeBroker({
      writeTeamProcess: async () => {
        throw new Error('must not be called');
      },
    });
    const text = getCallText(
      await handleToolCall(
        'team_process_write',
        { reason: 'r', disposition: 'correction' },
        broker,
        AUTHORITY,
      ),
    );
    expect(text).toMatch(/REPLACES the whole document/);
    expect(text).toMatch(/team_process_get/);
  });

  it('refuses a disposition outside the two rather than defaulting', async () => {
    const broker = makeBroker({
      writeTeamProcess: async () => {
        throw new Error('must not be called');
      },
    });
    const text = getCallText(
      await handleToolCall(
        'team_process_write',
        { text: 'x', reason: 'r', disposition: 'whatever' },
        broker,
        AUTHORITY,
      ),
    );
    expect(text).toMatch(/`disposition` must be "correction".*"scope_change"/s);
  });
});

// ─── the retired names, for one release ──────────────────────────────

/**
 * The tools shipped as `process_document_*`, and those names are quoted
 * in prose the rename cannot reach — team instructions, the process
 * text itself. For one release the old names dispatch to the new
 * handlers and log at warn naming the replacement; only the new names
 * are advertised. DELETE THIS BLOCK with the aliases in the next minor.
 */
describe('process_document_* aliases (deprecated — remove in the next minor)', () => {
  const ALIASES = [
    ['process_document_get', 'team_process_get'],
    ['process_document_history', 'team_process_history'],
    ['process_document_write', 'team_process_write'],
  ] as const;

  function capturingLogger() {
    const records: LogRecord[] = [];
    return { logger: createLogger({ level: 'debug', emit: (r) => records.push(r) }), records };
  }

  function broker() {
    return makeBroker({
      getTeamProcess: async () => DOC,
      teamProcessHistory: async () => [
        {
          version: 1,
          ts: 1,
          actor: 'AndrewJon',
          reason: 'first',
          disposition: 'scope_change',
          fields: ['text'],
          previous: {},
        },
      ],
      writeTeamProcess: async () => ({
        document: DOC,
        edit: {
          version: 2,
          ts: 2,
          actor: 'Lea',
          reason: 'r',
          disposition: 'correction' as const,
          fields: ['text' as const],
          previous: { text: 'before' },
        },
      }),
    });
  }

  it('advertises the new names and only the new names', () => {
    const names = defineTools(AUTHORITY).map((t) => t.name);
    // The positive control first: the replacements ARE listed, so the
    // absence below is a choice rather than an empty toolbox.
    for (const [, replacement] of ALIASES) expect(names).toContain(replacement);
    for (const [alias] of ALIASES) expect(names).not.toContain(alias);
  });

  it('dispatches each old name to the same handler as its replacement', async () => {
    const writeArgs = { text: 'x', reason: 'r', disposition: 'correction' };
    for (const [alias, replacement] of ALIASES) {
      const args = alias.endsWith('_write') ? writeArgs : {};
      const { logger } = capturingLogger();
      const viaAlias = getCallText(
        await handleToolCall(alias, args, broker(), AUTHORITY, undefined, logger),
      );
      const viaNew = getCallText(
        await handleToolCall(replacement, args, broker(), AUTHORITY, undefined, logger),
      );
      // Reached the handler, not the unknown-tool branch — assert the
      // value that branch alone produces before comparing.
      expect(viaAlias).not.toMatch(/unknown tool/);
      expect(viaAlias).toMatch(/process document/);
      expect(viaAlias).toBe(viaNew);
    }
  });

  it('warns once per aliased call, naming the alias and its replacement', async () => {
    for (const [alias, replacement] of ALIASES) {
      const { logger, records } = capturingLogger();
      const args = alias.endsWith('_write')
        ? { text: 'x', reason: 'r', disposition: 'correction' }
        : {};
      await handleToolCall(alias, args, broker(), AUTHORITY, undefined, logger);
      const warns = records.filter((r) => r.level === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatchObject({ tool: alias, replacement });
      expect(warns[0]?.msg).toMatch(/deprecated/i);

      // The negative control: the replacement itself is silent, so the
      // warn line means "an old name was used" and nothing else.
      await handleToolCall(replacement, args, broker(), AUTHORITY, undefined, logger);
      expect(records.filter((r) => r.level === 'warn')).toHaveLength(1);
    }
  });
});
