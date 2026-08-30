/**
 * Broker → channel-sink forwarder.
 *
 * Opens a long-lived WebSocket subscription to the broker for this slot's
 * name and delivers every inbound message as a typed `ChannelEvent`
 * (content + flat string meta) to the runner's channel sink — the
 * per-framework adapter piece that turns team traffic into the
 * agent's ambient input (SDK streaming input for claude, turn
 * dispatches for codex). Reconnects with exponential backoff on any
 * error.
 */

import { logger as defaultLogger, type Logger } from 'csuite-core';
import type { Client as BrokerClient } from 'csuite-sdk/client';
import type { Message } from 'csuite-sdk/types';
import type { Presence } from './presence.js';
import { formatAgentTimestamp } from './tools.js';

/**
 * One broker message, rendered for agent consumption: the body text
 * plus flat string metadata (`from`, `thread`, `ts`, `kind`, ...).
 * The meta keys the broker owns are stamped authoritatively here —
 * see `RESERVED_META_KEYS`.
 */
export interface ChannelEvent {
  content: string;
  meta: Record<string, string>;
}

/**
 * Where the forwarder delivers channel events. Implemented per agent
 * framework by the runner adapters (`claude-sink.ts`,
 * `codex/channel-sink.ts`); the runner's own `context_refresh`
 * re-briefs ride the same sink.
 */
export interface ChannelEventSink {
  deliver(event: ChannelEvent): Promise<void>;
}

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * A broker-originated context control, parsed off the member stream.
 * Mirrors the `data` block the broker stamps in
 * `POST /members/:name/context`.
 */
export interface ContextControlEvent {
  requestId: string;
  verb: 'compact' | 'clear' | 'reload';
  /**
   * Member this control is FOR.
   *
   * The broker fans a control out on a recipient list, which leaves
   * the envelope's `to` null — so without this the runner would be
   * executing a lifecycle control on the strength of "it arrived on
   * my stream" alone. Today that is in fact sufficient, but it is an
   * emergent property of the fanout rather than a stated one, and
   * compacting the wrong member's agent is not a failure worth
   * leaving to an invariant nobody wrote down.
   */
  target: string;
  /** Member that issued the control, for the activity ack. */
  requestedBy: string;
  reason?: string;
}

/**
 * Read a context control out of a message's `data`, or null if the
 * payload is not one.
 *
 * Strict on every field the ack depends on. A control with no
 * `requestId` could be executed but never correlated, which would
 * interrupt a member's work and leave the broker's request outstanding
 * forever — worse than dropping it, because the drop is at least
 * visible as a request that produced no outcome.
 */
export function parseContextControl(data: unknown): ContextControlEvent | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.kind !== 'context_control') return null;
  const { requestId, verb, target, requestedBy, reason } = d;
  if (typeof requestId !== 'string' || requestId.length === 0) return null;
  if (verb !== 'compact' && verb !== 'clear' && verb !== 'reload') return null;
  if (typeof target !== 'string' || target.length === 0) return null;
  if (typeof requestedBy !== 'string' || requestedBy.length === 0) return null;
  return {
    requestId,
    verb,
    target,
    requestedBy,
    ...(typeof reason === 'string' && reason.length > 0 ? { reason } : {}),
  };
}

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
  sink: ChannelEventSink;
  brokerClient: BrokerClient;
  name: string;
  signal: AbortSignal;
  /** Structured logger. Defaults to the shared logger's `forwarder` child. */
  logger?: Logger;
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
   * Invoked for every message whose `data.kind` is `'instructions'` —
   * an instruction-bearing edit changed this member's composed text.
   * The driver uses this to schedule a drain-and-restart of the agent
   * at the next idle boundary, since a live session's system prompt
   * cannot be changed in place. Fires for self-originated events too:
   * a member editing its own instructions is still running the old
   * ones.
   */
  onInstructionsEvent?: (message: Message) => void;
  /** Invoked when this member's resolved runner environment changed. */
  onEnvironmentEvent?: (message: Message) => void;
  /**
   * Invoked for every message whose `data.kind` is `'context_control'`
   * — the broker is asking this member's runner to compact or clear
   * its agent context.
   *
   * Handed the PARSED control rather than the raw message: a malformed
   * payload is dropped here with a log line, because a control the
   * runner cannot read is not a control it should half-execute.
   *
   * Unlike the three above this is NOT self-echo exempt in spirit —
   * but it arrives as a targeted push from `csuite`, never from the
   * member itself, so the `message.from === name` guard below never
   * applies to it. Self-issued controls still route through the
   * broker and come back stamped `from: 'csuite'`.
   */
  onContextControlEvent?: (control: ContextControlEvent) => void;
  /**
   * Optional presence signal. Flipped to `connecting` before each
   * subscribe attempt, `online` on first successful message, and
   * `offline` when the stream errors or ends. The HUD uses this to
   * drive the bottom-strip dot.
   */
  presence?: Presence;
}

