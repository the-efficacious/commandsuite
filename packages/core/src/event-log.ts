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
   * `'chan:general'` — and, because that shape is also how an
   * untagged recipient-list push persists, applies `feedVisibleTo` to
   * what it collects: `viewer` sees the general channel's broadcasts
   * plus only those scoped rows it was actually sent. A named channel
   * is not audience-filtered; membership is the read gate there.
   * Mutually exclusive with `with`.
   */
  channel?: string;
  /** Hard upper bound on rows returned. Defaults to 100, max 1000. */
  limit?: number;
  /**
   * Exclusive composite cursor for the newest-first walk: return only
   * rows strictly before `(ts, id)` in `ts DESC, id DESC` order.
   *
   * It is composite because a scalar `ts` bound is LOSSY. Message
   * timestamps are `Date.now()` at push time and two posts in one tick
   * collide routinely under an agent burst; when the page boundary
   * falls inside such a tie, `ts < before` excludes every row sharing
   * that millisecond — including the ones the caller has not seen. They
   * are not delayed, they are unreachable: any bound that admits them
   * also re-returns rows the caller already has, with no id to
   * deduplicate against a page that never arrived.
   *
   * `id` breaks that tie. It is a random identifier, so within one
   * millisecond the order is arbitrary — but it is TOTAL and STABLE,
   * which is the only property a complete page walk needs.
   *
   * A caller with a timestamp and nothing else passes
   * `{ ts, id: SCALAR_BOUND_ID }`, which degrades to exactly the old
   * `ts < before` behaviour, holes included.
   */
  before?: { ts: number; id: string };
}

/**
 * The `id` half of a cursor built from a timestamp alone.
 *
 * Empty string sorts before every real id under binary comparison — in
 * SQLite and in JavaScript alike — so `(ts < T OR (ts = T AND id < ''))`
 * is `ts < T` exactly. That makes the scalar bound a degenerate cursor
 * rather than a second code path, and the wire's `before_ts` with no
 * `before_id` a documented lossy shorthand rather than a different
 * mechanism to keep in step.
 */
export const SCALAR_BOUND_ID = '';

/**
 * The newest-first order every read here returns: `ts DESC, id DESC`.
 *
 * The `id` tiebreak is arbitrary — ids are random — but total and
 * stable, which is what lets a page walk enumerate a shared millisecond
 * instead of skipping it.
 */
