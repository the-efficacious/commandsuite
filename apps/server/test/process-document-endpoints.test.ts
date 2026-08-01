/**
 * Process document endpoints — the authority gate, the injection seam,
 * and the retrieval seam.
 *
 * Criterion 1 is "one document, injected, always current", so the
 * assertion that matters is on `GET /briefing`: a member who was told
 * nothing gets the current text because it is state, not an
 * announcement.
 *
 * The gate is `process.manage`, a DEDICATED leaf. Under this shape the
 * permission is the entire authority — whoever holds it decides what
 * binds every member — so both branches are asserted, and a member
 * holding every OTHER permission is refused.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import type { ProcessDocument, ProcessDocumentEdit } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { createSqliteProcessDocumentStore } from '../src/process-document.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const EDITOR = 'csuite_test_editor_processdoc_token';
const BOUND = 'csuite_test_bound_processdoc_token';
const ADMIN = 'csuite_test_admin_processdoc_token';

const V1 = 'Keep a conversation running before action.\nSquash-merge to main.';
const V2 = 'Keep a conversation running before action.\nMerge commits to main.';

function makeApp() {
  const broker = new Broker({ eventLog: new InMemoryEventLog(), now: () => 1_700_000_000_000 });
  const members = createMemberStore([
    // Holds the authority and nothing else.
    {
      name: 'lea',
      role: { title: 'lead', description: '' },
      permissions: ['process.manage'],
      token: EDITOR,
    },
    // Bound by the document, holds no authority over it.
    { name: 'cora', role: { title: 'engineer', description: '' }, permissions: [], token: BOUND },
    // Holds every OTHER permission. The gate is this leaf, not seniority.
    {
      name: 'andrewjon',
      role: { title: 'director', description: '' },
      permissions: [
        'team.manage',
        'members.manage',
        'objectives.create',
        'objectives.cancel',
        'secrets.manage',
        'tools.manage',
      ],
      token: ADMIN,
    },
  ]);
  const db = openDatabase(':memory:');
  const processDocument = createSqliteProcessDocumentStore(db);
  const { app } = createApp({
    broker,
    members,
    tokens: createTokenStoreFromMembers(db, members),
    sessions: new SessionStore(db),
    teamStore: mockTeamStore({ name: 'demo-team', context: '', permissionPresets: {} }),
    processDocument,
    version: '0.0.0',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { app, broker, processDocument };
}

function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = method ?? (body !== undefined ? 'PUT' : 'GET');
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

const write = (text: string, reason = 'because') => ({
  text,
  reason,
  disposition: 'scope_change' as const,
});

// ─── the gate is the permission, not the role ────────────────────────

describe('the write gate is process.manage and nothing else', () => {
  it('refuses a member the document binds but who lacks the leaf', async () => {
    const { app } = makeApp();
    const res = await app.request('/process-document', authed(BOUND, write(V1)));
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'requires process.manage',
    });
  });

  /**
   * The reason this leaf exists. A director holding six other
   * permissions — including `objectives.create`, which the predecessor
   * used as this gate — still cannot rewrite the team's process.
   */
  it('refuses a member holding every other permission, including objectives.create', async () => {
    const { app } = makeApp();
    const res = await app.request('/process-document', authed(ADMIN, write(V1)));
    expect(res.status).toBe(403);
  });

  it('allows the holder of the leaf', async () => {
    const { app } = makeApp();
    const res = await app.request('/process-document', authed(EDITOR, write(V1)));
    expect(res.status).toBe(201);
  });

  it('lets a bound member READ the document that binds them', async () => {
    const { app } = makeApp();
    await app.request('/process-document', authed(EDITOR, write(V1)));
    const res = await app.request('/process-document', authed(BOUND));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { document: ProcessDocument };
    expect(body.document.text).toBe(V1);
  });
});

// ─── absence is a state, not a missing resource ──────────────────────

