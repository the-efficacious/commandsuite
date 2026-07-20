/**
 * Broker → stdio forwarder.
 *
 * Opens a long-lived SSE subscription to the broker for this slot's
 * name and relays every inbound message as a
 * `notifications/claude/channel` JSON-RPC notification on the link's
 * MCP stdio server. Reconnects with exponential backoff on any error.
 */

import type { Client as BrokerClient } from 'csuite-sdk/client';
import { MCP_CHANNEL_NOTIFICATION } from 'csuite-sdk/protocol';
import type { Message } from 'csuite-sdk/types';
import type { Presence } from './presence.js';
import { formatAgentTimestamp } from './tools.js';

/**
 * Minimal surface the forwarder needs from its notification sink. In
 * the link this was an `@modelcontextprotocol/sdk` `Server`; in the
 * runner it's a shim that converts the call into an IPC frame. Both
 * satisfy this shape with no `as any` casts.
 */
export interface ForwarderNotificationSink {
  notification(args: { method: string; params: Record<string, unknown> }): Promise<void>;
}

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * How an incoming message was routed, from the agent's point of view:
 *
 *   `primary` — broadcast to the team channel (`general`).
 *   `dm`      — direct message addressed to this agent.
 *   `channel` — posted into a non-general channel that this agent is a
 *               member of. The channel id is preserved in the
 *               `channel` meta key so the agent can scope replies via
 *               `channels_post`.
 *
 * The classification is computed in `forwardMessage` from the broker's
 * authoritative state, NOT trusted from the sender's payload — see
 * `RESERVED_META_KEYS`.
 */
export type ThreadType = 'primary' | 'dm' | 'channel';

const CHANNEL_THREAD_PREFIX = 'chan:';

export interface ForwarderOptions {
  server: ForwarderNotificationSink;
  brokerClient: BrokerClient;
  name: string;
  signal: AbortSignal;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
  /**
   * Invoked for every message the forwarder observes whose `data.kind`
   * is `'objective'`. The tracker uses this to refresh the runner's
   * cached open-objectives snapshot (which seeds the `context_refresh`
   * re-brief and the activity markers). Fires for both self-originated
   * and inbound events — even though the self-echo suppression below
   * drops self-originated objective messages from the channel forward,
   * the tracker still wants to know about them so the snapshot stays
   * correct after the agent acts on its own objective.
   */
  onObjectiveEvent?: (message: Message) => void;
  /**
   * Invoked for every message whose `data.kind` is `'tool_source'` —
   * the broker's registry changed in a way that affects this member.
   * The runner refreshes its external-tools snapshot and emits
   * `tools/list_changed` (a genuine capability change — the one case
   * that earns a prompt-prefix cache break). Fires for self-originated
   * events too, same rationale as `onObjectiveEvent`.
   */
  onToolSourceEvent?: (message: Message) => void;
  /**
   * Optional presence signal. Flipped to `connecting` before each
   * subscribe attempt, `online` on first successful message, and
   * `offline` when the stream errors or ends. The HUD uses this to
   * drive the bottom-strip dot.
   */
  presence?: Presence;
}

