/**
 * Broker — the runtime-agnostic core of csuite.
 *
 * Ties the presence registry to an event log and handles the push
 * fanout. Knows nothing about HTTP, MCP, or persistence; runtime
 * adapters layer those on top.
 *
 * Identity model: every authenticated caller is a member with a
 * unique `name`. The broker enforces `name === context.name` on
 * register and subscribe, so a member can only act on their own
 * connection. DMs go to the target member and also fan out to the
 * sender's own connection (if registered), which keeps multiple
 * live sessions of the same member in sync with zero client-side
 * bookkeeping.
 */

import { containsBearerToken } from 'csuite-sdk/credential-safety';
import { NameSchema } from 'csuite-sdk/schemas';
import type {
  ClientIdentity,
  Member,
  Message,
  MessageDispositionFrame,
  Presence,
  PushPayload,
  PushResult,
  Role,
  RunnerIdentity,
} from 'csuite-sdk/types';
import type { EventLog } from './event-log.js';
import { logger as defaultLogger, type Logger } from './logger.js';
import { InMemoryMessageDeliveryLedger, type MessageDeliveryLedger } from './message-delivery.js';
import {
  PresenceIdentityError,
  PresenceRegistry,
  type PresenceState,
  type Subscriber,
} from './registry.js';

/**
 * `payload.to` was not a syntactically valid member name.
 *
 * THROWN RATHER THAN COERCED, and the reason is the routing table
 * below rather than strictness for its own sake. `push` selects its
 * recipient set from `targetName`: a truthy value addresses one member,
 * and a falsy one falls through to `registry.allStates()` — every
 * registered member on the team. So the tempting lenient repair,
 * "unparseable name, treat it as null", turns a message its author
 * addressed to a single recipient into a team-wide broadcast. Rejecting
 * a send is recoverable; widening its audience silently is not.
 *
 * The domain is `NameSchema`'s, imported rather than restated, because
 * this exists to make one artifact agree with another and a copied
 * regex is a second place for them to drift apart.
 */
export class InvalidRecipientError extends Error {
  readonly to: unknown;
  constructor(to: unknown, detail: string) {
    super(
      `push: 'to' must be a member name (${detail}); received ${JSON.stringify(to)}. ` +
        'Channel sends do not address a channel — they omit `to` and carry ' +
        '`data.thread = "chan:<id>"` with an explicit recipient list in PushContext.',
    );
    this.name = 'InvalidRecipientError';
    this.to = to;
  }
}

/** A message body contained the complete shape of a plaintext bearer credential. */
export class CredentialShapedBodyError extends Error {
  constructor() {
    super(
      'message refused: credential-shaped body detected; credentials must use the device-enrolment or secret-value paths, never chat',
    );
    this.name = 'CredentialShapedBodyError';
  }
}

export interface BrokerOptions {
  eventLog: EventLog;
  /** Clock injection point. Defaults to `Date.now`. */
  now?: () => number;
  /** ID factory. Defaults to `crypto.randomUUID`. */
  idFactory?: () => string;
  /** Logger for subscriber-side failures and diagnostics. */
  logger?: Logger;
  /**
   * Max subscribers invoked in parallel during a single `push`. Keeps
   * one slow WebSocket writer from head-of-line-blocking every other
   * subscriber on the same push, while still bounding fan-out
   * concurrency so a pathological 10000-subscriber broadcast doesn't
   * spawn 10000 simultaneous async tasks.
   *
   * Defaults to 32 — comfortably parallel for real team-scale
   * workloads (≤100 concurrent subscribers total), cheap enough
   * that smaller deployments see no overhead. Set to 1 to keep the
   * pre-2026-04-16 serial behavior for debugging.
   */
  fanoutConcurrency?: number;
  /** Durable message disposition ledger. In-memory by default for embedders/tests. */
  deliveryLedger?: MessageDeliveryLedger;
}

/**
 * Per-push context supplied by the runtime adapter. `from` is the
 * authenticated user's name; the broker stamps it onto
 * `message.from` verbatim and never reads sender identity from the
 * payload. Pass `from: null` for unauthenticated / system-originated
 * pushes (tests, internal fanout).
 */
export interface PushContext {
  from: string | null;
  /**
   * Explicit recipient list, used by channel-scoped pushes to fan out
   * only to the channel's member set instead of the whole team.
   * `undefined` (or omitted) means "use the default routing":
   * targeted-DM when `payload.to` is set, broadcast-to-all otherwise.
   *
   * When provided, the sender is auto-included so multi-device sync
   * still works (mirrors the targeted-DM convention). Each name is
   * looked up in the registry; missing names are silently skipped.
   */
  recipients?: string[];
  /** False for terminal refusal/expiry facts so a refusal cannot recursively expire. */
  trackDisposition?: boolean;
}

