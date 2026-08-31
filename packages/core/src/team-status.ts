import type { TeamStatusObjective, TeamStatusResponse } from 'csuite-sdk/types';
import type { ActivityStore } from './activity-store.js';
import type { Broker } from './broker.js';
import type { EventLog } from './event-log.js';
import type { MemberStore } from './members-domain.js';
import { teammatesFromMembers } from './members-domain.js';
import type { ObjectivesStore } from './objectives.js';

export interface ComposeTeamStatusOptions {
  broker: Broker;
  brokerVersion: string;
  members: MemberStore;
  objectives?: ObjectivesStore;
  eventLog: EventLog;
  activityStore?: ActivityStore;
  generatedAt: number;
  stalledAfterMs: number | null;
}

/** The one broker-side definition shared by HTTP, CLI, MCP, and UI. */
export async function composeTeamStatus(
  options: ComposeTeamStatusOptions,
): Promise<TeamStatusResponse> {
  const presences = new Map(
    options.broker
      .listPresences(options.brokerVersion)
      .map((presence) => [presence.name, presence]),
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
