/**
 * The process document as a watched block.
 *
 * THE DEFECT THIS PREVENTS is not a miss, it is a loop. If the block
 * is projected but its text is not exempt from capture redaction, the
 * captured copy is redacted, never matches the unredacted sent text,
 * and resends every turn forever. On this codebase that cannot happen
 * through `briefingCaptureExemptions` — it is a `.map()` of the
 * projection, so there is no second list to forget — but criterion 4
 * asks for that to be verified for this block rather than assumed,
 * and it is verified below.
 *
 * WHERE IT CAN STILL HAPPEN is a call site. Three places build a
 * `ComposeBriefingInput`; one passes the canonical object and two
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
  briefingCaptureBlocks,
  briefingCaptureExemptions,
  composeBriefing,
} from '../src/briefing.js';
import { contextResendBody, inspectBriefingContext } from '../src/context-watchdog.js';
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
    const composed = composeBriefing(input(DOC)).instructions;
    // The premise. If this ever became false the substring test would
    // work and this whole mechanism would be unnecessary — so assert
    // it rather than rely on it.
    expect(composed).not.toContain(DOC.text);

    const kinds = briefingCaptureBlocks(input(DOC)).map((b) => b.kind);
    expect(kinds).toContain('process_document');
  });

  it('projects the exact text the runner renders, not a summary of it', () => {
    const block = briefingCaptureBlocks(input(DOC)).find((b) => b.kind === 'process_document');
    expect(block?.text).toBe(DOC.text);
  });

  it('projects nothing when the team has no document', () => {
    expect(briefingCaptureBlocks(input(null)).map((b) => b.kind)).not.toContain('process_document');
  });

  it('projects nothing for a document that is only whitespace', () => {
    const blank = { ...DOC, text: '   \n  ' };
    expect(briefingCaptureBlocks(input(blank)).map((b) => b.kind)).not.toContain(
      'process_document',
    );
  });

  it('still projects the three authored blocks by their own test', () => {
    // The document must not displace the substring-based membership
    // that the composed blocks depend on.
    const kinds = briefingCaptureBlocks(input(DOC)).map((b) => b.kind);
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
    expect(briefingCaptureExemptions(input(DOC))).toContain(DOC.text);
  });

  /**
   * The property that makes the loop unreachable: exemptions are a
   * `.map()` of the projection, so a block cannot be projected without
   * being exempt. Asserted rather than assumed — criterion 4.
   */
  it('is exactly the projection, block for block', () => {
    expect(briefingCaptureExemptions(input(DOC))).toEqual(
      briefingCaptureBlocks(input(DOC)).map((b) => b.text),
    );
  });

  it('omits the document when there is none, in both lists together', () => {
    expect(briefingCaptureExemptions(input(null))).toEqual(
      briefingCaptureBlocks(input(null)).map((b) => b.text),
    );
    expect(briefingCaptureExemptions(input(null))).not.toContain(DOC.text);
  });
});

// ─── criteria 6 and 7: resend behaviour and the negative controls ────

describe('resend behaviour for the process document', () => {
  const inference = (system: string) => ({
    systemInstructions: [{ type: 'text' as const, content: system }],
  });
  const block = { kind: 'process_document' as const, text: DOC.text };

  /**
   * CRITERION 7, first half. A document that IS in the turn must never
   * be re-sent — otherwise the feature is a permanent loop rather than
   * a recovery.
   */
  it('never re-sends a document that is present in the turn', () => {
    const [observation] = inspectBriefingContext({
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
    const [observation] = inspectBriefingContext({
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
    const [observation] = inspectBriefingContext({
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
