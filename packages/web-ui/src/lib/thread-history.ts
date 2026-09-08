/**
 * Thread history paging — lazy hydration for the chat transcript.
 *
 * The live subscription (`live.ts`) only hydrates a small global
 * window of recent messages on connect. That's enough to show a
 * thread's tail, but a DM or channel the viewer scrolls back through
 * needs older messages fetched on demand — otherwise the transcript
 * silently bottoms out at whatever the global hydration happened to
 * include.
 *
 * Two entry points:
 *   - `hydrateThread` — run once when a thread is first opened. Pulls
 *     the most recent page for *that* thread specifically (the global
 *     hydration is not thread-scoped, so a quiet DM can be missing from
 *     it entirely).
 *   - `loadOlderThreadMessages` — pull the next older page, anchored on
 *     the composite `{ts, id}` cursor of the oldest message held.
 *
 * Both fetch into the shared `messagesByThread` store via
 * `prependMessages`, which dedups by id — so overlap with the live
 * hydration or with a previous page is harmless.
 *
 * Per-thread state (`loading`, `exhausted`, `hydrated`) lives in one
 * signal keyed by thread key, so the transcript can render a spinner
 * / hide the "load older" control without each thread needing its own
 * signal.
 */

import { signal } from '@preact/signals';
import type { HistoryQuery, Message } from 'csuite-sdk/types';
import { getClient } from './client.js';
import {
  channelIdOfThread,
  dmOther,
  isDmThread,
  prependMessages,
  threadMessages,
} from './messages.js';

/** Messages fetched per history page. */
const PAGE_SIZE = 50;

export interface ThreadHistoryState {
  /** A hydrate or load-older fetch is in flight. */
  loading: boolean;
  /** The server has no older messages for this thread. */
  exhausted: boolean;
  /** `hydrateThread` has run (successfully or not) for this thread. */
  hydrated: boolean;
}

const EMPTY_STATE: ThreadHistoryState = { loading: false, exhausted: false, hydrated: false };

/** Per-thread paging state, keyed by thread key. */
export const threadHistory = signal<Map<string, ThreadHistoryState>>(new Map());

/** Read paging state for a thread; never null. */
export function threadHistoryState(key: string): ThreadHistoryState {
  return threadHistory.value.get(key) ?? EMPTY_STATE;
}

function patchState(key: string, patch: Partial<ThreadHistoryState>): void {
  const next = new Map(threadHistory.value);
  next.set(key, { ...threadHistoryState(key), ...patch });
  threadHistory.value = next;
}

/**
 * Build the thread-scoping query for a thread key. DM threads filter
 * by counterpart (`with`); channel threads (including the general /
 * primary thread) filter by channel id. Returns `null` for threads
 * with no server-side history endpoint — objective threads and the
 * self-DM — so callers skip paging cleanly.
 */
function queryFor(threadKey: string): HistoryQuery | null {
  if (isDmThread(threadKey)) {
    const other = dmOther(threadKey);
    if (other === null || other === 'self') return null;
    return { with: other };
  }
  const channelId = channelIdOfThread(threadKey);
  if (channelId !== null) return { channel: channelId };
  return null;
}

/**
 * Fetch the most recent page for a thread the first time it's opened.
 * Idempotent — the `hydrated` flag guards re-entry, so it's safe to
 * call on every mount / thread switch. No-op for threads without a
 * history endpoint.
 */
export async function hydrateThread(viewer: string, threadKey: string): Promise<void> {
  const state = threadHistoryState(threadKey);
  if (state.hydrated || state.loading) return;
  const query = queryFor(threadKey);
  if (query === null) {
    patchState(threadKey, { hydrated: true, exhausted: true });
    return;
  }
  patchState(threadKey, { loading: true });
  try {
    const page = await getClient().history({ ...query, limit: PAGE_SIZE });
    prependMessages(viewer, page);
    patchState(threadKey, {
      hydrated: true,
      loading: false,
      exhausted: page.length < PAGE_SIZE,
    });
  } catch {
    // Leave `hydrated` false so a later open retries; clear `loading`
    // so the transcript drops its spinner.
    patchState(threadKey, { loading: false });
  }
}

/**
 * Fetch the next older page for a thread, anchored before the oldest
 * message currently in the store. No-op when already loading, already
 * exhausted, or the thread has no history endpoint.
 *
 * The anchor is the composite `{ts, id}` cursor, not the oldest
 * message's timestamp. A timestamp alone excludes every message sharing
 * that millisecond — including ones this pager has never seen, which it
 * then has no way to ask for again — and a run of them at a boundary
 * also short-pages, which the `exhausted` check below reads as the end
 * of the thread. The activity pager next door names the same failure in
 * its own comment; this one used to be the pattern it warns about.
 */
/**
 * The furthest-back message held, in the server's own order.
 *
 * NOT `messages[0]`. The local store sorts on `ts` alone, so within a
 * shared millisecond its head is whichever message happened to merge
 * first — while `/history` orders `ts DESC, id DESC`. Resuming from the
 * local head would therefore ask the server to continue from a point it
 * has already passed, and everything between the two is skipped. The
 * minimum of `(ts, id)` is the same row under both orderings, which is
 * the only anchor that survives the disagreement.
 */
function resumePoint(messages: readonly Message[]): Message | undefined {
  let oldest: Message | undefined;
  for (const m of messages) {
    if (oldest === undefined || m.ts < oldest.ts || (m.ts === oldest.ts && m.id < oldest.id)) {
      oldest = m;
    }
  }
  return oldest;
}

export async function loadOlderThreadMessages(viewer: string, threadKey: string): Promise<void> {
  const state = threadHistoryState(threadKey);
  if (state.loading || state.exhausted) return;
  const query = queryFor(threadKey);
  if (query === null) return;

  const oldest = resumePoint(threadMessages(threadKey));
  patchState(threadKey, { loading: true });
  try {
    const page = await getClient().history({
      ...query,
      limit: PAGE_SIZE,
      ...(oldest ? { cursor: { ts: oldest.ts, id: oldest.id } } : {}),
    });
    prependMessages(viewer, page);
    patchState(threadKey, {
      loading: false,
      exhausted: page.length < PAGE_SIZE,
    });
  } catch {
    patchState(threadKey, { loading: false });
  }
}

/** Test-only reset so unit tests start clean. */
export function __resetThreadHistoryForTests(): void {
  threadHistory.value = new Map();
}
