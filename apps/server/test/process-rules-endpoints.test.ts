/**
 * Process rule endpoints — the authority gate and the retrieval seam.
 *
 * Criterion 5 is "amendable by the permission, not the role", so both
 * branches are asserted: a member the rule BINDS but who lacks the
 * permission is refused, and a member who holds it may amend whether or
 * not the rule binds them.
 *
 * Criterion 4 is "history retrievable, not resident" — the list
 * response must not carry amendments, and history must be its own call.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import type { ProcessRule, ProcessRuleAmendment } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { createSqliteProcessRulesStore } from '../src/process-rules.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const LEA = 'csuite_test_lea_process_token';
const CORA = 'csuite_test_cora_process_token';

const RULE = 'I can release patches mid sprint but minors end of sprint.';
const RULE_V2 =
  'The release happens when the work for the release is done, not when some work for the release is done.';

function makeApp() {
  const broker = new Broker({ eventLog: new InMemoryEventLog(), now: () => 1_700_000_000_000 });
  const members = createMemberStore([
    // Holds the authority.
    {
      name: 'lea',
      role: { title: 'lead', description: '' },
      permissions: ['objectives.create'],
      token: LEA,
    },
    // Bound by every rule, holds no authority over any of them.
    { name: 'cora', role: { title: 'engineer', description: '' }, permissions: [], token: CORA },
  ]);
  const db = openDatabase(':memory:');
  const processRules = createSqliteProcessRulesStore(db);
  const { app } = createApp({
    broker,
    members,
    tokens: createTokenStoreFromMembers(db, members),
    sessions: new SessionStore(db),
    teamStore: mockTeamStore({ name: 'demo-team', context: '', permissionPresets: {} }),
    processRules,
    version: '0.0.0',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { app, processRules, broker };
}

function authed(token: string, body?: unknown): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = body !== undefined ? 'POST' : 'GET';
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

async function seed(app: ReturnType<typeof makeApp>['app']) {
  return app.request(
    '/process-rules',
    authed(LEA, {
      anchor: 'release-cadence',
      title: 'Release cadence',
      text: RULE,
      provenance: 'director',
      attribution: 'AndrewJon',
    }),
  );
}

describe('criterion 5 — the gate is the permission, not the role', () => {
  it('refuses a member the rule binds but who lacks the authority', async () => {
    const { app } = makeApp();
    await seed(app);
    const res = await app.request(
      '/process-rules/release-cadence/amend',
      authed(CORA, {
        text: RULE_V2,
        reason: 'r',
        disposition: 'correction',
        changeKind: 'refinement',
      }),
    );
    expect(res.status).toBe(403);
  });

  it('allows a holder of the authority', async () => {
    const { app } = makeApp();
    await seed(app);
    const res = await app.request(
      '/process-rules/release-cadence/amend',
      authed(LEA, {
        text: RULE_V2,
        reason: 'Director tightened it.',
        disposition: 'correction',
        changeKind: 'refinement',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rule: ProcessRule; amendment: ProcessRuleAmendment };
    expect(body.rule.text).toBe(RULE_V2);
    expect(body.rule.version).toBe(2);
    expect(body.amendment.changeKind).toBe('refinement');
  });

  it('lets a bound member READ every rule that binds them', async () => {
    // A rule you cannot read is a rule you cannot follow.
    const { app } = makeApp();
    await seed(app);
    const res = await app.request('/process-rules', authed(CORA));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rules: ProcessRule[] }).rules).toHaveLength(1);
  });
});

describe('criterion 4 — history is retrievable, not resident', () => {
  it('the list response carries no amendment history', async () => {
    const { app } = makeApp();
    await seed(app);
    for (let i = 0; i < 5; i += 1) {
      await app.request(
        '/process-rules/release-cadence/amend',
        authed(LEA, {
          text: `revision ${i}`,
          reason: 'churn',
          disposition: 'correction',
          changeKind: 'wording',
        }),
      );
    }
    const listed = await (await app.request('/process-rules', authed(CORA))).text();
    // Five amendments happened; none of their text is in what a member
    // is served. This is what keeps the injected block bounded.
    expect(listed).not.toContain('churn');
    expect(listed).not.toContain('revision 0');
    expect(listed).toContain('revision 4'); // current state only

    const history = (await (
      await app.request('/process-rules/release-cadence/history', authed(CORA))
    ).json()) as { amendments: ProcessRuleAmendment[] };
    expect(history.amendments).toHaveLength(5);
    expect(history.amendments[0]?.previous.text).toBe(RULE);
  });

  it('404s history for a rule that does not exist', async () => {
    const { app } = makeApp();
    const res = await app.request('/process-rules/nope/history', authed(CORA));
    expect(res.status).toBe(404);
  });
});

describe('a disputed rule is served, and says what is disputed', () => {
  it('refuses to create one without a reason, and serves one that has it', async () => {
    const { app } = makeApp();
    const bad = await app.request(
      '/process-rules',
      authed(LEA, {
        anchor: 'merge-model',
        title: 'Who merges',
        text: 'Verifier merges; the director gates the release.',
        provenance: 'unattributed',
        status: 'disputed',
      }),
    );
    expect(bad.status).toBe(400);

    const ok = await app.request(
      '/process-rules',
      authed(LEA, {
        anchor: 'merge-model',
        title: 'Who merges',
        text: 'Verifier merges; the director gates the release.',
        provenance: 'unattributed',
        status: 'disputed',
        disputeReason: 'Observed practice contradicts it; director to settle.',
      }),
    );
    expect(ok.status).toBe(201);

    const rules = (
      (await (await app.request('/process-rules', authed(CORA))).json()) as {
        rules: ProcessRule[];
      }
    ).rules;
    const disputed = rules.find((r) => r.anchor === 'merge-model');
    expect(disputed?.status).toBe('disputed');
    expect(disputed?.disputeReason).toContain('director to settle');
  });
});

describe('criterion 7 — an amendment takes effect with nobody broadcasting it', () => {
  it('a member who never saw an announcement receives the current rule', async () => {
    // The negative control, and the point of the objective. Nothing is
    // pushed, posted or announced: the member fetches a briefing and
    // the current text is simply there.
    const { app, broker } = makeApp();
    await seed(app);

    const before = (await (await app.request('/briefing', authed(CORA))).json()) as {
      processRules: ProcessRule[];
    };
    expect(before.processRules[0]?.text).toBe(RULE);

    // Count everything the broker has emitted, so "no broadcast" is
    // asserted rather than assumed.
    const emitted: unknown[] = [];
    const originalPush = broker.push.bind(broker);
    broker.push = (async (...args: unknown[]) => {
      emitted.push(args);
      return originalPush(...(args as Parameters<typeof originalPush>));
    }) as typeof broker.push;

    await app.request(
      '/process-rules/release-cadence/amend',
      authed(LEA, {
        text: RULE_V2,
        reason: 'Director tightened it.',
        disposition: 'correction',
        changeKind: 'refinement',
      }),
    );

    // Nothing was announced to anyone.
    expect(emitted).toHaveLength(0);

    // And the member — who saw nothing — gets the new text on their
    // next briefing, with the version moved so they can tell.
    const after = (await (await app.request('/briefing', authed(CORA))).json()) as {
      processRules: ProcessRule[];
    };
    expect(after.processRules[0]?.text).toBe(RULE_V2);
    expect(after.processRules[0]?.version).toBe(2);
    expect(after.processRules[0]?.anchor).toBe('release-cadence');
  });

  it('a broker with no rules serves an empty list, not a missing field', async () => {
    // Absent and empty must not be the same observation for a client:
    // `.default([])` makes an older broker parse, and this asserts a
    // current broker is explicit rather than relying on that.
    const { app } = makeApp();
    const briefing = (await (await app.request('/briefing', authed(CORA))).json()) as {
      processRules: ProcessRule[];
    };
    expect(Array.isArray(briefing.processRules)).toBe(true);
    expect(briefing.processRules).toHaveLength(0);
  });
});
