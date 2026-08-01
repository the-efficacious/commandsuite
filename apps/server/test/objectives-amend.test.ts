/**
 * Objective contract amendment.
 *
 * The defect this closes, measured on the live record: `obj-ms9kcbqc-2`
 * is `done`, and its `outcome` field still contains criterion 7 — the
 * one struck at 23:22:52 on 2026-07-31 because *"it asserts a
 * consequence that does not occur"*. The durable field makes a false
 * security claim and the retraction is a chat message.
 *
 * The three fixtures below are that record's actual text, read out of
 * the team database rather than invented:
 *
 *   struck     obj-ms9kcbqc-2 criterion 7
 *   narrowed   obj-ms9kcbqc-2 criterion 3
 *   split      obj-ms99co3o-f criterion 3, whose two clauses resolved
 *              differently — ruled not-met, then REVERSED to met 45
 *              seconds later. That reversal is the reason amendments
 *              are a sequence rather than a nullable `previous` column.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import type { Objective, ObjectiveEvent, Team } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { createSqliteObjectivesStore } from '../src/objectives.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const LEA = 'csuite_test_lea_amend_token';
const RUNE = 'csuite_test_rune_amend_token';
const CAROL = 'csuite_test_carol_amend_token';

const TEAM: Team = { name: 'demo-team', context: '', permissionPresets: {} };

/** Verbatim from `obj-ms9kcbqc-2`, the criterion Lea struck. */
const STRUCK_CRITERION =
  '7. **The result states that stored request bodies become un-redacted.** Verbatim spool bytes ' +
  'become authoritative, so registered secret values stop being scrubbed from `raw_exchange`. ' +
  'Documented design, unstated consequence — **AndrewJon rules before merge.**';

/** Verbatim from `obj-ms9kcbqc-2`, the criterion narrowed in the same message. */
const NARROWED_BEFORE =
  '3. **`refs.length` counts refs whose bytes became the stored body**, not substitutions ' +
  'attempted. Ack and unlink are both gated on it.';
const NARROWED_AFTER =
  '3. **`refs.length` counts refs whose bytes became the sole forwarded `body`** — the boundary ' +
  'the relay can actually observe. Ack and unlink are both gated on it.';

/** Verbatim from `obj-ms99co3o-f`, the two-clause criterion. */
const SPLIT_CRITERION =
  "3. **A quarantined file is not counted as unacked capture** in Turner's Phase 3, without the " +
  'log-join being the only way to tell.';

function makeApp() {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: (() => {
      let n = 0;
      return () => `msg-${++n}`;
    })(),
  });
  const members = createMemberStore([
    {
      name: 'lea',
      role: { title: 'lead', description: '' },
      permissions: ['objectives.create', 'objectives.cancel', 'objectives.reassign'],
      token: LEA,
    },
    // Holds `objectives.create` AND is the assignee below. Amending
    // your own contract is allowed when you hold the permission — the
    // gate is the permission, not the role.
    {
      name: 'rune',
      role: { title: 'engineer', description: '' },
      permissions: ['objectives.create'],
      token: RUNE,
    },
    // Assignee WITHOUT the permission: the branch that must be refused.
    { name: 'carol', role: { title: 'engineer', description: '' }, permissions: [], token: CAROL },
  ]);
  for (const name of ['lea', 'rune', 'carol']) void broker.register(name);
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
  const objectives = createSqliteObjectivesStore(db);
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore(TEAM),
    objectives,
    version: '0.0.0',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { app, objectives };
}

function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = method ?? (body !== undefined ? 'POST' : 'GET');
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

async function createObjective(
  app: ReturnType<typeof makeApp>['app'],
  outcome: string,
  assignee = 'carol',
): Promise<Objective> {
  const res = await app.request(
    '/objectives',
    authed(LEA, { title: 'a contract', outcome, assignee }),
  );
  return (await res.json()) as Objective;
}

describe('criterion 1 — the gate is the permission, not the role', () => {
  it('refuses an assignee who does not hold objectives.create', async () => {
    const { app } = makeApp();
    const obj = await createObjective(app, STRUCK_CRITERION);
    const res = await app.request(
      `/objectives/${obj.id}/amend`,
      authed(CAROL, {
        outcome: 'rewritten by the executor',
        reason: 'r',
        disposition: 'correction',
      }),
    );
    expect(res.status).toBe(403);
  });

  it('allows an assignee who DOES hold objectives.create', async () => {
    // Looks wrong at a glance and is right: the constraint is "can
    // this member author contracts", not "is this member the executor".
    const { app } = makeApp();
    const obj = await createObjective(app, STRUCK_CRITERION, 'rune');
    const res = await app.request(
      `/objectives/${obj.id}/amend`,
      authed(RUNE, { outcome: 'amended by the assignee', reason: 'r', disposition: 'correction' }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Objective).outcome).toBe('amended by the assignee');
  });
});

