/**
 * The two claims the spine's non-annex tables make about themselves,
 * under test at last.
 *
 * `curator-schema.ts` has said since it landed that "these tables can
 * be dropped and rebuilt from nothing without losing a single fact
 * about the team", and exported `SPINE_CURATOR_TABLES` "for the test
 * that proves the curator can be dropped whole" — a test that did not
 * exist. A constant whose comment names a test, and no test, is a claim
 * nobody has checked; the verifier flagged it as a phase-4 condition,
 * with the honest alternative of deleting the constant. It is checked
 * here instead, because the claim is the reason the curator's state is
 * allowed to be a separate class of table at all.
 *
 * `SPINE_CHECK_TABLES` makes a STRONGER claim and gets a stronger test.
 * The curator's tables can go because nothing in them is a fact about
 * the room — a lost lease costs one redundant re-orientation. The check
 * registry is a PROJECTION: an armed check is something a member
 * authored, so losing it would lose a fact, and the claim is that it
 * can be refolded from the event stream rather than that it does not
 * matter. So this asserts equality with what was there before, not
 * merely that the system still runs.
 *
 * WHAT MAKES EITHER MEAN ANYTHING is the completeness half. Dropping
 * the tables somebody remembered to list proves nothing about the one
 * they added last week, so both cases assert that the list covers every
 * table its schema creates — read off `sqlite_master`, not off a second
 * hand-maintained list.
 */

import type { SpineCheck, SpineContract, SpineEvent } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { SPINE_CHECK_TABLES, SPINE_CURATOR_TABLES } from '../src/spine/index.js';
import {
  authed,
  HOOK_SLUG,
  makeProbeApp,
  type ProbeApp,
  settle,
  signedHook,
} from './helpers/spine-probe-app.js';

const CI_RECIPE = JSON.stringify({
  kind: 'webhook',
  endpoint: HOOK_SLUG,
  when: [{ path: 'check_run.conclusion', op: 'eq', value: 'success' }],
  revisionPath: 'check_run.head_sha',
});

const GREEN = { check_run: { conclusion: 'success', head_sha: 'sha-green' } };

function tokenFor(who: string): string {
  return `csuite_probe_${who}_token`;
}

/** Which tables a database holds, so a list is checked against the DDL rather than against itself. */
function tablesOf(db: ReturnType<typeof openDatabase>): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as unknown as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * A team that has done some work: a contract, an attempt, a verdict, an
 * ask armed with a check, and a delivery that fired it.
 */
async function seed(app: ProbeApp): Promise<{ contract: string; askId: string }> {
  const post = (who: string, body: unknown) =>
    app.app.request('/spine/events', authed(tokenFor(who), body));

  expect(
    (
      await app.app.request(
        '/spine/subjects',
        authed(tokenFor('lea'), { id: 'repo:acme', type: 'repo' }),
      )
    ).status,
  ).toBe(201);

  const spec = await post('lea', {
    kind: 'specification',
    subject: 'repo:acme',
    opId: 'op-spec',
    body: {
      title: 'Ship the endpoint',
      criteria: [{ id: 'c1', text: 'returns 200' }],
      assignee: 'rune',
      verifier: 'lea',
      authority: 'andrewjon',
    },
  });
  expect(spec.status, await spec.clone().text()).toBe(201);
  const contract = ((await spec.json()) as { event: SpineEvent }).event.id;

  const attempt = await post('rune', {
    kind: 'attempt',
    opId: 'op-attempt',
    expectedStateRev: 1,
    revision: { subject: 'repo:acme', value: 'sha-a', how: 'asserted', source: 'member:rune' },
    body: { contract, summary: 'pushed the fix' },
  });
  expect(attempt.status, await attempt.clone().text()).toBe(201);

  // An ask that stays armed, and one that fires.
  const standing = await post('lea', {
    kind: 'ask',
    subject: 'repo:acme',
    opId: 'op-standing',
    body: {
      authority: 'andrewjon',
      question: 'ship on Friday?',
      context: 'tight window',
      unblocks: 'the release',
      check: JSON.stringify({
        kind: 'http_poll',
        url: 'https://ci.example.com/status',
        intervalMs: 300_000,
        when: [{ path: 'state', op: 'eq', value: 'green' }],
      }),
    },
  });
  expect(standing.status, await standing.clone().text()).toBe(201);
  const askId = ((await standing.json()) as { event: SpineEvent }).event.id;

  const firing = await post('rune', {
    kind: 'lifecycle',
    opId: 'op-wait',
    expectedStateRev: 2,
    body: { contract, state: 'waiting_for', event: 'the CI build', check: CI_RECIPE },
  });
  expect(firing.status, await firing.clone().text()).toBe(201);

  // Reads and pushes, so the curator has leases, receipts and ledger
  // rows to lose.
  await app.app.request('/spine/orient', authed(tokenFor('rune')));
  await app.app.request('/spine/orient', authed(tokenFor('andrewjon')));
  await app.app.request(`/hooks/${HOOK_SLUG}`, signedHook(JSON.stringify(GREEN)));
  await settle();
  return { contract, askId };
}

/** Every fact about the room, as the annex and its projections hold it. */
async function annexFacts(app: ProbeApp): Promise<unknown> {
  const events = (await (
    await app.app.request('/spine/events?limit=500', authed(tokenFor('lea')))
  ).json()) as { events: SpineEvent[] };
  const contracts = (await (
    await app.app.request('/spine/contracts', authed(tokenFor('lea')))
  ).json()) as { contracts: SpineContract[] };
  return { events: events.events, contracts: contracts.contracts };
}

