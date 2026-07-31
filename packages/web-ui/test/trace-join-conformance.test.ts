/**
 * The UI half of the trace-join conformance corpus.
 *
 * `fixtures/trace-join-conformance.json` is shared with
 * `apps/server/test/capture-health-conformance.test.ts`. Both run the
 * same cases; this file asserts what `joinTurns` does with them.
 *
 * The point is not that this join is correct in isolation — it has its
 * own tests for that. The point is that when someone changes it, the
 * corpus says whether the broker's capture-health predicate still
 * agrees, without them having to know that a second join exists.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActivityLlmExchange } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { type JoinableCall, joinTurns } from '../src/lib/trace-join.js';

const CORPUS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/trace-join-conformance.json',
);

interface Case {
  name: string;
  why: string;
  markers: Array<{
    responseId: string | null;
    startedAt: number;
    endedAt: number;
    model: string | null;
    querySource: string | null;
  }>;
  calls: Array<{
    id: number;
    ts: number;
    model: string | null;
    responseId: string | null;
    querySource: string | null;
  }>;
  expect: {
    ui: {
      matched: number[];
      callsPerTurn: number[][];
      orphans: number[];
      matchStates?: Array<'exact' | 'containment' | 'unmatched-exact' | 'unmatched'>;
    };
    broker: { matched: number[]; evaluated: boolean };
  };
  divergence?: string;
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { cases: Case[] };

function toExchange(m: Case['markers'][number]): ActivityLlmExchange {
  return {
    kind: 'llm_exchange',
    ts: m.startedAt,
    duration: m.endedAt - m.startedAt,
    ...(m.querySource !== null ? { querySource: m.querySource } : {}),
    entry: {
      kind: 'anthropic_messages',
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      request: {
        model: m.model,
        maxTokens: null,
        temperature: null,
        system: null,
        messages: [],
        tools: null,
      },
      response: {
        stopReason: null,
        stopSequence: null,
        messages: [],
        usage: null,
        status: 200,
        responseId: m.responseId,
      },
    },
  } as ActivityLlmExchange;
}

describe('trace-join conformance corpus (UI side)', () => {
  it('the corpus is non-empty and every case declares both expectations', () => {
    // A corpus that silently emptied would make every case below vacuous
    // and the suite would still be green.
    expect(corpus.cases.length).toBeGreaterThan(0);
    for (const c of corpus.cases) {
      expect(c.expect.ui, c.name).toBeDefined();
      expect(c.expect.broker, c.name).toBeDefined();
    }
  });

  for (const c of corpus.cases) {
    it(`${c.name}: ${c.why}`, () => {
      const exchanges = c.markers.map(toExchange);
      const calls: JoinableCall[] = c.calls.map((call) => ({
        id: call.id,
        ts: call.ts,
        model: call.model,
        responseId: call.responseId,
        querySource: call.querySource,
      }));

      const result = joinTurns(exchanges, calls);
      const matched = result.turns
        .map((t, i) => (t.calls.length > 0 ? i : -1))
        .filter((i) => i >= 0);

      expect(matched).toEqual(c.expect.ui.matched);

      // WHICH record attached, not merely whether one did. `matched`
      // alone is too coarse: a mutation that glues a spare record onto
      // an already-exactly-matched turn leaves every turn non-empty and
      // slips through. That mutation survived until these two lines
      // existed.
      expect(result.turns.map((t) => t.calls.map((call) => call.id))).toEqual(
        c.expect.ui.callsPerTurn,
      );
      expect(result.orphans.map((o) => o.id)).toEqual(c.expect.ui.orphans);
      if (c.expect.ui.matchStates !== undefined) {
        expect(result.turns.map((t) => t.match)).toEqual(c.expect.ui.matchStates);
      }
    });
  }

  it('every divergence between the two joins is declared with a reason', () => {
    // An UNdeclared divergence is the drift the shared corpus exists to
    // catch. A declared one is a decision someone wrote down.
    for (const c of corpus.cases) {
      const agrees =
        c.expect.broker.evaluated &&
        JSON.stringify(c.expect.ui.matched) === JSON.stringify(c.expect.broker.matched);
      if (!agrees) {
        expect(c.divergence, `${c.name} diverges but declares no reason`).toBeTruthy();
      }
    }
  });
});
