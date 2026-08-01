/**
 * The agent-facing surface for process rules.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE HTTP TESTS. The routes were
 * built first and tested against `fetch`. That proves a human with a
 * session cookie can amend a rule. It proves nothing about whether the
 * member who actually holds the amendment permission on this team — an
 * agent, reaching the broker through MCP — can do it at all.
 *
 * That gap is the standing failure mode here: a capability that is
 * human-only or agent-only by accident of where it was built rather
 * than by decision. The read path arrives by injection, so it was
 * never in question; `history` and `amend` were HTTP-only until these
 * tools existed.
 */

import type { Client as BrokerClient } from 'csuite-sdk/client';
import type { BriefingResponse, ProcessRule, ProcessRuleAmendment } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';

import { defineTools, handleToolCall } from '../../src/runtime/tools.js';

const BRIEFING: BriefingResponse = {
  name: 'scout',
  role: { title: 'engineer', description: '' },
  permissions: [],
  instructions: '',
  team: { name: 'demo', context: '', permissionPresets: {} },
  teammates: [],
  openObjectives: [],
  toolSources: [],
  processRules: [],
};

/** The same member, holding the amendment authority. */
const AUTHORITY: BriefingResponse = { ...BRIEFING, permissions: ['objectives.create'] };

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

function rule(over: Partial<ProcessRule> = {}): ProcessRule {
  return {
    anchor: 'merge-model',
    title: 'Merge model',
    text: 'Squash-merge to main.',
    status: 'in_force',
    provenance: 'director',
    attribution: 'AndrewJon',
    disputeReason: null,
    version: 1,
    createdBy: 'Lea',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

// ─── the gate ────────────────────────────────────────────────────────

describe('process rules — the write gate is the permission, not the role', () => {
  it('offers read tools to a member with no permissions at all', () => {
    const names = defineTools(BRIEFING).map((t) => t.name);
    expect(names).toContain('process_rules_list');
    expect(names).toContain('process_rules_history');
  });

  it('withholds create and amend from a member without objectives.create', () => {
    const names = defineTools(BRIEFING).map((t) => t.name);
    expect(names).not.toContain('process_rules_create');
    expect(names).not.toContain('process_rules_amend');
  });

  it('offers create and amend to a holder of objectives.create', () => {
    const names = defineTools(AUTHORITY).map((t) => t.name);
    expect(names).toContain('process_rules_create');
    expect(names).toContain('process_rules_amend');
  });

  /**
   * The gate is the permission and NOT the role. A member whose role
   * makes rules bind them hardest still cannot amend them without the
   * leaf, and a member with the leaf can amend regardless of role.
   */
  it('ignores the role entirely — only the leaf decides', () => {
    const boundHard: BriefingResponse = {
      ...BRIEFING,
      role: { title: 'Lead', description: 'owns the seam' },
    };
    expect(defineTools(boundHard).map((t) => t.name)).not.toContain('process_rules_amend');

    const lowlyButAuthorised: BriefingResponse = {
      ...AUTHORITY,
      role: { title: 'intern', description: '' },
    };
    expect(defineTools(lowlyButAuthorised).map((t) => t.name)).toContain('process_rules_amend');
  });
});

// ─── the descriptions, which are the only spec an agent gets ─────────

describe('process rule tool descriptions state the limits an agent cannot see', () => {
  it('tells the reader list is not how it learns what binds it', () => {
    const list = defineTools(BRIEFING).find((t) => t.name === 'process_rules_list');
    expect(list?.description).toMatch(/already in your fixed context/i);
    expect(list?.description).toMatch(/retired/i);
  });

  it('warns that a new rule does not reach a running teammate', () => {
    const create = defineTools(AUTHORITY).find((t) => t.name === 'process_rules_create');
    // The delivery bound is the thing an agent will otherwise assume
    // wrongly: it is next-runner-start, not immediate.
    expect(create?.description).toMatch(/next runner start/i);
    expect(create?.description).toMatch(/NOT pushed into a running session/i);
  });

  it('names disposition as the same field and meaning as objectives_amend', () => {
    const amend = defineTools(AUTHORITY).find((t) => t.name === 'process_rules_amend');
    expect(amend?.description).toMatch(/objectives_amend/);
    expect(amend?.description).toMatch(/retroactive/i);
    expect(amend?.description).toMatch(/forward only/i);
  });

  it('distinguishes changeKind from disposition rather than blurring them', () => {
    const amend = defineTools(AUTHORITY).find((t) => t.name === 'process_rules_amend');
    const props = amend?.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.changeKind?.description).toMatch(/reversal/i);
    expect(props.disposition?.description).toMatch(/retroactive/i);
    // The two must not be described as the same axis.
    expect(amend?.description).toMatch(/separate and answers a different question/i);
  });

  it('requires the fields an amendment is meaningless without', () => {
    const amend = defineTools(AUTHORITY).find((t) => t.name === 'process_rules_amend');
    expect(amend?.inputSchema.required).toEqual(['anchor', 'reason', 'disposition', 'changeKind']);
  });
});

// ─── handlers ────────────────────────────────────────────────────────

describe('process_rules_list', () => {
  it('counts what is in force separately from the total', async () => {
    const broker = makeBroker({
      listProcessRules: async () => [
        rule(),
        rule({ anchor: 'old-way', status: 'retired', title: 'Old way' }),
      ],
    });
    const text = getCallText(await handleToolCall('process_rules_list', {}, broker, BRIEFING));
    // "2 rules" alone reads as "2 rules bind me".
    expect(text).toMatch(/2 process rules \(1 in force, 1 retired\)/);
  });

  it('renders a disputed rule as unsettled, with the reason', async () => {
    const broker = makeBroker({
      listProcessRules: async () => [
        rule({ status: 'disputed', disputeReason: 'contradicted by observed practice' }),
      ],
    });
    const text = getCallText(await handleToolCall('process_rules_list', {}, broker, BRIEFING));
    expect(text).toMatch(/DISPUTED — do not treat as settled: contradicted by observed practice/);
  });

  it('renders lead_uncontested as weaker than adoption, not as a director saying so', async () => {
    const broker = makeBroker({
      listProcessRules: async () => [rule({ provenance: 'lead_uncontested', attribution: 'Lea' })],
    });
    const text = getCallText(await handleToolCall('process_rules_list', {}, broker, BRIEFING));
    expect(text).toMatch(/proposed by Lea, not contested — weaker than adoption/);
    expect(text).not.toMatch(/stated by/);
  });

  it('says so plainly when the team has no rules', async () => {
    const broker = makeBroker({ listProcessRules: async () => [] });
    const text = getCallText(await handleToolCall('process_rules_list', {}, broker, BRIEFING));
    expect(text).toMatch(/no process rules are recorded/i);
  });
});

describe('process_rules_history', () => {
  function amendment(over: Partial<ProcessRuleAmendment> = {}): ProcessRuleAmendment {
    return {
      anchor: 'merge-model',
      version: 2,
      ts: 1_700_000_100_000,
      actor: 'Lea',
      disposition: 'scope_change',
      changeKind: 'reversal',
      reason: 'the team moved to merge commits',
      fields: ['text'],
      previous: { text: 'Squash-merge to main.' },
      ...over,
    };
  }

  it('surfaces the superseded text, which is the whole point of retrieving it', async () => {
    const broker = makeBroker({ processRuleHistory: async () => [amendment()] });
    const text = getCallText(
      await handleToolCall('process_rules_history', { anchor: 'merge-model' }, broker, BRIEFING),
    );
    expect(text).toMatch(/text was: Squash-merge to main\./);
    expect(text).toMatch(/reversal/);
    expect(text).toMatch(/work already underway finished under the prior text/);
  });

  it('distinguishes never-amended from amended, rather than returning nothing', async () => {
    const broker = makeBroker({ processRuleHistory: async () => [] });
    const text = getCallText(
      await handleToolCall('process_rules_history', { anchor: 'merge-model' }, broker, BRIEFING),
    );
    expect(text).toMatch(/never been amended — the text you were given is the original/);
  });

  it('requires an anchor', async () => {
    const broker = makeBroker({
      processRuleHistory: async () => {
        throw new Error('must not be called');
      },
    });
    const result = await handleToolCall('process_rules_history', {}, broker, BRIEFING);
    expect(getCallText(result)).toMatch(/`anchor` is required/);
  });
});

describe('process_rules_amend', () => {
  it('passes disposition and changeKind through and reports what moved', async () => {
    let seen: unknown;
    const broker = makeBroker({
      amendProcessRule: async (anchor: string, payload: unknown) => {
        seen = { anchor, payload };
        return {
          rule: rule({ version: 2, text: 'Merge commits to main.' }),
          amendment: {
            anchor: 'merge-model',
            version: 2,
            ts: 1,
            actor: 'Lea',
            disposition: 'scope_change' as const,
            changeKind: 'reversal' as const,
            reason: 'reversed',
            fields: ['text' as const],
            previous: { text: 'Squash-merge to main.' },
          },
        };
      },
    });
    const text = getCallText(
      await handleToolCall(
        'process_rules_amend',
        {
          anchor: 'merge-model',
          text: 'Merge commits to main.',
          reason: 'reversed',
          disposition: 'scope_change',
          changeKind: 'reversal',
        },
        broker,
        AUTHORITY,
      ),
    );
    expect(seen).toMatchObject({
      anchor: 'merge-model',
      payload: {
        disposition: 'scope_change',
        changeKind: 'reversal',
        text: 'Merge commits to main.',
      },
    });
    expect(text).toMatch(/amended 'merge-model' to v2 — reversal, scope_change/);
    expect(text).toMatch(/Changed: text/);
    expect(text).toMatch(/process_rules_history/);
  });

  /**
   * Criterion 7 at the tool surface. The success text must not tell an
   * agent to go announce the change — if the agent believes a
   * broadcast is what makes an amendment take effect, the durable
   * surface is decorative again and we are back at the motivating bug.
   */
  it('states the amendment takes effect with no broadcast, and sends none', async () => {
    // `push` is the broker method every announcement path goes through
    // — `broadcast`, `send` and `channels_post` all end up here. If an
    // amendment announced itself, it would show up in this array.
    const announcements: unknown[] = [];
    const broker = makeBroker({
      push: async (payload: unknown) => {
        announcements.push(payload);
        return {} as never;
      },
      amendProcessRule: async () => ({
        rule: rule({ version: 2 }),
        amendment: {
          anchor: 'merge-model',
          version: 2,
          ts: 1,
          actor: 'Lea',
          disposition: 'correction' as const,
          changeKind: 'wording' as const,
          reason: 'clarity',
          fields: ['text' as const],
          previous: { text: 'old' },
        },
      }),
    });
    const text = getCallText(
      await handleToolCall(
        'process_rules_amend',
        {
          anchor: 'merge-model',
          reason: 'clarity',
          disposition: 'correction',
          changeKind: 'wording',
        },
        broker,
        AUTHORITY,
      ),
    );
    expect(text).toMatch(/No broadcast is needed for this to take effect, and none is sent/);
    expect(text).toMatch(/next runner start/);

    // POSITIVE CONTROL FIRST. `expect(announcements).toEqual([])` is an
    // absence assertion, and an absence assertion against an observer
    // that never fires is vacuous — misname the stubbed method and this
    // test passes while watching nothing. So prove the observer works
    // by driving a real announcement through the same broker object,
    // and only then assert the amendment added nothing.
    await handleToolCall('broadcast', { body: 'a real announcement' }, broker, AUTHORITY);
    expect(announcements).toHaveLength(1);

    const afterAmend = announcements.length;
    await handleToolCall(
      'process_rules_amend',
      {
        anchor: 'merge-model',
        reason: 'clarity',
        disposition: 'correction',
        changeKind: 'wording',
      },
      broker,
      AUTHORITY,
    );
    expect(announcements).toHaveLength(afterAmend);
  });

  it('refuses a disposition that is not one of the two, rather than defaulting', async () => {
    const broker = makeBroker({
      amendProcessRule: async () => {
        throw new Error('must not be called');
      },
    });
    const text = getCallText(
      await handleToolCall(
        'process_rules_amend',
        { anchor: 'merge-model', reason: 'x', disposition: 'whatever', changeKind: 'wording' },
        broker,
        AUTHORITY,
      ),
    );
    expect(text).toMatch(/`disposition` must be "correction".*"scope_change"/s);
  });

  it('refuses a changeKind that is not one of the three', async () => {
    const broker = makeBroker({
      amendProcessRule: async () => {
        throw new Error('must not be called');
      },
    });
    const text = getCallText(
      await handleToolCall(
        'process_rules_amend',
        { anchor: 'merge-model', reason: 'x', disposition: 'correction', changeKind: 'tweak' },
        broker,
        AUTHORITY,
      ),
    );
    expect(text).toMatch(/`changeKind` must be "reversal", "refinement" or "wording"/);
  });
});

describe('process_rules_create', () => {
  it('refuses a provenance outside the three, rather than guessing one', async () => {
    const broker = makeBroker({
      createProcessRule: async () => {
        throw new Error('must not be called');
      },
    });
    const text = getCallText(
      await handleToolCall(
        'process_rules_create',
        { anchor: 'a-rule', title: 'T', text: 'X', provenance: 'someone-said-so' },
        broker,
        AUTHORITY,
      ),
    );
    expect(text).toMatch(/`provenance` must be "director", "lead_uncontested" or "unattributed"/);
  });

  it('reports the delivery bound rather than implying the rule is live everywhere', async () => {
    const broker = makeBroker({
      createProcessRule: async () => rule({ anchor: 'a-rule', version: 1 }),
    });
    const text = getCallText(
      await handleToolCall(
        'process_rules_create',
        { anchor: 'a-rule', title: 'T', text: 'X', provenance: 'director' },
        broker,
        AUTHORITY,
      ),
    );
    expect(text).toMatch(/NEXT runner start/);
    expect(text).toMatch(/a teammate already running has not seen it/i);
  });
});
