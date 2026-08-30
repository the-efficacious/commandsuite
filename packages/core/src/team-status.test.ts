import { describe, expect, it } from 'vitest';
import { composeTeamStatus } from './team-status.js';

const member = {
  name: 'rune',
  role: { title: 'engineer', description: 'builds' },
  permissions: ['members.manage'],
  instructions: '',
  totpSecret: null,
};

function fixture(generatedAt = 2_000, stalledAfterMs: number | null = 1_000) {
  return {
    broker: { listPresences: () => [] } as never,
    brokerVersion: '1.0.0',
    members: { members: () => [member] } as never,
    objectives: {
      list: ({ status }: { status?: string }) =>
        status === 'active'
          ? [
              {
                id: 'obj-1',
                title: 'work',
                status: 'active',
                assignee: 'rune',
                originator: 'lea',
              },
            ]
          : [],
      events: () => [{ ts: 1_000 }],
    } as never,
    eventLog: {
      latestObjectiveSignals: async () => ({ lastThreadPostAt: 1_000, lastPrLinkAt: null }),
    } as never,
    generatedAt,
    stalledAfterMs,
  };
}

describe('composeTeamStatus', () => {
  it('keeps stored absences null and uses a strict greater-than stall boundary', async () => {
    const atBoundary = await composeTeamStatus(fixture());
    expect(atBoundary.members[0]?.presence).toBeNull();
    expect(atBoundary.members[0]?.lastActivityAt).toBeNull();
    expect(atBoundary.members[0]?.activeObjectives[0]).toMatchObject({
      lastPrLinkAt: null,
      stalled: false,
      staleSignals: ['pr_link'],
    });

    const pastBoundary = await composeTeamStatus(fixture(2_001));
    expect(pastBoundary.members[0]?.activeObjectives[0]).toMatchObject({
      stalled: true,
      staleSignals: ['thread_post', 'pr_link', 'lifecycle'],
    });
  });

  it('filters to members with a stalled active objective only when requested', async () => {
    const report = await composeTeamStatus(fixture(1_500));
    expect(report.members).toEqual([]);
    const unfiltered = await composeTeamStatus(fixture(1_500, null));
    expect(unfiltered.members).toHaveLength(1);
    expect(unfiltered.members[0]?.activeObjectives[0]?.stalled).toBe(false);
  });
});