describe('criteria 2 and 3 — current text directly, prior text recoverable', () => {
  it('replaces the struck criterion and keeps the superseded text in the log', async () => {
    const { app } = makeApp();
    const obj = await createObjective(app, STRUCK_CRITERION);

    const amended = (await (
      await app.request(
        `/objectives/${obj.id}/amend`,
        authed(LEA, {
          outcome: '7. STRUCK — it asserts a consequence that does not occur.',
          reason: 'Redaction is broker-side at otlp-parse.ts:147; #86 changes which body wins.',
          disposition: 'correction',
        }),
      )
    ).json()) as Objective;

    // Criterion 3: current text read straight off the record.
    expect(amended.outcome).toBe('7. STRUCK — it asserts a consequence that does not occur.');
    expect(amended.outcome).not.toContain('stop being scrubbed');
    expect(amended.outcomeVersion).toBe(2);

    // Criterion 2: the superseded text survives, verbatim.
    expect(amended.amendments).toHaveLength(1);
    const a = amended.amendments[0];
    if (a?.target !== 'contract') throw new Error('expected a contract amendment');
    expect(a.previous.outcome).toBe(STRUCK_CRITERION);
    expect(a.fields).toEqual(['outcome']);
    expect(a.disposition).toBe('correction');
    expect(a.reason).toContain('otlp-parse.ts:147');
  });

  it('records which fields changed, so an outcome move is distinguishable from a prose fix', async () => {
    const { app } = makeApp();
    const obj = await createObjective(app, NARROWED_BEFORE);
    const amended = (await (
      await app.request(
        `/objectives/${obj.id}/amend`,
        authed(LEA, {
          title: 'a contract, retitled',
          reason: 'wording only',
          disposition: 'correction',
        }),
      )
    ).json()) as Objective;
    const a = amended.amendments[0];
    if (a?.target !== 'contract') throw new Error('expected a contract amendment');
    expect(a.fields).toEqual(['title']);
    // The outcome did not move, and the record says so.
    expect(amended.outcome).toBe(NARROWED_BEFORE);
  });

  it('rejects an amendment that changes nothing rather than bumping the version', async () => {
    const { app } = makeApp();
    const obj = await createObjective(app, NARROWED_BEFORE);
    const res = await app.request(
      `/objectives/${obj.id}/amend`,
      authed(LEA, { outcome: NARROWED_BEFORE, reason: 'no-op', disposition: 'correction' }),
    );
    expect(res.status).toBe(400);
    expect(objectiveVersion(await createObjective(app, NARROWED_BEFORE))).toBe(1);
  });
});

function objectiveVersion(o: Objective): number {
  return o.outcomeVersion;
}

describe('criterion 6 — the three real amendments reproduce', () => {
  it('a narrowed criterion keeps both texts and orders them', async () => {
    const { app } = makeApp();
    const obj = await createObjective(app, NARROWED_BEFORE);
    const amended = (await (
      await app.request(
        `/objectives/${obj.id}/amend`,
        authed(LEA, {
          outcome: NARROWED_AFTER,
          reason: 'amended to the boundary the relay can actually observe',
          disposition: 'correction',
        }),
      )
    ).json()) as Objective;
    expect(amended.outcome).toBe(NARROWED_AFTER);
    const a = amended.amendments[0];
    if (a?.target !== 'contract') throw new Error('expected a contract amendment');
    expect(a.previous.outcome).toBe(NARROWED_BEFORE);
  });

  it('a criterion amended TWICE, where the second reverses the first, keeps both', async () => {
    // obj-ms99co3o-f criterion 3: ruled not-met at 00:19:24, reversed
    // to met at 00:20:09 after Lea verified UNMATCHED_PREDICATE
    // herself. A reader who sees only the final state learns the right
    // answer and nothing about how it was reached — so the reversal
    // has to survive, with its reason.
    const { app } = makeApp();
    const obj = await createObjective(app, SPLIT_CRITERION);

    await app.request(
      `/objectives/${obj.id}/amend`,
      authed(LEA, {
        outcome: `${SPLIT_CRITERION}\n\nRULING: the second clause is NOT met, and it is not #96's job to meet it.`,
        reason: "Turner's read is right and I verified the quote rather than taking it.",
        disposition: 'correction',
      }),
    );
    const reversed = (await (
      await app.request(
        `/objectives/${obj.id}/amend`,
        authed(LEA, {
          outcome: `${SPLIT_CRITERION}\n\nRULING REVERSED: the second clause IS met, via capture-health's UNMATCHED_PREDICATE.`,
          reason:
            "Reversing my ruling. Rune's mechanism is the reason; I verified UNMATCHED_PREDICATE rather than take it.",
          disposition: 'correction',
        }),
      )
    ).json()) as Objective;

    expect(reversed.outcomeVersion).toBe(3);
    expect(reversed.amendments).toHaveLength(2);

    // Both turns are legible, in order, each with its own reason.
    const [first, second] = reversed.amendments;
    if (first?.target !== 'contract' || second?.target !== 'contract') {
      throw new Error('expected two contract amendments');
    }
    expect(first.version).toBe(2);
    expect(second.version).toBe(3);
    expect(first.previous.outcome).toBe(SPLIT_CRITERION);
    expect(second.previous.outcome).toContain('NOT met');
    expect(second.reason).toContain('Reversing my ruling');
    // The superseded ruling is recoverable — not just the final one.
    expect(JSON.stringify(reversed.amendments)).toContain("not #96's job");
  });

  it('a reversal is a correction, not a scope change', async () => {
    // A naive reading files "I changed my mind" as forward-only. The
    // amender was WRONG, not changing requirements, so work is not
    // held to the superseded ruling.
    const { app } = makeApp();
    const obj = await createObjective(app, SPLIT_CRITERION);
    const amended = (await (
      await app.request(
        `/objectives/${obj.id}/amend`,
        authed(LEA, {
          outcome: 'reversed',
          reason: 'I was wrong',
          disposition: 'correction',
        }),
      )
    ).json()) as Objective;
    const a = amended.amendments[0];
    if (a?.target !== 'contract') throw new Error('expected a contract amendment');
    expect(a.disposition).toBe('correction');
  });
});

