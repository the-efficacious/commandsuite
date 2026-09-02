/**
 * The process document as a projected, capture-exempt block.
 *
 * The document rides its own response field rather than the composed
 * prose, so its membership in `instructionBlocks` keys on WHAT WAS
 * SENT — the stored text, verbatim — not on a substring of the
 * instructions string. And because capture redaction only spares text
 * listed in `instructionCaptureExemptions`, the exemption must carry
 * the same bytes: a projected-but-not-exempt document would be
 * captured in redacted form and never match the sent text again.
 * That exemption is a `.map()` of the projection, so there is no
 * second list to forget — verified below rather than assumed.
 *
 * A call-site hazard is closed by typing: three places build a
 * `ComposeInstructionsInput`, one from the canonical object and two by
 * hand. `teamProcess` is REQUIRED on the input so a hand-built
 * literal that drops it does not compile.
 */

import {
  Broker,
  clearRegisteredSecretValues,
  composeInstructions,
  createApp,
  createGenAiStore,
  createSqliteTeamProcessStore,
  createTelemetryStore,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  instructionBlocks,
  instructionCaptureExemptions,
  registerSecretValues,
  SqliteSessionStore,
} from 'csuite-core';
import type { Member, Team, Teammate, TeamProcess } from 'csuite-sdk/types';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createGenAiCorrelator } from '../src/genai-correlator.js';
import { createMemberStore } from '../src/members.js';
import { createRawBodyStore } from '../src/raw-body-store.js';
import { recordingLogger } from './helpers/logger.js';
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

const DOC: TeamProcess = {
  text: 'Keep a conversation running before action.\nSquash-merge to main.',
  version: 3,
  createdBy: 'AndrewJon',
  createdAt: 1,
  updatedBy: 'Lea',
  updatedAt: 2,
};

const input = (teamProcess: TeamProcess | null) => ({
  self: SELF,
  team: TEAM,
  teammates: TEAMMATES,
  openObjectives: [],
  teamProcess,
});

// ─── membership keys on what was sent ────────────────────────────────

afterEach(() => clearRegisteredSecretValues());

describe('membership is what was sent, not a substring of the prose', () => {
  it('projects the document even though it is not in the composed instructions', () => {
    const composed = composeInstructions(input(DOC)).instructions;
    // The premise. If this ever became false the substring test would
    // work and this whole mechanism would be unnecessary — so assert
    // it rather than rely on it.
    expect(composed).not.toContain(DOC.text);

    const kinds = instructionBlocks(input(DOC)).map((b) => b.kind);
    expect(kinds).toContain('team_process');
  });

  it('projects the exact text the runner renders, not a summary of it', () => {
    const block = instructionBlocks(input(DOC)).find((b) => b.kind === 'team_process');
    expect(block?.text).toBe(DOC.text);
  });

  it('projects nothing when the team has no document', () => {
    expect(instructionBlocks(input(null)).map((b) => b.kind)).not.toContain('team_process');
  });

  /**
   * VERBATIM, including boundary whitespace.
   *
   * The store only refuses text whose TRIMMED value is empty — it does
   * not normalise valid text — so `"  rule\n"` is a legal document and
   * the runner renders it exactly. A trimmed projection would exempt
   * `"rule"`, which is not what the agent received.
   *
   * The existing exact-text case uses a string with no boundary
   * whitespace and cannot distinguish the two. This one can.
   */
  it('projects the sent bytes, including leading and trailing whitespace', () => {
    const padded = { ...DOC, text: '  Squash-merge to main.\n' };
    const block = instructionBlocks(input(padded)).find((b) => b.kind === 'team_process');
    expect(block?.text).toBe('  Squash-merge to main.\n');
    // Not the normalised form.
    expect(block?.text).not.toBe('Squash-merge to main.');
  });

  it('carries the same bytes into the derived exemption', () => {
    const padded = { ...DOC, text: '  Squash-merge to main.\n' };
    expect(instructionCaptureExemptions(input(padded))).toContain('  Squash-merge to main.\n');
  });

  it('projects nothing for a document that is only whitespace', () => {
    const blank = { ...DOC, text: '   \n  ' };
    expect(instructionBlocks(input(blank)).map((b) => b.kind)).not.toContain('team_process');
  });

  it('still projects the three authored blocks by their own test', () => {
    // The document must not displace the substring-based membership
    // that the composed blocks depend on.
    const kinds = instructionBlocks(input(DOC)).map((b) => b.kind);
    expect(kinds).toEqual([
      'team_context',
      'role_description',
      'personal_instructions',
      'team_process',
    ]);
  });
});

