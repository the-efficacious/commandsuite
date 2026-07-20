/**
 * Presence registry — tracks known members and their live subscribers.
 *
 * "Subscriber" here is a callback invoked when a message targets this
 * member. The Node server creates one subscriber per live WebSocket
 * connection; anything else that wants to observe pushes can attach
 * the same way.
 *
 * Identity model: a member's `name` is the key. The broker enforces
 * that register/subscribe callers authenticate as the same name
 * they're acting on (the registry itself is identity-agnostic so
 * core stays testable without wiring up auth). A mismatch surfaces
 * as `PresenceIdentityError`.
 */

import type { Message, Presence, Role } from 'csuite-sdk/types';

export type Subscriber = (message: Message) => void | Promise<void>;

export interface PresenceState {
  presence: Presence;
  subscribers: Set<Subscriber>;
}

/**
 * Thrown by `Broker.register` / `Broker.subscribe` when the caller's
 * authenticated member name doesn't match the name they're trying to
 * act on. Runtime adapters translate this into an HTTP 403.
 */
export class PresenceIdentityError extends Error {
  readonly targetName: string;
  readonly callerName: string;
  constructor(targetName: string, callerName: string) {
    super(
      `member '${callerName}' cannot act on '${targetName}'; ` +
        "the target name must equal the caller's authenticated name",
    );
    this.name = 'PresenceIdentityError';
    this.targetName = targetName;
    this.callerName = callerName;
  }
}

export class PresenceRegistry {
  private readonly presences = new Map<string, PresenceState>();

  /**
   * Look up or create a presence entry for `name`. Updates `lastSeen`
   * on each call so the list endpoint reflects recent activity. Role
   * is first-register-wins: once set, subsequent registrations ignore
   * the value (the registry is authoritative about online/offline,
   * not about role changes).
   */
  registerOrGet(name: string, now: number, role: Role | null = null): PresenceState {
    const existing = this.presences.get(name);
    if (existing) {
      existing.presence.lastSeen = now;
      return existing;
    }
    const state: PresenceState = {
      presence: {
        name,
        connected: 0,
        createdAt: now,
        lastSeen: now,
        role,
      },
      subscribers: new Set(),
    };
    this.presences.set(name, state);
    return state;
  }

  get(name: string): PresenceState | undefined {
    return this.presences.get(name);
  }

  has(name: string): boolean {
    return this.presences.has(name);
  }

  list(): Presence[] {
    const out: Presence[] = [];
    for (const state of this.presences.values()) {
      out.push({
        name: state.presence.name,
        connected: state.subscribers.size,
        createdAt: state.presence.createdAt,
        lastSeen: state.presence.lastSeen,
        role: state.presence.role,
      });
    }
    return out;
  }

  /** Snapshot of all live presence states (for broadcast fanout). */
  allStates(): PresenceState[] {
    return Array.from(this.presences.values());
  }
}