describe('criterion 7 — which contract was this work built against', () => {
  it('stamps the contract version on every lifecycle event', async () => {
    const { app } = makeApp();
    const obj = await createObjective(app, NARROWED_BEFORE);

    await app.request(
      `/objectives/${obj.id}/amend`,
      authed(LEA, {
        outcome: NARROWED_AFTER,
        reason: 'narrowed mid-flight',
        disposition: 'scope_change',
      }),
    );
    await app.request(`/objectives/${obj.id}/complete`, authed(CAROL, { result: 'delivered' }));

    const detail = (await (await app.request(`/objectives/${obj.id}`, authed(LEA))).json()) as {
      objective: Objective;
      events: ObjectiveEvent[];
    };
    const assigned = detail.events.find((e) => e.kind === 'assigned');
    const completed = detail.events.find((e) => e.kind === 'completed');
    // Assigned under v1, completed under v2 — stated, not inferred
    // from timestamps.
    expect(assigned?.payload.contractVersion).toBe(1);
    expect(completed?.payload.contractVersion).toBe(2);
  });
});

describe('criterion 4 — a lifecycle event is corrected by superseding, never rewriting', () => {
  it('records the correction and leaves the original event intact', async () => {
    // The measured instance: an objective completed at a PR head
    // rather than the merge SHA, where the author could only mark it
    // "provisional" in prose.
    const { app } = makeApp();
    const obj = await createObjective(app, NARROWED_BEFORE);
    await app.request(
      `/objectives/${obj.id}/complete`,
      authed(CAROL, { result: 'Outcome satisfied at 38198b0 in PR #106.' }),
    );

    const before = (await (await app.request(`/objectives/${obj.id}`, authed(LEA))).json()) as {
      events: ObjectiveEvent[];
    };
    const completed = before.events.find((e) => e.kind === 'completed');
    if (!completed) throw new Error('no completed event');

    const corrected = (await (
      await app.request(
        `/objectives/${obj.id}/correct-event`,
        authed(LEA, {
          eventTs: completed.ts,
          correction:
            'Completed at an approved PR head, before merge. The merge bar is satisfied by c8f0d18.',
          reason:
            'Lifecycle timing error: the outcome is a product property and main did not carry it.',
        }),
      )
    ).json()) as Objective;

    // Criterion 5: it is ON the objective, not in a discussion post.
    const a = corrected.amendments.find((x) => x.target === 'event');
    if (a?.target !== 'event') throw new Error('expected an event correction');
    expect(a.eventKind).toBe('completed');
    expect(a.eventTs).toBe(completed.ts);
    expect(a.correction).toContain('c8f0d18');

    // The original event is untouched, and the result still reads as
    // originally written — the correction supersedes, it does not
    // rewrite history.
    const after = (await (await app.request(`/objectives/${obj.id}`, authed(LEA))).json()) as {
      events: ObjectiveEvent[];
    };
    const stillThere = after.events.find((e) => e.kind === 'completed');
    expect(stillThere?.ts).toBe(completed.ts);
    expect(JSON.stringify(stillThere?.payload)).toContain('38198b0');

    // Correcting the record of what happened is not a contract change.
    expect(corrected.outcomeVersion).toBe(1);
  });

  it('refuses to correct an event that does not exist', async () => {
    const { app } = makeApp();
    const obj = await createObjective(app, NARROWED_BEFORE);
    const res = await app.request(
      `/objectives/${obj.id}/correct-event`,
      authed(LEA, { eventTs: 1, correction: 'x', reason: 'y' }),
    );
    expect(res.status).toBe(404);
  });
});
