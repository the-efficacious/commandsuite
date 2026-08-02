/**
 * The process document as a watched block.
 *
 * THE DEFECT THIS PREVENTS is not a miss, it is a loop. If the block
 * is projected but its text is not exempt from capture redaction, the
 * captured copy is redacted, never matches the unredacted sent text,
 * and resends every turn forever. On this codebase that cannot happen
 * through `instructionCaptureExemptions` — it is a `.map()` of the
 * projection, so there is no second list to forget — but criterion 4
 * asks for that to be verified for this block rather than assumed,
 * and it is verified below.
 *
 * WHERE IT CAN STILL HAPPEN is a call site. Three places build a
 * `ComposeInstructionsInput`; one passes the canonical object and two
 * construct a literal by hand. An optional field is carried by the
 * first and silently dropped by the other two. `processDocument` is
 * therefore REQUIRED on the input, so the partial literal does not
 * compile — a reminder closes this instance, the type closes the
 * mechanism.
 */

import {
  Broker,
  clearRegisteredSecretValues,
  InMemoryEventLog,
  registerSecretValues,
} from 'csuite-core';
import { PROCESS_DOCUMENT_MAX } from 'csuite-sdk/schemas';
import type { Member, ProcessDocument, Team, Teammate } from 'csuite-sdk/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import {
  instructionBlocks,
  instructionCaptureExemptions,
  composeInstructions,
} from '../src/instructions.js';
import {
  CONTEXT_PRESENCE_EVENT,
  contextResendBody,
  inspectInstructionContext,
} from '../src/context-watchdog.js';
import { openDatabase } from '../src/db.js';
import { createGenAiStore } from '../src/genai-store.js';
import { createMemberStore } from '../src/members.js';
import { createSqliteProcessDocumentStore } from '../src/process-document.js';
import { createRawBodyStore } from '../src/raw-body-store.js';
import { SessionStore } from '../src/sessions.js';
import { createTelemetryStore } from '../src/telemetry-store.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const TEAM: Team = {
  name: 'demo-team',
  context: 'We ship small and verify by mutating.',
  permissionPresets: {},
};

const SELF: Member = {
  name: 'cora',
  role: { title: 'engineer', description: 'Co-owns the broker.' },
  permissions: [],
  instructions: 'Sign your own work.',
};

const TEAMMATES: Teammate[] = [
  { name: 'rune', role: { title: 'engineer', description: '' }, permissions: [] },
];

const DOC: ProcessDocument = {
  text: 'Keep a conversation running before action.\nSquash-merge to main.',
  version: 3,
  createdBy: 'AndrewJon',
  createdAt: 1,
  updatedBy: 'Lea',
  updatedAt: 2,
};

const input = (processDocument: ProcessDocument | null) => ({
  self: SELF,
  team: TEAM,
  teammates: TEAMMATES,
  openObjectives: [],
  processDocument,
});

// ─── criterion 1: membership keys on what was sent ───────────────────

afterEach(() => clearRegisteredSecretValues());

