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

import type {
  ClientIdentity,
  ClientReport,
  Message,
  Presence,
  Role,
  RunnerConditionFrame,
  RunnerReport,
} from 'csuite-sdk/types';

export type Subscriber = (message: Message) => void | Promise<void>;

export interface PresenceState {
  presence: Presence;
  subscribers: Set<Subscriber>;
  subscriberTokenIds: Map<Subscriber, string | null>;
  subscriberClientIdentities: Map<Subscriber, ClientIdentity | null>;
  subscriberIds: Map<Subscriber, string>;
  runnerConditions: Map<Subscriber, RunnerConditionFrame>;
  runnerTurns: Map<Subscriber, Map<string, { startedAt: number }>>;
  runnerLastActedAt: Map<Subscriber, number>;
  runnerLastTurn: Map<Subscriber, { at: number; outcome: 'acted' | 'no_action' | 'failed' }>;
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
      subscriberTokenIds: new Map(),
      subscriberClientIdentities: new Map(),
      subscriberIds: new Map(),
      runnerConditions: new Map(),
      runnerTurns: new Map(),
      runnerLastActedAt: new Map(),
      runnerLastTurn: new Map(),
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

  list(blockedTokenIds: ReadonlySet<string> = new Set(), brokerVersion?: string): Presence[] {
    const out: Presence[] = [];
    for (const state of this.presences.values()) {
      const identities = [...state.subscriberClientIdentities.values()];
      const grouped = new Map<string, { identity: ClientIdentity; connections: number }>();
      for (const identity of identities) {
        if (identity === null) continue;
        const key =
          identity.kind === 'runner'
            ? JSON.stringify([
                identity.kind,
                identity.runnerIdentity.runner,
                identity.runnerIdentity.modelId,
                identity.runnerIdentity.runnerVersion,
                identity.runnerIdentity.runnerBuildSource,
                identity.runnerIdentity.supervision,
                identity.runnerIdentity.deliveryProtocol,
                identity.runnerIdentity.livenessProtocol,
              ])
            : JSON.stringify([identity.kind, identity.clientVersion]);
        const prior = grouped.get(key);
        if (prior) prior.connections += 1;
        else grouped.set(key, { identity, connections: 1 });
      }
      const clientReports: ClientReport[] = [...grouped.values()].map(
        ({ identity, connections }) =>
          identity.kind === 'runner'
            ? {
                ...identity,
                connections,
                versionSkew: {
                  skew:
                    brokerVersion !== undefined &&
                    identity.runnerIdentity.runnerVersion !== brokerVersion,
                  runnerVersion: identity.runnerIdentity.runnerVersion,
                  brokerVersion: brokerVersion ?? '(unreported)',
                },
              }
            : { ...identity, connections },
      );
      const runnerReports: RunnerReport[] = clientReports.flatMap((report) =>
        report.kind === 'runner'
          ? [
              {
                ...report.runnerIdentity,
                connections: report.connections,
                versionSkew: report.versionSkew,
              },
            ]
          : [],
      );
      const runnerSubscribers = [...state.subscribers].filter(
        (sub) => state.subscriberClientIdentities.get(sub)?.kind === 'runner',
      );
      const classifications = runnerSubscribers.map((sub) => {
        const tokenId = state.subscriberTokenIds.get(sub) ?? null;
        if (tokenId !== null && blockedTokenIds.has(tokenId)) {
          return {
            state: 'degraded' as const,
            reason: { code: 'auth_blocked' as const, detail: 'runner credential is revoked' },
          };
        }
        return state.runnerConditions.get(sub) ?? null;
      });
      const ready = classifications.some((condition) => condition?.state === 'ready');
      const allDegraded =
        classifications.length > 0 &&
        classifications.every((condition) => condition?.state === 'degraded');
      const lastActed = [...state.runnerLastActedAt.values()];
      const lastTurns = [...state.runnerLastTurn.values()].sort((a, b) => b.at - a.at);
      const executor = {
        state: ready
          ? ('ready' as const)
          : allDegraded
            ? ('degraded' as const)
            : ('unreported' as const),
        ...(allDegraded
          ? {
              reason: classifications.find((condition) => condition?.state === 'degraded')?.reason,
            }
          : {}),
        activeTurns: [...state.runnerTurns.values()].reduce(
          (count, turns) => count + turns.size,
          0,
        ),
        lastTurnAt: lastTurns[0]?.at ?? null,
        lastActedAt: lastActed.length > 0 ? Math.max(...lastActed) : null,
        ...(lastTurns[0] ? { lastTurnOutcome: lastTurns[0].outcome } : {}),
      };
      out.push({
        name: state.presence.name,
        connected: state.subscribers.size,
        authBlocked: [...state.subscriberTokenIds.values()].filter(
          (tokenId) => tokenId !== null && blockedTokenIds.has(tokenId),
        ).length,
        ...(brokerVersion !== undefined
          ? {
              runnerReports,
              clientReports,
              unreportedConnections: identities.filter((identity) => identity === null).length,
              executor,
            }
          : {}),
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
