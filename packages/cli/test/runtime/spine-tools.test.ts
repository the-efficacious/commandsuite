/**
 * The agent-facing surface of the spine.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE SERVER'S SUITES. The annex's own
 * rules are held against the real store, over HTTP, by
 * `apps/server/test/spine-*.test.ts`. None of that reaches the half a
 * member actually touches: the description that is the only
 * specification an agent has for a tool it cannot read, the payload the
 * tool composes from what the agent typed, and the refusal as rendered
 * back. A store that refuses correctly behind a tool that renders
 * "broker error 409" is a green server suite and a member who cannot
 * act on it.
 *
 * So this file asserts three things and they are different:
 *
 *   THE STRINGS   named, then grepped. `orient` must announce itself as
 *                 the recovery call; every state-changing tool must
 *                 carry the citation rule; `discuss` must say it is
 *                 never gated. These are deliverables a person or an
 *                 agent has to see.
 *   THE PAYLOAD   what went OUT, read off the broker. A tool that sends
 *                 `expected_state_rev` under the wrong name, or drops
 *                 the origin citation from a promotion, satisfies every
 *                 assertion made on what came back.
 *   THE REFUSAL   driven through a real `Client` against a real HTTP
 *                 response, because the rendering path begins with a
 *                 `ClientError` whose body is a JSON string, and a
 *                 hand-built error would be testing the fixture.
 */

import type { Client as BrokerClient } from 'csuite-sdk/client';
import { Client } from 'csuite-sdk/client';
import { SpineContractStateSchema } from 'csuite-sdk/schemas';
import type { InstructionsResponse, SpineEvent } from 'csuite-sdk/types';
import { SPINE_CITATION_LOCKED_KINDS } from 'csuite-sdk/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineTools, handleToolCall } from '../../src/runtime/tools.js';
import {
  FAKE_BROKER_TOKEN,
  type FakeBroker,
  fakeBrokerSpine,
  startFakeBroker,
} from './fake-broker.js';

const PACKET: InstructionsResponse = {
  name: 'rune',
  role: { title: 'engineer', description: '' },
  permissions: [],
  instructions: '',
  team: { name: 'demo', context: '', permissionPresets: {} },
  teammates: [],
  openObjectives: [],
  toolSources: [],
  processDocument: null,
};

/** The same member, holding the authoring leaf. */
const AUTHOR: InstructionsResponse = { ...PACKET, permissions: ['spine.author'] };

let broker: FakeBroker;
let client: BrokerClient;

beforeAll(async () => {
  broker = await startFakeBroker();
  client = new Client({ url: broker.url, token: FAKE_BROKER_TOKEN });
});

afterAll(async () => {
  await broker.close();
});

beforeEach(() => {
  fakeBrokerSpine.appends.length = 0;
  fakeBrokerSpine.subjects.length = 0;
  fakeBrokerSpine.events.length = 0;
  fakeBrokerSpine.eventsById = {};
  fakeBrokerSpine.contracts = {};
  fakeBrokerSpine.orient = {};
  fakeBrokerSpine.refuseNext = null;
  fakeBrokerSpine.replayNext = false;
  fakeBrokerSpine.curatorWrites.length = 0;
  fakeBrokerSpine.curatorConfig = {
    member: 'rune',
    subscriptions: [],
    policy: {
      member: 'rune',
      leaseTtlMs: 1_800_000,
      nudgeMinIntervalMs: 900_000,
      explicit: false,
      updatedBy: null,
      updatedAt: null,
    },
    capabilities: null,
  };
});

function tool(name: string, packet: InstructionsResponse = PACKET) {
  return defineTools(packet).find((t) => t.name === name);
}

function describeOf(name: string, packet: InstructionsResponse = PACKET): string {
  const found = tool(name, packet);
  if (found === undefined) throw new Error(`no such tool in the surface: ${name}`);
  return found.description ?? '';
}

function getCallText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected text content');
  }
  return first.text;
}

async function call(
  name: string,
  args: Record<string, unknown>,
  packet: InstructionsResponse = PACKET,
): Promise<{ text: string; isError: boolean }> {
  const result = await handleToolCall(name, args, client, packet);
  return { text: getCallText(result), isError: result.isError === true };
}

/** The last payload the broker actually received. */
function lastAppend(): Record<string, unknown> {
  const last = fakeBrokerSpine.appends.at(-1);
  if (last === undefined) throw new Error('no append reached the broker');
  return last;
}

const CONTRACT = 'evt_contract_1';

function seedContract(): void {
  fakeBrokerSpine.contracts[CONTRACT] = {
    id: CONTRACT,
    title: 'Ship the endpoint',
    state: 'active',
    stateRev: 2,
    version: 1,
    subject: 'repo:acme',
    revision: null,
    criteria: [{ id: 'c1', text: 'the endpoint returns 200' }],
    assignee: 'rune',
    verifier: 'lea',
    authority: 'andrewjon',
    constraints: [],
    createdBy: 'lea',
    createdAt: '2026-08-09T09:00:00.000Z',
    updatedAt: '2026-08-09T09:00:00.000Z',
    waitingOn: null,
    waitingFor: null,
    preemptedBy: null,
    result: null,
    reason: null,
    successor: null,
    stale: false,
    head: null,
  };
}

// ─── the surface, and its gate ───────────────────────────────────────

describe('the spine surface', () => {
  it('offers the thirteen ungated tools to a member with no permissions at all', () => {
    const names = defineTools(PACKET).map((t) => t.name);
    // The WHOLE list, not "orient is in there". Participation in the
    // record is not a privilege: a member who cannot say what they did
    // cannot be held to anything, and a gate that crept onto any of
    // these would produce work that happens off the record.
    for (const name of [
      'orient',
      'annex_read',
      'attempt_post',
      'verdict_post',
      'state_set',
      'contract_complete',
      'ask_author',
      'ruling_post',
      'proceed',
      'observe',
      'discuss',
      'promote',
      'subscribe',
    ]) {
      expect(names, `${name} must be baseline participation`).toContain(name);
    }
  });

  it('withholds authoring and amendment from a member without spine.author', () => {
    const names = defineTools(PACKET).map((t) => t.name);
    expect(names).not.toContain('contract_author');
    expect(names).not.toContain('contract_amend');
  });

  it('withholds them from a member holding every other leaf', () => {
    // The gate is this leaf, not seniority. Without a senior non-holder
    // in the fixture, "gated" and "admin-only" are indistinguishable.
    const senior: InstructionsResponse = {
      ...PACKET,
      permissions: ['objectives.create', 'members.manage', 'team.manage', 'process.manage'],
    };
    const names = defineTools(senior).map((t) => t.name);
    expect(names).not.toContain('contract_author');
    expect(names).not.toContain('contract_amend');
  });

  it('offers both to the holder of spine.author', () => {
    const names = defineTools(AUTHOR).map((t) => t.name);
    expect(names).toContain('contract_author');
    expect(names).toContain('contract_amend');
  });
});