describe('membership is what was sent, not a substring of the prose', () => {
  it('projects the document even though it is not in the composed instructions', () => {
    const composed = composeInstructions(input(DOC)).instructions;
    // The premise. If this ever became false the substring test would
    // work and this whole mechanism would be unnecessary — so assert
    // it rather than rely on it.
    expect(composed).not.toContain(DOC.text);

    const kinds = instructionBlocks(input(DOC)).map((b) => b.kind);
    expect(kinds).toContain('process_document');
  });

  it('projects the exact text the runner renders, not a summary of it', () => {
    const block = instructionBlocks(input(DOC)).find((b) => b.kind === 'process_document');
    expect(block?.text).toBe(DOC.text);
  });

  it('projects nothing when the team has no document', () => {
    expect(instructionBlocks(input(null)).map((b) => b.kind)).not.toContain('process_document');
  });

  /**
   * VERBATIM, including boundary whitespace.
   *
   * The store only refuses text whose TRIMMED value is empty — it does
   * not normalise valid text — so `"  rule\n"` is a legal document and
   * the runner renders it exactly. A trimmed projection would exempt
   * and re-send `"rule"`, which is not what the agent received, and
   * criterion 4 says exactly the document text.
   *
   * The existing exact-text case uses a string with no boundary
   * whitespace and cannot distinguish the two. This one can.
   */
  it('projects the sent bytes, including leading and trailing whitespace', () => {
    const padded = { ...DOC, text: '  Squash-merge to main.\n' };
    const block = instructionBlocks(input(padded)).find((b) => b.kind === 'process_document');
    expect(block?.text).toBe('  Squash-merge to main.\n');
    // Not the normalised form.
    expect(block?.text).not.toBe('Squash-merge to main.');
  });

  it('carries the same bytes into the derived exemption', () => {
    const padded = { ...DOC, text: '  Squash-merge to main.\n' };
    expect(instructionCaptureExemptions(input(padded))).toContain('  Squash-merge to main.\n');
  });

  it('carries the same bytes into the resend body', () => {
    const padded = { ...DOC, text: '  Squash-merge to main.\n' };
    const [block] = instructionBlocks(input(padded)).filter(
      (b) => b.kind === 'process_document',
    );
    const body = contextResendBody([{ block, present: false, resendFired: true } as never]);
    // The recovery must hand back what the runner received, byte for
    // byte, or the agent re-anchors on a different block.
    expect(body).toContain('  Squash-merge to main.\n');
  });

  it('projects nothing for a document that is only whitespace', () => {
    const blank = { ...DOC, text: '   \n  ' };
    expect(instructionBlocks(input(blank)).map((b) => b.kind)).not.toContain(
      'process_document',
    );
  });

  it('still projects the three authored blocks by their own test', () => {
    // The document must not displace the substring-based membership
    // that the composed blocks depend on.
    const kinds = instructionBlocks(input(DOC)).map((b) => b.kind);
    expect(kinds).toEqual([
      'team_context',
      'role_description',
      'personal_instructions',
      'process_document',
    ]);
  });
});

// ─── criterion 4: the derived exemption carries the document ─────────

describe('the exemption is derived, and carries this block', () => {
  it('contains exactly the document text', () => {
    expect(instructionCaptureExemptions(input(DOC))).toContain(DOC.text);
  });

  /**
   * The property that makes the loop unreachable: exemptions are a
   * `.map()` of the projection, so a block cannot be projected without
   * being exempt. Asserted rather than assumed — criterion 4.
   */
  it('is exactly the projection, block for block', () => {
    expect(instructionCaptureExemptions(input(DOC))).toEqual(
      instructionBlocks(input(DOC)).map((b) => b.text),
    );
  });

  it('omits the document when there is none, in both lists together', () => {
    expect(instructionCaptureExemptions(input(null))).toEqual(
      instructionBlocks(input(null)).map((b) => b.text),
    );
    expect(instructionCaptureExemptions(input(null))).not.toContain(DOC.text);
  });
});

// ─── criteria 6 and 7: resend behaviour and the negative controls ────

