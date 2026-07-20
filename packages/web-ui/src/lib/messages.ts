/**
 * Messages signal — transcript state keyed by thread.
 *
 * A "thread" is:
 *   - the shared team channel (`primary`)
 *   - a DM conversation (`dm:<other>`)
 *   - an objective's discussion thread (`obj:<id>`)
 *
 * `threadKeyOf` maps a Message to its thread key from the perspective
 * of the current viewer. When the sender tags a message with an
 * explicit thread key in `data.thread`, that wins — this is how
 * objective discussions and objective lifecycle events route into
 * their dedicated thread. Otherwise we fall back to the legacy
 * primary/DM derivation based on `agentId` + `from`.
 *
 * The signal value is a `Map<threadKey, Message[]>` — we store the Map
 * itself so reads stay O(1) and we can still replace it on change to
 * trigger signal reactivity. Append dedupes by message id — important
 * because SSE reconnects re-pull /history and we don't want duplicates
 * when reconciling.
 */

import { signal } from '@preact/signals';
import type { Message } from 'csuite-sdk/types';

export const PRIMARY_THREAD = 'primary';
export const DM_PREFIX = 'dm:';
export const OBJ_PREFIX = 'obj:';
export const CHAN_PREFIX = 'chan:';
/**
 * Special channel id reserved for the synthetic "general" channel —
 * the always-present, everyone's-default team thread. Server-side this
 * is `GENERAL_CHANNEL_ID` in `csuite-core`. We re-export the same
 * literal here to avoid a cross-package import for one constant.
 */
export const GENERAL_CHANNEL_ID = 'general';

/**
 * Thread key for the general channel. We continue to use the legacy
 * `'primary'` value so existing subscribers, persisted last-read
 * cursors, and the messages-map don't break — `general` is the same
 * thread, just renamed in the UI.
 */
export const GENERAL_THREAD = PRIMARY_THREAD;

/**
 * Build a DM thread key from the counterpart name. Centralized
 * so callers (sidebar clicks, composer targeting, transcript empty
 * state) never build the `dm:X` string literal by hand — if the key
 * format ever changes, this is the single point of edit.
 */
export function dmThreadKey(other: string): string {
  return `${DM_PREFIX}${other}`;
}

/** True if `key` names a DM thread (not the shared team channel). */
export function isDmThread(key: string): boolean {
  return key.startsWith(DM_PREFIX);
}

/** Build an objective thread key from an objective id. */
export function objectiveThreadKey(id: string): string {
  return `${OBJ_PREFIX}${id}`;
}

/** True if `key` names an objective discussion thread. */
export function isObjectiveThread(key: string): boolean {
  return key.startsWith(OBJ_PREFIX);
}

/**
 * Thread key for a non-general channel. The general channel uses the
 * legacy `PRIMARY_THREAD` key — see `channelThreadKey` below for the
 * id-aware version that handles both.
 */
export function channelThreadKey(channelId: string): string {
  if (channelId === GENERAL_CHANNEL_ID) return GENERAL_THREAD;
  return `${CHAN_PREFIX}${channelId}`;
}

/** True if `key` names a channel thread (general OR explicit `chan:<id>`). */
export function isChannelThread(key: string): boolean {
  return key === GENERAL_THREAD || key.startsWith(CHAN_PREFIX);
}

/**
 * Extract the channel id from a channel thread key, or `null` if the
 * key isn't a channel key. General returns `'general'` so callers can
 * use the result as a channel id directly.
 */
export function channelIdOfThread(key: string): string | null {
  if (key === GENERAL_THREAD) return GENERAL_CHANNEL_ID;
  if (key.startsWith(CHAN_PREFIX)) return key.slice(CHAN_PREFIX.length);
  return null;
}

/**
 * Extract the counterpart name from a DM thread key. Returns
 * `null` for `PRIMARY_THREAD` or any non-DM key so callers can
 * short-circuit cleanly.
 */
export function dmOther(key: string): string | null {
  if (!isDmThread(key)) return null;
  return key.slice(DM_PREFIX.length);
}

/** Thread key for `msg` from the perspective of the viewer `self`. */
export function threadKeyOf(msg: Message, self: string): string {
  // Explicit thread override wins. Objective lifecycle events and
  // discussion posts both ship with `data.thread = 'obj:<id>'` so
  // they route straight into the objective's dedicated thread,
  // bypassing the primary/DM heuristics below. Channel-tagged
  // messages flow the same way: `data.thread = 'chan:<id>'`. The
  // general channel uses the legacy `'primary'` key so persisted
  // state stays valid; we collapse `chan:general` → primary here.
  const explicit = typeof msg.data?.thread === 'string' ? (msg.data.thread as string) : null;
  if (explicit !== null && explicit.length > 0) {
    if (explicit === channelThreadKey(GENERAL_CHANNEL_ID)) return GENERAL_THREAD;
    if (explicit === `${CHAN_PREFIX}${GENERAL_CHANNEL_ID}`) return GENERAL_THREAD;
    return explicit;
  }

  if (msg.to === null) return PRIMARY_THREAD;
  if (msg.to === self) {
    // DM addressed to me — thread is keyed by the other party's
    // name. Edge case: self-DM (agentId=self AND from=self) gets
    // its own `dm:self` key so it doesn't collide with primary.
    return msg.from && msg.from !== self ? dmThreadKey(msg.from) : dmThreadKey('self');
  }
  // Outbound DM from me to someone else.
  return dmThreadKey(msg.to);
}

