import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import type { Client } from 'csuite-sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetTeamHomeForTests, TeamHome } from '../src/components/TeamHome.js';
import { __resetClientForTests, setClient } from '../src/lib/client.js';
import { instructions } from '../src/lib/instructions.js';
import { objectives } from '../src/lib/objectives.js';
import { roster } from '../src/lib/roster.js';

function seed(permissions: [] | ['members.manage']) {
  instructions.value = {
    name: 'lead',
    role: { title: 'lead', description: '' },
    permissions,
    team: { name: 'demo', context: '' },
    teammates: [],
    openObjectives: [],
    toolSources: [],
    processDocument: null,
    instructions: '',
  };
  roster.value = {
    teammates: [{ name: 'builder', role: { title: 'engineer', description: '' }, permissions: [] }],
    connected: [],
  };
  objectives.value = [];
}

beforeEach(() => {
  __resetTeamHomeForTests();
  __resetClientForTests();
});

afterEach(cleanup);

describe('TeamHome team status', () => {
  it('makes no status request for a baseline member', async () => {
    seed([]);
    const teamStatus = vi.fn();
    setClient({ teamStatus } as unknown as Client);
    render(<TeamHome viewer="lead" />);
    await Promise.resolve();
    expect(teamStatus).not.toHaveBeenCalled();
  });

  it('renders the broker-composed stalled fields for members.manage', async () => {
    seed(['members.manage']);
    const teamStatus = vi.fn(async () => ({
      generatedAt: 2_001,
      stalledAfterMs: null,
      members: [
        {
          member: {
            name: 'builder',
            role: { title: 'engineer', description: '' },
            permissions: [],
          },
          presence: null,
          lastActivityAt: null,
          activeObjectives: [
            {
              id: 'obj-1',
              title: 'work',
              status: 'active' as const,
              lastThreadPostAt: null,
              lastPrLinkAt: null,
              lastLifecycleAt: 1_000,
              lastSignalAt: 1_000,
              stalled: true,
              staleSignals: ['thread_post' as const, 'pr_link' as const],
            },
          ],
        },
      ],
    }));
    setClient({ teamStatus } as unknown as Client);
    render(<TeamHome viewer="lead" />);
    await waitFor(() => expect(screen.getByText(/obj-1 · active · STALLED/)).toBeTruthy());
    expect(teamStatus).toHaveBeenCalledOnce();
    expect(screen.getByText(/last activity: absent/)).toBeTruthy();
  });
});
