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
