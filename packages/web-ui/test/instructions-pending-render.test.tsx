/**
 * Restart-pending and the team-process panel as they reach a human —
 * rendered, not helped. Same discipline as capture-health-render:
 * every deliverable here is a string on a screen, so every test
 * renders the real component and asserts the string.
 *
 * The pending fixtures keep the capture-health epistemics: an ABSENT
 * `restartPending` field is an older broker with no opinion, and the
 * UI stays quiet rather than asserting a state nobody evaluated.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { Client } from 'csuite-sdk/client';
import type { InstructionsResponse, ProcessDocument, RosterResponse } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetTeamHomeForTests, TeamHome } from '../src/components/TeamHome.js';
import { briefing } from '../src/lib/briefing.js';
import { __resetClientForTests, setClient } from '../src/lib/client.js';
import { objectives as objectivesSignal } from '../src/lib/objectives.js';
import { roster } from '../src/lib/roster.js';

const DOC: ProcessDocument = {
  text: 'Keep a conversation running before action.\nSquash-merge to main.',
  version: 3,
  createdBy: 'director-1',
  createdAt: 1,
  updatedBy: 'lea',
  updatedAt: 2,
};

function briefingWith(
  overrides: Partial<InstructionsResponse> = {},
): InstructionsResponse {
  return {
    name: 'director-1',
    role: { title: 'director', description: '' },
    permissions: ['members.manage', 'team.manage', 'process.manage'],
    team: { name: 'demo-team', context: 'Short context.', permissionPresets: {} },
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
    processDocument: DOC,
    instructions: '',
    ...overrides,
  };
}

function rosterWith(restartPending?: string[]): RosterResponse {
  const base = briefingWith();
  return {
    teammates: base.teammates,
    connected: [],
    ...(restartPending !== undefined ? { restartPending } : {}),
  };
}

beforeEach(() => {
  __resetClientForTests();
  __resetTeamHomeForTests();
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ activity: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof fetch;
  briefing.value = briefingWith();
  roster.value = rosterWith();
  objectivesSignal.value = [];
});

afterEach(() => {
  cleanup();
  briefing.value = null;
  roster.value = null;
  objectivesSignal.value = [];
});

describe('restart-pending on TeamHome', () => {
  it('renders the badge and the banner for a listed member', () => {
    roster.value = rosterWith(['turner']);
    render(<TeamHome viewer="director-1" />);

    expect(screen.getByText('RESTART PENDING')).toBeTruthy();
    expect(screen.getByText('Restart pending:')).toBeTruthy();
  });

  it('stays quiet when nothing is pending', () => {
    roster.value = rosterWith([]);
    render(<TeamHome viewer="director-1" />);

    expect(screen.queryByText('RESTART PENDING')).toBeNull();
    expect(screen.queryByText('Restart pending:')).toBeNull();
  });

  it('stays quiet when the broker has no opinion (field absent)', () => {
    roster.value = rosterWith(undefined);
    render(<TeamHome viewer="director-1" />);

    expect(screen.queryByText('RESTART PENDING')).toBeNull();
    expect(screen.queryByText('Restart pending:')).toBeNull();
  });
});

describe('the team process panel', () => {
  it('renders the document text with its version provenance', () => {
    render(<TeamHome viewer="director-1" />);

    expect(screen.getByText('Team process')).toBeTruthy();
    expect(screen.getByText('v3 · last edited by lea')).toBeTruthy();
    // Multi-line text: match the leaf element whose own content is the
    // exact document, since the default matcher normalizes newlines.
    expect(
      screen.getByText((_, el) => el?.textContent === DOC.text && el.children.length === 0),
    ).toBeTruthy();
  });

  it('offers creation to a process.manage holder when no document is set', () => {
    briefing.value = briefingWith({ processDocument: null });
    render(<TeamHome viewer="director-1" />);

    expect(screen.getByText('+ Add team process')).toBeTruthy();
  });

  it('renders nothing for a non-manager when no document is set', () => {
    briefing.value = briefingWith({
      processDocument: null,
      permissions: [],
    });
    render(<TeamHome viewer="director-1" />);

    expect(screen.queryByText('+ Add team process')).toBeNull();
    expect(screen.queryByText('Team process')).toBeNull();
  });

  it('says unavailable — not "no document" — when the broker omits the field', () => {
    // The three-state contract from the wire, kept through to the
    // screen: absent is an older broker, and claiming "no process"
    // for it would be the UI answering a question nobody evaluated.
    const b = briefingWith();
    delete (b as { processDocument?: unknown }).processDocument;
    briefing.value = b;
    render(<TeamHome viewer="director-1" />);

    expect(
      screen.getByText('Team process: unavailable — this broker does not report a process document.'),
    ).toBeTruthy();
    expect(screen.queryByText('+ Add team process')).toBeNull();
  });

  it('submits an edit as PUT /process-document with reason and disposition', async () => {
    const puts: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PUT') {
        puts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return new Response(
          JSON.stringify({
            document: { ...DOC, text: 'Revised process.', version: 4 },
            edit: {
              version: 4,
              ts: 3,
              actor: 'director-1',
              reason: 'tightened the merge rule',
              disposition: 'scope_change',
              fields: ['text'],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/instructions')) {
        return new Response(JSON.stringify(briefingWith()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ activity: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    // The shell normally injects the host's client; the panel reaches
    // it via getClient(), so the test provides one over the recording
    // fetch above.
    setClient(new Client({ url: 'http://broker.test', token: 'csuite_test_ui_token' }));

    render(<TeamHome viewer="director-1" />);
    fireEvent.click(screen.getByText('Edit process'));

    const textarea = screen.getByPlaceholderText(
      'How this team works — the process every member executes against.',
    );
    fireEvent.input(textarea, { target: { value: 'Revised process.' } });
    fireEvent.input(screen.getByPlaceholderText('Why this edit'), {
      target: { value: 'tightened the merge rule' },
    });
    const form = screen.getByText('Save').closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    // One macrotask for the async submit → PUT → reload chain.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The consumer is the broker; what it reads is this request.
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toContain('/process-document');
    expect(puts[0]?.body).toEqual({
      text: 'Revised process.',
      reason: 'tightened the merge rule',
      disposition: 'scope_change',
    });
  });
});

describe('standing prose clamps until opened', () => {
  const LONG = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of standing context.`).join(
    '\n',
  );

  it('clamps long team context and expands on demand', () => {
    briefing.value = briefingWith({
      team: { name: 'demo-team', context: LONG, permissionPresets: {} },
    });
    render(<TeamHome viewer="director-1" />);

    const prose = screen.getByText((_, el) => el?.textContent === LONG && el.tagName === 'DIV');
    expect(prose.getAttribute('style')).toContain('-webkit-line-clamp');

    const toggle = screen.getByText(`Show all (${LONG.length.toLocaleString()} chars)`);
    fireEvent.click(toggle);
    expect(prose.getAttribute('style')).not.toContain('-webkit-line-clamp');
    expect(screen.getByText('Collapse')).toBeTruthy();
  });

  it('renders short context whole, with no toggle', () => {
    render(<TeamHome viewer="director-1" />);

    expect(screen.getByText('Short context.')).toBeTruthy();
    expect(screen.queryByText(/Show all \(/)).toBeNull();
  });
});