export async function runForwarder(opts: ForwarderOptions): Promise<void> {
  const { server, brokerClient, name, signal, log, onObjectiveEvent, onToolSourceEvent, presence } =
    opts;
  let backoff = BACKOFF_START_MS;

  // Channel id → slug cache for the `channel_slug` meta key. Messages
  // reference channels by immutable id, but `channels_post` takes the
  // slug — without this the agent needs a `channels_list` round trip
  // before it can reply to any channel post. Populated lazily from
  // `GET /channels` on the first unseen id; a slug rename mid-session
  // serves the stale slug until the next cache miss (renames are rare
  // and the agent gets a clear error + `channels_list` recovery path).
  const channelSlugCache = new Map<string, string>();
  const resolveChannelSlug = async (id: string): Promise<string | null> => {
    const cached = channelSlugCache.get(id);
    if (cached !== undefined) return cached;
    try {
      const channels = await brokerClient.listChannels();
      channelSlugCache.clear();
      for (const c of channels) channelSlugCache.set(c.id, c.slug);
      return channelSlugCache.get(id) ?? null;
    } catch (err) {
      log('channel slug resolution failed', {
        channelId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  while (!signal.aborted) {
    try {
      log('subscribing to broker', { name });
      presence?.setConnecting();
      backoff = BACKOFF_START_MS;

      const stream = brokerClient.subscribe(name, signal);
      // Presence flips to `online` optimistically as soon as subscribe
      // returns an iterator — we don't wait for the first message
      // because a quiet team with long heartbeat gaps would otherwise
      // spin at `connecting` for 30s+ after a perfectly healthy
      // subscribe. If the connection is actually dead, the iterator
      // will throw on the first `.next()` and our catch below flips
      // back to `offline`.
      presence?.setOnline();
      for await (const message of stream) {
        log('broker message received', {
          msgId: message.id,
          from: message.from,
          to: message.to,
          level: message.level,
          dataKind:
            typeof message.data === 'object' && message.data !== null
              ? ((message.data as Record<string, unknown>).kind ?? null)
              : null,
        });
        const dataKind =
          typeof message.data === 'object' && message.data !== null
            ? (message.data as Record<string, unknown>).kind
            : null;

        // Objectives tracker observes every objective event — including
        // ones where the agent itself was the actor — so the open-plate
        // snapshot stays correct after a self-initiated update.
        if (dataKind === 'objective' && onObjectiveEvent) {
          try {
            onObjectiveEvent(message);
          } catch (err) {
            log('onObjectiveEvent handler threw', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Tool-source registry changes drive the external-tools
        // refresh (→ tools/list_changed). Same self-echo-exempt
        // treatment as objectives.
        if (dataKind === 'tool_source' && onToolSourceEvent) {
          try {
            onToolSourceEvent(message);
          } catch (err) {
            log('onToolSourceEvent handler threw', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Self-echo suppression (chat plane): the broker fans out every
        // push to all subscribers INCLUDING the sender, so our own
        // sends come back on the SSE stream. Forwarding them would
        // cost the agent a turn to recognise and discard its own
        // output. `recent` still returns self-sends for scrollback.
        if (message.from === name) continue;
        await forwardMessage(server, message, log, resolveChannelSlug);
      }

      // If we get here, the stream ended cleanly — treat as a reconnect.
      log('broker subscription stream ended, reconnecting');
      presence?.setOffline();
    } catch (err) {
      if (signal.aborted) return;
      presence?.setOffline();
      log('broker loop error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (signal.aborted) return;
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}

/**
 * Meta keys the broker owns authoritatively. Anything a sender places
 * in `message.data` with one of these names is silently dropped so a
 * malicious push cannot spoof `from`, `thread`, `level`, etc. on the
 * receiving side. This mirrors the broker-side guarantee that
 * `message.from` is stamped from the authenticated slot and never from
 * the payload — same invariant, one layer down.
 */
const RESERVED_META_KEYS: ReadonlySet<string> = new Set([
  'msg_id',
  'level',
  'ts',
  'ts_ms',
  'thread',
  'from',
  'title',
  'target',
  'channel',
  'channel_slug',
]);

async function forwardMessage(
  server: ForwarderNotificationSink,
  message: Message,
  log: (msg: string, ctx?: Record<string, unknown>) => void,
  resolveChannelSlug?: (id: string) => Promise<string | null>,
): Promise<void> {
  // Detect channel-routed messages. The broker fans out a non-general
  // channel post as a per-recipient targeted push (each copy has
  // `to: <recipient-name>`), but the original `data.thread =
  // 'chan:<id>'` survives the fanout — that's our authoritative
  // channel marker. Without this branch a channel post would be
  // misclassified as `dm`, indistinguishable to the agent from a
  // direct message addressed to it personally.
  const channelId = extractChannelId(message);
  const thread: ThreadType =
    channelId !== null ? 'channel' : message.to === null ? 'primary' : 'dm';

  // `ts` is formatted for agent consumption — a fixed-width human
  // datetime like `04/15/26 14:23:45 UTC`. Parseable, unambiguous
  // about timezone, precise to the second, and doesn't require the
  // agent to run a tool to interpret raw unix milliseconds. A
  // separate `ts_ms` preserves the machine-readable value for
  // anything downstream that wants to do arithmetic on it.
  const meta: Record<string, string> = {
    msg_id: message.id,
    level: message.level,
    ts: formatAgentTimestamp(message.ts),
    ts_ms: String(message.ts),
    thread,
  };
  if (message.from) meta.from = message.from;
  if (message.title) meta.title = message.title;
  // `target` only makes sense for true DMs. On channel posts the
  // per-recipient `to` stamp is the agent itself, so surfacing it
  // would be misleading ("from=director, target=me" reads like a DM).
  if (thread === 'dm' && message.to) meta.target = message.to;
  if (channelId !== null) {
    meta.channel = channelId;
    // Resolve the mutable slug alongside the stable id so the agent
    // can reply via `channels_post` (which takes the slug) without a
    // `channels_list` lookup first. Best-effort — omitted on failure.
    const slug = resolveChannelSlug ? await resolveChannelSlug(channelId) : null;
    if (slug !== null) meta.channel_slug = slug;
  }

  if (typeof message.data === 'object' && message.data !== null) {
    for (const [k, v] of Object.entries(message.data)) {
      if (v === null || v === undefined) continue;
      const key = sanitizeMetaKey(k);
      if (!key) continue;
      // Skip reserved keys — a sender cannot override broker-stamped meta.
      if (RESERVED_META_KEYS.has(key)) continue;
      if (typeof v === 'string') {
        meta[key] = v;
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        meta[key] = String(v);
      }
      // Drop complex values — channels meta must be flat strings.
    }
  }

  try {
    await server.notification({
      method: MCP_CHANNEL_NOTIFICATION,
      params: {
        content: message.body,
        meta,
      },
    });
  } catch (err) {
    log('failed to emit channel notification', {
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Extract the channel id from a message tagged for a non-general
 * channel. Returns `null` for DMs, broadcasts to general, and
 * channel-tagged messages pointing at `general` (which the broker
 * treats as the implicit-broadcast channel and we report as
 * `thread='primary'`). The channel id is stable + opaque (the slug
 * is mutable and decoupled from existing message references — see
 * `Channel` in csuite-sdk/types).
 */
function extractChannelId(message: Message): string | null {
  if (typeof message.data !== 'object' || message.data === null) return null;
  const tag = (message.data as Record<string, unknown>).thread;
  if (typeof tag !== 'string' || !tag.startsWith(CHANNEL_THREAD_PREFIX)) return null;
  const id = tag.slice(CHANNEL_THREAD_PREFIX.length);
  if (id.length === 0 || id === 'general') return null;
  return id;
}

/**
 * Channel meta keys must be identifiers (letters, digits, underscore).
 * Anything else is silently dropped on the Claude Code side, so we
 * sanitise here to keep the key stable.
 */
function sanitizeMetaKey(key: string): string {
  const clean = key.replace(/[^a-zA-Z0-9_]/g, '_');
  // If the cleaned key is empty or starts with a digit, drop it.
  if (clean.length === 0 || /^[0-9]/.test(clean)) return '';
  return clean;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