describe('resend behaviour for the process document', () => {
  const inference = (system: string) => ({
    systemInstructions: [{ type: 'text' as const, content: system }],
    inputMessages: [],
  });
  const block = { kind: 'process_document' as const, text: DOC.text };

  /**
   * CRITERION 7, first half. A document that IS in the turn must never
   * be re-sent — otherwise the feature is a permanent loop rather than
   * a recovery.
   */
  it('never re-sends a document that is present in the turn', () => {
    const [observation] = inspectInstructionContext({
      memberName: 'cora',
      inference: inference(`some preamble\n${DOC.text}\nsome suffix`),
      blocks: [block],
      now: 1_000_000,
      lastResentAt: new Map(),
      systemProjectionObservable: true,
    });
    expect(observation?.present).toBe(true);
    expect(observation?.resendFired).toBe(false);
  });

  it('re-sends a document that is absent from an observable turn', () => {
    const [observation] = inspectInstructionContext({
      memberName: 'cora',
      inference: inference('nothing relevant here'),
      blocks: [block],
      now: 1_000_000,
      lastResentAt: new Map(),
      systemProjectionObservable: true,
    });
    expect(observation?.present).toBe(false);
    expect(observation?.resendFired).toBe(true);
  });

  /**
   * CRITERION 7, second half. Codex projects no observable system
   * prompt, so absence cannot be asserted — #118. The document must
   * be `null` (unknown), never `false` (absent), or every Codex turn
   * would resend forever.
   */
  it('never claims a Codex turn is missing the document', () => {
    const [observation] = inspectInstructionContext({
      memberName: 'seamus',
      inference: inference(''),
      blocks: [block],
      now: 1_000_000,
      lastResentAt: new Map(),
      systemProjectionObservable: false,
    });
    expect(observation?.present).toBeNull();
    expect(observation?.resendFired).toBe(false);
  });

  /**
   * CRITERION 6. Measured, not asserted to be small. A document at
   * PROCESS_DOCUMENT_MAX is the largest single block the resend path
   * can carry — the three authored blocks are UNCAPPED after #129, so
   * this is the only one with a ceiling at all.
   */
  it('carries the whole document in the resend body, at maximum size', () => {
    const maxDoc = { ...DOC, text: 'x'.repeat(PROCESS_DOCUMENT_MAX) };
    const body = contextResendBody([
      {
        block: { kind: 'process_document', text: maxDoc.text },
        present: false,
        resendFired: true,
        priorVersionPresent: false,
        deliveryUnconfirmed: false,
      } as never,
    ]);
    const bytes = Buffer.byteLength(body, 'utf8');
    // The document itself plus the wrapper. Not free, and not an
    // order of magnitude either — Turner's three authored blocks
    // already resend at 5,424 bytes today.
    expect(body).toContain(maxDoc.text);
    expect(bytes).toBeGreaterThan(PROCESS_DOCUMENT_MAX);
    expect(bytes).toBeLessThan(PROCESS_DOCUMENT_MAX + 512);
  });

  it('names the block kind in the resend, so the agent knows what it lost', () => {
    const body = contextResendBody([{ block, present: false, resendFired: true } as never]);
    expect(body).toContain('<persistent_context kind="process_document">');
    expect(body).toContain(DOC.text);
  });
});

// ─── criterion 5: the cold-broker rebuild, through the real app ──────
//
// This is where an omission surfaces, and it surfaces as a permanent
// loop rather than a miss. A live runner keeps uploading without
// refetching `/briefing`, so after a restart the broker rebuilds the
// exemption set from storage — via `exemptionsFor`, which constructs
// its own input by hand.
//
// The test never calls `/briefing`. That is the point: it exercises
// the path a warm broker would hide.