describe('a team with no document', () => {
  it('serves document: null with 200, not 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/process-document', authed(BOUND));
    expect(res.status).toBe(200);
    expect((await res.json()) as { document: null }).toEqual({ document: null });
  });

  it('serves an empty history rather than 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/process-document/history', authed(BOUND));
    expect(res.status).toBe(200);
    expect((await res.json()) as { edits: [] }).toEqual({ edits: [] });
  });

  it('carries null on the briefing, so the field is present and explicit', async () => {
    const { app } = makeApp();
    const res = await app.request('/briefing', authed(BOUND));
    const body = (await res.json()) as { processDocument: unknown };
    // Present-and-null, never absent: an absent field is what an older
    // broker sends, and a member must be able to tell those apart.
    expect('processDocument' in body).toBe(true);
    expect(body.processDocument).toBeNull();
  });
});

// ─── criterion 1: injected, always current, no announcement ──────────

describe('criterion 1 — the document is injected as current state', () => {
  it('reaches a member who was told nothing, and updates without a broadcast', async () => {
    const { app, broker } = makeApp();
    await app.request('/process-document', authed(EDITOR, write(V1)));

    const before = (await (await app.request('/briefing', authed(BOUND))).json()) as {
      processDocument: ProcessDocument;
    };
    expect(before.processDocument.text).toBe(V1);
    expect(before.processDocument.version).toBe(1);

    // POSITIVE CONTROL FIRST. `toHaveLength(0)` against an observer
    // that never fires is vacuous — misname the method and this test
    // passes while watching nothing. Prove the counter works by
    // driving a real announcement through the same broker.
    const announced: unknown[] = [];
    const originalPush = broker.push.bind(broker);
    broker.push = (async (...args: unknown[]) => {
      announced.push(args);
      return originalPush(...(args as Parameters<typeof originalPush>));
    }) as typeof broker.push;

    await app.request('/push', authed(EDITOR, { body: 'a real announcement' }, 'POST'));
    expect(announced).toHaveLength(1);
    const beforeEdit = announced.length;

    await app.request('/process-document', authed(EDITOR, write(V2, 'reversed the merge model')));

    // Nothing was announced — added to a counter just shown to work.
    expect(announced).toHaveLength(beforeEdit);

    // And the member, who saw nothing, has the new text with the
    // version moved so they can tell it changed.
    const after = (await (await app.request('/briefing', authed(BOUND))).json()) as {
      processDocument: ProcessDocument;
    };
    expect(after.processDocument.text).toBe(V2);
    expect(after.processDocument.version).toBe(2);
  });
});

// ─── criteria 3 and 8 across the wire ────────────────────────────────

describe('history over the wire', () => {
  it('returns 201 on create and 200 on edit, so a caller can tell them apart', async () => {
    const { app } = makeApp();
    expect((await app.request('/process-document', authed(EDITOR, write(V1)))).status).toBe(201);
    expect((await app.request('/process-document', authed(EDITOR, write(V2)))).status).toBe(200);
  });

  it('carries the full prior text, so the diff is derivable client-side', async () => {
    const { app } = makeApp();
    await app.request('/process-document', authed(EDITOR, write(V1)));
    await app.request('/process-document', authed(EDITOR, write(V2, 'reversed the merge model')));

    const res = await app.request('/process-document/history', authed(BOUND));
    const { edits } = (await res.json()) as { edits: ProcessDocumentEdit[] };
    expect(edits).toHaveLength(2);
    expect(edits[0]?.previous.text).toBeUndefined();
    expect(edits[1]?.previous.text).toBe(V1);
    expect(edits[1]?.reason).toBe('reversed the merge model');
    expect(edits[1]?.actor).toBe('lea');
  });

  it('keeps the injected document free of superseded text as edits accumulate', async () => {
    const { app } = makeApp();
    await app.request('/process-document', authed(EDITOR, write('revision 0')));
    for (let i = 1; i <= 4; i++) {
      await app.request('/process-document', authed(EDITOR, write(`revision ${i}`)));
    }
    const brief = (await (await app.request('/briefing', authed(BOUND))).json()) as {
      processDocument: ProcessDocument;
    };
    expect(brief.processDocument.text).toBe('revision 4');
    expect(brief.processDocument.text).not.toContain('revision 0');
    // Injected size is a function of the document, not the edit count.
    expect(brief.processDocument.text.length).toBe('revision 4'.length);
    const { edits } = (await (
      await app.request('/process-document/history', authed(BOUND))
    ).json()) as { edits: ProcessDocumentEdit[] };
    expect(edits).toHaveLength(5);
  });
});
