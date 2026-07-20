/**
 * Event log — append-only record of every message the broker has handled.
 *
 * Core depends only on this interface; the concrete implementation is
 * injected by the runtime adapter (Node server uses SQLite, tests use
 * the in-memory variant below).
 */

import type { Message } from 'csuite-sdk/types';

export interface EventLogTailOptions {
  /** Return only events with `ts >= since`. Defaults to 0 (all). */
  since?: number;
  /** Return at most this many events. Defaults to 100. */
  limit?: number;
}

/**
 * Query filter for fetching thread history on behalf of a viewer.
 * Only rows "relevant to the viewer" are returned:
 *   - broadcasts (`to === null`), always
 *   - DMs the viewer sent (`from === viewer`)
 *   - DMs addressed to the viewer (`to === viewer`)
 *
 * When `with` is set, the filter narrows to DMs between the viewer
 * and that other party (primary thread is excluded). Rows are
 * returned newest-first up to `limit`.
 */
export interface EventLogQueryOptions {
  viewer: string;
  /** If set, narrow to DMs between viewer and this other name. */
  with?: string;
  /**
   * If set, narrow to messages tagged for this channel id (matched
   * against `data.thread === 'chan:<channel>'`). The special value
   * `'general'` includes the implicit-broadcast variant — messages
   * with `to === null` whose `data.thread` is unset OR explicitly
   * `'chan:general'`. Mutually exclusive with `with`.
   */
  channel?: string;
  /** Hard upper bound on rows returned. Defaults to 100, max 1000. */
  limit?: number;
  /** Return only rows with `ts < before`. For pagination. */
  before?: number;
}

export const GENERAL_CHANNEL_ID = 'general' as const;
export const CHANNEL_THREAD_PREFIX = 'chan:' as const;

export function channelThreadTag(channelId: string): string {
  return `${CHANNEL_THREAD_PREFIX}${channelId}`;
}

export interface EventLog {
  append(message: Message): Promise<void>;
  tail(options?: EventLogTailOptions): Promise<Message[]>;
  /**
   * Return messages relevant to the viewer, newest-first. Used by
   * the broker's /history endpoint to hydrate the web UI on connect
   * and after reconnects.
   */
  query(options: EventLogQueryOptions): Promise<Message[]>;
  /** Close any underlying resources. No-op for in-memory impl. */
  close?(): Promise<void>;
}

export const DEFAULT_QUERY_LIMIT = 100;
export const MAX_QUERY_LIMIT = 1000;

/**
 * Normalize a caller-provided `limit` to a safe query size.
 * - `undefined` / non-finite → DEFAULT_QUERY_LIMIT
 * - `<= 0` → DEFAULT_QUERY_LIMIT (caller likely passed a bad value;
 *   return a useful default instead of a no-op query)
 * - `> MAX_QUERY_LIMIT` → clamped
 */
export function clampQueryLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_QUERY_LIMIT;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_QUERY_LIMIT;
  return Math.min(Math.floor(raw), MAX_QUERY_LIMIT);
}

/** In-memory event log. Useful for tests and ephemeral dev runs. */
export class InMemoryEventLog implements EventLog {
  private readonly events: Message[] = [];

  async append(message: Message): Promise<void> {
    this.events.push(message);
  }

  async tail(options: EventLogTailOptions = {}): Promise<Message[]> {
    const since = options.since ?? 0;
    const limit = options.limit ?? DEFAULT_QUERY_LIMIT;
    const filtered = this.events.filter((e) => e.ts >= since);
    return filtered.slice(-limit);
  }

  async query(options: EventLogQueryOptions): Promise<Message[]> {
    const limit = clampQueryLimit(options.limit);
    const matches: Message[] = [];
    // Walk newest-first so we can bail out once we've filled `limit`.
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (!ev) continue;
      if (options.before !== undefined && ev.ts >= options.before) continue;
      if (options.channel !== undefined) {
        if (!matchesChannel(ev, options.channel)) continue;
      } else if (!matchesViewer(ev, options.viewer, options.with)) {
        continue;
      }
      matches.push(ev);
      if (matches.length >= limit) break;
    }
    return matches;
  }

  /** Test-only: number of events currently in the log. */
  size(): number {
    return this.events.length;
  }
}

function matchesChannel(ev: Message, channelId: string): boolean {
  const tag = ev.data?.thread;
  const expected = channelThreadTag(channelId);
  if (typeof tag === 'string' && tag.length > 0) {
    return tag === expected;
  }
  // Untagged messages — for general only, treat broadcast (`to: null`)
  // messages without an explicit thread as channel content. Channel
  // messages are otherwise always tagged.
  if (channelId === GENERAL_CHANNEL_ID) {
    return ev.to === null;
  }
  return false;
}

function matchesViewer(ev: Message, viewer: string, withOther?: string): boolean {
  if (withOther !== undefined) {
    // Narrowed DM view: only messages between `viewer` and `withOther`.
    // A DM from viewer to withOther has from=viewer, to=withOther.
    // A DM from withOther to viewer has from=withOther, to=viewer.
    if (ev.to === null) return false;
    if (ev.from === viewer && ev.to === withOther) return true;
    if (ev.from === withOther && ev.to === viewer) return true;
    return false;
  }
  // Default feed: broadcasts + any DM where viewer is either end.
  if (ev.to === null) return true;
  if (ev.from === viewer) return true;
  if (ev.to === viewer) return true;
  return false;
}
