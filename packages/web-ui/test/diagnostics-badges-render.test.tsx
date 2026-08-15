/**
 * Retained-diagnostics state as it reaches a human.
 *
 * `diagnosticsUnresolved` and `diagnosticsRetention` were computed on
 * every roster response and read by nothing — grep across web-ui and
 * web-host found zero consumers. A member sitting on unresolved
 * capture incidents rendered identically to a clean one, which is the
 * same shape as the defect the diagnostics work was built to close:
 * the product knew and no surface said so.
 *
 * This is the sibling of `capture-health-render.test.tsx` and exists
 * for the same reason it does — a helper nobody renders satisfies
 * nothing. So these render the real component and assert badge text,
 * in both directions: the healthy roster must stay quiet.
 */

import { cleanup, render, screen } from '@testing-library/preact';
import type { InstructionsResponse, Presence, RosterResponse } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemberProfile } from '../src/components/MemberProfile.js';
import { __resetClientForTests } from '../src/lib/client.js';
import { instructions } from '../src/lib/instructions.js';
import { objectives as objectivesSignal } from '../src/lib/objectives.js';
import { presenceDiagnostics, roster } from '../src/lib/roster.js';

const PACKET: InstructionsResponse = {
  name: 'director-1',
  role: { title: 'director', description: '' },
  permissions: ['members.manage'],
  team: { name: 'demo-team', context: '', permissionPresets: {} },
  teammates: [
    {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
    },
    { name: 'turner', role: { title: 'engineer', description: '' }, permissions: [] },
  ],
  openObjectives: [],
  toolSources: [],
  processDocument: null,
  instructions: '',
};

function presenceWith(patch: Partial<Presence>): Presence {
  return {
    name: 'turner',
    connected: 1,
    createdAt: 1_700_000_000_000,
    lastSeen: 1_700_000_000_000,
    role: { title: 'engineer', description: '' },
    activity: 'working',
    busy: true,
    ...patch,
  };
}

function rosterWith(patch: Partial<Presence>): RosterResponse {
  return { teammates: PACKET.teammates, connected: [presenceWith(patch)] };
}

beforeEach(() => {
  __resetClientForTests();
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ activity: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof fetch;
  instructions.value = PACKET;
  objectivesSignal.value = [];
});

afterEach(() => {
  cleanup();
  instructions.value = null;
  roster.value = null;
  objectivesSignal.value = [];
});

describe('presenceDiagnostics', () => {
  it('is null when there is nothing to say', () => {
    expect(
      presenceDiagnostics(
        presenceWith({ diagnosticsUnresolved: 0, diagnosticsRetention: 'healthy' }),
      ),
    ).toBeNull();
  });

  it('reports unresolved incidents', () => {
    expect(
      presenceDiagnostics(
        presenceWith({ diagnosticsUnresolved: 3, diagnosticsRetention: 'healthy' }),
      ),
    ).toEqual({ unresolved: 3, retention: 'healthy' });
  });

  it('reports degraded retention even at zero unresolved', () => {
    // A store that cannot record is exactly the state in which a zero
    // means nothing. Reporting it as all-clear is the failure the
    // diagnostics work exists to end.
    expect(
      presenceDiagnostics(
        presenceWith({ diagnosticsUnresolved: 0, diagnosticsRetention: 'degraded' }),
      ),
    ).toEqual({ unresolved: 0, retention: 'degraded' });
  });

  it('is null for a server that reports neither field', () => {
    expect(presenceDiagnostics(presenceWith({}))).toBeNull();
  });
});

describe('what a reader actually sees', () => {
  it('renders the unresolved count on the member profile', () => {
    roster.value = rosterWith({ diagnosticsUnresolved: 3, diagnosticsRetention: 'healthy' });
    render(<MemberProfile name="turner" tab="overview" viewer="director-1" />);

    // The number matters, not just that something appeared: one
    // unresolved incident and thirty are different operational states.
    expect(screen.getByText('3 UNRESOLVED')).toBeTruthy();
  });

  it('renders the retention state when the store itself is degraded', () => {
    roster.value = rosterWith({ diagnosticsUnresolved: 0, diagnosticsRetention: 'degraded' });
    render(<MemberProfile name="turner" tab="overview" viewer="director-1" />);

    expect(screen.getByText('DIAGNOSTICS DEGRADED')).toBeTruthy();
  });

  it('renders NEITHER badge for a healthy member', () => {
    // The positive control. Without it, a component that rendered both
    // badges unconditionally would pass every test above.
    roster.value = rosterWith({ diagnosticsUnresolved: 0, diagnosticsRetention: 'healthy' });
    render(<MemberProfile name="turner" tab="overview" viewer="director-1" />);

    expect(screen.queryByText(/UNRESOLVED/)).toBeNull();
    expect(screen.queryByText(/DIAGNOSTICS/)).toBeNull();
  });
});