export async function runForwarder(opts: ForwarderOptions): Promise<void> {
  const {
    sink,
    brokerClient,
    name,
    signal,
    onObjectiveEvent,
    onToolSourceEvent,
    onInstructionsEvent,
    onEnvironmentEvent,
    onContextControlEvent,
    presence,
  } = opts;
  const log = opts.logger ?? defaultLogger.child('forwarder');
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
      log.warn('channel slug resolution failed', {
        channelId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  while (!signal.aborted) {
    try {
      log.info('subscribing to broker', { name });
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
        log.debug('broker message received', {
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
            log.error('onObjectiveEvent handler threw', {
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
            log.error('onToolSourceEvent handler threw', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Instruction edits schedule a drain-and-restart. Self-echo
        // exempt like the two above: the member who edited is still
        // running the superseded text.
        if (dataKind === 'instructions' && onInstructionsEvent) {
          try {
            onInstructionsEvent(message);
          } catch (err) {
            log.error('onInstructionsEvent handler threw', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (dataKind === 'environment' && onEnvironmentEvent) {
          try {
            onEnvironmentEvent(message);
          } catch (err) {
            log.error('onEnvironmentEvent handler threw', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Context control — a broker request to compact or clear this
        // member's agent context.
        //
        // This one CONSUMES the message instead of falling through to
        // the channel sink. The other three data kinds annotate chat
        // traffic the agent should also read; a control is an
        // instruction to the RUNNER, and forwarding it as ambient text
        // would put "compact your context" in the very context it is
        // about to act on — visible to the agent as a teammate's
        // request it might separately try to honour, racing the
        // runner's own execution of it.
        if (dataKind === 'context_control') {
          const control = parseContextControl(message.data);
          if (control === null) {
            log.warn('dropped malformed context control', { msgId: message.id });
          } else if (control.target !== name) {
            // Addressed to a teammate. The broker does not currently
            // send us those, which is exactly why this is worth
            // keeping cheap and explicit rather than assumed: the cost
            // of being wrong is compacting somebody else's agent.
            log.warn('ignored context control addressed to another member', {
              target: control.target,
              requestId: control.requestId,
            });
          } else if (onContextControlEvent) {
            try {
              onContextControlEvent(control);
            } catch (err) {
              log.error('onContextControlEvent handler threw', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          } else {
            log.warn('context control received but this runner has no handler', {
              verb: control.verb,
              requestId: control.requestId,
            });
          }
          continue;
        }

        // Self-echo suppression (chat plane): the broker fans out every
        // push to all subscribers INCLUDING the sender, so our own
        // sends come back on the subscription stream. Forwarding them would
        // cost the agent a turn to recognise and discard its own
        // output. `recent` still returns self-sends for scrollback.
        if (message.from === name) continue;
        await forwardMessage(sink, message, log, resolveChannelSlug);
      }

      // If we get here, the stream ended cleanly — treat as a reconnect.
      log.info('broker subscription stream ended, reconnecting');
      presence?.setOffline();
    } catch (err) {
      if (signal.aborted) return;
      presence?.setOffline();
      log.error('broker loop error', {
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
  sink: ChannelEventSink,
  message: Message,
  log: Logger,
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
  // would be misleading ("from=sender, target=me" reads like a DM).
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
    await sink.deliver({ content: message.body, meta });
  } catch (err) {
    log.error('failed to deliver channel event', {
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
 * Channel meta keys must be identifiers (letters, digits, underscore)
 * so they render cleanly as `<channel key="value">` attributes across
 * every sink; anything else is sanitised here to keep the key stable.
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
