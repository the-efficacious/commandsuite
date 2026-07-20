/**
 * Per-thread unread tracking.
 *
 * State: `lastReadByThread` maps a thread key to the ts of the latest
 * message the viewer has seen in that thread. Unread count for a
 * thread = messages with `ts > lastRead[key]` AND `from !== viewer`.
 * Self-sends never count as unread — your own outbound broadcast
 * shouldn't leave a "(1)" badge on Team Chat after you hit send.
 *
 * Lifecycle:
 *
 *   1. Shell mounts, loads `/history`, calls `appendMessages(...)`.
 *   2. Shell calls `initializeLastReadFromStore()` — seeds lastRead
 *      for every thread in the store to its latest ts. Everything
 *      already loaded is treated as read. MUST happen before SSE
 *      opens, otherwise a message arriving mid-bootstrap races with
 *      the seed and could get marked read-on-arrival.
 *   3. SSE stream opens. New messages land in `messagesByThread` but
 *      lastRead stays at the seed value, so unread counts grow for
 *      every thread except the one the user is actively looking at.
 *   4. An `effect()` in Shell watches `view` + `messagesByThread`
 *      and calls `markThreadRead(activeKey, latestTs)` whenever either
 *      changes — that's what keeps the active thread always at zero
 *      unread while the user is on it.
 *   5. User clicks a different thread → `markThreadRead` bumps the
 *      new active thread's lastRead, its badge clears.
 *
 * Non-persistent: reloading the page resets the unread state. That
 * matches most chat apps' behavior for "unread since you last loaded
 * this tab" and avoids a localStorage dependency. Can be layered on
 * later if a real use case appears.
 */

import { signal } from '@preact/signals';
import type { Message } from 'csuite-sdk/types';
import { messagesByThread } from './messages.js';

export const lastReadByThread = signal<Map<string, number>>(new Map());

/**
 * Guard: only seed lastRead once per page load. Calling
 * `initializeLastReadFromStore` a second time mid-session would wipe
 * the map and silently mark every unseen message as read. Shell's
 * mount effect re-runs when the authenticated slot changes, so the
 * reset-on-login path goes through `__resetUnreadForTests` explicitly.
 */
let initialized = false;

/**
 * Bump a thread's lastRead position forward to `ts`. Monotonic —
 * never moves backward, so an out-of-order SSE backfill can't
 * "un-read" a later message by delivering an earlier one.
 */
export function markThreadRead(threadKey: string, ts: number): void {
  const existing = lastReadByThread.value.get(threadKey) ?? 0;
  if (ts <= existing) return;
  const next = new Map(lastReadByThread.value);
  next.set(threadKey, ts);
  lastReadByThread.value = next;
}

/**
 * Seed lastRead for every thread currently in the message store to
 * its latest message's ts. Called once at Shell mount after the
 * initial history load, BEFORE the SSE stream opens.
 *
 * Wipes any previous lastRead state — this is an initialization
 * helper, not an incremental update. Calling it mid-session would
 * mark all current content as read, which is not what a "reset"
 * semantic should do. Keep it to one invocation per Shell mount.
 */
export function initializeLastReadFromStore(): void {
  if (initialized) return;
  initialized = true;
  const next = new Map<string, number>();
  for (const [key, messages] of messagesByThread.value) {
    if (messages.length === 0) continue;
    const latest = messages[messages.length - 1];
    if (latest) next.set(key, latest.ts);
  }
  lastReadByThread.value = next;
}

/**
 * Pure unread-count computation. Takes both state maps as
 * parameters so callers can read the signal values once at the top
 * of a render and pass them down — avoids each per-row call
 * re-reading and re-subscribing the caller.
 *
 * Counts messages with ts > lastRead and excludes any from the
 * viewer's own slot. Self-DMs (`from === viewer && agentId ===
 * viewer`) naturally get excluded because `from === viewer` checks
 * before anything else.
 */
export function unreadCount(
  threadKey: string,
  viewer: string,
  lastReadMap: Map<string, number>,
  msgMap: Map<string, Message[]>,
): number {
  const lr = lastReadMap.get(threadKey) ?? 0;
  const msgs = msgMap.get(threadKey) ?? [];
  let count = 0;
  for (const m of msgs) {
    if (m.ts <= lr) continue;
    if (m.from === viewer) continue;
    count++;
  }
  return count;
}

/** Test reset. */
export function __resetUnreadForTests(): void {
  lastReadByThread.value = new Map();
  initialized = false;
}