// ─── descriptions are the specification ──────────────────────────────

describe('orient is announced as the recovery call', () => {
  it('says to call it after a restart or compaction, and that it never refuses', () => {
    const orient = describeOf('orient');
    expect(orient).toMatch(/restart, compaction, or gap/i);
    expect(orient).toMatch(/never refuses/i);
    expect(orient).toMatch(/Guessing is more expensive than this call/);
  });

  it('names what the member is promised, rather than describing a status report', () => {
    const orient = describeOf('orient');
    for (const promised of [
      'contract',
      'criteria',
      'verdict',
      'revision',
      'rulings',
      'cursor',
      'asks',
    ]) {
      expect(orient, `orient must promise ${promised}`).toContain(promised);
    }
    // No arguments at all: the cheapest description in the surface to
    // act on is one with nothing to get wrong.
    expect(tool('orient')?.inputSchema.properties).toEqual({});
  });

  it('is pointed at from the tools whose preconditions it supplies', () => {
    for (const name of ['attempt_post', 'verdict_post', 'state_set', 'contract_complete']) {
      expect(describeOf(name), `${name} must point at orient`).toContain('orient');
    }
  });
});

describe('the citation rule reaches every tool it binds', () => {
  /** The exact sentence an agent has to see. Named, then grepped. */
  const CITATION_MARKERS = ['CITATION LOCK', 'YOU DO NOT HAVE A RULING', 'CONTAINING it'];

  /**
   * ALL SIX, and the list is written out rather than sampled.
   *
   * The previous version iterated three ungated tools plus the two
   * gated ones — and `verdict_post` was missing the rule for exactly
   * as long as nothing enumerated the tools the rule itself names. A
   * partial list reads as a complete one.
   */
  const LOCKED_TOOLS = [
    'contract_author',
    'contract_amend',
    'attempt_post',
    'verdict_post',
    'state_set',
    'contract_complete',
  ];

  it('carries the rule on every one of the six tools it binds', () => {
    for (const name of LOCKED_TOOLS) {
      for (const marker of CITATION_MARKERS) {
        expect(describeOf(name, AUTHOR), `${name} must carry "${marker}"`).toContain(marker);
      }
    }
  });

  /**
   * THE CROSS-CHECK THAT WOULD HAVE CAUGHT THE OMISSION.
   *
   * The rule's own sentence lists the tools it binds, and the store
   * locks a list of KINDS. Those are two statements of one fact in two
   * vocabularies, and nothing compared them — so the sentence could
   * name a tool that did not carry it, which is precisely what
   * happened. This maps kinds to tools and asserts both directions.
   */
  it('names exactly the tools whose kinds the store locks, and no others', () => {
    const toolForKind: Record<string, string[]> = {
      specification: ['contract_author'],
      amendment: ['contract_amend'],
      attempt: ['attempt_post'],
      criterion_verdict: ['verdict_post'],
      // One kind, two tools: both write a `lifecycle`.
      lifecycle: ['state_set', 'contract_complete'],
    };
    const expected = SPINE_CITATION_LOCKED_KINDS.flatMap((kind) => toolForKind[kind] ?? []);
    // Every kind the store locks is accounted for by a tool.
    expect(expected.length, 'a locked kind has no tool mapped to it').toBe(LOCKED_TOOLS.length);
    // The rule's own prose names each of them…
    const rule = describeOf('attempt_post');
    for (const name of expected) {
      expect(rule, `the citation rule must name \`${name}\``).toContain(`\`${name}\``);
    }
    // …and each of them carries the rule.
    for (const name of expected) {
      expect(describeOf(name, AUTHOR), `${name} must carry the rule`).toContain('CITATION LOCK');
    }
    // No tool outside that set claims to be locked, which is the other
    // half of the drift: a rule pasted onto a tool it does not bind
    // teaches a refusal that will never come.
    for (const name of ['orient', 'annex_read', 'discuss', 'observe', 'proceed', 'ruling_post']) {
      expect(describeOf(name), `${name} must not claim to be locked`).not.toContain(
        'CITATION LOCK',
      );
    }
  });

  it('warns at the point the ask is raised, not only where it bites', () => {
    // The member most likely to be surprised by the lock is the one
    // raising the ask, and they are one tool away from the surprise.
    expect(describeOf('ask_author')).toContain('CITATION LOCK');
    expect(describeOf('ask_author')).toMatch(/binds you/i);
  });

  it('names both exits truthfully wherever it states the rule', () => {
    const attempt = describeOf('attempt_post');
    // The ruling exit is the ANSWER, not a citation ceremony: a ruling
    // resolves its ask, so there is nothing left to cite afterwards.
    // Telling an agent to cite it on the write is instructing a step
    // that cannot be the thing that releases them.
    expect(attempt).toMatch(/Getting the ruling IS the release/);
    expect(attempt).toMatch(/it resolves the ask/);
    expect(attempt).not.toMatch(/cite a ruling on that ask/);
    expect(attempt).toMatch(/`proceed`/);
    expect(attempt).toMatch(/Proceeding is legitimate/);
  });

  it('tells the reader `discuss` is never gated by it', () => {
    const discuss = describeOf('discuss');
    expect(discuss).toMatch(/never refused by the citation lock/i);
    expect(discuss).toMatch(/cheapest surface/i);
    // The largest cap in the system, stated as a number the agent can
    // plan against.
    expect(discuss).toContain('65536');
    expect(discuss).not.toContain('CITATION LOCK');
  });

  it('tells the reader `observe` is never gated by it either', () => {
    expect(describeOf('observe')).toMatch(/never refused by the citation lock/i);
  });
});

