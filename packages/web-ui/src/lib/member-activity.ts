/**
 * Member activity stream — hydration + live WebSocket tailing for a
 * single member's `/members/:name/activity` timeline.
 *
 * There's exactly one active subscription at a time — a new call
 * to `startMemberActivitySubscribe(name)` tears down the previous
 * WebSocket before opening a new one. Matches how the MemberProfile
 * page mounts/unmounts across navigation.
 *
 * On open:
 *   1. Hydrate via `listActivity(name)` — the server returns up to
 *      200 most-recent rows newest-first. We reverse into oldest-first
 *      so the rendered feed is chronological top-to-bottom (newest at
 *      the bottom — chat/`tail -f` semantics).
 *   2. Open the WebSocket at `/members/:name/activity/stream`.
 *   3. Every incoming message event is a JSON-encoded `ActivityRow`.
 *      Merge into the list, de-duping by `id` so overlap with the
 *      hydration backfill after a reconnect doesn't double-render.
 *
 * Reconnect: WebSocket doesn't auto-reconnect. We roll our own with
 * exponential backoff (1s → 30s cap, reset on successful open).
 *
 * We cap the in-memory list at `MAX_ROWS` to avoid unbounded growth
 * on long-running pages — oldest rows drop when the cap is exceeded.
 * `loadOlderMemberActivity()` fetches older rows on demand for
 * pagination.
 */

import { signal } from '@preact/signals';
import { ActivityRowSchema } from 'csuite-sdk/schemas';
import type { ActivityRow } from 'csuite-sdk/types';
import { getClient } from './client.js';
import {
  extendGenAiCallsBack,
  hydrateGenAiCalls,
  notifyExchangeArrived,
  startGenAiCallFeed,
  stopGenAiCallFeed,
} from './genai-feed.js';
import { resetGenAiRecords } from './genai-lazy.js';

/** Hard cap on the in-memory row list per subscription. */
const MAX_ROWS = 500;

/**
 * Rows for the currently-subscribed agent, **oldest-first** (newest
 * at the tail of the array). Empty when no subscription is active or
 * before hydration completes.
 */
export const memberActivityRows = signal<ActivityRow[]>([]);

/** True while the WebSocket connection is live. False before open / after drop. */
export const memberActivityConnected = signal(false);

/** True during initial hydration + any time `loadOlder()` is in flight. */
export const memberActivityLoading = signal(false);

/** Non-null when hydration failed — surfaced inline on the page. */
export const memberActivityError = signal<string | null>(null);

/** Name of the currently-subscribed agent. null when idle. */
export const memberActivityName = signal<string | null>(null);

/**
 * True when we've scrolled back as far as the server has — no more
 * older rows to fetch. Set when a `loadOlder()` call returns fewer
 * rows than the limit it asked for.
 */
export const memberActivityExhausted = signal(false);

export interface StartAgentActivityOptions {
  name: string;
  /** Backfill depth on hydrate. Default 200 (max). */
  hydrationLimit?: number;
  /** Surface errors to the page. */
  onError?: (err: unknown) => void;
}

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/**
 * Start (or switch) the member-activity subscription to the given
 * name. Returns a teardown function that closes the WebSocket and
 * clears the signals. Idempotent.
 */
export function startMemberActivitySubscribe(options: StartAgentActivityOptions): () => void {
  const { name, hydrationLimit = 200, onError } = options;
  const url = buildWsUrl(`/members/${encodeURIComponent(name)}/activity/stream`);

  let ws: WebSocket | null = null;
  let cancelled = false;
  let retryMs = INITIAL_RETRY_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Reset state for the new subscription — previous pages leave
  // their rows in the signal which would otherwise briefly flash
  // the old member's data.
  memberActivityRows.value = [];
  memberActivityConnected.value = false;
  memberActivityLoading.value = true;
  memberActivityError.value = null;
  memberActivityExhausted.value = false;
  memberActivityName.value = name;
  // Drop any lazily-loaded full records from the previous member so
  // they can't surface on this feed, and start a fresh call ledger
  // (hydrated once activity hydration knows its window).
  resetGenAiRecords();
  startGenAiCallFeed(name);

  const hydrate = async (): Promise<void> => {
    try {
      const rows = await getClient().listActivity(name, { limit: hydrationLimit });
      if (cancelled) return;
      // Server returns newest-first; flip to oldest-first for the
      // chat-style feed (newest at the bottom).
      const ascending = rows.slice().reverse();
      memberActivityRows.value =
        ascending.length > MAX_ROWS ? ascending.slice(-MAX_ROWS) : ascending;
      // If the server returned fewer than requested, there's no
      // more history to fetch.
      if (rows.length < hydrationLimit) memberActivityExhausted.value = true;
      memberActivityError.value = null;
      // Hydrate the genai call ledger over the same window — the
      // turn-spine join and the orphan call rows both feed off it.
      void hydrateGenAiCalls(ascending[0]?.event.ts ?? Date.now());
    } catch (err) {
      if (cancelled) return;
      const msg = err instanceof Error ? err.message : String(err);
      memberActivityError.value = msg;
      onError?.(err);
    } finally {
      if (!cancelled) memberActivityLoading.value = false;
    }
  };

  const scheduleReconnect = (): void => {
    if (cancelled) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  };

  const open = (): void => {
    if (cancelled) return;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      onError?.(err);
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      memberActivityConnected.value = true;
      retryMs = INITIAL_RETRY_MS;
      // Re-hydrate on every successful connect: on initial open
      // this seeds the list, on reconnect it fills any gap the
      // stream dropped. `mergeRow` de-dupes by id so the overlap
      // is harmless.
      void hydrate();
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      const raw = typeof event.data === 'string' ? event.data : '';
      if (!raw) return;
      try {
        // The zod schema's `.optional()` fields infer as `T | undefined`,
        // which trips `exactOptionalPropertyTypes` when handed to the
        // hand-written `ActivityRow` type (exact-optional). The parse has
        // already validated the shape, so cast the validated result —
        // same pattern the core activity-store uses.
        const row = ActivityRowSchema.parse(JSON.parse(raw)) as ActivityRow;
        mergeRow(row);
        // The turn's genai record lands at the broker a few seconds
        // after the marker — schedule catch-up sweeps of the ledger.
        if (row.event.kind === 'llm_exchange') notifyExchangeArrived();
      } catch (err) {
        onError?.(err);
      }
    });

    ws.addEventListener('error', () => {
      memberActivityConnected.value = false;
    });

    ws.addEventListener('close', () => {
      memberActivityConnected.value = false;
      ws = null;
      scheduleReconnect();
    });
  };

  open();

  return () => {
    cancelled = true;
    stopGenAiCallFeed();
    memberActivityConnected.value = false;
    memberActivityLoading.value = false;
    memberActivityName.value = null;
    memberActivityRows.value = [];
    memberActivityError.value = null;
    memberActivityExhausted.value = false;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      ws = null;
    }
  };
}

