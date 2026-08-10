import type { Member, Team, Teammate } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { composeInstructions, instructionCaptureExemptions } from '../src/instructions.js';

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
      processDocument: null,
    };
    const personalBlock = ALPHA_1.instructions;
    const composedWithoutPersonal = composeInstructions(input).instructions.replace(
      personalBlock,
      '',
    );

    expect(instructionCaptureExemptions(input, composedWithoutPersonal)).not.toContain(
      personalBlock,
    );
  });

  it('includes name, role, permissions, team, and teammates', () => {
    const packet = composeInstructions({
      self: DIRECTOR,
      team: TEAM,
      teammates: TEAMMATES,
      processDocument: null,
    });
    expect(packet.name).toBe('director-1');
    expect(packet.role.title).toBe('director');
    expect(packet.permissions).toContain('members.manage');
    expect(packet.team).toEqual(TEAM);
    expect(packet.teammates).toEqual(TEAMMATES);
  });

  it('renders complementary instructions that reference team context', () => {
    const packet = composeInstructions({
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
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
      processDocument: null,
    });
    expect(packet.instructions).not.toContain('Personal instructions:');
  });

  it('notes that the link suppresses self-echoes on the live stream', () => {
    const packet = composeInstructions({
      self: ENGINEER_2,
      team: TEAM,
      teammates: TEAMMATES,
      processDocument: null,
    });
    expect(packet.instructions).toContain('Your own sends are suppressed by the link');
  });

  /**
   * The spine section is short by design and carries exactly three
   * things a frozen prompt has to hold: where to go when context is
   * gone, the one gate that refuses rather than warns, and that talking
   * is free. Each is asserted by the string a member reads, because the
   * prose IS the deliverable here — a section that composed correctly
   * and said none of these would pass any structural check.
   */
  it('teaches the spine: the recovery call, the citation rule, and the cheap surface', () => {
    const packet = composeInstructions({
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      processDocument: null,
    });
    expect(packet.instructions).toContain('── Spine ──');

    // The recovery call, named as such, with the trigger that matters.
    expect(packet.instructions).toContain('`orient` is the recovery call');
    // The curator's half: a member who does not know that acts naming
    // them arrive on their own will poll, which is the behaviour the
    // whole class-1 machinery exists to make unnecessary.
    expect(packet.instructions).toContain('reaches you unbidden');
    expect(packet.instructions).toContain('You never have to poll');
    expect(packet.instructions).toMatch(/after a restart or compaction/);
    expect(packet.instructions).toMatch(/Guessing costs more than the call/);

    // The citation rule, in one sentence, including both exits and the
    // anti-confabulation wording the refusal itself uses.
    expect(packet.instructions).toMatch(/An ask scoped to a subject or a contract binds you/);
    expect(packet.instructions).toMatch(/record a `proceed` past it/);
    expect(packet.instructions).toMatch(/you do not have a ruling/);
    expect(packet.instructions).toMatch(/Proceeding is legitimate/);
    // The ruling exit stated truthfully: a ruling RESOLVES its ask, so
    // there is no citation step left to perform, and the prose must
    // not instruct one.
    expect(packet.instructions).toMatch(/Getting the ruling releases you on its own/);
    expect(packet.instructions).not.toMatch(/cite a ruling on it/);
    // And that a redirect is not an answer — the moment a member is
    // most likely to believe they have been released.
    expect(packet.instructions).toMatch(/A redirect does NOT release you/);

    // The cheap surface, and the promotion path off it.
    expect(packet.instructions).toContain('`discuss` is the cheap surface');
    expect(packet.instructions).toMatch(/`promote` turns it into the typed event/);

    // And the precondition, which is the field agents will otherwise
    // omit and then guess at.
    expect(packet.instructions).toContain('expected_state_rev');
    expect(packet.instructions).toMatch(/returns the events you missed IN FULL/);
  });

  it('teaches the spine and NOTHING about objectives — the cut-over', () => {
    // This test used to hold both sections present and in order, while
    // the two surfaces ran side by side. The cut-over is that phase,
    // so it now holds the spine section ALONE.
    //
    // The negative half is the load-bearing half and it is asserted on
    // the composed string rather than on the source: an agent's whole
    // model of the team comes from this prose, and a leftover sentence
    // teaching a tool that no longer exists spends the first call of
    // every session on a refusal.
    const packet = composeInstructions({
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      processDocument: null,
    });
    expect(packet.instructions).toContain('── Spine ──');
    expect(packet.instructions).not.toContain('── Objectives ──');
    expect(packet.instructions).not.toContain('objectives_');
    expect(packet.instructions.toLowerCase()).not.toContain('objective');
  });

  it('teaches all three channel thread types, and no re-brief that no longer fires', () => {
    const packet = composeInstructions({
      self: ALPHA_1,
      team: TEAM,
      teammates: TEAMMATES,
      processDocument: null,
    });
    expect(packet.instructions).toContain('thread="primary"');
    expect(packet.instructions).toContain('thread="dm"');
    expect(packet.instructions).toContain('thread="channel"');
    expect(packet.instructions).toContain('channel_slug');
    expect(packet.instructions).toContain('channels_post');
    // The `context_refresh` re-brief was the runner recomposing the
    // open-objectives plate and pushing it. It went with the
    // subsystem, and `orient` — which the spine section teaches —
    // replaced it. Promising a block that will never arrive teaches an
    // agent to wait for one.
    expect(packet.instructions).not.toContain('context_refresh');
  });
});