describe('the descriptions state the rules that will otherwise refuse the call', () => {
  it('says a verdict cannot come from the assignee, and that cannot_verify needs why', () => {
    const verdict = describeOf('verdict_post');
    expect(verdict).toMatch(/cannot judge a contract you are the assignee of/i);
    expect(verdict).toMatch(/`cannot_verify` is a\s+first-class answer and REQUIRES `why`/);
  });

  it('says completion is a hard gate and where the gap will be named', () => {
    const complete = describeOf('contract_complete');
    expect(complete).toMatch(/HARD GATE/);
    expect(complete).toMatch(/EVERY criterion at ONE revision/);
    expect(complete).toMatch(/names each criterion that is not covered/);
  });

  it('says only the named authority may rule', () => {
    expect(describeOf('ruling_post')).toMatch(/Only the\s+ask’s named authority can rule on it/);
  });

  it('says the proceed cover is keyed to the ask, and that its subject is caption only', () => {
    // The sentence exists because the field invites the opposite
    // reading: `proceed` takes a `subject`, so an agent will assume
    // that is what it covers, and will re-proceed on each narrower one.
    // The cover is per-ask-per-actor and the ask already carries the
    // scope.
    const proceed = describeOf('proceed');
    expect(proceed).toContain('The cover is keyed to the ASK, not to what you type in `subject`');
    expect(proceed).toMatch(/`subject` here is caption only/);
    expect(proceed).toMatch(/naming a narrower one does not narrow what this proceeding covers/);
  });

  it('states the state_rev contract, including that the refusal carries the delta', () => {
    const state = describeOf('state_set');
    expect(state).toMatch(/expected_state_rev` is the contract counter AS YOU LAST READ IT/);
    expect(state).toMatch(/carries every authoritative event you missed, in full/);
    // And that completion is not reachable here — one route to done.
    expect(state).toMatch(/Completion is not here/);
  });

  it('says amendment refuses a silent removal, and names the disclosure that fixes it', () => {
    const amend = describeOf('contract_amend', AUTHOR);
    expect(amend).toMatch(/removing text without a `disclosure` is refused/);
    expect(amend).toMatch(/must CITE that verdict/);
    expect(amend).toMatch(/Requires `spine.author`/);
  });

  it('says the authoring leaf out loud, the way process_document_write does', () => {
    expect(describeOf('contract_author', AUTHOR)).toMatch(/Requires `spine.author`/);
  });

  it('names the revision caption as three fields, on every tool that takes one', () => {
    for (const name of ['attempt_post', 'verdict_post', 'contract_complete', 'observe']) {
      const props = tool(name)?.inputSchema.properties as Record<
        string,
        { properties?: Record<string, unknown>; required?: string[] }
      >;
      expect(Object.keys(props.revision?.properties ?? {}), name).toContain('how');
      expect(props.revision?.required, name).toEqual(['value', 'how', 'source']);
    }
  });
});

// ─── what the tools actually send ────────────────────────────────────

describe('the payload a tool composes', () => {
  it('sends an attempt with the precondition, an op id and the contract’s subject', async () => {
    seedContract();
    const { text, isError } = await call('attempt_post', {
      contract: CONTRACT,
      summary: 'pushed the fix',
      expected_state_rev: 2,
      revision: { value: 'sha-a', how: 'asserted', source: 'member:rune' },
    });
    expect(isError, text).toBe(false);
    const sent = lastAppend();
    expect(sent.kind).toBe('attempt');
    // The wire names, not the tool's. A rename on either side is
    // invisible to any assertion made on what came back.
    expect(sent.expectedStateRev).toBe(2);
    expect(typeof sent.opId).toBe('string');
    // The revision's subject was never typed by the agent: it is the
    // contract's, fetched, because making them restate it is how it
    // gets restated wrongly.
    expect(sent.revision).toEqual({
      subject: 'repo:acme',
      value: 'sha-a',
      how: 'asserted',
      source: 'member:rune',
    });
    expect(sent.body).toEqual({ contract: CONTRACT, summary: 'pushed the fix' });
  });

  it('honours an op_id the caller chose, so a retry can be free', async () => {
    seedContract();
    await call('attempt_post', {
      contract: CONTRACT,
      summary: 'pushed the fix',
      expected_state_rev: 2,
      op_id: 'op-mine',
      revision: { value: 'sha-a', how: 'asserted', source: 'member:rune' },
    });
    expect(lastAppend().opId).toBe('op-mine');
  });

  it('sends a verdict per criterion, carrying why on cannot_verify', async () => {
    seedContract();
    await call('verdict_post', {
      contract: CONTRACT,
      criterion: 'c1',
      decision: 'cannot_verify',
      evidence: 'tried the staging deploy',
      why: 'no access to the deploy',
      expected_state_rev: 2,
      revision: { value: 'sha-a', how: 'observed', source: 'integration:github' },
    });
    expect(lastAppend().body).toEqual({
      contract: CONTRACT,
      criterion: 'c1',
      decision: 'cannot_verify',
      evidence: 'tried the staging deploy',
      why: 'no access to the deploy',
    });
  });

  it('sends completion as a done lifecycle carrying the verdicts it stands on', async () => {
    seedContract();
    await call('contract_complete', {
      contract: CONTRACT,
      result: 'shipped and green',
      expected_state_rev: 2,
      cites: ['evt_verdict_1'],
      revision: { value: 'sha-a', how: 'observed', source: 'integration:github' },
    });
    const sent = lastAppend();
    expect(sent.kind).toBe('lifecycle');
    expect(sent.cites).toEqual(['evt_verdict_1']);
    expect(sent.body).toEqual({ contract: CONTRACT, state: 'done', result: 'shipped and green' });
  });

  it('registers the subject inline when contract_author is given its type', async () => {
    await call(
      'contract_author',
      {
        subject: 'file:acme/api.ts',
        subject_type: 'file',
        subject_parent: 'repo:acme',
        title: 'Ship the endpoint',
        criteria: [{ id: 'c1', text: 'the endpoint returns 200' }],
        assignee: 'rune',
        verifier: 'lea',
      },
      AUTHOR,
    );
    expect(fakeBrokerSpine.subjects).toEqual([
      { id: 'file:acme/api.ts', type: 'file', parent: 'repo:acme' },
    ]);
    expect(lastAppend().kind).toBe('specification');
  });

  it('does not register a subject when no type is given', async () => {
    // The nearest valid thing, and the negative control on the branch
    // above: an existing subject must not be re-registered on every
    // authored contract.
    await call(
      'contract_author',
      {
        subject: 'repo:acme',
        title: 'Ship the endpoint',
        criteria: [{ id: 'c1', text: 'the endpoint returns 200' }],
        assignee: 'rune',
      },
      AUTHOR,
    );
    expect(fakeBrokerSpine.subjects).toEqual([]);
    expect(lastAppend().kind).toBe('specification');
  });

  it('sends a discussion with no op id and no precondition — nothing gated', async () => {
    await call('discuss', { body: 'the handler was deliberate', contract: CONTRACT });
    const sent = lastAppend();
    expect(sent.kind).toBe('discussion');
    expect(sent.opId).toBeUndefined();
    expect(sent.expectedStateRev).toBeUndefined();
    expect(sent.body).toEqual({ body: 'the handler was deliberate', contract: CONTRACT });
  });

  it('sends a proceeding naming the ask and the subject it covers', async () => {
    const { text } = await call('proceed', {
      ask: 'evt_ask_1',
      subject: 'repo:acme',
      reason: 'the window closes today',
    });
    expect(lastAppend().body).toEqual({
      ask: 'evt_ask_1',
      reason: 'the window closes today',
    });
    expect(lastAppend().subject).toBe('repo:acme');
    // And the result says what it bought, and what it did not.
    expect(text).toMatch(/covered until that ask resolves/);
    expect(text).toMatch(/your decision, not as an answer you were given/);
  });

  it('tells the asker that raising an ask has just bound them', async () => {
    const { text } = await call('ask_author', {
      authority: 'andrewjon',
      question: 'may we drop the legacy header?',
      context: 'two callers still send it',
      unblocks: 'the migration',
      subject: 'repo:acme',
    });
    expect(text).toMatch(/THIS NOW BINDS YOU/);
    expect(text).toMatch(/repo:acme/);
    expect(text).toMatch(/`proceed`/);
  });
});

// ─── promote ─────────────────────────────────────────────────────────

describe('promote synthesises the typed event from the post', () => {
  beforeEach(() => {
    fakeBrokerSpine.eventsById.evt_post_1 = {
      seq: 7,
      id: 'evt_post_1',
      kind: 'discussion',
      class: 'ambient',
      subject: 'repo:acme',
      revision: null,
      actor: 'cora',
      authoredBy: null,
      at: '2026-08-09T09:00:00.000Z',
      provenance: 'native',
      opId: null,
      cites: [],
      staplesTo: null,
      contract: CONTRACT,
      stateRev: null,
      body: { body: 'the header is unused — I grepped every caller', contract: CONTRACT },
    } satisfies Record<string, unknown> as unknown as Record<string, unknown>;
  });

  it('carries the post’s text into the kind’s principal field and cites it as origin', async () => {
    const { text, isError } = await call('promote', {
      event: 'evt_post_1',
      as: 'observation',
      fields: { what: 'grepped every caller' },
    });
    expect(isError, text).toBe(false);
    const sent = lastAppend();
    expect(sent.kind).toBe('observation');
    // The post's own words, verbatim, in the field that holds them.
    expect(sent.body).toEqual({
      output: 'the header is unused — I grepped every caller',
      what: 'grepped every caller',
    });
    // THE ORIGIN, FIRST. This is the whole difference between promoting
    // and retyping: the record shows where the decision happened.
    expect(sent.cites).toEqual(['evt_post_1']);
    expect(sent.subject).toBe('repo:acme');
    expect(text).toMatch(/citing the post as its origin/);
  });

  it('inherits the contract for a kind that requires one, and carries the precondition', async () => {
    await call('promote', {
      event: 'evt_post_1',
      as: 'attempt',
      expected_state_rev: 2,
    });
    const sent = lastAppend();
    expect(sent.kind).toBe('attempt');
    expect(sent.body).toEqual({
      summary: 'the header is unused — I grepped every caller',
      contract: CONTRACT,
    });
    expect(sent.expectedStateRev).toBe(2);
    expect(typeof sent.opId).toBe('string');
  });

  it('lets an explicit field override what the post would have supplied', async () => {
    await call('promote', {
      event: 'evt_post_1',
      as: 'attempt',
      expected_state_rev: 2,
      fields: { summary: 'a tighter summary', contract: 'evt_other' },
    });
    expect(lastAppend().body).toEqual({ summary: 'a tighter summary', contract: 'evt_other' });
  });

  it('refuses to promote something that is not a discussion', async () => {
    // A WELL-FORMED verdict, not a discussion wearing a different
    // `kind`. The client parses the response against the discriminated
    // union, so a mismatched body is refused one layer before the
    // handler and the fixture never reaches the branch it names.
    fakeBrokerSpine.eventsById.evt_verdict_1 = {
      ...(fakeBrokerSpine.eventsById.evt_post_1 as Record<string, unknown>),
      id: 'evt_verdict_1',
      kind: 'criterion_verdict',
      revision: {
        id: 'rev_1',
        subject: 'repo:acme',
        value: 'sha-a',
        how: 'observed',
        source: 'integration:github',
        at: '2026-08-09T09:01:00.000Z',
      },
      opId: 'op-v1',
      stateRev: 3,
      body: { contract: CONTRACT, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    };
    const { text, isError } = await call('promote', { event: 'evt_verdict_1', as: 'observation' });
    expect(isError).toBe(true);
    expect(text).toMatch(/is a criterion_verdict, not a discussion/);
    expect(text).toMatch(/turns CHATTER into a typed event/);
    // Nothing was written on the way to refusing.
    expect(fakeBrokerSpine.appends).toEqual([]);
  });

  it('refuses a target kind promotion cannot produce, and names the ones it can', async () => {
    const { text, isError } = await call('promote', { event: 'evt_post_1', as: 'discussion' });
    expect(isError).toBe(true);
    expect(text).toMatch(/cannot promote into 'discussion'/);
    expect(text).toMatch(/observation, testimony/);
    expect(fakeBrokerSpine.appends).toEqual([]);
  });

  it('surfaces the annex’s own refusal when a required field is still missing', async () => {
    // The schema is the law, and this is where an agent finds out which
    // law: promoting into a verdict without a criterion or a decision.
    const { text, isError } = await call('promote', {
      event: 'evt_post_1',
      as: 'criterion_verdict',
      expected_state_rev: 2,
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/the schema is the law/);
    expect(text).toMatch(/criterion/);
    expect(text).toMatch(/decision/);
  });
});

// ─── refusals, rendered ──────────────────────────────────────────────

describe('a refusal is rendered completely, because the refusal is the re-brief', () => {
  /** Two events the caller missed, each with a body worth reading. */
  const INTERVENING: SpineEvent[] = [
    {
      seq: 11,
      id: 'evt_missed_1',
      kind: 'criterion_verdict',
      class: 'authoritative',
      subject: null,
      revision: {
        id: 'rev_1',
        subject: 'repo:acme',
        value: 'sha-b',
        how: 'observed',
        source: 'integration:github',
        at: '2026-08-09T09:01:00.000Z',
      },
      actor: 'lea',
      authoredBy: null,
      at: '2026-08-09T09:01:00.000Z',
      provenance: 'native',
      opId: 'op-v1',
      cites: [],
      staplesTo: null,
      contract: CONTRACT,
      stateRev: 3,
      body: {
        contract: CONTRACT,
        criterion: 'c1',
        decision: 'unmet',
        evidence: 'the endpoint 500s on an empty body',
      },
    },
    {
      seq: 12,
      id: 'evt_missed_2',
      kind: 'lifecycle',
      class: 'authoritative',
      subject: null,
      revision: null,
      actor: 'andrewjon',
      authoredBy: null,
      at: '2026-08-09T09:02:00.000Z',
      provenance: 'native',
      opId: 'op-l1',
      cites: [],
      staplesTo: null,
      contract: CONTRACT,
      stateRev: 4,
      body: { contract: CONTRACT, state: 'waiting_on', member: 'rune', reason: 'needs a rebase' },
    },
  ];

  it('renders every intervening event of a stale refusal, with its body', async () => {
    seedContract();
    fakeBrokerSpine.refuseNext = {
      status: 409,
      body: {
        error: 'contract evt_contract_1 is at state_rev 4, not 2.',
        code: 'stale_state_rev',
        detail: {
          contract: CONTRACT,
          expectedStateRev: 2,
          currentStateRev: 4,
          intervening: INTERVENING,
        },
      },
    };
    const { text, isError } = await call('attempt_post', {
      contract: CONTRACT,
      summary: 'pushed the fix',
      expected_state_rev: 2,
      revision: { value: 'sha-a', how: 'asserted', source: 'member:rune' },
    });
    expect(isError).toBe(true);

    // COUNT, then CONTENT. A renderer that printed the first event and
    // stopped satisfies any assertion made on the presence of one.
    expect(text).toContain('The 2 authoritative event(s)');
    for (const event of INTERVENING) {
      expect(text, `${event.id} must be rendered`).toContain(event.id);
      expect(text).toContain(`#${event.seq}`);
      expect(text).toContain(event.actor);
    }
    // The bodies, not a summary of them. This one carries the reason
    // the retry should not simply be repeated.
    expect(text).toContain('the endpoint 500s on an empty body');
    expect(text).toContain('needs a rebase');
    expect(text).toContain('"decision": "unmet"');
    // The revision caption rides whole — a bare id here is a derived
    // value rendering bare, in the one payload with no second call
    // available to resolve it.
    expect(text).toContain('sha-b (observed, from integration:github');
    // And what to do next, with the number to use.
    expect(text).toContain('Retry with expected_state_rev=4');
  });

  it('renders every uncovered criterion of a coverage gap, with why', async () => {
    seedContract();
    fakeBrokerSpine.refuseNext = {
      status: 409,
      body: {
        error: 'contract evt_contract_1 cannot complete at sha-a: 2 of 2 criteria are not covered',
        code: 'coverage_gap',
        detail: {
          contract: CONTRACT,
          revision: {
            subject: 'repo:acme',
            value: 'sha-a',
            how: 'observed',
            source: 'integration:github',
          },
          missing: [
            {
              criterion: 'c1',
              text: 'the endpoint returns 200',
              why: 'the current verdict evt_v1 says unmet at sha-a',
            },
            {
              criterion: 'c2',
              text: 'and logs the request id',
              why: 'no verdict has been reached on this criterion at sha-a',
            },
          ],
        },
      },
    };
    const { text, isError } = await call('contract_complete', {
      contract: CONTRACT,
      result: 'shipped',
      expected_state_rev: 2,
      cites: [],
      revision: { value: 'sha-a', how: 'observed', source: 'integration:github' },
    });
    expect(isError).toBe(true);
    // BOTH of them, with the criterion text and the reason. This list
    // is the shortest description of what is left to do.
    expect(text).toContain('c1: the endpoint returns 200');
    expect(text).toContain('the current verdict evt_v1 says unmet at sha-a');
    expect(text).toContain('c2: and logs the request id');
    expect(text).toContain('no verdict has been reached on this criterion at sha-a');
    expect(text).toContain('Uncovered at sha-a (observed, from integration:github)');
  });

  it('renders a citation refusal with the ask whole and both exits named', async () => {
    seedContract();
    fakeBrokerSpine.refuseNext = {
      status: 409,
      body: {
        error:
          'this attempt on repo:acme is a state-changing act, and you have 1 unresolved ask ' +
          'covering it. YOU DO NOT HAVE A RULING ON IT.',
        code: 'citation_required',
        detail: {
          subject: 'file:acme/api.ts',
          kind: 'attempt',
          contract: CONTRACT,
          scope: ['repo:acme', 'file:acme/api.ts'],
          asks: [
            {
              id: 'evt_ask_1',
              authority: 'andrewjon',
              asker: 'rune',
              subject: 'repo:acme',
              contract: null,
              question: 'may we drop the legacy header?',
              context: 'two callers still send it',
              unblocks: 'the whole migration',
              state: 'open',
              resolvedBy: null,
              at: '2026-08-09T09:00:00.000Z',
            },
          ],
        },
      },
    };
    const { text, isError } = await call('attempt_post', {
      contract: CONTRACT,
      summary: 'pushed the fix',
      expected_state_rev: 2,
      revision: { value: 'sha-a', how: 'asserted', source: 'member:rune' },
    });
    expect(isError).toBe(true);
    expect(text).toContain('YOU DO NOT HAVE A RULING');
    // The ask WHOLE: an id would invite the member to remember what
    // they asked, which is the failure the lock exists to close.
    expect(text).toContain('evt_ask_1');
    expect(text).toContain('question: may we drop the legacy header?');
    expect(text).toContain('context: two callers still send it');
    expect(text).toContain('unblocks: the whole migration');
    expect(text).toContain('awaiting andrewjon');
    // The containment that explains why an act on a file was refused.
    expect(text).toContain('Scope searched: repo:acme ⊃ file:acme/api.ts');
    // The truthful exit: a ruling RESOLVES the ask, so there is
    // nothing left to cite once it lands.
    expect(text).toMatch(/Get the ruling — that resolves the ask and releases you/);
    expect(text).toMatch(/`proceed` past the ask and say why/);
  });

  it('names the event a duplicated op id already resolved to', async () => {
    seedContract();
    fakeBrokerSpine.refuseNext = {
      status: 409,
      body: {
        error: 'op_id op-mine was already used for a different actor or payload',
        code: 'idempotency_conflict',
        detail: { opId: 'op-mine', originalEvent: 'evt_earlier' },
      },
    };
    const { text, isError } = await call('attempt_post', {
      contract: CONTRACT,
      summary: 'pushed the fix',
      expected_state_rev: 2,
      op_id: 'op-mine',
      revision: { value: 'sha-a', how: 'asserted', source: 'member:rune' },
    });
    expect(isError).toBe(true);
    expect(text).toContain('evt_earlier');
    expect(text).toMatch(/your write already landed/);
  });
});