/**
 * Per-register / per-subscribe context. `name` is the caller's
 * authenticated identity — the broker checks it matches the target
 * name being registered/subscribed. Pass `name: null` to skip the
 * check (tests, in-process core usage without a runtime). `role` is
 * cosmetic and surfaces on the user's presence entry.
 */
export interface IdentityContext {
  name?: string | null;
  role?: Role | null;
  /** Opaque bearer token id for token-aware presence; null for cookie/JWT/in-process callers. */
  tokenId?: string | null;
  /** Typed, observational identity of this subscriber. Never authorizes. */
  clientIdentity?: ClientIdentity;
  /** @deprecated Compatibility for in-process callers; maps to client kind `runner`. */
  runnerIdentity?: RunnerIdentity;
}

export interface RegistrationResult {
  name: string;
  registeredAt: number;
}

export interface MessageDispositionEvent {
  message: Message;
  recipient: string;
  disposition: MessageDispositionFrame['disposition'];
  at: number;
  reason: MessageDispositionFrame['reason'] | null;
}

const EMPTY_IDENTITY: IdentityContext = {};

const DEFAULT_FANOUT_CONCURRENCY = 32;

/**
 * Minimal bounded-parallel `forEach` over async callbacks. Runs up to
 * `concurrency` callbacks in flight at once; awaits all of them
 * before resolving. Exceptions from individual callbacks are passed
 * to `onError` and swallowed from the caller's perspective — fan-out
 * must be best-effort-to-each-subscriber rather than all-or-nothing,
 * because one stuck WebSocket writer should not prevent delivery to
 * the other 99 subscribers on the same push.
 *
 * Kept as an inline helper (rather than adding `p-limit` as a core
 * dep) because `csuite-core` is deliberately dep-light — it
 * carries only `csuite-sdk` as a runtime dep. A 15-line
 * semaphore is cheaper than dragging p-limit into every non-Node
 * runtime that wants to embed the broker.
 */
async function boundedParallel<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  onError: (item: T, err: unknown) => void,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.floor(concurrency));
  if (limit >= items.length) {
    await Promise.all(
      items.map(async (item) => {
        try {
          await worker(item);
        } catch (err) {
          onError(item, err);
        }
      }),
    );
    return;
  }
  let next = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < limit; i++) {
    runners.push(
      (async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const item = items[index] as T;
          try {
            await worker(item);
          } catch (err) {
            onError(item, err);
          }
        }
      })(),
    );
  }
  await Promise.all(runners);
}

export class Broker {
  private readonly registry = new PresenceRegistry();
  private readonly eventLog: EventLog;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly logger: Logger;
  private readonly fanoutConcurrency: number;
  private readonly deliveryLedger: MessageDeliveryLedger;
  private readonly dispositionListeners = new Set<(event: MessageDispositionEvent) => void>();
  private readonly blockedTokenIds = new Set<string>();

  constructor(options: BrokerOptions) {
    this.eventLog = options.eventLog;
    this.now = options.now ?? (() => Date.now());
    this.idFactory =
      options.idFactory ??
      (() => {
        if (!globalThis.crypto?.randomUUID) {
          throw new Error('Broker: globalThis.crypto.randomUUID is unavailable');
        }
        return globalThis.crypto.randomUUID();
      });
    // Default to the real logger, not a no-op: a broker whose warnings
    // vanish unless a host remembers to inject one is how subscriber
    // failures went unobserved.
    this.logger = options.logger ?? defaultLogger.child('broker');
    this.fanoutConcurrency = options.fanoutConcurrency ?? DEFAULT_FANOUT_CONCURRENCY;
    this.deliveryLedger = options.deliveryLedger ?? new InMemoryMessageDeliveryLedger();
  }

  /**
   * Explicitly register a member's presence so it shows up in
   * listPresences(). If `context.name` is supplied it must equal
   * `name`; any mismatch throws `PresenceIdentityError`. Core tests
   * skip the check by passing no context.
   */
  async register(
    name: string,
    context: IdentityContext = EMPTY_IDENTITY,
  ): Promise<RegistrationResult> {
    this.assertIdentity(name, context.name);
    const state = this.registry.registerOrGet(name, this.now(), context.role ?? null);
    return {
      name: state.presence.name,
      registeredAt: state.presence.createdAt,
    };
  }