/**
 * The message store. Map identity changes on every write so signal
 * subscribers re-render; individual arrays inside the map are also
 * replaced rather than mutated for the same reason.
 */
export const messagesByThread = signal<Map<string, Message[]>>(new Map());

/**
 * Currently-selected message id. Set when the user clicks an exchange
 * in the right-rail `ActivityInspector` to jump to the agent message
 * that exchange produced. Cleared on thread switch (Transcript owns
 * that). `null` is the "nothing selected" steady state.
 */
export const selectedThreadMessageId = signal<string | null>(null);

export function selectThreadMessage(id: string | null): void {
  selectedThreadMessageId.value = id;
}

/**
 * Bucket a flat message list by thread key. Shared by `appendMessages`
 * and `prependMessages` so each only walks the input once even when it
 * spans many threads.
 */
function bucketByThread(viewer: string, msgs: Message[]): Map<string, Message[]> {
  const byThread = new Map<string, Message[]>();
  for (const m of msgs) {
    const key = threadKeyOf(m, viewer);
    const arr = byThread.get(key) ?? [];
    arr.push(m);
    byThread.set(key, arr);
  }
  return byThread;
}

/**
 * Append one or more messages to their respective threads. Keeps
 * arrays ordered by `ts` ascending and dedups by message id, so
 * calling this repeatedly with overlapping history pages is safe.
 *
 * Fast path: when every fresh message lands at or after the current
 * tail — the case for live WS arrivals and tail backfill, i.e. nearly
 * always — the merged array is a plain concat with no full re-sort.
 * That keeps per-frame cost flat as a thread grows; the old behavior
 * ran a full `O(n log n)` sort on every arriving message. Out-of-order
 * arrivals (reconnect backfill) still fall back to a sort.
 */
export function appendMessages(viewer: string, msgs: Message[]): void {
  if (msgs.length === 0) return;
  const next = new Map(messagesByThread.value);
  const byThread = bucketByThread(viewer, msgs);

  for (const [key, incoming] of byThread) {
    const existing = next.get(key) ?? [];
    const seenIds = new Set(existing.map((m) => m.id));
    const fresh = incoming.filter((m) => !seenIds.has(m.id));
    if (fresh.length === 0) continue;
    fresh.sort((a, b) => a.ts - b.ts);
    const tailTs =
      existing.length > 0 ? (existing[existing.length - 1]?.ts ?? -Infinity) : -Infinity;
    const inOrder = (fresh[0]?.ts ?? -Infinity) >= tailTs;
    const merged = inOrder
      ? [...existing, ...fresh]
      : [...existing, ...fresh].sort((a, b) => a.ts - b.ts);
    next.set(key, merged);
  }

  messagesByThread.value = next;
}

/**
 * Prepend older messages to their threads — the paging counterpart to
 * `appendMessages`, used when the transcript fetches a page of history
 * older than what's already loaded. Dedups by id and, like the append
 * fast path, skips the full re-sort when the incoming page sits
 * entirely at or before the current head (the normal case for an
 * older-history page).
 */
export function prependMessages(viewer: string, msgs: Message[]): void {
  if (msgs.length === 0) return;
  const next = new Map(messagesByThread.value);
  const byThread = bucketByThread(viewer, msgs);

  for (const [key, incoming] of byThread) {
    const existing = next.get(key) ?? [];
    const seenIds = new Set(existing.map((m) => m.id));
    const fresh = incoming.filter((m) => !seenIds.has(m.id));
    if (fresh.length === 0) continue;
    fresh.sort((a, b) => a.ts - b.ts);
    const headTs = existing.length > 0 ? (existing[0]?.ts ?? Infinity) : Infinity;
    const inOrder = (fresh[fresh.length - 1]?.ts ?? Infinity) <= headTs;
    const merged = inOrder
      ? [...fresh, ...existing]
      : [...fresh, ...existing].sort((a, b) => a.ts - b.ts);
    next.set(key, merged);
  }

  messagesByThread.value = next;
}

/** Read the messages for a given thread, never null. */
export function threadMessages(key: string): Message[] {
  return messagesByThread.value.get(key) ?? [];
}

/**
 * Enumerate every thread key currently in the store, plus
 * `PRIMARY_THREAD` if it isn't already present. Used by the sidebar
 * so the team channel is always clickable even when it has no messages.
 */
export function threadKeys(): string[] {
  const keys = new Set(messagesByThread.value.keys());
  keys.add(PRIMARY_THREAD);
  // Sort: primary first, then DM threads alphabetically by name.
  return [...keys].sort((a, b) => {
    if (a === PRIMARY_THREAD) return -1;
    if (b === PRIMARY_THREAD) return 1;
    return a.localeCompare(b);
  });
}

/** Test hook: wipe the store between it() blocks. */
export function __resetMessagesForTests(): void {
  messagesByThread.value = new Map();
}
