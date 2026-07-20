/**
 * The member's GenAI call ledger — light inference SUMMARIES for the
 * activity feed's window, kept fresh alongside the live stream.
 *
 * The turn-spine timeline needs the genai layer for two things the
 * activity stream can't provide: which API call(s) each turn marker
 * corresponds to (the join key for lazy full-context loading), and
 * the calls that have NO marker at all — subagent work, server-tool
 * sidecars (web search), away summaries — which would otherwise be
 * invisible in the feed. Summaries (no content bodies) are cheap
 * (~200 bytes/row), so we hydrate the whole visible window eagerly
 * and let `genai-lazy.ts` pull full bodies per call on expand.
 *
 * Freshness: genai records land at the broker AFTER the transcript
 * marker — Claude Code's OTLP body export flushes late (observed up
 * to ~10s after the call), codex bundles ship per turn. There's no
 * push channel for this store, so when a new `llm_exchange` arrives
 * on the activity WebSocket we schedule two catch-up fetches (a
 * quick one and a late straggler sweep), each pulling from a little
 * before the newest summary we hold and merging by id. Quiet on
 * failure — this layer is enrichment; the feed keeps rendering
 * markers and reports "not captured" honestly.
 */

import { signal } from '@preact/signals';
import type { GenAiInferenceSummary } from 'csuite-sdk/types';
import { getClient } from './client.js';

/** In-memory cap; oldest drop first (matches the activity feed cap philosophy). */
const MAX_CALLS = 2_000;
/** Rows per hydration/backfill fetch. */
const FETCH_LIMIT = 1_000;
/** Widen fetch windows by this much to absorb capture-clock skew. */
const WINDOW_SLACK_MS = 30_000;
/** Catch-up fetch delays after a new exchange arrives on the stream. */
const REFRESH_DELAYS_MS = [3_000, 15_000];

/** Call summaries for the subscribed member, ts-ascending. */
export const memberGenAiCalls = signal<GenAiInferenceSummary[]>([]);

/**
 * True once the initial hydration has settled (success OR failure).
 * Until then, turn expanders show "loading" instead of a premature
 * "not captured".
 */
export const memberGenAiCallsReady = signal(false);

let subscribedName: string | null = null;
let hydratedFrom: number | null = null;
let refreshTimers: Array<ReturnType<typeof setTimeout>> = [];

/** Begin a fresh ledger for `name`. Clears any previous state. */
export function startGenAiCallFeed(name: string): void {
  stopGenAiCallFeed();
  subscribedName = name;
}

/** Tear down: clear timers, signals, and the subscription. */
export function stopGenAiCallFeed(): void {
  for (const t of refreshTimers) clearTimeout(t);
  refreshTimers = [];
  subscribedName = null;
  hydratedFrom = null;
  memberGenAiCalls.value = [];
  memberGenAiCallsReady.value = false;
}

/**
 * Hydrate the ledger for the feed's visible window — called once the
 * activity hydration knows its oldest row. Idempotent per subscribe.
 */
export async function hydrateGenAiCalls(fromTs: number): Promise<void> {
  const name = subscribedName;
  if (name === null) return;
  hydratedFrom = fromTs;
  try {
    const rows = await getClient().listGenaiSummaries(name, {
      from: fromTs - WINDOW_SLACK_MS,
      limit: FETCH_LIMIT,
    });
    if (subscribedName !== name) return;
    mergeCalls(rows);
  } catch {
    // Enrichment only — older brokers without the summary view, or a
    // transient failure, degrade to a markers-only feed.
  } finally {
    if (subscribedName === name) memberGenAiCallsReady.value = true;
  }
}

/**
 * A new `llm_exchange` landed on the live stream — its genai record
 * arrives at the broker seconds later. Schedule catch-up fetches
 * unless a pair is already pending (bursts collapse into the same
 * sweeps; a steady stream of turns can't starve the timer, and each
 * sweep's window overlap picks up anything the previous one missed).
 */
export function notifyExchangeArrived(): void {
  if (subscribedName === null || refreshTimers.length > 0) return;
  refreshTimers = REFRESH_DELAYS_MS.map((delay) => {
    const timer = setTimeout(() => {
      // Self-remove so the slot frees as sweeps fire; once the last
      // one runs, the next exchange can schedule a fresh pair.
      refreshTimers = refreshTimers.filter((t) => t !== timer);
      void refreshGenAiCalls();
    }, delay);
    return timer;
  });
}

/** Extend the ledger backwards to `fromTs` (feed "load older"). */
export async function extendGenAiCallsBack(fromTs: number): Promise<void> {
  const name = subscribedName;
  if (name === null) return;
  const oldest = memberGenAiCalls.value[0];
  const to = oldest !== undefined ? oldest.ts : Date.now();
  if (hydratedFrom !== null && fromTs >= hydratedFrom) return;
  hydratedFrom = fromTs;
  try {
    const rows = await getClient().listGenaiSummaries(name, {
      from: fromTs - WINDOW_SLACK_MS,
      to,
      limit: FETCH_LIMIT,
    });
    if (subscribedName !== name) return;
    mergeCalls(rows);
  } catch {
    /* enrichment only */
  }
}

/** Pull anything newer than (a little before) the newest summary we hold. */
async function refreshGenAiCalls(): Promise<void> {
  const name = subscribedName;
  if (name === null) return;
  const list = memberGenAiCalls.value;
  const newest = list[list.length - 1];
  const from = (newest !== undefined ? newest.ts : (hydratedFrom ?? Date.now())) - WINDOW_SLACK_MS;
  try {
    const rows = await getClient().listGenaiSummaries(name, { from, limit: FETCH_LIMIT });
    if (subscribedName !== name) return;
    mergeCalls(rows);
    // Even if hydration failed earlier, a successful refresh means the
    // ledger is live — let the feed trust it.
    memberGenAiCallsReady.value = true;
  } catch {
    /* enrichment only */
  }
}

/** Merge fetched rows into the ledger: dedupe by id, ts-ascending, capped. */
function mergeCalls(rows: GenAiInferenceSummary[]): void {
  if (rows.length === 0) return;
  const seen = new Set<number>();
  const merged: GenAiInferenceSummary[] = [];
  for (const r of [...memberGenAiCalls.value, ...rows]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  merged.sort((a, b) => a.ts - b.ts || a.id - b.id);
  memberGenAiCalls.value = merged.length > MAX_CALLS ? merged.slice(-MAX_CALLS) : merged;
}

/** Test-only reset. */
export function __resetGenAiCallFeedForTests(): void {
  stopGenAiCallFeed();
}