// ─── the derived exemption carries the document ──────────────────────

describe('the exemption is derived, and carries this block', () => {
  it('contains exactly the document text', () => {
    expect(instructionCaptureExemptions(input(DOC))).toContain(DOC.text);
  });

  /**
   * The property that makes a projected-but-redacted document
   * unrepresentable: exemptions are a `.map()` of the projection, so a
   * block cannot be projected without being exempt. Asserted rather
   * than assumed.
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

// ─── the cold-broker rebuild, through the real app ───────────────────
//
// A live runner keeps uploading without refetching `/packet`, so after
// a restart the broker rebuilds the exemption set from storage — via
// `exemptionsFor`, which constructs its own input by hand. The test
// never calls `/packet`. That is the point: it exercises the path a
// warm broker would hide.

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
      .map((row) => new TextDecoder().decode(store.getBlob(row.hash) ?? new Uint8Array()))
      .join('\n');
  }

  async function coldApp(withDocument: boolean, docText: string = DOC.text) {
    const broker = new Broker({ eventLog: new InMemoryEventLog(), now: () => 1 });
    const members = createMemberStore([
      {
        name: 'cora',
        role: { title: 'engineer', description: '' },
        permissions: ['team_process.manage'],
        token: TOKEN,
      },
    ]);
    const db = openDatabase(':memory:');
    const logger = recordingLogger().logger;
    const teamProcess = createSqliteTeamProcessStore(db);
    const genaiStore = createGenAiStore(db, { logger });
    const rawBodyStore = createRawBodyStore(db, { logger });
    const telemetryStore = createTelemetryStore(db, { logger });
    if (withDocument) {
      teamProcess.write(
        { text: docText, reason: 'seeded', disposition: 'scope_change' },
        'AndrewJon',
        1,
      );
    }
    const { app } = createApp({
      createGenAiCorrelator,
      broker,
      members,
      tokens: await createTokenStoreFromMembers(db, members),
      sessions: new SqliteSessionStore(db),
      teamStore: mockTeamStore(TEAM),
      teamProcess,
      genaiStore,
      rawBodyStore,
      telemetryStore,
      version: '0.0.0',
      logger,
    });
    return { app, teamProcess, rawBodyStore };
  }

  /**
   * The document text must be exempt from capture redaction on a
   * broker that has never served this member a packet.
   *
   * THE REGISTERED LITERAL IS THE WHOLE TEST. Redaction only rewrites
   * values that are registered, so a document containing none would
   * survive capture whether or not the exemption existed — the test
   * would pass and prove nothing. The document here contains one.
   */
  it('exempts the document on a broker that has served no packet', async () => {
    const { app, rawBodyStore } = await coldApp(true, SECRET_IN_DOC);
    registerSecretValues([SECRET_IN_DOC]);
    // A captured body containing the document verbatim. If the
    // exemption is missing, redaction rewrites the literal inside it
    // and the captured copy never matches the sent text again.
    const res = await app.request('/otlp/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(otlpCall(`system prompt\n${DOC_WITH_SECRET}`)),
    });
    expect([200, 202, 204]).toContain(res.status);

    // The assertion that matters: the document text survived capture
    // VERBATIM, including the registered literal inside it, on a
    // broker that never composed a packet for this member.
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
    const { app, rawBodyStore } = await coldApp(true, SECRET_IN_DOC);
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

  it('has a document to rebuild from, independent of any packet fetch', async () => {
    const { teamProcess } = await coldApp(true);
    // The store is the authority the cold path reads. If this were
    // empty the rebuild would have nothing to carry and the test
    // above would pass for the wrong reason.
    expect(teamProcess.get()?.text).toBe(DOC.text);
  });

  it('rebuilds nothing for a team with no document', async () => {
    const { teamProcess } = await coldApp(false);
    expect(teamProcess.get()).toBeNull();
  });
});