export function compareNewestFirst(
  a: { ts: number; id: string },
  b: { ts: number; id: string },
): number {
  if (a.ts !== b.ts) return b.ts - a.ts;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Is `a` strictly before `b` in the newest-first order `ts DESC, id DESC`?
 *
 * The in-memory walk's half of the seek predicate; `SqliteEventLog`'s
 * SQL says the same thing and the two must move together.
 */
export function beforeCursor(
  row: { ts: number; id: string },
  cursor: { ts: number; id: string },
): boolean {
  return row.ts < cursor.ts || (row.ts === cursor.ts && row.id < cursor.id);
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

/**
 * Other fan-out event families whose membership can be narrower than the team.
 *
 * These three plus `CHANNEL_THREAD_PREFIX`, `SECRET_THREAD_PREFIX` and
 * `OBJECTIVE_THREAD_PREFIX` are the six thread-tag prefixes, and this module is
 * the only place any of them is spelled. Every writer imports from here —
 * `app.ts` for the tags it stamps onto pushes, `SqliteEventLog` for the feed
 * predicate it expresses in SQL — so the scoping rule cannot fork. A prefix
 * declared here but missing from a writer's copy is a scoped event leaking into
 * every viewer's feed.
 *
 * `HOOK_THREAD_PREFIX` is named for its value, not for the subsystem: `hook:` is
 * the user-visible wire spelling and it is what a reader greps for.
 */
export const TOOL_THREAD_PREFIX = 'tool:' as const;
export const VARIABLE_THREAD_PREFIX = 'variable:' as const;
export const HOOK_THREAD_PREFIX = 'hook:' as const;

/** The six thread-tag prefixes, in one list, for callers that iterate them. */
export const THREAD_TAG_PREFIXES = [
  CHANNEL_THREAD_PREFIX,
  OBJECTIVE_THREAD_PREFIX,
  SECRET_THREAD_PREFIX,
  TOOL_THREAD_PREFIX,
  VARIABLE_THREAD_PREFIX,
  HOOK_THREAD_PREFIX,
] as const;

/** Build the thread tag for a tool-source registry event (`tool:<slug>`). */
export function toolThreadTag(slug: string): string {
  return `${TOOL_THREAD_PREFIX}${slug}`;
}

/** Build the thread tag for a variable registry event (`variable:<slug>`). */
export function variableThreadTag(slug: string): string {
  return `${VARIABLE_THREAD_PREFIX}${slug}`;
}

/** Build the thread tag for a notification-endpoint registry event (`hook:<slug>`). */
export function hookThreadTag(slug: string): string {
  return `${HOOK_THREAD_PREFIX}${slug}`;
}

/** Build the thread tag for a secret lifecycle event (`secret:<slug>`). */
export function secretThreadTag(slug: string): string {
  return `${SECRET_THREAD_PREFIX}${slug}`;
}

/** Build the thread tag for an objective's discussion thread (`obj:<id>`). */
export function objectiveThreadTag(objectiveId: string): string {
  return `${OBJECTIVE_THREAD_PREFIX}${objectiveId}`;
}

/**
 * Recipient-list events that predate the thread-tag convention.
 *
 * `SqliteEventLog` builds the SQL half of this set from this constant, so the
 * two cannot fork. `environment` is deliberately absent: that kind landed after
 * the `recipients` column, so no environment row without an audience has ever
 * existed and adding it here would only withhold rows that carry their own
 * answer.
 */
export const SCOPED_UNTHREADED_KINDS: ReadonlySet<string> = new Set([
  'instructions',
  'context_control',
]);

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
  if (tag.startsWith(HOOK_THREAD_PREFIX)) return true;
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
 * Is `ev` visible to `viewer`?
 *
 * THE RULE, stated once. `SqliteEventLog`'s feed statement is the same
 * predicate in SQL and the two must move together — a test in each
 * asserts the same scoping, and `event-log-scope.test.ts` runs the
 * shared cases against both.
 *
 * It governs two reads: the default feed, and the general channel.
 * General-channel membership is implicit (everyone), so read access
 * gates nothing there and a row's recorded audience is the only
 * audience it has — see `matchesChannel` and the general-channel
 * branch of `query`. A named channel is different on purpose: joining
 * one is read access to its history, so `?channel=<named>` does not
 * consult this rule (docs/concepts/channels.mdx).
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
    // Walk in the SAME order the cursor compares in — `ts DESC, id DESC`
    // — not in insertion order. A pager whose cursor and whose traversal
    // disagree skips rows at every page boundary, and this walk has to
    // answer identically to `SqliteEventLog`'s `ORDER BY ts DESC, id
    // DESC`: the two are the same contract with two backends, and the
    // shared cases in event-log-scope.test.ts run against both.
    const ordered = [...this.stored].sort((a, b) => compareNewestFirst(a.message, b.message));
    for (const entry of ordered) {
      const ev = entry.message;
      if (options.before !== undefined && !beforeCursor(ev, options.before)) continue;
      if (options.channel !== undefined) {
        if (!matchesChannel(ev, options.channel)) continue;
        // The general channel collects untagged broadcasts, and a
        // recipient-list push with no thread tag has that same shape.
        // Its membership is implicit, so there is no read access to
        // gate on and the recorded delivery audience is the only
        // audience the row has. A named channel is deliberately
        // retro-readable and is not filtered here.
        if (
          options.channel === GENERAL_CHANNEL_ID &&
          !feedVisibleTo(ev, entry.recipients, options.viewer)
        ) {
          continue;
        }
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
    const thread = objectiveThreadTag(objectiveId);
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
