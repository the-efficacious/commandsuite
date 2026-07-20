/**
 * Component-level tests for the Phase 5 shell: Transcript, Sidebar,
 * Composer, and a minimal Shell mount path. We stub `globalThis.fetch`
 * so the real SDK client runs end-to-end (response validation + URL
 * construction are part of the coverage).
 *
 * We stub `WebSocket` globally so Shell's `startSubscribe` effect has
 * a constructor to call in happy-dom (which doesn't ship one). The
 * stub is inert — it never fires open/message events — so these
 * tests only exercise the signal-driven view, not the live stream.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { Client } from 'csuite-sdk/client';
import type { Message } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetComposerForTests, Composer } from '../src/components/Composer.js';
import { NavColumn as Sidebar } from '../src/components/shell/NavColumn.js';
import { TeamHome } from '../src/components/TeamHome.js';
import { Transcript } from '../src/components/Transcript.js';
import { __resetBriefingForTests, briefing } from '../src/lib/briefing.js';
import { __resetChannelsForTests, channels as channelsSignal } from '../src/lib/channels.js';
import { __resetClientForTests, setClient } from '../src/lib/client.js';
import { __resetIdentityForTests, identity } from '../src/lib/identity.js';
import { __resetLiveForTests } from '../src/lib/live.js';
import { __resetMessagesForTests, appendMessages } from '../src/lib/messages.js';
import { __resetRosterForTests, roster } from '../src/lib/roster.js';
import {
  __resetViewForTests,
  selectDmWith,
  selectOverview,
  selectThread,
  view,
} from '../src/lib/view.js';

const originalFetch = globalThis.fetch;

// Mock WebSocket so Shell's `startSubscribe` effect has a constructor
// to call. happy-dom ships no real WebSocket; we want these tests
// insensitive to network details, so the stub is deliberately inert —
// it never fires open/message/close so the subscribe effect just
// sits there doing nothing while the rest of the component renders.
class MockWebSocket {
  url: string;
  protocol = '';
  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSING = 2 as const;
  readonly CLOSED = 3 as const;
  readyState: 0 | 1 | 2 | 3 = 0;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(_type: string, _listener: EventListener): void {}
  removeEventListener(_type: string, _listener: EventListener): void {}
  close(): void {
    this.readyState = 3;
  }
  send(_data: string): void {}
  dispatchEvent(_event: Event): boolean {
    return true;
  }
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSING = 2 as const;
  static readonly CLOSED = 3 as const;
}
// biome-ignore lint/suspicious/noExplicitAny: happy-dom WebSocket shim for tests
(globalThis as any).WebSocket = MockWebSocket;

beforeEach(() => {
  identity.value = {
    member: 'director-1',
    role: { title: 'director', description: '' },
    permissions: ['members.manage'],
    expiresAt: 9_999_999_999_999,
  };
  __resetMessagesForTests();
  __resetBriefingForTests();
  __resetRosterForTests();
  __resetLiveForTests();
  __resetChannelsForTests();
  __resetViewForTests();
  __resetClientForTests();
  __resetComposerForTests();
  // Seed a synthetic general channel so the sidebar's channels list
  // has the well-known default. Tests that need additional channels
  // override this in their setup.
  channelsSignal.value = [
    {
      id: 'general',
      slug: 'general',
      createdBy: '__system__',
      createdAt: 0,
      archivedAt: null,
      joined: true,
      myRole: 'member',
      memberCount: 0,
    },
  ];
});

afterEach(() => {
  cleanup();
  __resetIdentityForTests();
  globalThis.fetch = originalFetch;
});

function stubFetch(
  routes: Record<string, (init: RequestInit) => { status: number; body: unknown }>,
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.includes(suffix)) {
        const { status, body } = handler(init);
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
    }
    return Promise.resolve(new Response('no route', { status: 500 }));
  }) as typeof fetch;
  // Build the SDK client AFTER the fetch stub is in place — the
  // client captures the current `globalThis.fetch` at construction.
  setClient(new Client({ url: 'http://localhost', useCookies: true }));
}

function mkMsg(overrides: Partial<Message>): Message {
  return {
    id: 'm1',
    ts: 1_700_000_000_000,
    to: null,
    from: 'build-bot',
    title: null,
    body: 'hello',
    level: 'info',
    data: {},
    attachments: [],
    ...overrides,
  };
}

describe('<Transcript />', () => {
  it('renders the empty-state placeholder when a thread has no messages', () => {
    render(<Transcript viewer="director-1" />);
    expect(screen.getByText(/net is quiet/i)).toBeTruthy();
  });

  it('renders messages from the current thread', () => {
    appendMessages('director-1', [
      mkMsg({ id: 'a', ts: 1_700_000_000_000, body: 'first' }),
      mkMsg({ id: 'b', ts: 1_700_000_000_500, body: 'second' }),
    ]);
    render(<Transcript viewer="director-1" />);
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText('second')).toBeTruthy();
  });

  it('switches threads when the view signal changes', async () => {
    appendMessages('director-1', [
      mkMsg({ id: 'p', ts: 1, body: 'primary msg' }),
      mkMsg({ id: 'd', ts: 2, to: 'build-bot', from: 'director-1', body: 'dm msg' }),
    ]);
    const { rerender } = render(<Transcript viewer="director-1" />);
    expect(screen.getByText('primary msg')).toBeTruthy();

    selectThread('dm:build-bot');
    rerender(<Transcript viewer="director-1" />);
    await waitFor(() => {
      expect(screen.getByText('dm msg')).toBeTruthy();
    });
  });
});

describe('<Sidebar />', () => {
  function setRoster(connected: Record<string, number> = {}) {
    roster.value = {
      teammates: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
        },
        { name: 'build-bot', role: { title: 'engineer', description: '' }, permissions: [] },
        { name: 'test-agent-1', role: { title: 'watcher', description: '' }, permissions: [] },
      ],
      connected: Object.entries(connected).map(([name, count]) => ({
        name,
        connected: count,
        createdAt: 0,
        lastSeen: 0,
        role: null,
      })),
    };
  }

  it('shows the general channel even when roster is still loading', () => {
    render(<Sidebar viewer="director-1" />);
    expect(screen.getByText('general')).toBeTruthy();
  });

  it('lists every teammate from the roster (excluding the viewer as a DM row)', () => {
    setRoster();
    render(<Sidebar viewer="director-1" />);
    expect(screen.getByText('build-bot')).toBeTruthy();
    expect(screen.getByText('test-agent-1')).toBeTruthy();
    // Self is filtered out of the DM list (no "Message director-1" button).
    expect(screen.queryByRole('button', { name: /message director-1/i })).toBeNull();
    // Viewer still appears in the UserChip footer — but that's a
    // profile button, not a DM entry.
    // Identity affordance is the gear-iconed Account button in the
    // navcol footer (post-modalization). The avatar+name UserChip
    // it replaced has no equivalent surface anymore.
    expect(screen.getByRole('button', { name: /account settings/i })).toBeTruthy();
  });

  it('does NOT use @ prefix on teammate rows', () => {
    setRoster();
    render(<Sidebar viewer="director-1" />);
    expect(screen.queryByText('@build-bot')).toBeNull();
    expect(screen.getByText('build-bot')).toBeTruthy();
  });

  it('clicking a teammate opens a DM thread', async () => {
    setRoster();
    render(<Sidebar viewer="director-1" />);
    fireEvent.click(screen.getByText('build-bot'));
    await waitFor(() => {
      expect(view.value).toEqual({ kind: 'thread', key: 'dm:build-bot' });
    });
  });

  it('clicking the general channel selects the primary thread', async () => {
    setRoster();
    selectDmWith('build-bot');
    render(<Sidebar viewer="director-1" />);
    fireEvent.click(screen.getByText('general'));
    await waitFor(() => {
      expect(view.value).toEqual({
        kind: 'thread',
        key: 'primary',
        channelSlug: 'general',
      });
    });
  });

  it('active teammate row marks itself active', () => {
    setRoster();
    selectDmWith('build-bot');
    render(<Sidebar viewer="director-1" />);
    const btn = screen.getByText('build-bot').closest('button');
    // Active state is now communicated via the canonical `.navitem.active`
    // class (ice background + steel inset edge, defined in theme.css).
    expect(btn?.className).toMatch(/\bactive\b/);
  });

  it('renders online dot for connected teammates and muted dot for offline', () => {
    setRoster({ 'build-bot': 2 });
    render(<Sidebar viewer="director-1" />);
    const onlineBtn = screen.getByLabelText(/Message build-bot \(online\)/i);
    const offlineBtn = screen.getByLabelText(/Message test-agent-1 \(offline\)/i);
    expect(onlineBtn).toBeTruthy();
    expect(offlineBtn).toBeTruthy();
  });

  it('online indicator is a filled circle, offline is muted', () => {
    setRoster({ 'build-bot': 1 });
    render(<Sidebar viewer="director-1" />);
    // .dot.ok = online (steel fill via theme.css);
    // .dot.muted = offline (frost fill via theme.css).
    const onlineBtn = screen.getByLabelText(/Message build-bot \(online\)/i);
    const offlineBtn = screen.getByLabelText(/Message test-agent-1 \(offline\)/i);
    expect(onlineBtn.querySelector('.dot.ok')).toBeTruthy();
    expect(offlineBtn.querySelector('.dot.muted')).toBeTruthy();
  });

  it('renders a working spinner when a teammate is busy', () => {
    // Helper sets connected counts; busy comes from a custom roster.
    roster.value = {
      teammates: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
        },
        { name: 'build-bot', role: { title: 'engineer', description: '' }, permissions: [] },
        { name: 'test-agent-1', role: { title: 'watcher', description: '' }, permissions: [] },
      ],
      connected: [
        {
          name: 'build-bot',
          connected: 1,
          createdAt: 0,
          lastSeen: 0,
          role: null,
          busy: true,
        },
        {
          name: 'test-agent-1',
          connected: 1,
          createdAt: 0,
          lastSeen: 0,
          role: null,
        },
      ],
    };
    render(<Sidebar viewer="director-1" />);
    const busyBtn = screen.getByLabelText(/Message build-bot \(working\)/i);
    expect(busyBtn).toBeTruthy();
    expect(busyBtn.querySelector('.spinner')).toBeTruthy();
    // The non-busy online teammate stays a dot, no spinner.
    const idleBtn = screen.getByLabelText(/Message test-agent-1 \(online\)/i);
    expect(idleBtn.querySelector('.spinner')).toBeNull();
  });

  it('omits the spinner when busy is absent or false', () => {
    setRoster({ 'build-bot': 1 });
    render(<Sidebar viewer="director-1" />);
    const onlineBtn = screen.getByLabelText(/Message build-bot \(online\)/i);
    expect(onlineBtn.querySelector('.spinner')).toBeNull();
  });

  it('renders a "needs input" attention badge when a teammate is blocked', () => {
    roster.value = {
      teammates: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
        },
        { name: 'build-bot', role: { title: 'engineer', description: '' }, permissions: [] },
        { name: 'test-agent-1', role: { title: 'watcher', description: '' }, permissions: [] },
      ],
      connected: [
        {
          name: 'build-bot',
          connected: 1,
          createdAt: 0,
          lastSeen: 0,
          role: null,
          activity: 'blocked',
        },
        {
          name: 'test-agent-1',
          connected: 1,
          createdAt: 0,
          lastSeen: 0,
          role: null,
          activity: 'working',
        },
      ],
    };
    render(<Sidebar viewer="director-1" />);
    // Blocked → amber badge, a11y label "needs input", NOT a spinner.
    const blockedBtn = screen.getByLabelText(/Message build-bot \(needs input\)/i);
    expect(blockedBtn).toBeTruthy();
    expect(blockedBtn.querySelector('.spinner')).toBeNull();
    expect(blockedBtn.querySelector('.badge.ember')).toBeTruthy();
    expect(blockedBtn.querySelector('[aria-label="needs input"]')).toBeTruthy();
    // Working teammate keeps the spinner and shows no needs-input badge.
    const workingBtn = screen.getByLabelText(/Message test-agent-1 \(working\)/i);
    expect(workingBtn.querySelector('.spinner')).toBeTruthy();
    expect(workingBtn.querySelector('.badge.ember')).toBeNull();
  });

  it('prefers the 3-state activity field over the back-compat busy boolean', () => {
    // A server that reports activity: 'blocked' with busy omitted must
    // render as blocked (not idle) — the new field is authoritative.
    roster.value = {
      teammates: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
        },
        { name: 'build-bot', role: { title: 'engineer', description: '' }, permissions: [] },
      ],
      connected: [
        {
          name: 'build-bot',
          connected: 1,
          createdAt: 0,
          lastSeen: 0,
          role: null,
          activity: 'blocked',
        },
      ],
    };
    render(<Sidebar viewer="director-1" />);
    expect(screen.getByLabelText(/Message build-bot \(needs input\)/i)).toBeTruthy();
  });

  it('renders neither spinner nor badge for an idle (connected) teammate', () => {
    roster.value = {
      teammates: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
        },
        { name: 'build-bot', role: { title: 'engineer', description: '' }, permissions: [] },
      ],
      connected: [
        {
          name: 'build-bot',
          connected: 1,
          createdAt: 0,
          lastSeen: 0,
          role: null,
          activity: 'idle',
        },
      ],
    };
    render(<Sidebar viewer="director-1" />);
    const idleBtn = screen.getByLabelText(/Message build-bot \(online\)/i);
    expect(idleBtn.querySelector('.spinner')).toBeNull();
    expect(idleBtn.querySelector('.badge.ember')).toBeNull();
    expect(idleBtn.querySelector('.dot.ok')).toBeTruthy();
  });

  it('falls back to briefing teammates when roster is still null (cold start)', () => {
    briefing.value = {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      team: { name: 'alpha', directive: 'ship', context: '', permissionPresets: {} },
      teammates: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
        },
        { name: 'build-bot', role: { title: 'engineer', description: '' }, permissions: [] },
      ],
      openObjectives: [],
      toolSources: [],
      instructions: '',
    };
    // roster.value stays null from beforeEach reset.
    render(<Sidebar viewer="director-1" />);
    expect(screen.getByText('build-bot')).toBeTruthy();
    // With roster null, build-bot is shown as offline (we don't know yet).
    expect(screen.getByLabelText(/Message build-bot \(offline\)/i)).toBeTruthy();
  });
});

describe('<Composer />', () => {
  it('sends a broadcast on Enter when the primary thread is active', async () => {
    stubFetch({
      '/push': () => ({
        status: 200,
        body: {
          delivery: { live: 0, targets: 0 },
          message: {
            id: 'echo',
            ts: 1,
            to: null,
            from: 'director-1',
            title: null,
            body: 'ping',
            level: 'info',
            data: {},
          },
        },
      }),
    });
    render(<Composer viewer="director-1" />);
    const textarea = screen.getByPlaceholderText(/reply to #general/i) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'ping' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(textarea.value).toBe('');
    });
  });

  it('disables send when draft is empty', () => {
    render(<Composer viewer="director-1" />);
    const button = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('sends a DM to the selected counterparty when in a dm thread', async () => {
    const seen: RequestInit[] = [];
    stubFetch({
      '/push': (init) => {
        seen.push(init);
        return {
          status: 200,
          body: {
            delivery: { live: 0, targets: 0 },
            message: {
              id: 'echo',
              ts: 1,
              name: 'build-bot',
              from: 'director-1',
              title: null,
              body: 'hey',
              level: 'info',
              data: {},
            },
          },
        };
      },
    });
    selectThread('dm:build-bot');
    render(<Composer viewer="director-1" />);
    const textarea = screen.getByPlaceholderText(/reply to @build-bot/i) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'hey' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    const body = JSON.parse(seen[0]?.body as string) as { to?: string; body: string };
    expect(body.to).toBe('build-bot');
    expect(body.body).toBe('hey');
  });
});

describe('<TeamHome />', () => {
  it('shows loading state until briefing + roster populated', () => {
    render(<TeamHome viewer="director-1" />);
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it('marks teammates as online when connected count > 0', async () => {
    briefing.value = {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      team: { name: 'demo-team', directive: '', context: '', permissionPresets: {} },
      teammates: [],
      openObjectives: [],
      toolSources: [],
      instructions: '',
    };
    roster.value = {
      teammates: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
        },
        { name: 'build-bot', role: { title: 'engineer', description: '' }, permissions: [] },
      ],
      connected: [
        {
          name: 'build-bot',
          connected: 1,
          createdAt: 0,
          lastSeen: 0,
          role: { title: 'engineer', description: '' },
        },
      ],
    };
    render(<TeamHome viewer="director-1" />);
    await waitFor(() => {
      expect(screen.getByText(/ONLINE/)).toBeTruthy();
      expect(screen.getByText(/OFFLINE/)).toBeTruthy();
    });
  });

  it('renders the three activity states distinctly on the roster', async () => {
    briefing.value = {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      team: { name: 'demo-team', directive: '', context: '', permissionPresets: {} },
      teammates: [],
      openObjectives: [],
      toolSources: [],
      instructions: '',
    };
    roster.value = {
      teammates: [
        { name: 'worker-bot', role: { title: 'engineer', description: '' }, permissions: [] },
        { name: 'stuck-bot', role: { title: 'engineer', description: '' }, permissions: [] },
        { name: 'idle-bot', role: { title: 'engineer', description: '' }, permissions: [] },
      ],
      connected: [
        {
          name: 'worker-bot',
          connected: 1,
          createdAt: 0,
          lastSeen: 0,
          role: null,
          activity: 'working',
        },
        {
          name: 'stuck-bot',
          connected: 1,
          createdAt: 0,
          lastSeen: 0,
          role: null,
          activity: 'blocked',
        },
        { name: 'idle-bot', connected: 1, createdAt: 0, lastSeen: 0, role: null, activity: 'idle' },
      ],
    };
    render(<TeamHome viewer="director-1" />);
    await waitFor(() => {
      expect(screen.getByText('WORKING')).toBeTruthy();
      expect(screen.getByText('NEEDS INPUT')).toBeTruthy();
      // Idle-but-connected still reads ONLINE via the connection dimension.
      expect(screen.getByText('ONLINE')).toBeTruthy();
    });

    const workingRow = screen.getByRole('button', { name: /open profile for worker-bot/i });
    expect(workingRow.querySelector('.spinner')).toBeTruthy();

    const blockedRow = screen.getByRole('button', { name: /open profile for stuck-bot/i });
    // Blocked → amber attention dot (.dot.warn), no spinner.
    expect(blockedRow.querySelector('.spinner')).toBeNull();
    expect(blockedRow.querySelector('.dot.warn')).toBeTruthy();

    const idleRow = screen.getByRole('button', { name: /open profile for idle-bot/i });
    expect(idleRow.querySelector('.spinner')).toBeNull();
    expect(idleRow.querySelector('.dot.warn')).toBeNull();
    expect(idleRow.querySelector('.dot.ok')).toBeTruthy();
  });

  it('clicking a teammate opens their profile', async () => {
    briefing.value = {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      team: { name: 'demo-team', directive: '', context: '', permissionPresets: {} },
      teammates: [],
      openObjectives: [],
      toolSources: [],
      instructions: '',
    };
    roster.value = {
      teammates: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
        },
        { name: 'build-bot', role: { title: 'engineer', description: '' }, permissions: [] },
      ],
      connected: [],
    };
    render(<TeamHome viewer="director-1" />);
    const button = screen.getByRole('button', { name: /open profile for build-bot/i });
    fireEvent.click(button);
    await waitFor(() => {
      expect(view.value).toEqual({ kind: 'member-profile', name: 'build-bot', tab: 'overview' });
    });
  });

  it('self-row links to own profile too', () => {
    briefing.value = {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      team: { name: 'demo-team', directive: '', context: '', permissionPresets: {} },
      teammates: [],
      openObjectives: [],
      toolSources: [],
      instructions: '',
    };
    roster.value = {
      teammates: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
        },
        { name: 'build-bot', role: { title: 'engineer', description: '' }, permissions: [] },
      ],
      connected: [],
    };
    render(<TeamHome viewer="director-1" />);
    // Both rows are now buttons linking to profiles (hover card hosts the DM action).
    expect(screen.getByRole('button', { name: /open profile for director-1/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /open profile for build-bot/i })).toBeTruthy();
  });
});

describe('<Transcript /> empty state', () => {
  it('shows "net is quiet" for an empty primary thread', () => {
    selectThread('primary');
    render(<Transcript viewer="director-1" />);
    expect(screen.getByText(/net is quiet/i)).toBeTruthy();
  });

  it('shows a DM-specific empty state for a fresh DM thread', () => {
    selectThread('dm:build-bot');
    render(<Transcript viewer="director-1" />);
    expect(screen.getByText(/no messages yet with/i)).toBeTruthy();
    expect(screen.getByText('@build-bot')).toBeTruthy();
  });
});

describe('briefing bootstrap', () => {
  it('NavColumn reflects team + viewer identity from briefing', () => {
    briefing.value = {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      team: { name: 'demo-team', directive: 'ship', context: '', permissionPresets: {} },
      teammates: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
        },
      ],
      openObjectives: [],
      toolSources: [],
      instructions: '',
    };
    render(<Sidebar viewer="director-1" />);
    // Team name renders in the NavColumn team header.
    expect(screen.getByText('demo-team')).toBeTruthy();
    // Footer identity is the gear-iconed Account button (the legacy
    // avatar + viewer-name UserChip was retired in favor of a single
    // settings affordance).
    expect(screen.getByRole('button', { name: /account settings/i })).toBeTruthy();
  });
});

describe('<Sidebar /> overview button', () => {
  it('renders a single Overview button above the threads section', () => {
    render(<Sidebar viewer="director-1" />);
    const btn = screen.getByRole('button', { name: /open team home/i });
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/Home/);
  });

  it('clicking the overview button flips view to overview', async () => {
    render(<Sidebar viewer="director-1" />);
    fireEvent.click(screen.getByRole('button', { name: /open team home/i }));
    await waitFor(() => {
      expect(view.value).toEqual({ kind: 'overview' });
    });
  });

  it('overview button highlights when view is overview', () => {
    selectOverview();
    render(<Sidebar viewer="director-1" />);
    const btn = screen.getByRole('button', { name: /open team home/i });
    // Active state for the canonical .navitem is the "active" class
    // (theme.css applies bg-ink + text-paper + frost-tinted nums).
    expect(btn.className).toMatch(/\bactive\b/);
  });

  it('renders team name and viewer name in the NavColumn team header', () => {
    briefing.value = {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      team: {
        name: 'demo-team',
        directive: 'Ship the payment service.',
        context: '',
        permissionPresets: {},
      },
      teammates: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
        },
      ],
      openObjectives: [],
      toolSources: [],
      instructions: '',
    };
    render(<Sidebar viewer="director-1" />);
    // Top of the NavColumn shows the team name and the viewer's own
    // name underneath. The team directive is intentionally NOT here —
    // it's static, never personalized, and would just be repeated
    // chrome on every page; viewer name is the higher-signal anchor
    // for "you are signed in as _" recognition.
    expect(screen.getByText('demo-team')).toBeTruthy();
    expect(screen.getByText('director-1')).toBeTruthy();
  });
});

describe('<TeamHome /> directive header', () => {
  it('renders team name and directive at the top when briefing is set', () => {
    briefing.value = {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      team: {
        name: 'demo-team',
        directive: 'Ship the payment service.',
        context: 'Longer context about the operating window.',
        permissionPresets: {},
      },
      teammates: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
        },
      ],
      openObjectives: [],
      toolSources: [],
      instructions: '',
    };
    roster.value = {
      teammates: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
        },
      ],
      connected: [],
    };
    render(<TeamHome viewer="director-1" />);
    expect(screen.getByText('demo-team')).toBeTruthy();
    expect(screen.getByText('Ship the payment service.')).toBeTruthy();
    expect(screen.getByText(/operating window/)).toBeTruthy();
  });

  it('shows loading UI when briefing is null', () => {
    roster.value = {
      teammates: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
        },
      ],
      connected: [],
    };
    render(<TeamHome viewer="director-1" />);
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });
});

// Keep vi imported so we don't lose the "import vi" line if we add
// spies later — prevents a lint warning drifting in during Phase 6.
void vi;
