import type { TeamStatusObjective, TeamStatusResponse } from 'csuite-sdk/types';
import type { ActivityStore } from './activity-store.js';
import type { Broker } from './broker.js';
import type { CaptureHealthStore } from './capture-health.js';
import type { DiagnosticStore } from './diagnostics.js';
import type { EventLog } from './event-log.js';
import type { MemberStore } from './members-domain.js';
import { teammatesFromMembers } from './members-domain.js';
import type { ObjectivesStore } from './objectives.js';
import { enrichPresence } from './presence-enrichment.js';
import type { WorkStateTracker } from './work-state.js';

export interface ComposeTeamStatusOptions {
  broker: Broker;
  brokerVersion: string;
  members: MemberStore;
  objectives?: ObjectivesStore;
  eventLog: EventLog;
  activityStore?: ActivityStore;
  /**
   * Per-member work-state reports. REQUIRED, and required on purpose:
   * `TeamStatusMember.presence` is the same `Presence` `GET /roster`
   * publishes, so it owes the same population. Leaving this optional is
   * how the two projections drifted — a caller that simply forgot it
   * would emit a `Presence` whose absent `activity` reads as "idle" for
   * a member the runner has reported blocked.
   */
  workState: Pick<WorkStateTracker, 'getWorkState'>;
  /**
   * Capture-health detector. Optional exactly as it is on the broker:
   * absent means this broker has no opinion, never "healthy".
   */
  captureHealth?: CaptureHealthStore;
  /** Retained completeness diagnostics. Same absence rule as `captureHealth`. */
  diagnostics?: DiagnosticStore;
  generatedAt: number;
  stalledAfterMs: number | null;
}

/** The one broker-side definition shared by HTTP, CLI, MCP, and UI. */
export async function composeTeamStatus(
  options: ComposeTeamStatusOptions,
): Promise<TeamStatusResponse> {
  // Enriched here, not forwarded raw: `enrichPresence` is the one
  // definition of the shape, and `GET /roster` calls the same function
  // over the same registry records.
  const presences = new Map(
    options.broker.listPresences(options.brokerVersion).map((presence) => [
      presence.name,
      enrichPresence(presence, {
        workState: options.workState,
        members: options.members,
        ...(options.captureHealth !== undefined ? { captureHealth: options.captureHealth } : {}),
        ...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
        now: options.generatedAt,
      }),
    ]),
  );
  const open = [
    ...(options.objectives?.list({ status: 'active' }) ?? []),
    ...(options.objectives?.list({ status: 'blocked' }) ?? []),
  ];
  const members = await Promise.all(
    teammatesFromMembers(options.members).map(async (member) => {
      const activeObjectives: TeamStatusObjective[] = await Promise.all(
        open
          .filter((objective) => objective.assignee === member.name)
          .map(async (objective) => {
            const discussion = await options.eventLog.latestObjectiveSignals(objective.id);
            const lifecycle = options.objectives?.events(objective.id) ?? [];
            const lastLifecycleAt = lifecycle.at(-1)?.ts ?? null;
            const timestamps = [
              discussion.lastThreadPostAt,
              discussion.lastPrLinkAt,
              lastLifecycleAt,
            ].filter((value): value is number => value !== null);
            const lastSignalAt = timestamps.length > 0 ? Math.max(...timestamps) : null;
            const stale = (value: number | null): boolean =>
              options.stalledAfterMs !== null &&
              (value === null || options.generatedAt - value > options.stalledAfterMs);
            const staleSignals: TeamStatusObjective['staleSignals'] = [];
            if (stale(discussion.lastThreadPostAt)) staleSignals.push('thread_post');
            if (stale(discussion.lastPrLinkAt)) staleSignals.push('pr_link');
            if (stale(lastLifecycleAt)) staleSignals.push('lifecycle');
            return {
              id: objective.id,
              title: objective.title,
              status: objective.status as 'active' | 'blocked',
              ...discussion,
              lastLifecycleAt,
              lastSignalAt,
              stalled: stale(lastSignalAt),
              staleSignals,
            };
          }),
      );
      // Already enriched — `enrichPresence` re-read the role from the
      // member store, so this block cannot disagree with `member.role`
      // beside it, and it carries the same axes the roster publishes.
      const presence = presences.get(member.name) ?? null;
      const objectiveStalled = activeObjectives.some((objective) => objective.stalled);
      const executorDegraded = presence?.executor?.state === 'degraded';
      return {
        member,
        presence,
        activeObjectives,
        lastActivityAt:
          options.activityStore?.list({ memberName: member.name, limit: 1 })[0]?.event.ts ?? null,
        stalled: objectiveStalled || executorDegraded,
        stalledReasons: [
          ...(objectiveStalled ? (['objective_stale'] as const) : []),
          ...(executorDegraded ? (['executor_degraded'] as const) : []),
        ],
      };
    }),
  );
  return {
    generatedAt: options.generatedAt,
    stalledAfterMs: options.stalledAfterMs,
    members: options.stalledAfterMs === null ? members : members.filter((row) => row.stalled),
  };
}