describe('the cold-broker rebuild carries the document', () => {
  const TOKEN = 'csuite_test_coldbroker_token';
  const SECRET_IN_DOC = 'csuite_literal_inside_the_process_doc_4b71';
  const DOC_WITH_SECRET = `${DOC.text}\nEscalate via ${SECRET_IN_DOC}.`;

  /**
   * The real relay shape: a `claude_code.api_request_body` record
   * carrying the request JSON, which is what the correlator parses and
   * the raw-body store persists. A bare log record is ignored, so a
   * test using one would store nothing and assert on an empty string.
   */
  function otlpCall(system: string) {
    const attrs = (eventName: string, values: Record<string, string>) => [
      { key: 'event.name', value: { stringValue: `claude_code.${eventName}` } },
      ...Object.entries(values).map(([key, value]) => ({ key, value: { stringValue: value } })),
    ];
    return {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1700000000000000000',
                  attributes: attrs('api_request_body', {
                    body: JSON.stringify({
                      model: 'claude-opus-4-6',
                      system: [{ type: 'text', text: system }],
                      messages: [],
                    }),
                    model: 'claude-opus-4-6',
                  }),
                },
                {
                  timeUnixNano: '1700000001000000000',
                  attributes: attrs('api_request', {
                    request_id: 'req_cold_1',
                    model: 'claude-opus-4-6',
                  }),
                },
              ],
            },
          ],
        },
      ],
    };
  }

  /**
   * Every stored body, read back through the store's real API — rows
   * carry a content hash, and the bytes come from `getBlob`.
   */
  function readAllStoredText(store: ReturnType<typeof createRawBodyStore>): string {
    return store
      .list()
      .map((row) => store.getBlob(row.hash)?.toString('utf8') ?? '')
      .join('\n');
  }

  function coldApp(withDocument: boolean, docText: string = DOC.text) {
    const broker = new Broker({ eventLog: new InMemoryEventLog(), now: () => 1 });
    const members = createMemberStore([
      {
        name: 'cora',
        role: { title: 'engineer', description: '' },
        permissions: ['process.manage'],
        token: TOKEN,
      },
    ]);
    const db = openDatabase(':memory:');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const processDocument = createSqliteProcessDocumentStore(db);
    const genaiStore = createGenAiStore(db, { logger });
    const rawBodyStore = createRawBodyStore(db, { logger });
    const telemetryStore = createTelemetryStore(db, { logger });
    if (withDocument) {
      processDocument.write(
        { text: docText, reason: 'seeded', disposition: 'scope_change' },
        'AndrewJon',
        1,
      );
    }
    const { app } = createApp({
      broker,
      members,
      tokens: createTokenStoreFromMembers(db, members),
      sessions: new SessionStore(db),
      teamStore: mockTeamStore(TEAM),
      processDocument,
      genaiStore,
      rawBodyStore,
      telemetryStore,
      version: '0.0.0',
      logger,
    });
    return { app, processDocument, rawBodyStore };
  }

  /**
   * The document text must be exempt from capture redaction on a
   * broker that has never served this member a briefing.
   *
   * THE REGISTERED LITERAL IS THE WHOLE TEST. Redaction only rewrites
   * values that are registered, so a document containing none would
   * survive capture whether or not the exemption existed — the test
   * would pass and prove nothing. The loop Rune and Lea described
   * occurs precisely when the document contains a registered literal,
   * so the document here contains one.
   */
  it('exempts the document on a broker that has served no briefing', async () => {
    const { app, rawBodyStore } = coldApp(true, SECRET_IN_DOC);
    registerSecretValues([SECRET_IN_DOC]);
    // A captured body containing the document verbatim. If the
    // exemption is missing, redaction rewrites the literal inside it
    // and the watchdog can never match the document again.
    const res = await app.request('/otlp/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(otlpCall(`system prompt\n${DOC_WITH_SECRET}`)),
    });
    expect([200, 202, 204]).toContain(res.status);

    // The assertion that matters: the document text survived capture
    // VERBATIM, including the registered literal inside it, on a
    // broker that never composed a briefing for this member.
    const stored = rawBodyStore.count() > 0 ? readAllStoredText(rawBodyStore) : '';
    expect(stored).toContain(SECRET_IN_DOC);
    expect(stored).not.toContain('[REDACTED]');
  });

  /**
   * POSITIVE CONTROL for the assertion above. A registered literal
   * that is NOT part of the process document must still be redacted —
   * otherwise the test passes on a broker with redaction switched off
   * entirely, and proves nothing about the exemption.
   */
  it('still redacts a registered value that is not the document', async () => {
    const { app, rawBodyStore } = coldApp(true, SECRET_IN_DOC);
    const unrelated = 'csuite_unrelated_secret_value_9f2a';
    registerSecretValues([SECRET_IN_DOC, unrelated]);
    await app.request('/otlp/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(otlpCall(`prompt ${unrelated} and ${DOC_WITH_SECRET}`)),
    });
    const stored = readAllStoredText(rawBodyStore);
    // The document's literal survives; the unrelated one does not.
    expect(stored).toContain(SECRET_IN_DOC);
    expect(stored).not.toContain(unrelated);
  });

  it('has a document to rebuild from, independent of any briefing fetch', () => {
    const { processDocument } = coldApp(true);
    // The store is the authority the cold path reads. If this were
    // empty the rebuild would have nothing to carry and the test
    // above would pass for the wrong reason.
    expect(processDocument.get()?.text).toBe(DOC.text);
  });

  it('rebuilds nothing for a team with no document', () => {
    const { processDocument } = coldApp(false);
    expect(processDocument.get()).toBeNull();
  });
});

