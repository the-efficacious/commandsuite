/**
 * The spine over HTTP — the gate, the error mapping, and the reads.
 *
 * THE CONSUMER HERE IS A CLIENT, so what gets asserted is the STATUS
 * CODE AND THE BODY, never a handler's return value. A store that
 * refuses correctly behind a route that answers 200 is a green suite
 * and a broken product.
 *
 * The gate is `spine.author`, and it is asserted in both directions
 * with a third member who holds every OTHER leaf — the gate is this
 * leaf, not seniority, and a fixture without a senior non-holder
 * cannot tell those apart.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import type { ListSpineEventsResponse, OrientPack, SpineEvent } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import {
  ANDREWJON,
  authed,
  CORA,
  get,
  LEA,
  makeSpineApp,
  post,
  RUNE,
  type SpineApp,
} from './helpers/spine-app.js';

let app: SpineApp;

const SPEC = {
  kind: 'specification',
  subject: 'repo:acme',
  opId: 'op-spec',
  body: {
    title: 'Ship the endpoint',
    criteria: [{ id: 'c1', text: 'the endpoint returns 200' }],
    assignee: 'rune',
    verifier: 'lea',
    authority: 'andrewjon',
  },
};

beforeEach(async () => {
  app = makeSpineApp().app;
  await post(app, '/spine/subjects', LEA, { id: 'repo:acme', type: 'repo' });
});

async function authorContract(): Promise<string> {
  return ((await post(app, '/spine/events', LEA, SPEC)).event as SpineEvent).id;
}

// ─────────────────────────────────────────────────────────────────────

describe('the routes register only when the store is injected', () => {
  it('404s the whole surface on a broker with no spine', async () => {
    const members = createMemberStore([
      { name: 'lea', role: { title: 'lead', description: '' }, permissions: [], token: LEA },
    ]);
    const db = openDatabase(':memory:');
    const { app: bare } = createApp({
      broker: new Broker({ eventLog: new InMemoryEventLog() }),
      members,
      tokens: createTokenStoreFromMembers(db, members),
      sessions: new SessionStore(db),
      teamStore: { getTeam: () => ({ name: 't', context: '', permissionPresets: {} }) } as never,
      version: '0.0.0',
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    for (const path of ['/spine/events', '/spine/orient', '/spine/subjects', '/spine/contracts']) {
      expect((await bare.request(path, authed(LEA))).status, path).toBe(404);
    }
  });
});

describe('the write gate is spine.author and nothing else', () => {
  it('lets the holder author and amend', async () => {
    const contract = await authorContract();
    await post(app, '/spine/events', LEA, {
      kind: 'amendment',
      opId: 'op-amend',
      expectedStateRev: 1,
      body: {
        contract,
        changes: 'tightened the criterion',
        reason: 'the original was ambiguous',
        disposition: 'correction',
        criteria: [{ id: 'c1', text: 'the endpoint returns 200 with a JSON body' }],
      },
    });
    const one = (await get(app, `/spine/contracts/${contract}`, RUNE)).contract as {
      version: number;
      criteria: { text: string }[];
    };
    expect(one.version).toBe(2);
    expect(one.criteria[0]?.text).toBe('the endpoint returns 200 with a JSON body');
  });

  it('refuses authoring to a member holding every OTHER leaf', async () => {
    const res = await app.request('/spine/events', authed(ANDREWJON, SPEC));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'requires spine.author' });
  });

  it('refuses amendment to a member holding every OTHER leaf', async () => {
    const contract = await authorContract();
    const res = await app.request(
      '/spine/events',
      authed(ANDREWJON, {
        kind: 'amendment',
        opId: 'op-amend',
        expectedStateRev: 1,
        body: {
          contract,
          changes: 'rewrite',
          reason: 'because',
          disposition: 'scope_change',
          title: 'Something else entirely',
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'requires spine.author' });
  });

  it('gates NOTHING else — a member with no leaves is a full participant', async () => {
    const contract = await authorContract();
    // Every one of these is baseline participation. A gate that had
    // crept onto any of them would fail here rather than being
    // discovered by a member who could not do their job.
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-attempt',
      expectedStateRev: 1,
      revision: { subject: 'repo:acme', value: 'sha-a', how: 'asserted', source: 'member:rune' },
      body: { contract, summary: 'pushed the fix' },
    });
    await post(app, '/spine/events', RUNE, {
      kind: 'discussion',
      body: { body: 'the handler was deliberate; see the 2024 thread', contract },
    });
    await post(app, '/spine/events', RUNE, {
      kind: 'ask',
      opId: 'op-ask',
      subject: 'repo:acme',
      body: {
        authority: 'andrewjon',
        question: 'ship on Friday?',
        context: 'tight window',
        unblocks: 'the release',
      },
    });
    await post(app, '/spine/events', CORA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 2,
      revision: {
        subject: 'repo:acme',
        value: 'sha-a',
        how: 'observed',
        source: 'integration:github',
      },
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });
    await post(app, '/spine/events', RUNE, {
      kind: 'lifecycle',
      opId: 'op-done',
      expectedStateRev: 3,
      revision: { subject: 'repo:acme', value: 'sha-a', how: 'asserted', source: 'member:rune' },
      cites: [
        (
          (await get(
            app,
            `/spine/events?kind=criterion_verdict`,
            RUNE,
          )) as unknown as ListSpineEventsResponse
        ).events[0]?.id as string,
      ],
      body: { contract, state: 'done', result: 'shipped' },
    });
    expect(
      ((await get(app, `/spine/contracts/${contract}`, RUNE)).contract as { state: string }).state,
    ).toBe('done');
  });
});

describe('the typed error mapping', () => {
  it('403s a structurally illegitimate verdict, and 201s the same one from anyone else', async () => {
    const contract = await authorContract();
    const res = await app.request(
      '/spine/events',
      authed(RUNE, {
        kind: 'criterion_verdict',
        opId: 'op-self-verdict',
        expectedStateRev: 1,
        revision: {
          subject: 'repo:acme',
          value: 'sha-a',
          how: 'observed',
          source: 'integration:github',
        },
        body: { contract, criterion: 'c1', decision: 'met', evidence: 'trust me' },
      }),
    );
    // 403 rather than 400: the payload is perfectly well formed, and
    // telling an agent to fix a payload that is already right costs it
    // a turn and teaches it nothing.
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('not_permitted');
    expect(body.error).toContain('assignee');
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: {
        subject: 'repo:acme',
        value: 'sha-a',
        how: 'observed',
        source: 'integration:github',
      },
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green' },
    });
  });

  it('404s an event about a contract that does not exist', async () => {
    const res = await app.request(
      '/spine/events',
      authed(RUNE, {
        kind: 'attempt',
        opId: 'op-attempt',
        expectedStateRev: 1,
        body: { contract: 'evt_nope', summary: 'working on a ghost' },
      }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');
  });

  it('400s a payload the schema refuses, and names the field', async () => {
    const res = await app.request(
      '/spine/events',
      authed(LEA, {
        kind: 'criterion_verdict',
        opId: 'op-cv',
        expectedStateRev: 1,
        revision: {
          subject: 'repo:acme',
          value: 'sha-a',
          how: 'observed',
          source: 'integration:github',
        },
        body: { contract: 'evt_x', criterion: 'c1', decision: 'cannot_verify', evidence: 'e' },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: { path: unknown[] }[] };
    expect(body.error).toBe('invalid spine event');
    // The field, so the caller can fix it rather than re-reading the
    // whole schema.
    expect(JSON.stringify(body.details)).toContain('why');
  });

  it('400s an event naming a member who is not on the team', async () => {
    const res = await app.request(
      '/spine/events',
      authed(LEA, { ...SPEC, body: { ...SPEC.body, assignee: 'nobody' } }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'no such member: nobody' });
    // The nearest valid thing: the same spec with a real assignee.
    await post(app, '/spine/events', LEA, SPEC);
  });

  it('409s a stale precondition and keeps the delta on the response', async () => {
    const contract = await authorContract();
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-attempt',
      expectedStateRev: 1,
      body: { contract, summary: 'pushed' },
    });
    const res = await app.request(
      '/spine/events',
      authed(RUNE, {
        kind: 'attempt',
        opId: 'op-attempt-2',
        expectedStateRev: 1,
        body: { contract, summary: 'pushed again' },
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      detail: { intervening: SpineEvent[]; currentStateRev: number };
    };
    expect(body.code).toBe('stale_state_rev');
    // The `detail` has to survive the route. Dropping it turns "here
    // are the events you missed" into "something changed", which is
    // the whole difference between a refusal and a recovery.
    expect(body.detail.currentStateRev).toBe(2);
    expect(body.detail.intervening.map((e) => e.kind)).toEqual(['attempt']);
  });

  it('200s an idempotent replay and 201s a first write', async () => {
    const first = await app.request('/spine/events', authed(LEA, SPEC));
    expect(first.status).toBe(201);
    const replay = await app.request('/spine/events', authed(LEA, SPEC));
    expect(replay.status).toBe(200);
    const body = (await replay.json()) as { replayed: boolean };
    expect(body.replayed).toBe(true);
  });

  it('401s an unauthenticated call to every route', async () => {
    for (const path of ['/spine/events', '/spine/orient', '/spine/subjects', '/spine/contracts']) {
      expect((await app.request(path)).status, path).toBe(401);
    }
  });
});

describe('reads', () => {
  it('registers subjects and lists them with transitive containment', async () => {
    await post(app, '/spine/subjects', RUNE, {
      id: 'pr:acme/7',
      type: 'pr',
      parent: 'repo:acme',
    });
    await post(app, '/spine/subjects', RUNE, {
      id: 'file:acme/7/api.ts',
      type: 'file',
      parent: 'pr:acme/7',
    });
    const within = (await get(app, '/spine/subjects?within=repo:acme', CORA)) as {
      subjects: { id: string }[];
    };
    expect(within.subjects.map((s) => s.id).sort()).toEqual([
      'file:acme/7/api.ts',
      'pr:acme/7',
      'repo:acme',
    ]);
    const byType = (await get(app, '/spine/subjects?type=pr', CORA)) as {
      subjects: { id: string }[];
    };
    expect(byType.subjects.map((s) => s.id)).toEqual(['pr:acme/7']);
  });

  it('404s a subject registration whose parent is unregistered', async () => {
    const res = await app.request(
      '/spine/subjects',
      authed(RUNE, { id: 'file:x', type: 'file', parent: 'repo:ghost' }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');
  });

  it('lists contracts, filters by member, and 404s one that does not exist', async () => {
    const contract = await authorContract();
    const all = (await get(app, '/spine/contracts', CORA)) as { contracts: { id: string }[] };
    expect(all.contracts.map((c) => c.id)).toEqual([contract]);
    const mine = (await get(app, '/spine/contracts?member=rune', RUNE)) as {
      contracts: { id: string }[];
    };
    expect(mine.contracts.map((c) => c.id)).toEqual([contract]);
    // The negative direction: a member with no binding sees no
    // contracts, which is different from the filter being ignored.
    const theirs = (await get(app, '/spine/contracts?member=cora', CORA)) as {
      contracts: { id: string }[];
    };
    expect(theirs.contracts).toEqual([]);
    expect((await app.request('/spine/contracts/evt_nope', authed(CORA))).status).toBe(404);
  });

  it('400s an out-of-range page size and honours one inside it', async () => {
    await authorContract();
    expect((await app.request('/spine/events?limit=5000', authed(RUNE))).status).toBe(400);
    // The nearest valid thing, so this is not passing against a route
    // that refuses every limit.
    const page = (await get(
      app,
      '/spine/events?limit=500',
      RUNE,
    )) as unknown as ListSpineEventsResponse;
    expect(page.events).toHaveLength(1);
  });

  it('orients the CALLER and nobody else', async () => {
    await authorContract();
    const leaPack = (await get(app, '/spine/orient', LEA)) as unknown as OrientPack;
    expect(leaPack.member).toBe('lea');
    expect(leaPack.contracts.map((c) => c.bindings)).toEqual([['verifier']]);
    const runePack = (await get(app, '/spine/orient', RUNE)) as unknown as OrientPack;
    expect(runePack.member).toBe('rune');
    expect(runePack.contracts.map((c) => c.bindings)).toEqual([['assignee']]);
    // A member bound to nothing gets an empty pack rather than the
    // team's whole plate — the failure mode that made the predecessor's
    // list unusable.
    const coraPack = (await get(app, '/spine/orient', CORA)) as unknown as OrientPack;
    expect(coraPack.contracts).toEqual([]);
    expect(coraPack.cursor).toBe(leaPack.cursor);
  });
});
