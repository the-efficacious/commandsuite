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

/**
 * Thread prefix for secret lifecycle events (`secret:<slug>`).
 *
 * These are pushed to an explicit recipient set — the members bound to
 * the secret plus every `secrets.manage` holder — and are deliberately
 * NOT part of the default viewer feed. The delivery is scoped; without
 * this the persisted row is not, because a fan-out push stores
 * `to: null` and the default feed returns every `to: null` row to
 * everyone. Live delivery and durable readback disagreeing is the
 * defect; this makes them agree.
 *
 * Excluded for every viewer rather than only for non-recipients,
 * because the event log has no access to secret bindings and should
 * not grow one. Nothing is stranded: `GET /secrets` returns per-viewer
 * summaries and `GET /secrets/resolve` returns the caller's own env
 * delta, which is the surface built for this. The row stays in the log
 * for forensics; it is the *feed* that stops carrying it.
 */
export const SECRET_THREAD_PREFIX = 'secret:' as const;

export function channelThreadTag(channelId: string): string {
  return `${CHANNEL_THREAD_PREFIX}${channelId}`;
}

/** Thread prefix for objective lifecycle + discussion events (`obj:<id>`). */
export const OBJECTIVE_THREAD_PREFIX = 'obj:' as const;
/** Other fan-out event families whose membership can be narrower than the team. */
const TOOL_THREAD_PREFIX = 'tool:' as const;
const VARIABLE_THREAD_PREFIX = 'variable:' as const;
const NOTIFICATION_THREAD_PREFIX = 'hook:' as const;

/** Recipient-list events that predate the thread-tag convention. */
const SCOPED_UNTHREADED_KINDS: ReadonlySet<string> = new Set(['instructions', 'context_control']);

/**
 * True when a thread tag names an audience narrower than the team.
 *
 * `chan:general` is deliberately NOT scoped: the general channel's
 * membership is implicit (everyone), so its pushes take the broadcast
 * path and carry no recipient list.
 *
 * Used only for rows written before `recipients` was persisted — see
 * `feedVisibleTo`. Rows written since carry their audience and are
 * judged on that instead of on their tag.
 */
export function isScopedThreadTag(tag: unknown): boolean {
  if (typeof tag !== 'string' || tag.length === 0) return false;
  if (tag.startsWith(SECRET_THREAD_PREFIX)) return true;
  if (tag.startsWith(OBJECTIVE_THREAD_PREFIX)) return true;
  if (tag.startsWith(TOOL_THREAD_PREFIX)) return true;
  if (tag.startsWith(VARIABLE_THREAD_PREFIX)) return true;
  if (tag.startsWith(NOTIFICATION_THREAD_PREFIX)) return true;
  if (tag.startsWith(CHANNEL_THREAD_PREFIX)) {
    return tag !== channelThreadTag(GENERAL_CHANNEL_ID);
  }
  return false;
}

/**
 * Whether a row with no recorded audience came from a scoped fan-out.
 *
 * Most such events carry a thread tag. Instruction-change and context-control
 * pushes do not, but their `kind` still identifies recipient-list delivery.
 * Both shapes existed before the audience column, so upgrades must recognize
 * both or old private rows remain broadcasts forever.
 */
function isLegacyScopedEvent(ev: Pick<Message, 'data'>): boolean {
  if (isScopedThreadTag(ev.data?.thread)) return true;
  const kind = ev.data?.kind;
  return typeof kind === 'string' && SCOPED_UNTHREADED_KINDS.has(kind);
}

/** True when a message is a secret lifecycle event. */
export function isSecretThread(ev: Pick<Message, 'data'>): boolean {
  const tag = ev.data?.thread;
  return typeof tag === 'string' && tag.startsWith(SECRET_THREAD_PREFIX);
}

/**
 * What an append needs to know beyond the message itself.
 *
 * `recipients` is the delivery audience the broker fanned the message
 * out to — the channel's members, an objective thread, the holders of
 * a secret. It is persisted so a later read can answer the same
 * question the live fan-out already answered.
 *
 * `null` / omitted means "no narrower audience": a DM (addressed by
 * `to`) or a team-wide broadcast. It does NOT mean "audience unknown"
 * — every fan-out path passes its list.
 */
export interface EventLogAppendOptions {
  recipients?: readonly string[] | null;
}