// ─── orient, rendered ────────────────────────────────────────────────

describe('orient renders the whole pack', () => {
  it('renders bindings, criteria, staleness, rulings, asks and the cursor', async () => {
    fakeBrokerSpine.orient = {
      member: 'rune',
      at: '2026-08-09T09:05:00.000Z',
      cursor: 42,
      contracts: [
        {
          bindings: ['assignee'],
          contract: CONTRACT,
          title: 'Ship the endpoint',
          state: 'active',
          stateRev: 3,
          criteria: [
            {
              criterion: 'c1',
              text: 'the endpoint returns 200',
              decision: 'unmet',
              revision: {
                id: 'rev_1',
                subject: 'repo:acme',
                value: 'sha-a',
                how: 'observed',
                source: 'integration:github',
                at: '2026-08-09T09:01:00.000Z',
              },
              event: 'evt_v1',
              waivedBy: null,
              atBoundRevision: true,
            },
            {
              criterion: 'c2',
              text: 'and logs the request id',
              decision: null,
              revision: null,
              event: null,
              waivedBy: null,
              atBoundRevision: false,
            },
          ],
          subject: {
            id: 'repo:acme',
            type: 'repo',
            parent: null,
            registeredBy: 'lea',
            at: '2026-08-09T09:00:00.000Z',
          },
          revision: {
            id: 'rev_1',
            subject: 'repo:acme',
            value: 'sha-a',
            how: 'observed',
            source: 'integration:github',
            at: '2026-08-09T09:01:00.000Z',
          },
          stale: true,
          head: {
            id: 'rev_2',
            subject: 'repo:acme',
            value: 'sha-b',
            how: 'observed',
            source: 'integration:github',
            at: '2026-08-09T09:04:00.000Z',
          },
          rulings: [],
        },
      ],
      asksForMe: [],
      myOpenAsks: [
        {
          id: 'evt_ask_1',
          authority: 'andrewjon',
          asker: 'rune',
          subject: 'repo:acme',
          contract: null,
          question: 'may we drop the legacy header?',
          context: 'two callers still send it',
          unblocks: 'the whole migration',
          state: 'open',
          resolvedBy: null,
          at: '2026-08-09T09:00:00.000Z',
        },
      ],
    };
    const { text, isError } = await call('orient', {});
    expect(isError, text).toBe(false);

    expect(text).toContain('orient for rune');
    expect(text).toContain('annex cursor 42');
    expect(text).toContain('you are: assignee');
    // BOTH criteria, including the one nobody has judged — a renderer
    // that printed only the judged ones would hide the work left.
    expect(text).toContain('c1: unmet at sha-a');
    expect(text).toContain('the endpoint returns 200');
    expect(text).toContain('c2: no verdict yet');
    expect(text).toContain('and logs the request id');
    // Staleness, with both revisions, reported and not repaired.
    expect(text).toContain('STALE: the subject has since been observed at sha-b');
    expect(text).toContain('Reported, not repaired');
    // The member's own ask, and what it costs them.
    expect(text).toContain('your own open asks (1)');
    expect(text).toContain('may we drop the legacy header?');
    expect(text).toContain('cannot make state-changing acts');
    // The cursor, as a call they can make.
    expect(text).toContain('annex_read since_seq=42');
  });

  it('says an empty pack is a real state rather than returning nothing', async () => {
    fakeBrokerSpine.orient = {
      member: 'rune',
      at: '2026-08-09T09:05:00.000Z',
      cursor: 0,
      contracts: [],
      asksForMe: [],
      myOpenAsks: [],
    };
    const { text } = await call('orient', {});
    expect(text).toMatch(/No contracts bind you right now/);
    expect(text).toMatch(/a real state, not an empty read/);
  });
});