function buildWsUrl(path: string): string {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}${path}`;
}

/**
 * Merge a single freshly-arrived row into the oldest-first list.
 * Deduped by `id` — if an earlier hydration already has this row,
 * we leave the list alone. Appends new rows at the tail (the live
 * edge) and, when the cap is exceeded, drops the oldest from the
 * head.
 */
function mergeRow(row: ActivityRow): void {
  const existing = memberActivityRows.value;
  if (existing.some((r) => r.id === row.id)) return;
  // Insert in ts-ascending position. The common case is that the
  // new row is newer than everything in the list, so we fast-path
  // that and only walk the list for out-of-order arrivals.
  const newest = existing[existing.length - 1];
  if (!newest || row.event.ts >= newest.event.ts) {
    const next = [...existing, row];
    memberActivityRows.value = next.length > MAX_ROWS ? next.slice(-MAX_ROWS) : next;
    return;
  }
  const inserted = [...existing];
  const idx = inserted.findIndex((r) => r.event.ts > row.event.ts);
  if (idx === -1) inserted.push(row);
  else inserted.splice(idx, 0, row);
  memberActivityRows.value = inserted.length > MAX_ROWS ? inserted.slice(-MAX_ROWS) : inserted;
}

/**
 * Load one more page of older rows for the currently-subscribed
 * agent. Uses the oldest row in the current list as an upper
 * bound on the `to` query and asks the server for another
 * hydration-sized chunk. No-op if we're already exhausted or no
 * subscription is active.
 */
export async function loadOlderMemberActivity(limit = 100): Promise<void> {
  const name = memberActivityName.value;
  if (!name) return;
  if (memberActivityExhausted.value) return;
  const rows = memberActivityRows.value;
  const oldest = rows[0];
  if (!oldest) return;
  memberActivityLoading.value = true;
  try {
    // `to = oldest.ts - 1` so we don't re-fetch the oldest row.
    // Server returns newest-first; reverse so the older batch comes
    // back oldest-first and prepends cleanly.
    const olderDesc = await getClient().listActivity(name, {
      to: oldest.event.ts - 1,
      limit,
    });
    if (olderDesc.length === 0) {
      memberActivityExhausted.value = true;
      return;
    }
    const olderAsc = olderDesc.slice().reverse();
    const merged = [...olderAsc, ...rows];
    // Dedup by id as a safety net against concurrent inserts.
    const seen = new Set<number>();
    const deduped: ActivityRow[] = [];
    for (const r of merged) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      deduped.push(r);
    }
    // Cap from the head (drop oldest) to keep newest visible.
    memberActivityRows.value = deduped.length > MAX_ROWS ? deduped.slice(-MAX_ROWS) : deduped;
    if (olderDesc.length < limit) memberActivityExhausted.value = true;
    // Walk the call ledger back with the feed window.
    const newOldest = olderAsc[0];
    if (newOldest !== undefined) void extendGenAiCallsBack(newOldest.event.ts);
  } catch (err) {
    memberActivityError.value = err instanceof Error ? err.message : String(err);
  } finally {
    memberActivityLoading.value = false;
  }
}

/** Test-only reset for unit tests. */
export function __resetMemberActivityForTests(): void {
  memberActivityRows.value = [];
  memberActivityConnected.value = false;
  memberActivityLoading.value = false;
  memberActivityError.value = null;
  memberActivityName.value = null;
  memberActivityExhausted.value = false;
}
