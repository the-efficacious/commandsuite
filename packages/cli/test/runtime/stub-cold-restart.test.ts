/**
 * Cold-restart substrate conformance, driven through `csuite stub`.
 *
 * An instruction edit no longer resumes the agent's conversation: the
 * successor starts cold, and what makes that safe is the SUBSTRATE
 * around it — not anything a model does. This suite asserts that
 * substrate end to end, through the real command entry point against
 * the fake broker, with the stub as the deterministic agent:
 *
 *   1. the swap is COLD and says so: the successor's `session_start`
 *      carries `resumed: false` with `resumeReason: 'instructions
 *      changed'`, after the predecessor's `session_end`;
 *   2. instructions are re-fetched and the successor composes from the
 *      refreshed packet before its first turn (the packet on the broker
 *      changes between the generations, and the successor reports the
 *      new length);
 *   3. the `context_refresh` re-brief reaches the successor's session
 *      and enumerates EVERY open objective — including within the
 *      cooldown window of the predecessor's own re-brief;
 *   4. mail arriving across the seam is neither lost nor doubled: a DM
 *      sent while the swap is in flight is answered exactly once, by
 *      the successor;
 *   5. capture continuity: the capture host follows the successor's
 *      transcript path, emits only the lines that are new, and re-emits
 *      NOTHING from the history a resumed transcript replays — the
 *      regression net for the runner-side re-pin and the `sourceId`
 *      stamp (1000+ historical rows re-uploaded in one second, measured
 *      in production before those existed).
 *
 * The stub has no transcript of its own, so (5) drives the capture
 * host's hook endpoint directly — the same POSTs Claude Code's hooks
 * make — with hand-authored transcript files. That is the real host,
 * the real reader and the real uploader; only the agent is canned.
 *
 * The fake broker holds no delivery ledger, so the broker-side lease
 * release (`releaseOwner`) is out of reach here; (4) asserts the runner
 * seam — the sink buffers during the swap and hands the mail to the
 * successor — and the answer's arrival at the broker.
 *
 * Skips, like the conformance kit, when `dist/index.js` is not built:
 * the stub spawns the real `csuite mcp-bridge` from it.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, type LogRecord } from 'csuite-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runStubCommand } from '../../src/commands/stub.js';
import { CLI_BINARY } from './conformance/kit.js';
import {
  FAKE_BROKER_NAME,
  FAKE_BROKER_TOKEN,
  type FakeBroker,
  fakeBrokerActivity,
  fakeBrokerInstructions,
  fakeBrokerInstructionsRunnerVersions,
  fakeBrokerObjectives,
  fakeBrokerTimeline,
  startFakeBroker,
} from './fake-broker.js';

const describeIfBuilt = existsSync(CLI_BINARY) ? describe : describe.skip;

async function waitFor(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function objective(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title,
    body: '',
    outcome: `${title} is done.`,
    status: 'active',
    assignee: FAKE_BROKER_NAME,
    originator: 'director-1',
    watchers: [],
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    result: null,
    blockReason: null,
    attachments: [],
    ...over,
  };
}

const userLine = (uuid: string, iso: string, text: string): string =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: iso,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
const assistantLine = (uuid: string, iso: string, text: string): string =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: iso,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

async function postHook(url: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // The fixture must reach the hook server; a 404 here would otherwise
  // read as "the reader never saw the path" further down.
  expect(res.status).toBe(200);
  await res.arrayBuffer();
}

describeIfBuilt('cold instruction restart — substrate (csuite stub)', () => {
  let broker: FakeBroker;
  let sandbox: string;
  let records: LogRecord[];
  const log = createLogger({ level: 'debug', emit: (record) => records.push(record) });

  beforeAll(async () => {
    broker = await startFakeBroker();
  });

  afterAll(async () => {
    await broker.close();
  });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'csuite-stub-cold-'));
    records = [];
    fakeBrokerActivity.length = 0;
    fakeBrokerTimeline.length = 0;
    fakeBrokerObjectives.length = 0;
    fakeBrokerInstructions.value = '';
  });

  afterEach(() => {
    delete process.env.CSUITE_STUB_EXIT_AFTER_MS;
    delete process.env.CSUITE_STUB_EXIT_CODE;
    fakeBrokerObjectives.length = 0;
    fakeBrokerInstructions.value = '';
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('cold-opens the successor: re-fetched packet, full re-brief, mail intact, capture continuous', async () => {
    const V1 = 'v1: ship the thing';
    const V2 = 'v2: ship the thing, then write it up properly';
    fakeBrokerInstructions.value = V1;
    fakeBrokerObjectives.push(
      objective('obj-1', 'Restore search indexing'),
      objective('obj-2', 'Rotate signing keys', {
        status: 'blocked',
        blockReason: 'waiting on ops approval',
      }),
      objective('obj-3', 'Backfill the audit table'),
    );
    const fetchesBefore = fakeBrokerInstructionsRunnerVersions.length;

    // No exit knob yet: the FIRST generation must live until the
    // restart replaces it. The knob is set below, before the restart,
    // and only the successor (which reads env at its own spawn) arms it.
    const session = runStubCommand({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      cwd: sandbox,
      logger: log,
      bridgeCommand: process.execPath,
      bridgeArgs: [CLI_BINARY, 'mcp-bridge'],
    });

    const starts = () => fakeBrokerActivity.filter((a) => a.event.kind === 'session_start');
    const ends = () => fakeBrokerActivity.filter((a) => a.event.kind === 'session_end');
    const liveLogs = () => records.filter((r) => r.msg === 'stub agent generation live');
    const rebriefsFor = (session: unknown) =>
      records.filter(
        (r) =>
          r.msg === 'stub received channel event' &&
          r.kind === 'context_refresh' &&
          r.session === session,
      );

    // ── Generation 1 up: presence, bracket, toolbox listed, re-briefed ──
    const sub = await broker.waitForSubscriber(FAKE_BROKER_NAME, 10_000);
    await waitFor(() => starts().length === 1, 'the first session_start');
    await waitFor(() => liveLogs().length === 1, 'generation 1 live');
    const gen1 = liveLogs()[0]?.session;
    expect(typeof gen1).toBe('string');
    expect(liveLogs()[0]?.instructionChars).toBe(V1.length);
    // The predecessor's own re-brief — so the successor's, seconds
    // later, lands INSIDE the cooldown that once suppressed it.
    await waitFor(() => rebriefsFor(gen1).length === 1, 'generation 1 re-brief');

    // The capture host is the runner's, not the generation's: one hook
    // endpoint spans the swap. Drive it as Claude Code's hooks would.
    const started = records.find((r) => r.msg === 'started' && typeof r.hookUrl === 'string');
    expect(started, 'capture host never logged its hook endpoint').toBeDefined();
    const hookUrl = started?.hookUrl as string;

    const pathA = join(sandbox, 'transcript-a.jsonl');
    writeFileSync(
      pathA,
      `${userLine('a-1', '2026-07-05T00:00:01.000Z', 'first ask')}\n` +
        `${assistantLine('asst-a', '2026-07-05T00:00:02.000Z', 'first answer')}\n`,
    );
    await postHook(hookUrl, {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'sess-a',
      transcript_path: pathA,
    });
    const uploadedIds = () =>
      fakeBrokerActivity.map((a) => a.event.sourceId).filter((id) => typeof id === 'string');
    await waitFor(
      () => uploadedIds().includes('a-1') && uploadedIds().includes('asst-a'),
      "transcript A's two lines at the broker",
    );

    // ── The edit: packet changes on the broker, event fans out ──────────
    fakeBrokerInstructions.value = V2;
    process.env.CSUITE_STUB_EXIT_AFTER_MS = '3000';
    process.env.CSUITE_STUB_EXIT_CODE = '0';
    // The broker's own fan-out shape: a targeted notice from `csuite`
    // (see the instruction-edit fanout in core's app.ts). It is also
    // delivered as ambient input, and the stub answers any addressed
    // DM — so the mail assertions below select by recipient.
    sub.write({
      id: 'msg-instructions',
      ts: 1_700_000_001_000,
      to: FAKE_BROKER_NAME,
      from: 'csuite',
      title: null,
      body: 'Instruction blocks edited by director-1 (personal). Your composed instructions changed.',
      level: 'notice',
      data: {
        kind: 'instructions',
        event: 'edited',
        changed: ['personal'],
        actor: 'director-1',
        affected: [FAKE_BROKER_NAME],
      },
    });

    // Predecessor down — its bracket closes with the restart reason…
    await waitFor(() => ends().length === 1, "generation 1's session_end");
    expect(ends()[0]?.event.reason).toBe('restart-instructions');
    // …and mail arriving NOW lands in the seam: the sink is detached,
    // the successor not yet up. It must reach the successor, once.
    sub.write({
      id: 'msg-dm-across-seam',
      ts: 1_700_000_002_000,
      to: FAKE_BROKER_NAME,
      from: 'admin',
      title: null,
      body: 'are you there?',
      level: 'info',
      data: {},
    });

    // ── Generation 2: cold, on the refreshed packet, re-briefed ──────────
    await waitFor(() => starts().length === 2, "the successor's session_start");
    expect(starts()[1]?.event).toMatchObject({
      runner: 'stub',
      resumed: false,
      resumeReason: 'instructions changed',
    });
    // Ordered: the predecessor's end precedes the successor's start.
    expect(
      fakeBrokerActivity.indexOf(ends()[0] as (typeof fakeBrokerActivity)[number]),
    ).toBeLessThan(fakeBrokerActivity.indexOf(starts()[1] as (typeof fakeBrokerActivity)[number]));

    await waitFor(() => liveLogs().length === 2, 'generation 2 live');
    const gen2 = liveLogs()[1]?.session;
    expect(typeof gen2).toBe('string');
    expect(gen2).not.toBe(gen1);
    // Composed from the REFRESHED packet: V2's length, not V1's — and
    // the refetch itself is on the record, before the successor spawned.
    expect(liveLogs()[1]?.instructionChars).toBe(V2.length);
    expect(fakeBrokerInstructionsRunnerVersions.length).toBeGreaterThan(fetchesBefore + 1);
    const refreshedAt = records.findIndex((r) => r.msg === 'instructions refreshed');
    const gen2LiveAt = records.indexOf(liveLogs()[1] as LogRecord);
    expect(refreshedAt).toBeGreaterThanOrEqual(0);
    expect(refreshedAt).toBeLessThan(gen2LiveAt);

    // The re-brief reaches the successor's session and names EVERY open
    // objective — a partial plate would pass a presence check on one id.
    await waitFor(() => rebriefsFor(gen2).length === 1, "the successor's re-brief");
    const plate = rebriefsFor(gen2)[0]?.content as string;
    expect(plate).toContain('your open objectives (3)');
    for (const o of fakeBrokerObjectives) {
      expect(plate).toContain(`- ${o.id as string} [`);
      expect(plate).toContain(o.title as string);
    }
    expect(plate).toContain('[blocked]');
    expect(plate).toContain('waiting on ops approval');

    // ── Capture continuity across the seam ──────────────────────────────
    // The successor's transcript in its most hostile shape: the whole
    // prior history replayed under the SAME uuids (what a resumed or
    // forked session writes), then the genuinely new lines.
    const pathB = join(sandbox, 'transcript-b.jsonl');
    writeFileSync(
      pathB,
      `${userLine('a-1', '2026-07-05T00:00:01.000Z', 'first ask')}\n` +
        `${assistantLine('asst-a', '2026-07-05T00:00:02.000Z', 'first answer')}\n` +
        `${userLine('b-1', '2026-07-05T00:00:03.000Z', 'second ask')}\n` +
        `${assistantLine('asst-b', '2026-07-05T00:00:04.000Z', 'second answer')}\n`,
    );
    await postHook(hookUrl, {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'sess-b',
      transcript_path: pathB,
    });
    await waitFor(
      () => uploadedIds().includes('b-1') && uploadedIds().includes('asst-b'),
      "transcript B's new lines at the broker",
    );

    // ── Session ends on the successor's own exit ────────────────────────
    expect(await session).toBe(0);

    // Exactly one of each: the replayed history was recognised, the new
    // lines emitted once. A count of two here is the production defect.
    const ids = uploadedIds();
    for (const id of ['a-1', 'asst-a', 'b-1', 'asst-b']) {
      expect(
        ids.filter((x) => x === id),
        `sourceId ${id}`,
      ).toHaveLength(1);
    }
    // Nothing was dropped on either generation — the uploader was never
    // saturated by a history burst.
    expect(ends()).toHaveLength(2);
    expect(ends()[1]?.event.reason).toBe('agent-exited-0');
    for (const end of ends()) {
      expect((end.event.capture as { dropped: number }).dropped).toBe(0);
    }
    // Each session_end names its own generation, so the mail check below
    // can attribute the answer.
    expect(ends()[0]?.event.agentSessionId).toBe(gen1);
    expect(ends()[1]?.event.agentSessionId).toBe(gen2);

    // The DM sent into the seam was answered exactly once, by the
    // successor, and the answer reached the broker.
    const answers = records.filter(
      (r) => r.msg === 'stub answered a DM with the canned turn' && r.to === 'admin',
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]?.session).toBe(gen2);
    const replies = broker.pushes.filter((p) => p.to === 'admin');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.body).toContain('stub runner');
  }, 40_000);
});