// ─── refusals the tool makes before spending a round trip ────────────

describe('the tool refuses what the annex would refuse, with the reason', () => {
  it('refuses `done` through state_set and points at contract_complete', async () => {
    const { text, isError } = await call('state_set', {
      contract: CONTRACT,
      state: 'done',
      expected_state_rev: 2,
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/completion goes through `contract_complete`/);
    expect(fakeBrokerSpine.appends).toEqual([]);
  });

  it('accepts every other lifecycle state, not merely one of them', async () => {
    // THE CONTROL, exercised across the whole list. Sampling one state
    // let a mutation shrink the handler's legal list to two and pass:
    // "a tool that refuses everything" is not the only failure — "a
    // tool that refuses four of six" satisfied it too.
    const extra: Record<string, Record<string, unknown>> = {
      active: {},
      waiting_on: { member: 'lea' },
      waiting_for: { event: 'the nightly build', check: 'CI reports green on main' },
      parked: { preempted_by: 'the incident' },
      cancelled: {},
      superseded: { successor: 'evt_successor' },
    };
    const accepted: string[] = [];
    for (const state of Object.keys(extra)) {
      const { isError, text } = await call('state_set', {
        contract: CONTRACT,
        state,
        reason: 'because',
        expected_state_rev: 2,
        ...extra[state],
      });
      expect(isError, `${state} must be accepted: ${text}`).toBe(false);
      accepted.push((lastAppend().body as { state: string }).state);
    }
    expect(accepted).toEqual([
      'active',
      'waiting_on',
      'waiting_for',
      'parked',
      'cancelled',
      'superseded',
    ]);
  });

  /**
   * The enum an agent reads and the check the handler applies are one
   * list, and together with `done` they must be every lifecycle state
   * there is. A new state that reached neither tool would be
   * unreachable through the surface with nothing to say so.
   */
  it('offers exactly the lifecycle states that are not completion', () => {
    const props = tool('state_set')?.inputSchema.properties as Record<string, { enum?: string[] }>;
    const offered = props.state?.enum ?? [];
    expect(offered).toEqual([
      'active',
      'waiting_on',
      'waiting_for',
      'parked',
      'cancelled',
      'superseded',
    ]);
    expect([...offered, 'done'].sort()).toEqual([...SpineContractStateSchema.options].sort());
  });

  it('refuses cannot_verify with no why, and accepts it with one', async () => {
    seedContract();
    const refused = await call('verdict_post', {
      contract: CONTRACT,
      criterion: 'c1',
      decision: 'cannot_verify',
      evidence: 'tried the deploy',
      expected_state_rev: 2,
      revision: { value: 'sha-a', how: 'observed', source: 'integration:github' },
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/indistinguishable from silence/);
    expect(fakeBrokerSpine.appends).toEqual([]);

    const accepted = await call('verdict_post', {
      contract: CONTRACT,
      criterion: 'c1',
      decision: 'cannot_verify',
      evidence: 'tried the deploy',
      why: 'no access to the deploy',
      expected_state_rev: 2,
      revision: { value: 'sha-a', how: 'observed', source: 'integration:github' },
    });
    expect(accepted.isError, accepted.text).toBe(false);
  });

  it('refuses a bare revision value and says what a revision is', async () => {
    seedContract();
    const { text, isError } = await call('attempt_post', {
      contract: CONTRACT,
      summary: 'pushed the fix',
      expected_state_rev: 2,
      revision: { value: 'sha-a' },
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/A bare value is not a revision/);
    expect(fakeBrokerSpine.appends).toEqual([]);
  });

  it('refuses an ask naming a contract with no precondition', async () => {
    const { text, isError } = await call('ask_author', {
      authority: 'andrewjon',
      question: 'ship on Friday?',
      context: 'tight window',
      unblocks: 'the release',
      contract: CONTRACT,
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/requires `expected_state_rev`/);
    expect(fakeBrokerSpine.appends).toEqual([]);
  });

  it('accepts the same ask without a contract, which is the control', async () => {
    const { isError } = await call('ask_author', {
      authority: 'andrewjon',
      question: 'ship on Friday?',
      context: 'tight window',
      unblocks: 'the release',
      subject: 'repo:acme',
    });
    expect(isError).toBe(false);
    expect(lastAppend().kind).toBe('ask');
  });
});

// ─── the result of a write, rendered ─────────────────────────────────

describe('a write reports where the contract now stands', () => {
  it('renders the new state_rev, which is the number every description tells you to read back', async () => {
    // `SPINE_STATE_REV_RULE` tells an agent to send the counter "as you
    // last read it", and this line is where they last read it. It went
    // unrendered in every test until the fake broker could echo a
    // contract — two mutations deleting parts of this line survived a
    // green suite.
    seedContract();
    const { text, isError } = await call('attempt_post', {
      contract: CONTRACT,
      summary: 'pushed the fix',
      expected_state_rev: 2,
      revision: { value: 'sha-a', how: 'asserted', source: 'member:rune' },
    });
    expect(isError, text).toBe(false);
    expect(text).toContain(`contract ${CONTRACT} is now active at state_rev 2`);
    expect(text).toContain('pass that as expected_state_rev on your next write');
  });

  it('warns that the contract is stale, naming both revisions', async () => {
    seedContract();
    const contract = fakeBrokerSpine.contracts[CONTRACT] as Record<string, unknown>;
    contract.stale = true;
    contract.revision = {
      id: 'rev_1',
      subject: 'repo:acme',
      value: 'sha-a',
      how: 'asserted',
      source: 'member:rune',
      at: '2026-08-09T09:00:00.000Z',
    };
    contract.head = {
      id: 'rev_2',
      subject: 'repo:acme',
      value: 'sha-b',
      how: 'observed',
      source: 'integration:github',
      at: '2026-08-09T09:04:00.000Z',
    };
    const { text } = await call('attempt_post', {
      contract: CONTRACT,
      summary: 'pushed the fix',
      expected_state_rev: 2,
      revision: { value: 'sha-a', how: 'asserted', source: 'member:rune' },
    });
    // Both operands. A flag saying you are behind, without saying what
    // you are behind, is a derived value rendering bare.
    expect(text).toContain('STALE: it is bound to sha-a');
    expect(text).toContain('observed at sha-b (integration:github');
  });

  it('says plainly when a write was a replay rather than a second event', async () => {
    seedContract();
    fakeBrokerSpine.replayNext = true;
    const { text, isError } = await call('attempt_post', {
      contract: CONTRACT,
      summary: 'pushed the fix',
      expected_state_rev: 2,
      op_id: 'op-mine',
      revision: { value: 'sha-a', how: 'asserted', source: 'member:rune' },
    });
    expect(isError, text).toBe(false);
    // The honest answer to "did my write land twice".
    expect(text).toContain('REPLAY');
    expect(text).toContain('nothing was appended a second time');
  });

  it('omits the replay notice on a first write, which is the control', async () => {
    seedContract();
    const { text } = await call('attempt_post', {
      contract: CONTRACT,
      summary: 'pushed the fix',
      expected_state_rev: 2,
      revision: { value: 'sha-a', how: 'asserted', source: 'member:rune' },
    });
    expect(text).not.toContain('REPLAY');
  });
});

// ─── what an ask actually binds ──────────────────────────────────────

describe('ask_author tells the truth about what the ask binds', () => {
  it('names the scope when the ask has one', async () => {
    const { text } = await call('ask_author', {
      authority: 'andrewjon',
      question: 'may we drop the legacy header?',
      context: 'two callers still send it',
      unblocks: 'the migration',
      subject: 'repo:acme',
    });
    expect(text).toMatch(/THIS NOW BINDS YOU/);
    expect(text).toContain('repo:acme');
    expect(text).toMatch(/Getting the ruling releases you on its own/);
  });

  it('names the contract as the scope when that is what it carries', async () => {
    const { text } = await call('ask_author', {
      authority: 'andrewjon',
      question: 'ship on Friday?',
      context: 'tight window',
      unblocks: 'the release',
      contract: CONTRACT,
      expected_state_rev: 2,
    });
    expect(text).toMatch(/THIS NOW BINDS YOU/);
    expect(text).toContain(`contract ${CONTRACT}`);
  });

  it('says an unscoped ask binds NOTHING, rather than promising a lock it does not get', async () => {
    // An uncaptioned ask legitimately scopes nothing — subject and
    // contract are both optional by design. Telling its author "THIS
    // NOW BINDS YOU" taught them a protection they did not have, which
    // is worse than teaching them none: a member who believes the annex
    // is holding the line stops holding it themselves.
    const { text } = await call('ask_author', {
      authority: 'andrewjon',
      question: 'are we still targeting Friday?',
      context: 'no particular subject',
      unblocks: 'planning',
    });
    expect(text).not.toMatch(/THIS NOW BINDS YOU/);
    expect(text).toMatch(/does NOT bind your acts/);
    expect(text).toMatch(/Name a subject or a contract/);
  });

  it('says the same thing in the description an agent reads before calling', () => {
    const desc = describeOf('ask_author');
    expect(desc).toMatch(/only as far as it is scoped/);
    expect(desc).toMatch(/an ask carrying\s+neither scopes nothing/);
  });
});

// ─── promote cannot dodge the lock by inheriting a caption ───────────

describe('promote cannot move an act out of its contract’s scope', () => {
  it('is refused when the origin post’s caption points outside the contract', async () => {
    // The agent-reachable half of the dodge: `promote` defaults the new
    // event's subject to the origin post's. A post about `repo:other`
    // promoted into an attempt on a contract about `repo:acme` would
    // have been evaluated for the lock in the wrong scope entirely.
    fakeBrokerSpine.eventsById.evt_stray = {
      seq: 9,
      id: 'evt_stray',
      kind: 'discussion',
      class: 'ambient',
      subject: 'repo:other',
      revision: null,
      actor: 'rune',
      authoredBy: null,
      at: '2026-08-09T09:00:00.000Z',
      provenance: 'native',
      opId: null,
      cites: [],
      staplesTo: null,
      contract: CONTRACT,
      stateRev: null,
      body: { body: 'pushed the fix', contract: CONTRACT },
    };
    // The real annex refuses this; the fake stages that refusal so the
    // rendering an agent sees is what gets asserted.
    fakeBrokerSpine.refuseNext = {
      status: 400,
      body: {
        error:
          'this attempt names contract evt_contract_1, which is about repo:acme, but captions ' +
          'itself repo:other — a subject that is neither repo:acme nor contained in it.',
        code: 'invalid_input',
      },
    };
    const { text, isError } = await call('promote', {
      event: 'evt_stray',
      as: 'attempt',
      expected_state_rev: 2,
    });
    // The caption went out as the post's, which is what makes the
    // server-side rule load-bearing rather than decorative…
    expect(lastAppend().subject).toBe('repo:other');
    // …and the refusal is what the agent gets, naming both subjects.
    expect(isError).toBe(true);
    expect(text).toContain('repo:other');
    expect(text).toContain('repo:acme');
  });

  it('sends the contract’s own scope when the post carries none, which is the control', async () => {
    // Built whole rather than spread from a fixture defined in another
    // describe: a partial event fails the client's response schema one
    // layer before the handler, and the test would never reach the
    // branch it names.
    fakeBrokerSpine.eventsById.evt_plain = {
      seq: 9,
      id: 'evt_plain',
      kind: 'discussion',
      class: 'ambient',
      subject: null,
      revision: null,
      actor: 'cora',
      authoredBy: null,
      at: '2026-08-09T09:00:00.000Z',
      provenance: 'native',
      opId: null,
      cites: [],
      staplesTo: null,
      contract: CONTRACT,
      stateRev: null,
      body: { body: 'pushed the fix', contract: CONTRACT },
    };
    const { isError } = await call('promote', {
      event: 'evt_plain',
      as: 'attempt',
      expected_state_rev: 2,
    });
    expect(isError).toBe(false);
    // No caption at all, so the annex takes the contract's — which is
    // the scope the lock is evaluated in.
    expect(lastAppend().subject).toBeUndefined();
    expect((lastAppend().body as { contract: string }).contract).toBe(CONTRACT);
  });
});

// ─── the reader-side control ─────────────────────────────────────────

describe('subscribe is the reader-side control, and says what it cannot silence', () => {
  it('leads with the fact that the default is already quiet', () => {
    // #155 finding 1 was members drowning in fanout they never chose.
    // A member who does not know silence is the default will read the
    // noise as unavoidable and never reach for this tool at all, so
    // the default is the first thing the description states.
    const description = describeOf('subscribe');
    expect(description).toMatch(/default is already\s+\*\*?quiet|default is already quiet/i);
    expect(description).toContain('all');
    expect(description).toContain('lifecycle');
    expect(description).toContain('none');
    // The anti-misreading clause, named as a string because it is the
    // deliverable: a member must not believe an ask to them can be
    // switched off.
    expect(description).toMatch(/names you personally/i);
    expect(description).toMatch(/regardless of every\s+level/i);
  });

  it('sends the level the agent chose, for the contract it named', () => {
    fakeBrokerSpine.curatorConfig = {
      ...(fakeBrokerSpine.curatorConfig as Record<string, unknown>),
      subscriptions: [
        {
          member: 'rune',
          contract: CONTRACT,
          level: 'all',
          explicit: true,
          updatedBy: 'rune',
          updatedAt: '2026-08-09T09:00:00.000Z',
        },
      ],
    };
    return call('subscribe', { contract: CONTRACT, level: 'all' }).then(({ text, isError }) => {
      expect(isError).toBe(false);
      // What went OUT. A tool that sent the level under the wrong key
      // satisfies every assertion made on what came back.
      expect(fakeBrokerSpine.curatorWrites).toEqual([
        { subscription: { contract: CONTRACT, level: 'all' } },
      ]);
      expect(text).toContain(CONTRACT);
      expect(text).toContain('all');
      expect(text).toMatch(/never the contract text again/i);
    });
  });

  it('restates what `none` does NOT silence', async () => {
    fakeBrokerSpine.curatorConfig = {
      ...(fakeBrokerSpine.curatorConfig as Record<string, unknown>),
      subscriptions: [
        {
          member: 'rune',
          contract: CONTRACT,
          level: 'none',
          explicit: true,
          updatedBy: 'rune',
          updatedAt: '2026-08-09T09:00:00.000Z',
        },
      ],
    };
    const { text } = await call('subscribe', { contract: CONTRACT, level: 'none' });
    expect(text).toMatch(/names you personally still\s+reaches you/i);
    expect(text).toMatch(/cannot be switched off/i);
  });

  it('refuses a level outside the three, and accepts the nearest valid one', async () => {
    const bad = await call('subscribe', { contract: CONTRACT, level: 'everything' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('all, lifecycle, none');
    expect(fakeBrokerSpine.curatorWrites).toHaveLength(0);
    // The positive control: the check still admits what it should.
    const good = await call('subscribe', { contract: CONTRACT, level: 'lifecycle' });
    expect(good.isError).toBe(false);
    expect(fakeBrokerSpine.curatorWrites).toHaveLength(1);
  });
});
