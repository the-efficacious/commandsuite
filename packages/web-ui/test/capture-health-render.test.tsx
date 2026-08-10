/**
 * Capture health as it actually reaches a human — rendered, not helped.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM capture-health-surface.test.ts
 * ------------------------------------------------------------------
 * That file tests `presenceCaptureWarning` and proves the HELPER. It
 * does not prove a caller exists: deleting either badge's JSX left all
 * seven of those tests green, which Rune established by doing it. The
 * outcome is the state being visible on both human views, and a helper
 * nobody renders satisfies none of it.
 *
 * This is the same defect as the thing being built. The helper reports
 * a gap correctly; nothing surfaces it; and the tests that "cover" it
 * are asking the right question one layer below the answer.
 *
 * So these tests render the real components and assert on badge text.
 * Each render site is independently mutable: removing TeamHome's badge
 * must fail TeamHome's tests and not MemberProfile's, and vice versa.
 */

import { cleanup, render, screen } from '@testing-library/preact';
import type { InstructionsResponse, Presence, RosterResponse } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemberProfile } from '../src/components/MemberProfile.js';
import { TeamHome } from '../src/components/TeamHome.js';
import { __resetClientForTests } from '../src/lib/client.js';
import { instructions } from '../src/lib/instructions.js';
import { roster } from '../src/lib/roster.js';

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

/**
 * The member is CONNECTED and WORKING in every fixture below.
 *
 * That is deliberate and it is the shape of the real failure: the
 * runner whose capture was dead for a full day looked online and busy
 * the entire time. A badge gated on idleness or disconnection would
 * never have fired for the case it exists for.
 */
function presenceFor(captureHealth?: Presence['captureHealth']): Presence {
  return {
    name: 'turner',
    connected: 1,
    createdAt: 1_700_000_000_000,
    lastSeen: 1_700_000_000_000,
    role: { title: 'engineer', description: '' },
    activity: 'working',
    busy: true,
    ...(captureHealth !== undefined ? { captureHealth } : {}),
  };
}

function rosterWith(captureHealth?: Presence['captureHealth']): RosterResponse {
  return { teammates: PACKET.teammates, connected: [presenceFor(captureHealth)] };
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
});

afterEach(() => {
  cleanup();
  instructions.value = null;
  roster.value = null;
});

describe('TeamHome roster row', () => {
  it('renders NO CAPTURE for a connected, working member in a gap', () => {
    roster.value = rosterWith('gap');
    render(<TeamHome viewer="director-1" />);

    expect(screen.getByText('NO CAPTURE')).toBeTruthy();
  });

  it('renders CAPTURE UNCHECKED for an unevaluated member', () => {
    // Distinct from both the warning and silence: the broker looked and
    // declined, rather than not being asked.
    roster.value = rosterWith('unevaluated');
    render(<TeamHome viewer="director-1" />);

    expect(screen.getByText('CAPTURE UNCHECKED')).toBeTruthy();
    expect(screen.queryByText('NO CAPTURE')).toBeNull();
  });

  it('renders neither badge for a healthy member', () => {
    roster.value = rosterWith('ok');
    render(<TeamHome viewer="director-1" />);

    expect(screen.queryByText('NO CAPTURE')).toBeNull();
    expect(screen.queryByText('CAPTURE UNCHECKED')).toBeNull();
  });

  it('renders neither badge when the broker has no opinion', () => {
    // An older broker omits the field. The row must stay quiet — NOT
    // show a healthy state, which would be the UI asserting something
    // no broker evaluated.
    roster.value = rosterWith(undefined);
    render(<TeamHome viewer="director-1" />);

    expect(screen.queryByText('NO CAPTURE')).toBeNull();
    expect(screen.queryByText('CAPTURE UNCHECKED')).toBeNull();
  });
});

describe('MemberProfile header', () => {
  it('renders NO CAPTURE for a connected, working member in a gap', () => {
    roster.value = rosterWith('gap');
    render(<MemberProfile name="turner" tab="overview" viewer="director-1" />);

    expect(screen.getByText('NO CAPTURE')).toBeTruthy();
    // The member is genuinely online; the badge is orthogonal to that
    // and must not have replaced the connection state.
    expect(screen.getByText('● ONLINE')).toBeTruthy();
  });

  it('renders CAPTURE UNCHECKED for an unevaluated member', () => {
    roster.value = rosterWith('unevaluated');
    render(<MemberProfile name="turner" tab="overview" viewer="director-1" />);

    expect(screen.getByText('CAPTURE UNCHECKED')).toBeTruthy();
    expect(screen.queryByText('NO CAPTURE')).toBeNull();
  });

  it('renders neither badge for a healthy member', () => {
    roster.value = rosterWith('ok');
    render(<MemberProfile name="turner" tab="overview" viewer="director-1" />);

    expect(screen.queryByText('NO CAPTURE')).toBeNull();
    expect(screen.queryByText('CAPTURE UNCHECKED')).toBeNull();
  });

  it('renders neither badge when the broker has no opinion', () => {
    roster.value = rosterWith(undefined);
    render(<MemberProfile name="turner" tab="overview" viewer="director-1" />);

    expect(screen.queryByText('NO CAPTURE')).toBeNull();
    expect(screen.queryByText('CAPTURE UNCHECKED')).toBeNull();
  });
});
