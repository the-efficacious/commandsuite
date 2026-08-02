import type { Member, Team, Teammate } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { instructionCaptureExemptions, composeInstructions } from '../src/instructions.js';

const TEAM: Team = {
  name: 'demo-team',
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

describe('composeInstructions', () => {
  it('projects exact authored blocks from this member packet without positional guesses', () => {
    const input = {
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
      processDocument: null,
    };
    const packet = composeInstructions(input);
    const exemptions = instructionCaptureExemptions(input);
    expect(exemptions).toEqual([TEAM.context, ALPHA_1.role.description, ALPHA_1.instructions]);
    for (const block of exemptions) expect(packet.instructions).toContain(block);
    expect(exemptions).not.toContain(DIRECTOR.role.description);
  });

  it('does not exempt an authored block absent from the composed packet', () => {
    const input = {
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
      processDocument: null,
    };
    const personalBlock = ALPHA_1.instructions;
    const composedWithoutPersonal = composeInstructions(input).instructions.replace(personalBlock, '');

    expect(instructionCaptureExemptions(input, composedWithoutPersonal)).not.toContain(personalBlock);
  });

  it('includes name, role, permissions, team, and teammates', () => {
    const packet = composeInstructions({
      self: DIRECTOR,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
      processDocument: null,
    });
    expect(packet.name).toBe('director-1');
    expect(packet.role.title).toBe('director');
    expect(packet.permissions).toContain('members.manage');
    expect(packet.team).toEqual(TEAM);
    expect(packet.teammates).toEqual(TEAMMATES);
    expect(packet.openObjectives).toEqual([]);
  });

  it('renders complementary instructions that reference team context', () => {
    const packet = composeInstructions({
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
      processDocument: null,
    });
    expect(packet.instructions).toContain('You: engineer-1');
    expect(packet.instructions).toContain('Your role here: engineer');
    expect(packet.instructions).toContain(TEAM.name);
    expect(packet.instructions).toContain(TEAM.context);
    expect(packet.instructions).toContain(ALPHA_1.instructions);
  });

  it('names CommandSuite and csuite with separate broker and runner versions in one opening line', () => {
    const packet = composeInstructions({
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
      processDocument: null,
      brokerVersion: '0.4.0',
      runnerVersion: '0.3.4',
    });
    const [opening, identity] = packet.instructions.split('\n');
    expect(opening).toBe('demo-team CommandSuite/csuite: broker=0.4.0 runner=0.3.4');
    expect(identity).toBe('You: engineer-1');
    expect(packet.instructions).not.toContain('\nTeam: demo-team\n');
  });

  it('names unavailable versions as unknown without changing capture blocks', () => {
    const input = {
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
      processDocument: null,
    };
    const packet = composeInstructions(input);
    expect(packet.instructions).toContain('CommandSuite/csuite: broker=unknown runner=unknown');
    expect(instructionCaptureExemptions(input)).toEqual([
      TEAM.context,
      ALPHA_1.role.description,
      ALPHA_1.instructions,
    ]);
  });

  it('never grows the composed packet relative to the replaced opening', () => {
    const legacyChars =
      `You've connected to the csuite net. In this team you go by ${ALPHA_1.name}.`.length +
      1 +
      `Team: ${TEAM.name}`.length;

    for (const runnerVersion of ['x'.repeat(64), undefined]) {
      const packet = composeInstructions({
        self: ALPHA_1,
        team: TEAM,
        teammates: TEAMMATES,
        openObjectives: [],
        processDocument: null,
        brokerVersion: 'x'.repeat(64),
        runnerVersion,
      });
      const [opening = '', identity = ''] = packet.instructions.split('\n');
      expect(opening.length + 1 + identity.length).toBeLessThanOrEqual(legacyChars);
    }
  });

  it('bounds long versions while retaining both ends', () => {
    const packet = composeInstructions({
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
      processDocument: null,
      brokerVersion: '0.5.0-alpha.20260801+broker',
      runnerVersion: '0.5.0-alpha.20260731+runner',
    });
    const [opening] = packet.instructions.split('\n');
    expect(opening).toContain('broker=0.5.0-al…ker');
    expect(opening).toContain('runner=0.5.0-al…ner');
  });

  it('lists other teammates and filters self out of the rendered list', () => {
    const packet = composeInstructions({
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
      processDocument: null,
    });
    expect(packet.teammates.some((t) => t.name === 'engineer-1')).toBe(true);
    const linesAfterHeader = packet.instructions
      .split('\n')
      .slice(packet.instructions.split('\n').indexOf('Teammates on the net:'))
      .join('\n');
    expect(linesAfterHeader).toContain('director-1');
    expect(linesAfterHeader).toContain('engineer-2');
    expect(linesAfterHeader).not.toMatch(/^\s{2}engineer-1\s/m);
  });

  it('omits the context line when team.context is empty', () => {
    const teamNoContext: Team = { ...TEAM, context: '' };
    const packet = composeInstructions({
      self: DIRECTOR,
      team: teamNoContext,
      teammates: TEAMMATES,
      openObjectives: [],
      processDocument: null,
    });
    expect(packet.instructions).not.toContain('Context:');
    expect(packet.instructions).toContain(`${teamNoContext.name} CommandSuite/csuite`);
  });

  it('omits the personal-instructions block when the member has none', () => {
    const packet = composeInstructions({
      self: ENGINEER_2,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
      processDocument: null,
    });
    expect(packet.instructions).not.toContain('Personal instructions:');
  });

  it('notes that the link suppresses self-echoes on the live stream', () => {
    const packet = composeInstructions({
      self: ENGINEER_2,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
      processDocument: null,
    });
    expect(packet.instructions).toContain('Your own sends are suppressed by the link');
  });

  it('returns open objectives on the response but does NOT render them into instructions', () => {
    // The instructions prose is frozen per session, so we deliberately
    // keep the live list out of it — it would go stale the moment a
    // new objective was assigned mid-session. Live state reaches the
    // agent as message traffic (channel events + the runner's
    // `context_refresh` re-briefs) instead.
    const packet = composeInstructions({
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
          outcomeVersion: 1,
          amendments: [],
        },
      ],
      processDocument: null,
    });
    // openObjectives surfaces on the response body for non-packet callers.
    expect(packet.openObjectives).toHaveLength(1);
    expect(packet.openObjectives[0]?.id).toBe('obj-1');
    // But the ID / title / outcome never land in the prose.
    expect(packet.instructions).not.toContain('obj-1');
    expect(packet.instructions).not.toContain('Fix the login redirect bug');
    expect(packet.instructions).not.toContain('Objectives on your plate');
  });

  it('teaches the objective mechanism in instructions regardless of current plate', () => {
    const packet = composeInstructions({
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
      processDocument: null,
    });
    expect(packet.instructions).toContain('── Objectives ──');
    expect(packet.instructions).toContain('kind="objective"');
    expect(packet.instructions).toContain('objectives_list');
    expect(packet.instructions).toContain('objectives_discuss');
    expect(packet.instructions).toContain('objectives_update');
    expect(packet.instructions).toContain('objectives_complete');
    expect(packet.instructions).toContain('required `outcome`');
    // objectives_update is state-transitions only — the prose must not
    // teach a `note=` parameter the tool rejects (regression: it used
    // to, and the first progress report of every session burned a
    // failed call).
    expect(packet.instructions).not.toContain('note=');
    // No stale promise of live tool descriptions — state freshness
    // comes from message traffic, not tool metadata.
    expect(packet.instructions).not.toContain('tool description refreshes');
  });

  it('teaches all three channel thread types and the context_refresh re-brief', () => {
    const packet = composeInstructions({
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
      processDocument: null,
    });
    expect(packet.instructions).toContain('thread="primary"');
    expect(packet.instructions).toContain('thread="dm"');
    expect(packet.instructions).toContain('thread="channel"');
    expect(packet.instructions).toContain('channel_slug');
    expect(packet.instructions).toContain('channels_post');
    expect(packet.instructions).toContain('context_refresh');
  });
});
