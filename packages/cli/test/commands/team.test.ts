import type { Client } from 'csuite-sdk/client';
import { describe, expect, it, vi } from 'vitest';
import { runTeamCommand } from '../../src/commands/team.js';

const team = { name: 'demo', context: '12345', permissionPresets: {} };

describe('csuite team instruction metrics', () => {
  it('reports context characters and explicitly estimated tokens on read', async () => {
    const lines: string[] = [];
    await runTeamCommand(
      ['get'],
      { getTeam: vi.fn(async () => team) } as unknown as Client,
      (line) => lines.push(line),
    );
    expect(lines).toContain('  [5 characters · ≈2 estimated tokens (characters ÷ 4)]');
  });

  it('reports the resulting context metrics after an authored update', async () => {
    const lines: string[] = [];
    await runTeamCommand(
      ['set', '--context', '12345'],
      { updateTeam: vi.fn(async () => team) } as unknown as Client,
      (line) => lines.push(line),
    );
    expect(lines).toContain('  context: 5 characters · ≈2 estimated tokens (characters ÷ 4)');
  });
});

describe('csuite team status', () => {
  it('passes a parsed stalled duration and preserves nulls in JSON', async () => {
    const lines: string[] = [];
    const teamStatus = vi.fn(async () => ({
      generatedAt: 10,
      stalledAfterMs: 120_000,
      members: [
        {
          member: { name: 'rune', role: { title: 'engineer', description: '' }, permissions: [] },
          presence: null,
          activeObjectives: [],
          lastActivityAt: null,
        },
      ],
    }));
    await runTeamCommand(
      ['status', '--stalled', '2m', '--json'],
      { teamStatus } as unknown as Client,
      (line) => lines.push(line),
    );
    expect(teamStatus).toHaveBeenCalledWith({ stalledMs: 120_000 });
    expect(JSON.parse(lines.join('\n')).members[0]).toMatchObject({
      presence: null,
      lastActivityAt: null,
    });
  });

  it('does not call absent presence disconnected or null model unreported', async () => {
    const lines: string[] = [];
    await runTeamCommand(
      ['status'],
      {
        teamStatus: vi.fn(async () => ({
          generatedAt: 10,
          stalledAfterMs: null,
          members: [
            {
              member: {
                name: 'rune',
                role: { title: 'engineer', description: '' },
                permissions: [],
              },
              presence: null,
              activeObjectives: [
                {
                  id: 'obj-1',
                  title: 'work',
                  status: 'active' as const,
                  lastThreadPostAt: 1_000,
                  lastPrLinkAt: null,
                  lastLifecycleAt: null,
                  lastSignalAt: 1_000,
                  stalled: false,
                  staleSignals: [],
                },
              ],
              lastActivityAt: 2_000,
            },
            {
              member: {
                name: 'cora',
                role: { title: 'engineer', description: '' },
                permissions: [],
              },
              presence: {
                name: 'cora',
                connected: 1,
                createdAt: 1,
                lastSeen: 2,
                role: null,
                runnerReports: [
                  {
                    runner: 'codex' as const,
                    modelId: null,
                    runnerVersion: '1.0.0',
                    runnerBuildSource: 'main' as const,
                    connections: 1,
                    versionSkew: { skew: false, runnerVersion: '1.0.0', brokerVersion: '1.0.0' },
                  },
                ],
              },
              activeObjectives: [],
              lastActivityAt: null,
            },
          ],
        })),
      } as unknown as Client,
      (line) => lines.push(line),
    );
    expect(lines).toContain('rune  presence=absent  last-activity=1970-01-01T00:00:02.000Z');
    expect(lines.join('\n')).toContain('model=agent default — not resolved locally');
    expect(lines.join('\n')).not.toContain('model=unreported');
    expect(lines.join('\n')).toContain('last-activity=1970-01-01T00:00:02.000Z');
    expect(lines.join('\n')).toContain('last-post=1970-01-01T00:00:01.000Z');
  });
});