// ─── stale is restart-pending, missing is resent ─────────────────────
//
// The projection is built from the CURRENT stored document, so an
// agent still carrying yesterday's text does not contain today's.
// When the WATCHDOG KNOWS the prior version (it issued it), the state
// is `stale` and nothing is re-sent: the runner's drain-and-restart is
// the remediation, the roster reports restart-pending meanwhile, and
// re-injecting the new text would put two versions in one frozen
// context and re-fire every cooldown. When the prior text is NOT
// recognisable, the block has genuinely fallen out — that is `missing`
// and the resend is recovery, not delivery.

describe('a session holding superseded text', () => {
  const inference = (system: string) => ({
    systemInstructions: [{ type: 'text' as const, content: system }],
    inputMessages: [],
  });

  it('treats the previous version as absence of the current one', () => {
    const previous = 'Squash-merge to main.';
    const current = 'Merge commits to main.';
    const [observation] = inspectInstructionContext({
      memberName: 'cora',
      // The agent's context still holds the superseded text.
      inference: inference(`preamble\n${previous}\nsuffix`),
      blocks: [{ kind: 'process_document', text: current }],
      now: 1_000_000,
      lastResentAt: new Map(),
      systemProjectionObservable: true,
    });
    expect(observation?.present).toBe(false);
    expect(observation?.resendFired).toBe(true);
  });

  it('classifies it as stale rather than merely missing, when the prior text is known', () => {
    const previous = 'Squash-merge to main.';
    const current = 'Merge commits to main.';
    const [observation] = inspectInstructionContext({
      memberName: 'cora',
      inference: inference(`preamble\n${previous}\nsuffix`),
      blocks: [{ kind: 'process_document', text: current }],
      now: 1_000_000,
      lastResentAt: new Map(),
      systemProjectionObservable: true,
      knownPriorVersions: new Map([['process_document', new Set([previous])]]),
    });
    // Distinguishes "you lost it" from "yours is out of date" — and
    // out-of-date is the restart protocol's job, not the resend's.
    expect(observation?.priorVersionPresent).toBe(true);
    expect(observation?.resendFired).toBe(false);
  });
});

// ─── the watchdog's OWN input, through the real app ──────────────────
//
// Found by Rune: mutating `app.ts:679` — the hand-built input inside
// `inspectCapturedBriefing` — to a valid `null` left all 22 tests in
// this file green. The tests above exercise `instructionBlocks`
// with an input I construct, and the cold-redaction test exercises
// `exemptionsFor` at `:636`. Neither drives the site that decides
// which blocks are examined at all.
//
// Required typing closes OMISSION — a partial literal will not compile
// — and leaves SUBSTITUTION open, which is the failure a hurried caller
// actually commits, because `null` is the easy thing to write when you
// do not have the value to hand.
//
// This test fetches no briefing, because `:679` exists precisely to
// serve runners that never refetch.