  /**
   * Pre-populate the registry with every member defined in the team
   * config. Called once at server boot so the roster shows the full
   * team structure even before anyone has connected. Connection
   * state is still tracked live via WebSocket subscribers; seeding
   * only creates the zero-subscriber PresenceState entry.
   */
  seedMembers(members: Iterable<Pick<Member, 'name' | 'role'>>): void {
    const ts = this.now();
    for (const m of members) {
      this.registry.registerOrGet(m.name, ts, m.role);
    }
  }

  /**
   * Push a message to one user (if `payload.to` is set) or broadcast
   * to every registered user. Always writes to the event log.
   * Always returns the constructed Message so callers can surface IDs.
   *
   * For targeted pushes, the message also fans out to the sender's
   * own presence if one is registered — multi-device sync, free of
   * charge. The sender-fanout does not count toward `delivery.targets`
   * (which still reports the primary recipient count).
   */
  async push(payload: PushPayload, context: PushContext = { from: null }): Promise<PushResult> {
    // This is the last shared boundary before every DM, channel post,
    // objective discussion, and internal message reaches durable history.
    // Reject before minting an id or touching the event log; never echo the
    // body (and therefore never echo the credential) in the error.
    if (containsBearerToken(payload.body)) throw new CredentialShapedBodyError();
    const ts = this.now();
    const targetName = this.resolveTarget(payload.to);
    const message: Message = {
      id: this.idFactory(),
      ts,
      to: targetName,
      from: context.from,
      title: payload.title ?? null,
      body: payload.body,
      level: payload.level ?? 'info',
      data: payload.data ?? {},
      attachments: payload.attachments ?? [],
    };

    // The audience is persisted with the row, not just used for live
    // fan-out. A scoped push (channel, objective thread, secret) stores
    // `to: null` like a broadcast does, so the row alone cannot say who
    // it was for — and `/history` answered that question wrong for as
    // long as it had to guess from the thread tag.
    //
    // Recorded BEFORE delivery, from the same list delivery uses, so
    // the two cannot drift: whoever the fan-out below reaches is
    // whoever the durable read will show it to.
    await this.eventLog.append(message, {
      recipients:
        targetName === null && context.recipients !== undefined
          ? [...new Set([...context.recipients, ...(context.from ? [context.from] : [])])]
          : null,
    });

    const recipients = new Set<PresenceState>();
    if (targetName) {
      const target = this.registry.get(targetName);
      if (target) recipients.add(target);
      if (context.from && context.from !== targetName) {
        const sender = this.registry.get(context.from);
        if (sender) recipients.add(sender);
      }
    } else if (context.recipients !== undefined) {
      // Explicit recipient list (channel-scoped push). Look up each
      // name in the registry; missing names are dropped silently —
      // an offline channel member is just no-live-delivery, which
      // is the same outcome they'd get for a broadcast push.
      for (const name of context.recipients) {
        const state = this.registry.get(name);
        if (state) recipients.add(state);
      }
      // Always include the sender so their other devices receive
      // their own message (parity with the targeted-DM path).
      if (context.from) {
        const sender = this.registry.get(context.from);
        if (sender) recipients.add(sender);
      }
    } else {
      for (const state of this.registry.allStates()) recipients.add(state);
    }

    const targetStates = [...recipients];
    const dispositionNames = new Set<string>(
      targetName
        ? [targetName]
        : context.recipients !== undefined
          ? context.recipients
          : targetStates.map((state) => state.presence.name),
    );
    let live = 0;
    let pending = 0;
    let unreported = 0;

    // A disposition belongs to the member identity, not to a browser tab
    // or individual runner socket. Offline recipients remain pending. A
    // live legacy runner receives the message under the old contract and
    // is explicitly unreported rather than being guessed into support.
    if (context.trackDisposition !== false) {
      for (const state of targetStates) {
        if (!dispositionNames.has(state.presence.name)) continue;
        const runnerIdentities = [...state.subscriberClientIdentities.values()].filter(
          (identity) => identity?.kind === 'runner',
        );
        const hasAckRunner = runnerIdentities.some(
          (identity) => identity.runnerIdentity.deliveryProtocol === 'disposition-v1',
        );
        const hasLegacyRunner = runnerIdentities.length > 0 && !hasAckRunner;
        if (hasLegacyRunner) {
          unreported += 1;
        } else {
          this.deliveryLedger.track(message, state.presence.name, ts);
          pending += 1;
        }
      }
    }

    // Flatten (state, subscriber) pairs once so one bounded-concurrency
    // sweep covers every subscriber across every recipient. With the
    // old nested serial await, one slow WebSocket writer on user A
    // would head-of-line-block delivery to user B — fine at 1–3
    // subscribers per user in v0 tests, visibly broken at team scale
    // under backpressure. See `fanoutConcurrency` in BrokerOptions for
    // the tunable; default 32 stays well above real-world subscriber
    // counts while bounding pathological broadcast cases.
    type FanoutTask = { state: PresenceState; sub: Subscriber; ackCapable: boolean };
    const tasks: FanoutTask[] = [];
    for (const state of targetStates) {
      state.presence.lastSeen = ts;
      // Snapshot subscribers before collecting — a subscriber callback
      // is allowed to mutate the Set (e.g. self-unsubscribe, or trigger
      // cleanup that removes another subscriber). Iterating a live
      // Set while callbacks may mutate it is technically well-defined
      // for deletions but too subtle to rely on.
      for (const sub of state.subscribers) {
        const identity = state.subscriberClientIdentities.get(sub);
        tasks.push({
          state,
          sub,
          ackCapable:
            identity?.kind === 'runner' &&
            identity.runnerIdentity.deliveryProtocol === 'disposition-v1',
        });
      }
    }

    await boundedParallel(
      tasks,
      this.fanoutConcurrency,
      async ({ state, sub, ackCapable }) => {
        await sub(message);
        if (context.trackDisposition !== false && ackCapable) {
          this.deliveryLedger.noteSent(message.id, state.presence.name, ts);
        }
        live++;
      },
      ({ state }, err) => {
        this.logger.warn('subscriber threw during delivery', {
          name: state.presence.name,
          messageId: message.id,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );

    // A subscriber may disposition synchronously from its callback. Report
    // the ledger state after fan-out, not the pre-delivery snapshot.
    if (context.trackDisposition !== false) {
      pending = [...dispositionNames].reduce(
        (count, name) =>
          count +
          (this.deliveryLedger
            .pending(name, this.now())
            .some((row) => row.message.id === message.id)
            ? 1
            : 0),
        0,
      );
    }

    let targets: number;
    if (targetName) {
      targets = this.registry.has(targetName) ? 1 : 0;
    } else if (context.recipients !== undefined) {
      // Channel push — `targets` reports the explicit recipient set
      // (excluding the auto-added sender which got there via
      // multi-device-sync, not as an addressee).
      targets = context.recipients.length;
    } else {
      targets = targetStates.length;
    }
    return {
      delivery: {
        live,
        targets,
        ...(context.trackDisposition === false
          ? {}
          : {
              acknowledgement: {
                status:
                  pending > 0
                    ? ('pending' as const)
                    : unreported > 0
                      ? ('unreported' as const)
                      : ('settled' as const),
                pending,
                unreported,
              },
            }),
      },
      message,
    };
  }

  /**
   * Attach a subscriber. The member is auto-registered if unknown so
   * callers don't have to make a separate register() call. Identity
   * is checked the same way as `register` — a mismatched name
   * throws `PresenceIdentityError`.
   */
  subscribe(
    name: string,
    callback: Subscriber,
    context: IdentityContext = EMPTY_IDENTITY,
  ): () => void {
    this.assertIdentity(name, context.name);
    const state = this.registry.registerOrGet(name, this.now(), context.role ?? null);
    state.subscribers.add(callback);
    state.subscriberTokenIds.set(callback, context.tokenId ?? null);
    state.subscriberClientIdentities.set(
      callback,
      context.clientIdentity ??
        (context.runnerIdentity
          ? { kind: 'runner', runnerIdentity: context.runnerIdentity }
          : null),
    );
    return () => {
      const current = this.registry.get(name);
      current?.subscribers.delete(callback);
      current?.subscriberTokenIds.delete(callback);
      current?.subscriberClientIdentities.delete(callback);
    };
  }

  /** Settle/defer one delivery from the authenticated ack-capable runner socket. */
  async disposition(
    name: string,
    frame: MessageDispositionFrame,
    context: IdentityContext = EMPTY_IDENTITY,
  ): Promise<boolean> {
    this.assertIdentity(name, context.name);
    if (
      context.clientIdentity?.kind !== 'runner' ||
      context.clientIdentity.runnerIdentity.deliveryProtocol !== 'disposition-v1'
    ) {
      return false;
    }
    const row = this.deliveryLedger.settle(name, frame);
    if (!row) return false;
    const event: MessageDispositionEvent = {
      message: row.message,
      recipient: name,
      disposition: frame.disposition,
      at: frame.at,
      reason: frame.reason ?? null,
    };
    for (const listener of this.dispositionListeners) listener(event);
    if (frame.disposition === 'refused' && row.message.from !== null) {
      await this.push(
        {
          to: row.message.from,
          title: 'Message explicitly refused',
          body: `Message ${row.message.id} to ${name} was refused.`,
          level: 'warning',
          data: {
            kind: 'message_disposition',
            messageId: row.message.id,
            recipient: name,
            disposition: 'refused',
            reason: frame.reason ?? null,
          },
        },
        { from: null, trackDisposition: false },
      );
    }
    return true;
  }

  /** Observe runner dispositions; notification receipts consume this same primitive. */
  onMessageDisposition(listener: (event: MessageDispositionEvent) => void): () => void {
    this.dispositionListeners.add(listener);
    return () => this.dispositionListeners.delete(listener);
  }

  /** Redeliver pending rows in original message order on runner attach. */
  async redeliverPending(
    name: string,
    callback: Subscriber,
    clientIdentity: ClientIdentity | null,
  ): Promise<number> {
    const rows = this.deliveryLedger.pending(name, this.now());
    const capable =
      clientIdentity?.kind === 'runner' &&
      clientIdentity.runnerIdentity.deliveryProtocol === 'disposition-v1';
    const legacy = clientIdentity?.kind === 'runner' && !capable;
    if (!capable && !legacy) return 0;
    let delivered = 0;
    for (const row of rows) {
      await callback(row.message);
      delivered += 1;
      if (capable) this.deliveryLedger.noteSent(row.message.id, name, this.now());
      else this.deliveryLedger.markUnreported(row.message.id, name, this.now());
    }
    return delivered;
  }

  /**
   * Expire the temporal (24h) bound. Refusal facts are ledger-exempt,
   * so an offline sender can read them from history but they never
   * recurse into another expiry/refusal.
   */
  async sweepMessageDeliveries(): Promise<number> {
    const expired = this.deliveryLedger.expire(this.now());
    for (const row of expired) {
      for (const listener of this.dispositionListeners) {
        listener({
          message: row.message,
          recipient: row.recipient,
          disposition: 'refused',
          at: this.now(),
          reason: { code: 'expired', detail: 'message acknowledgement expired after 24 hours' },
        });
      }
      if (row.sender === null) continue;
      await this.push(
        {
          to: row.sender,
          title: 'Message explicitly refused',
          body: `Message ${row.message.id} to ${row.recipient} expired without acknowledgement.`,
          level: 'warning',
          data: {
            kind: 'message_disposition',
            messageId: row.message.id,
            recipient: row.recipient,
            disposition: 'refused',
            reason: 'expired',
          },
        },
        { from: null, trackDisposition: false },
      );
    }
    return expired.length;
  }

  /** Mark live subscriptions authenticated by these revoked tokens as blocked. */
  blockTokens(tokenIds: readonly string[]): void {
    for (const id of tokenIds) this.blockedTokenIds.add(id);
  }

  listPresences(brokerVersion?: string): Presence[] {
    return this.registry.list(this.blockedTokenIds, brokerVersion);
  }

  hasMember(name: string): boolean {
    return this.registry.has(name);
  }

  getEventLog(): EventLog {
    return this.eventLog;
  }

  /**
   * Normalise and validate `payload.to` into the recipient name, or
   * null for "not addressed to anyone in particular".
   *
   * Runs BEFORE `eventLog.append`. Validating after the append would
   * still reject the send while leaving the rejected message durably
   * in the log — the exact class of row this change exists to stop
   * being written.
   *
   * `undefined` and `null` both mean unaddressed and are accepted;
   * everything else must satisfy `NameSchema`. Empty string is
   * REJECTED rather than folded into null, even though `?? null`
   * previously let it through to the same broadcast branch: `to: ''`
   * is much more likely a bug at the callsite — an unset variable
   * interpolated into a name — than a deliberate broadcast, and the
   * deliberate form is already spelled by omitting the field.
   */
  private resolveTarget(to: string | null | undefined): string | null {
    if (to === undefined || to === null) return null;
    const parsed = NameSchema.safeParse(to);
    if (!parsed.success) {
      throw new InvalidRecipientError(to, parsed.error.issues[0]?.message ?? 'invalid');
    }
    return parsed.data;
  }

  private assertIdentity(target: string, name: string | null | undefined): void {
    if (name == null) return;
    if (name !== target) {
      throw new PresenceIdentityError(target, name);
    }
  }
}
