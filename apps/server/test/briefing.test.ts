import type { Member, Team, Teammate } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { composeBriefing } from '../src/briefing.js';

const TEAM: Team = {
  name: 'demo-team',
  directive: 'Ship the payment service.',
  context: 'We own the full lifecycle of the payment service.',
  permissionPresets: {},
};

const DIRECTOR: Member = {
  name: 'director-1',
  role: { title: 'director', description: 'Leads the team, makes go/no-go calls.' },
  permissions: ['members.manage'],
  instructions: 'Lead the team and issue directives in the team channel.',
};
const ALPHA_1: Member = {
  name: 'engineer-1',
  role: { title: 'engineer', description: 'Writes and ships code.' },
  permissions: [],
  instructions: 'Take direction from command, ship code, report progress.',
};
const ENGINEER_2: Member = {
  name: 'engineer-2',
  role: { title: 'engineer', description: 'Writes and ships code.' },
  permissions: [],
  instructions: '',
};

const TEAMMATES: Teammate[] = [
  {
    name: 'director-1',
    role: { title: 'director', description: 'Leads the team, makes go/no-go calls.' },
    permissions: ['members.manage'],
  },
  {
    name: 'engineer-1',
    role: { title: 'engineer', description: 'Writes and ships code.' },
    permissions: [],
  },
  {
    name: 'engineer-2',
    role: { title: 'engineer', description: 'Writes and ships code.' },
    permissions: [],
  },
];

describe('composeBriefing', () => {
  it('includes name, role, permissions, team, and teammates', () => {
    const briefing = composeBriefing({
      self: DIRECTOR,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.name).toBe('director-1');
    expect(briefing.role.title).toBe('director');
    expect(briefing.permissions).toContain('members.manage');
    expect(briefing.team).toEqual(TEAM);
    expect(briefing.teammates).toEqual(TEAMMATES);
    expect(briefing.openObjectives).toEqual([]);
  });

  it('renders complementary instructions that reference team context', () => {
    const briefing = composeBriefing({
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).toContain('you go by engineer-1');
    expect(briefing.instructions).toContain('Your role here: engineer');
    expect(briefing.instructions).toContain(TEAM.name);
    expect(briefing.instructions).toContain(TEAM.directive);
    expect(briefing.instructions).toContain(TEAM.context);
    expect(briefing.instructions).toContain(ALPHA_1.instructions);
  });

  it('lists other teammates and filters self out of the rendered list', () => {
    const briefing = composeBriefing({
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.teammates.some((t) => t.name === 'engineer-1')).toBe(true);
    const linesAfterHeader = briefing.instructions
      .split('\n')
      .slice(briefing.instructions.split('\n').indexOf('Teammates on the net:'))
      .join('\n');
    expect(linesAfterHeader).toContain('director-1');
    expect(linesAfterHeader).toContain('engineer-2');
    expect(linesAfterHeader).not.toMatch(/^\s{2}engineer-1\s/m);
  });

  it('omits the context line when team.context is empty', () => {
    const teamNoContext: Team = { ...TEAM, context: '' };
    const briefing = composeBriefing({
      self: DIRECTOR,
      team: teamNoContext,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).not.toContain('Context:');
    expect(briefing.instructions).toContain(`Directive: ${teamNoContext.directive}`);
  });

  it('omits the personal-instructions block when the member has none', () => {
    const briefing = composeBriefing({
      self: ENGINEER_2,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).not.toContain('Personal instructions:');
  });

  it('notes that the link suppresses self-echoes on the live stream', () => {
    const briefing = composeBriefing({
      self: ENGINEER_2,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).toContain('Your own sends are suppressed by the link');
  });

  it('returns open objectives on the response but does NOT render them into instructions', () => {
    // The instructions prose is frozen per session, so we deliberately
    // keep the live list out of it — it would go stale the moment a
    // new objective was assigned mid-session. Live state reaches the
    // agent as message traffic (channel events + the runner's
    // `context_refresh` re-briefs) instead.
    const briefing = composeBriefing({
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [
        {
          id: 'obj-1',
          title: 'Fix the login redirect bug',
          body: '',
          outcome: 'Users hitting /login while authenticated land on /dashboard.',
          status: 'active',
          assignee: 'engineer-1',
          originator: 'director-1',
          watchers: [],
          createdAt: 1,
          updatedAt: 1,
          completedAt: null,
          result: null,
          blockReason: null,
          attachments: [],
        },
      ],
    });
    // openObjectives surfaces on the response body for non-briefing callers.
    expect(briefing.openObjectives).toHaveLength(1);
    expect(briefing.openObjectives[0]?.id).toBe('obj-1');
    // But the ID / title / outcome never land in the prose.
    expect(briefing.instructions).not.toContain('obj-1');
    expect(briefing.instructions).not.toContain('Fix the login redirect bug');
    expect(briefing.instructions).not.toContain('Objectives on your plate');
  });

  it('teaches the objective mechanism in instructions regardless of current plate', () => {
    const briefing = composeBriefing({
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).toContain('── Objectives ──');
    expect(briefing.instructions).toContain('kind="objective"');
    expect(briefing.instructions).toContain('objectives_list');
    expect(briefing.instructions).toContain('objectives_discuss');
    expect(briefing.instructions).toContain('objectives_update');
    expect(briefing.instructions).toContain('objectives_complete');
    expect(briefing.instructions).toContain('required `outcome`');
    // objectives_update is state-transitions only — the prose must not
    // teach a `note=` parameter the tool rejects (regression: it used
    // to, and the first progress report of every session burned a
    // failed call).
    expect(briefing.instructions).not.toContain('note=');
    // No stale promise of live tool descriptions — state freshness
    // comes from message traffic, not tool metadata.
    expect(briefing.instructions).not.toContain('tool description refreshes');
  });

  it('teaches all three channel thread types and the context_refresh re-brief', () => {
    const briefing = composeBriefing({
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).toContain('thread="primary"');
    expect(briefing.instructions).toContain('thread="dm"');
    expect(briefing.instructions).toContain('thread="channel"');
    expect(briefing.instructions).toContain('channel_slug');
    expect(briefing.instructions).toContain('channels_post');
    expect(briefing.instructions).toContain('context_refresh');
  });
});