export interface EventLog {
  append(message: Message, options?: EventLogAppendOptions): Promise<void>;
  tail(options?: EventLogTailOptions): Promise<Message[]>;
  /**
   * Return messages relevant to the viewer, newest-first. Used by
   * the broker's /history endpoint to hydrate the web UI on connect
   * and after reconnects.
   */
  query(options: EventLogQueryOptions): Promise<Message[]>;
  /** Latest stored discussion and canonical GitHub PR-link timestamps for an objective thread. */
  latestObjectiveSignals(objectiveId: string): Promise<{
    lastThreadPostAt: number | null;
    lastPrLinkAt: number | null;
  }>;
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

/**
 * Is `ev` part of `viewer`'s default feed?
 *
 * THE RULE, stated once. `SqliteEventLog`'s feed statement is the same
 * predicate in SQL and the two must move together — a test in each
 * asserts the same scoping, and `event-log-scope.test.ts` runs the
 * shared cases against both.
 *
 *   1. Secret lifecycle events are never in anyone's feed. Unchanged,
 *      and deliberately unconditional — `GET /secrets` is the surface
 *      built for that question.
 *   2. Addressed messages (`to` set) reach their two ends only.
 *   3. A message with a recorded audience reaches that audience, plus
 *      its sender.
 *   4. A message with NO recorded audience predates this column. If its
 *      thread or event kind identifies recipient-list delivery, we cannot
 *      reconstruct who it was for, so it is withheld from everyone but
 *      its sender — the fail-closed direction. Unscoped legacy rows stay
 *      visible.
 */
export function feedVisibleTo(
  ev: Message,
  recipients: readonly string[] | null,
  viewer: string,
): boolean {
  if (isSecretThread(ev)) return false;
  if (ev.to !== null && ev.from !== viewer && ev.to !== viewer) return false;
  if (ev.from === viewer) return true;
  if (recipients !== null) return recipients.includes(viewer);
  if (ev.to !== null) return ev.to === viewer;
  return !isLegacyScopedEvent(ev);
}

interface StoredEvent {
  message: Message;
  recipients: readonly string[] | null;
}

/** In-memory event log. Useful for tests and ephemeral dev runs. */
export class InMemoryEventLog implements EventLog {
  private readonly stored: StoredEvent[] = [];

  private get events(): Message[] {
    return this.stored.map((e) => e.message);
  }

  async append(message: Message, options: EventLogAppendOptions = {}): Promise<void> {
    this.stored.push({
      message,
      recipients: options.recipients ? [...options.recipients] : null,
    });
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
    for (let i = this.stored.length - 1; i >= 0; i--) {
      const entry = this.stored[i];
      if (!entry) continue;
      const ev = entry.message;
      if (options.before !== undefined && ev.ts >= options.before) continue;
      if (options.channel !== undefined) {
        if (!matchesChannel(ev, options.channel)) continue;
      } else if (!matchesViewer(ev, entry.recipients, options.viewer, options.with)) {
        continue;
      }
      matches.push(ev);
      if (matches.length >= limit) break;
    }
    return matches;
  }

  async latestObjectiveSignals(objectiveId: string): Promise<{
    lastThreadPostAt: number | null;
    lastPrLinkAt: number | null;
  }> {
    let lastThreadPostAt: number | null = null;
    let lastPrLinkAt: number | null = null;
    const thread = `obj:${objectiveId}`;
    for (const { message } of this.stored) {
      if (message.data?.kind !== 'objective_discuss' || message.data?.thread !== thread) continue;
      lastThreadPostAt = Math.max(lastThreadPostAt ?? -Infinity, message.ts);
      if (containsCanonicalPullRequestUrl(message.body)) {
        lastPrLinkAt = Math.max(lastPrLinkAt ?? -Infinity, message.ts);
      }
    }
    return { lastThreadPostAt, lastPrLinkAt };
  }

  /** Test-only: number of events currently in the log. */
  size(): number {
    return this.stored.length;
  }
}

/** Bare `#123` is deliberately not evidence of a linked PR. */
export function containsCanonicalPullRequestUrl(body: string): boolean {
  return /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+(?:\b|\/)/.test(
    body,
  );
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

function matchesViewer(
  ev: Message,
  recipients: readonly string[] | null,
  viewer: string,
  withOther?: string,
): boolean {
  if (withOther !== undefined) {
    // Narrowed DM view: only messages between `viewer` and `withOther`.
    // A DM from viewer to withOther has from=viewer, to=withOther.
    // A DM from withOther to viewer has from=withOther, to=viewer.
    if (ev.to === null) return false;
    if (ev.from === viewer && ev.to === withOther) return true;
    if (ev.from === withOther && ev.to === viewer) return true;
    return false;
  }
  return feedVisibleTo(ev, recipients, viewer);
}
