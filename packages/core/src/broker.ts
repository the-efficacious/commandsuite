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

import type { Member, Message, Presence, PushPayload, PushResult, Role } from 'csuite-sdk/types';
import type { EventLog } from './event-log.js';
import {
  PresenceIdentityError,
  PresenceRegistry,
  type PresenceState,
  type Subscriber,
} from './registry.js';

export interface BrokerLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface BrokerOptions {
  eventLog: EventLog;
  /** Clock injection point. Defaults to `Date.now`. */
  now?: () => number;
  /** ID factory. Defaults to `crypto.randomUUID`. */
  idFactory?: () => string;
  /** Logger for subscriber-side failures and diagnostics. */
  logger?: BrokerLogger;
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
}

export interface RegistrationResult {
  name: string;
  registeredAt: number;
}

const NOOP_LOGGER: BrokerLogger = {
  warn: () => {},
  error: () => {},
};

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
  private readonly logger: BrokerLogger;
  private readonly fanoutConcurrency: number;

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
    this.logger = options.logger ?? NOOP_LOGGER;
    this.fanoutConcurrency = options.fanoutConcurrency ?? DEFAULT_FANOUT_CONCURRENCY;
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
    const ts = this.now();
    const targetName = payload.to ?? null;
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

    await this.eventLog.append(message);

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
    let live = 0;

    // Flatten (state, subscriber) pairs once so one bounded-concurrency
    // sweep covers every subscriber across every recipient. With the
    // old nested serial await, one slow WebSocket writer on user A
    // would head-of-line-block delivery to user B — fine at 1–3
    // subscribers per user in v0 tests, visibly broken at team scale
    // under backpressure. See `fanoutConcurrency` in BrokerOptions for
    // the tunable; default 32 stays well above real-world subscriber
    // counts while bounding pathological broadcast cases.
    type FanoutTask = { state: PresenceState; sub: Subscriber };
    const tasks: FanoutTask[] = [];
    for (const state of targetStates) {
      state.presence.lastSeen = ts;
      // Snapshot subscribers before collecting — a subscriber callback
      // is allowed to mutate the Set (e.g. self-unsubscribe, or trigger
      // cleanup that removes another subscriber). Iterating a live
      // Set while callbacks may mutate it is technically well-defined
      // for deletions but too subtle to rely on.
      for (const sub of state.subscribers) {
        tasks.push({ state, sub });
      }
    }

    await boundedParallel(
      tasks,
      this.fanoutConcurrency,
      async ({ sub }) => {
        await sub(message);
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
    return () => {
      const current = this.registry.get(name);
      current?.subscribers.delete(callback);
    };
  }

  listPresences(): Presence[] {
    return this.registry.list();
  }

  hasMember(name: string): boolean {
    return this.registry.has(name);
  }

  getEventLog(): EventLog {
    return this.eventLog;
  }

  private assertIdentity(target: string, name: string | null | undefined): void {
    if (name == null) return;
    if (name !== target) {
      throw new PresenceIdentityError(target, name);
    }
  }
}
