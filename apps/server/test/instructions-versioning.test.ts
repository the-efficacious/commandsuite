/**
 * Instruction versioning — the canonical route + alias, the composed
 * hash, the edit fanout, and restart-pending.
 *
 * The load-bearing decisions under test:
 *
 *  - STRICT RIPPLE. "Affected" is whoever's canonical composed text
 *    changed, computed by hashing every member's composition before
 *    and after the edit — so a role edit reaches the teammates whose
 *    roster line moved, and a personal edit reaches exactly one
 *    member.
 *  - THE HASH IS CANONICAL. The broker/runner version line is
 *    normalized out, so a runner upgrade must never read as an
 *    instruction edit.
 *  - UNKNOWN IS NOT PENDING. A member whose issued hash the broker
 *    does not hold (never fetched, or broker restarted) is not listed
 *    restart-pending — the broker does not guess.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import { RUNNER_VERSION_HEADER } from 'csuite-sdk/protocol';
import type { InstructionBlockDescriptor } from 'csuite-sdk/types';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { composedInstructionsSha256 } from '../src/instructions.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { createSqliteProcessDocumentStore } from '../src/process-document.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN = 'csuite_test_admin_instrver_token';
const CORA = 'csuite_test_cora_instrver_token';
const RUNE = 'csuite_test_rune_instrver_token';

function makeApp() {
  const broker = new Broker({ eventLog: new InMemoryEventLog(), now: () => 1_700_000_000_000 });
  const members = createMemberStore([
    {
      name: 'andrewjon',
      role: { title: 'director', description: 'Owns the seam.' },
      permissions: ['team.manage', 'members.manage', 'process.manage'],
      token: ADMIN,
    },
    {
      name: 'cora',
      role: { title: 'engineer', description: 'Co-owns the broker.' },
      permissions: [],
      instructions: 'Sign your own work.',
      token: CORA,
    },
    {
      name: 'rune',
      role: { title: 'engineer', description: 'Verifies what cora writes.' },
      permissions: [],
      token: RUNE,
    },
  ]);
  const db = openDatabase(':memory:');
  const { app } = createApp({
    broker,
    members,
    tokens: createTokenStoreFromMembers(db, members),
    sessions: new SessionStore(db),
    teamStore: mockTeamStore({
      name: 'demo-team',
      context: 'We ship small and verify by mutating.',
      permissionPresets: {},
    }),
    processDocument: createSqliteProcessDocumentStore(db),
    persistMembers: () => {},
    version: '0.0.0',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const pushed: Array<{ body: string; data: Record<string, unknown>; recipients?: string[] }> = [];
  const originalPush = broker.push.bind(broker);
  broker.push = (async (payload, opts) => {
    pushed.push({
      body: (payload as { body: string }).body,
      data: (payload as { data: Record<string, unknown> }).data,
      ...(opts && 'recipients' in opts ? { recipients: (opts as { recipients: string[] }).recipients } : {}),
    });
    return originalPush(payload as never, opts as never);
  }) as typeof broker.push;
  return { app, broker, pushed };
}

function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = method ?? (body !== undefined ? 'PATCH' : 'GET');
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const instructionEvents = (pushed: Array<{ data: Record<string, unknown> }>) =>
  pushed.filter((p) => p.data?.kind === 'instructions');

// ─── the rename is a clean break, not an alias ───────────────────────

describe('GET /instructions replaced GET /briefing outright', () => {
  it('serves the packet on the new path and nothing on the old one', async () => {
    const { app } = makeApp();
    // Positive control first: the new path answers…
    const canonical = await app.request('/instructions', authed(CORA));
    expect(canonical.status).toBe(200);
    // …and the old path is GONE, not aliased. Removed with zero
    // deployed consumers; a 404 here is a stale client that must
    // upgrade, and it should fail loudly rather than quietly read an
    // alias that would then have to live forever.
    const removed = await app.request('/briefing', authed(CORA));
    expect(removed.status).toBe(404);
  });

  it('names each composed block by the sha256 of its exact text', async () => {
    const { app } = makeApp();
    const body = (await (await app.request('/instructions', authed(CORA))).json()) as {
      blocks: InstructionBlockDescriptor[];
      composedSha256: string;
    };
    expect(body.composedSha256).toMatch(/^[0-9a-f]{64}$/);
    // The descriptor is the hash of the authored text, verifiable by
    // an outside party holding the text — not an opaque counter.
    expect(body.blocks).toContainEqual({
      kind: 'team_context',
      sha256: sha256('We ship small and verify by mutating.'),
    });
    expect(body.blocks).toContainEqual({
      kind: 'personal_instructions',
      sha256: sha256('Sign your own work.'),
    });
  });

  it('keeps composedSha256 identical across different reported runner versions', async () => {
    const { app } = makeApp();
    const withVersion = (v: string): RequestInit => ({
      headers: { Authorization: `Bearer ${CORA}`, [RUNNER_VERSION_HEADER]: v },
    });
    const first = (await (await app.request('/instructions', withVersion('0.3.4'))).json()) as {
      composedSha256: string;
      instructions: string;
    };
    const second = (await (await app.request('/instructions', withVersion('0.9.9'))).json()) as {
      composedSha256: string;
      instructions: string;
    };
    // The PROSE differs (the version line reports what was sent)…
    expect(first.instructions).not.toBe(second.instructions);
    // …the version identifier must not: a runner upgrade is not an
    // instruction edit, and hashing the raw prose would mark the whole
    // fleet restart-pending on every deploy.
    expect(first.composedSha256).toBe(second.composedSha256);
  });
});

// ─── the strip lives in the pure function, not in call-site care ─────
//
// The route's own helper happens to omit versions when it builds the
// input, so the route test above cannot distinguish "the function
// strips them" from "nobody passed them" — a mutation deleting the
// strip survives it. Found by that mutation. This test feeds versions
// in directly, so only the strip can make it pass.

describe('composedInstructionsSha256 canonicalization', () => {
  it('ignores broker and runner versions a caller passes in', () => {
    const base = {
      self: {
        name: 'cora',
        role: { title: 'engineer', description: '' },
        permissions: [],
        instructions: '',
      },
      team: { name: 'demo-team', context: 'ctx', permissionPresets: {} },
      teammates: [],
      openObjectives: [],
      processDocument: null,
    };
    const bare = composedInstructionsSha256(base);
    const versioned = composedInstructionsSha256({
      ...base,
      brokerVersion: '9.9.9',
      runnerVersion: '0.3.4',
    });
    expect(versioned).toBe(bare);
    // Positive control: something that IS composed must move the hash,
    // or an implementation returning a constant satisfies the above.
    const edited = composedInstructionsSha256({
      ...base,
      team: { ...base.team, context: 'different ctx' },
    });
    expect(edited).not.toBe(bare);
  });
});

// ─── edit fanout: affected is whoever's composition moved ────────────

describe('instruction edit fanout', () => {
  it('reaches every member on a team-context edit', async () => {
    const { app, pushed } = makeApp();
    await app.request('/team', authed(ADMIN, { context: 'New shared context.' }));
    const events = instructionEvents(pushed);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ event: 'edited', changed: ['team_context'] });
    expect(events[0]?.recipients).toEqual(['andrewjon', 'cora', 'rune']);
  });

  it('reaches exactly one member on a personal-instructions edit', async () => {
    const { app, pushed } = makeApp();
    await app.request('/members/cora', authed(ADMIN, { instructions: 'New personal rules.' }));
    const events = instructionEvents(pushed);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ changed: ['personal_instructions'] });
    expect(events[0]?.recipients).toEqual(['cora']);
  });

  it('ripples a role edit to every teammate whose roster line moved', async () => {
    const { app, pushed } = makeApp();
    await app.request(
      '/members/cora',
      authed(ADMIN, { role: { title: 'engineer', description: 'Now also owns the runner.' } }),
    );
    const events = instructionEvents(pushed);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ changed: ['role_description'] });
    // THE strict-ripple decision: cora's own role block changed AND
    // every teammate's roster line for cora changed — all three
    // compositions moved.
    expect(events[0]?.recipients).toEqual(['andrewjon', 'cora', 'rune']);
  });

  it('fans out nothing when an edit rewrites a block to its existing text', async () => {
    const { app, pushed } = makeApp();
    await app.request('/team', authed(ADMIN, { context: 'We ship small and verify by mutating.' }));
    expect(instructionEvents(pushed)).toHaveLength(0);
  });

  it('fans out nothing on a permissions-only member patch', async () => {
    const { app, pushed } = makeApp();
    await app.request('/members/cora', authed(ADMIN, { permissions: ['team.manage'] }));
    expect(instructionEvents(pushed)).toHaveLength(0);
  });
});

// ─── restart-pending: issued vs current, and unknown is not pending ──

describe('restart-pending on the roster', () => {
  const rosterPending = async (app: {
    request: (path: string, init: RequestInit) => Promise<Response>;
  }): Promise<string[]> => {
    const res = await app.request('/roster', authed(CORA));
    return ((await res.json()) as { restartPending: string[] }).restartPending;
  };

  it('lists a fetched member after an edit, and clears them on refetch', async () => {
    const { app } = makeApp();
    // Nothing issued yet → nothing pending (and the field EXISTS as an
    // explicit empty answer, not an absent one).
    expect(await rosterPending(app)).toEqual([]);

    await app.request('/instructions', authed(CORA));
    expect(await rosterPending(app)).toEqual([]);

    await app.request('/team', authed(ADMIN, { context: 'Edited after cora fetched.' }));
    // cora's session runs the old composition — pending. rune and
    // andrewjon never fetched: unknown, NOT listed.
    expect(await rosterPending(app)).toEqual(['cora']);

    // The refetch models what a restarting runner does first.
    await app.request('/instructions', authed(CORA));
    expect(await rosterPending(app)).toEqual([]);
  });

  it('marks a teammate pending when a role edit moves their roster line', async () => {
    const { app } = makeApp();
    await app.request('/instructions', authed(RUNE));
    await app.request(
      '/members/cora',
      authed(ADMIN, { role: { title: 'engineer', description: 'Retitled.' } }),
    );
    // rune never edited anything and their own blocks are untouched —
    // but their composed text (cora's roster line) moved.
    expect(await rosterPending(app)).toEqual(['rune']);
  });
});