describe('the watchdog resends through the real app, with no briefing fetch', () => {
  const RUNNER = 'csuite_test_watchdog_runner_token';
  const DOCUMENT = 'Keep a conversation running before action.\nSquash-merge to main.';

  function watchdogApp() {
    const broker = new Broker({ eventLog: new InMemoryEventLog(), now: () => 1 });
    const members = createMemberStore([
      {
        name: 'cora',
        role: { title: 'engineer', description: '' },
        permissions: [],
        token: RUNNER,
      },
    ]);
    const db = openDatabase(':memory:');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const processDocument = createSqliteProcessDocumentStore(db);
    processDocument.write(
      { text: DOCUMENT, reason: 'seeded', disposition: 'scope_change' },
      'AndrewJon',
      1,
    );
    const telemetryStore = createTelemetryStore(db, { logger });
    const { app } = createApp({
      broker,
      members,
      tokens: createTokenStoreFromMembers(db, members),
      sessions: new SessionStore(db),
      teamStore: mockTeamStore(TEAM),
      processDocument,
      genaiStore: createGenAiStore(db, { logger }),
      rawBodyStore: createRawBodyStore(db, { logger }),
      telemetryStore,
      version: '0.0.0',
      logger,
    });

    // Observe every push the broker makes to this member.
    const pushes: { title: string | null; body: string }[] = [];
    const originalPush = broker.push.bind(broker);
    broker.push = (async (payload: never, opts?: never) => {
      const p = payload as { title?: string | null; body?: string };
      pushes.push({ title: p.title ?? null, body: p.body ?? '' });
      return originalPush(payload, opts as never);
    }) as typeof broker.push;

    return { app, pushes, telemetryStore };
  }

  const capture = (system: string) => {
    const attrs = (eventName: string, values: Record<string, string>) => [
      { key: 'event.name', value: { stringValue: `claude_code.${eventName}` } },
      ...Object.entries(values).map(([key, value]) => ({ key, value: { stringValue: value } })),
    ];
    return {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1700000000000000000',
                  attributes: attrs('api_request_body', {
                    body: JSON.stringify({
                      model: 'claude-opus-4-6',
                      system: [{ type: 'text', text: system }],
                      messages: [],
                    }),
                    model: 'claude-opus-4-6',
                  }),
                },
                {
                  timeUnixNano: '1700000001000000000',
                  attributes: attrs('api_request', {
                    request_id: 'req_watchdog_1',
                    model: 'claude-opus-4-6',
                  }),
                },
                // The response is REQUIRED. Without it the correlator
                // holds the exchange pending and emits no inference, so
                // the watchdog never runs and the assertions below fail
                // against an empty array — which reads identically to
                // "the feature is broken".
                {
                  timeUnixNano: '1700000002000000000',
                  attributes: attrs('api_response_body', {
                    body: JSON.stringify({
                      id: 'msg_watchdog_1',
                      role: 'assistant',
                      content: [{ type: 'text', text: 'done' }],
                      stop_reason: 'end_turn',
                      usage: { input_tokens: 1, output_tokens: 1 },
                    }),
                    request_id: 'req_watchdog_1',
                  }),
                },
              ],
            },
          ],
        },
      ],
    };
  };

  const ingest = (app: ReturnType<typeof watchdogApp>['app'], system: string) =>
    app.request('/otlp/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RUNNER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(capture(system)),
    });

  it('re-sends the exact document when an observable turn lacks it', async () => {
    const { app, pushes, telemetryStore } = watchdogApp();
    await ingest(app, 'a system prompt with no process document in it at all');

    const restored = pushes.filter((p) => p.title === 'persistent context restored');
    expect(restored).toHaveLength(1);
    // The exact bytes, not a summary and not a normalised copy.
    expect(restored[0]?.body).toContain(DOCUMENT);
    expect(restored[0]?.body).toContain('<persistent_context kind="process_document">');

    const presence = telemetryStore
      .list({ name: CONTEXT_PRESENCE_EVENT })
      .filter((row) => row.attributes?.['context.block.kind'] === 'process_document');
    expect(presence).toHaveLength(1);
    expect(presence[0]?.attributes).toMatchObject({
      'context.block.kind': 'process_document',
      'context.block.present': false,
      'context.block.resend_fired': true,
    });
  });

  /**
   * The negative control. Without it the test above would pass on a
   * broker that re-sends unconditionally, which is a loop rather than
   * a recovery.
   */
  it('re-sends nothing for a document the turn already contains', async () => {
    const { app, pushes, telemetryStore } = watchdogApp();
    // Contains the document. The three authored blocks are absent, so
    // a restore push still fires FOR THOSE — assert about this block
    // rather than about the push existing, or the test measures the
    // wrong thing.
    await ingest(app, `preamble\n${DOCUMENT}\nsuffix`);

    const restored = pushes.filter((p) => p.title === 'persistent context restored');
    for (const push of restored) {
      expect(push.body).not.toContain('kind="process_document"');
      expect(push.body).not.toContain(DOCUMENT);
    }

    const presence = telemetryStore
      .list({ name: CONTEXT_PRESENCE_EVENT })
      .filter((row) => row.attributes?.['context.block.kind'] === 'process_document');
    expect(presence).toHaveLength(1);
    expect(presence[0]?.attributes).toMatchObject({
      'context.block.present': true,
      'context.block.resend_fired': false,
    });
  });
});