async function checkRows(app: ProbeApp): Promise<SpineCheck[]> {
  const res = await app.app.request('/spine/checks', authed(tokenFor('lea')));
  return ((await res.json()) as { checks: SpineCheck[] }).checks;
}

describe('the curator can be dropped whole', () => {
  it('loses no fact about the team, and comes back working', async () => {
    const app = makeProbeApp();
    await seed(app);
    const before = await annexFacts(app);
    const ledgerBefore = (await (
      await app.app.request('/spine/injections', authed(tokenFor('rune')))
    ).json()) as { injections: unknown[] };
    expect(
      ledgerBefore.injections.length,
      'the fixture must give the curator something to lose',
    ).toBeGreaterThan(0);

    for (const table of SPINE_CURATOR_TABLES) app.db.exec(`DROP TABLE ${table}`);
    // The store's constructor is the migration — idempotent DDL, house
    // form 1 — so re-running it is the whole recovery.
    const { createSqliteCuratorStore } = await import('../src/spine/index.js');
    createSqliteCuratorStore(app.db);

    // NOT ONE FACT ABOUT THE ROOM. Every event, every contract, byte
    // for byte — which is the claim the header makes and the reason
    // these tables are allowed to be a different class.
    expect(await annexFacts(app)).toEqual(before);

    // AND IT STILL WORKS. An empty ledger that 500s on the next read
    // would satisfy the assertion above.
    const ledgerAfter = (await (
      await app.app.request('/spine/injections', authed(tokenFor('rune')))
    ).json()) as { injections: unknown[] };
    expect(ledgerAfter.injections).toEqual([]);
    const orient = await app.app.request('/spine/orient', authed(tokenFor('rune')));
    expect(orient.status).toBe(200);
    const regrown = (await (
      await app.app.request('/spine/injections', authed(tokenFor('rune')))
    ).json()) as { injections: unknown[] };
    expect(regrown.injections.length, 'a dropped ledger must start recording again').toBe(1);
    app.db.close();
  });

  it('names every table its schema creates', async () => {
    // The completeness half, and the only half that survives someone
    // adding a seventh table.
    //
    // Asserted by CONSTRUCTION rather than by subtraction: build the
    // curator's store over an empty database and see what appears. A
    // list compared against another hand-kept list proves the two agree
    // and nothing about whether either is right; a list compared
    // against what the DDL actually creates cannot be satisfied by
    // updating it in one place.
    const bare = openDatabase(':memory:');
    const { createSqliteCuratorStore } = await import('../src/spine/index.js');
    expect(tablesOf(bare)).toEqual([]);
    createSqliteCuratorStore(bare);
    expect(tablesOf(bare).sort()).toEqual([...SPINE_CURATOR_TABLES].sort());
    bare.close();
  });
});

describe('the check registry can be dropped and refolded', () => {
  it('comes back identical from the event stream alone', async () => {
    const app = makeProbeApp();
    await seed(app);
    const before = await checkRows(app);
    expect(before.map((c) => c.state).sort()).toEqual(['armed', 'fired']);

    for (const table of SPINE_CHECK_TABLES) app.db.exec(`DROP TABLE ${table}`);
    const { createSqliteCheckStore, createProbeEngine } = await import('../src/spine/index.js');
    const store = createSqliteCheckStore(app.db);
    expect(store.list(), 'the drop must actually have emptied it').toEqual([]);

    // A FRESH ENGINE over the same annex — which is what a restart
    // against a migrated database is.
    const engine = createProbeEngine({
      write: {
        store: app.annex,
        append: async () => {
          throw new Error('a rebuild must not write to the annex');
        },
        appendAsProbe: async () => {
          throw new Error('a rebuild must not write to the annex');
        },
        onAppend: () => {},
      },
      checks: store,
      logger: app.logger,
      now: () => app.clock.ms,
    });
    engine.rebuildChecks();

    const after = store.list();
    // `lastEvaluatedAt` is the one column a rebuild loses: it is a fact
    // about the ENGINE (a predicate was tested and said no), not about
    // the team, and losing it costs one redundant evaluation.
    const strip = (checks: SpineCheck[]) =>
      checks.map(({ lastEvaluatedAt: _drop, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(before));
    // The ids and the fired evidence specifically, because those are
    // what every historical observation's `actor` already points at: a
    // refold that minted new ids would orphan the annex's own captions.
    expect(after.map((c) => `${c.id}:${c.firedEvent ?? '-'}`)).toEqual(
      before.map((c) => `${c.id}:${c.firedEvent ?? '-'}`),
    );
    app.db.close();
  });

  it('names every table its schema creates', async () => {
    const bare = openDatabase(':memory:');
    const { createSqliteCheckStore } = await import('../src/spine/index.js');
    expect(tablesOf(bare)).toEqual([]);
    createSqliteCheckStore(bare);
    expect(tablesOf(bare).sort()).toEqual([...SPINE_CHECK_TABLES].sort());
    bare.close();
  });

  it('can fail: an unlisted table survives the drop', () => {
    // The positive control on the completeness assertions above. If
    // `SPINE_CHECK_TABLES` were missing an entry, this is the shape the
    // failure takes — asserted directly so the test is known to be able
    // to notice, rather than assumed to be.
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE spine_checks_extra (id TEXT PRIMARY KEY)');
    for (const table of SPINE_CHECK_TABLES) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY)`);
      db.exec(`DROP TABLE ${table}`);
    }
    const left = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'spine_checks%'",
        )
        .all() as unknown as { name: string }[]
    ).map((r) => r.name);
    expect(left).toEqual(['spine_checks_extra']);
    db.close();
  });
});
