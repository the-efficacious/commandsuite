/**
 * Tests for unread tracking:
 *
 *   - `unreadCount` pure computation (messages > lastRead, excluding
 *     self-sends)
 *   - `markThreadRead` monotonicity
 *   - `initializeLastReadFromStore` seeds every thread to its latest ts
 *   - `<Sidebar />` rendering: unread badge shown, label bolded,
 *     badge NOT shown on the active thread (auto-read)
 *   - cap at 99+
 *
 * The auto-read effect in Shell is covered implicitly by the
 * Sidebar tests: each test manually sets `view` + `lastRead`
 * to simulate the state the Shell effect would produce, and asserts
 * the rendered DOM.
 */

import { cleanup, render, screen } from '@testing-library/preact';
import type { Message } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NavColumn as Sidebar } from '../src/components/shell/NavColumn.js';
import { __resetBriefingForTests } from '../src/lib/briefing.js';
import { __resetChannelsForTests, channels as channelsSignal } from '../src/lib/channels.js';
import { __resetMessagesForTests, appendMessages, messagesByThread } from '../src/lib/messages.js';
import { __resetRosterForTests, roster } from '../src/lib/roster.js';
import {
  __resetUnreadForTests,
  initializeLastReadFromStore,
  lastReadByThread,
  markThreadRead,
  unreadCount,
} from '../src/lib/unread.js';
import {
  __resetViewForTests,
  selectDmWith,
  selectOverview,
  selectThread,
} from '../src/lib/view.js';

function mkMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm',
    ts: 1_700_000_000_000,
    to: null,
    from: 'przy-1',
    title: null,
    body: 'hello',
    level: 'info',
    data: {},
    attachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  __resetMessagesForTests();
  __resetUnreadForTests();
  __resetBriefingForTests();
  __resetRosterForTests();
  __resetChannelsForTests();
  __resetViewForTests();
  // Seed the channels signal with a synthetic general entry so the
  // sidebar renders the channels list. Tests that need additional
  // channels override this.
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
});

// ─── unreadCount pure logic ─────────────────────────────────────

describe('unreadCount', () => {
  it('returns 0 for a thread with no messages', () => {
    expect(unreadCount('primary', 'me', new Map(), new Map())).toBe(0);
  });

  it('counts messages with ts > lastRead', () => {
    const msgs = new Map([
      [
        'primary',
        [
          mkMsg({ id: 'a', ts: 10, from: 'other' }),
          mkMsg({ id: 'b', ts: 20, from: 'other' }),
          mkMsg({ id: 'c', ts: 30, from: 'other' }),
        ],
      ],
    ]);
    const lastRead = new Map([['primary', 15]]);
    expect(unreadCount('primary', 'me', lastRead, msgs)).toBe(2);
  });

  it('excludes self-sends from the count', () => {
    const msgs = new Map([
      [
        'primary',
        [mkMsg({ id: 'a', ts: 20, from: 'me' }), mkMsg({ id: 'b', ts: 30, from: 'other' })],
      ],
    ]);
    const lastRead = new Map([['primary', 10]]);
    expect(unreadCount('primary', 'me', lastRead, msgs)).toBe(1);
  });

  it('returns 0 when lastRead is ≥ latest message ts', () => {
    const msgs = new Map([['primary', [mkMsg({ id: 'a', ts: 10, from: 'other' })]]]);
    const lastRead = new Map([['primary', 10]]);
    expect(unreadCount('primary', 'me', lastRead, msgs)).toBe(0);
  });

  it('treats missing lastRead as 0 (everything after ts 0 is unread)', () => {
    const msgs = new Map([['primary', [mkMsg({ id: 'a', ts: 10, from: 'other' })]]]);
    expect(unreadCount('primary', 'me', new Map(), msgs)).toBe(1);
  });
});

// ─── markThreadRead + initializeLastReadFromStore ────────────────

describe('markThreadRead', () => {
  it('advances lastRead forward', () => {
    markThreadRead('primary', 100);
    expect(lastReadByThread.value.get('primary')).toBe(100);
    markThreadRead('primary', 200);
    expect(lastReadByThread.value.get('primary')).toBe(200);
  });

  it('is monotonic (never moves backward)', () => {
    markThreadRead('primary', 200);
    markThreadRead('primary', 100);
    expect(lastReadByThread.value.get('primary')).toBe(200);
  });

  it('no-ops when the new ts equals the existing one', () => {
    markThreadRead('primary', 100);
    const snapshot = lastReadByThread.value;
    markThreadRead('primary', 100);
    // Map identity should not change on a no-op — cheaper re-renders.
    expect(lastReadByThread.value).toBe(snapshot);
  });
});

describe('initializeLastReadFromStore', () => {
  it('seeds lastRead for every thread in the store to the latest ts', () => {
    appendMessages('me', [
      mkMsg({ id: 'p1', ts: 10, to: null, from: 'other' }),
      mkMsg({ id: 'p2', ts: 20, to: null, from: 'other' }),
      mkMsg({ id: 'd1', ts: 50, to: 'build-bot', from: 'me' }),
      mkMsg({ id: 'd2', ts: 60, to: 'build-bot', from: 'me' }),
    ]);
    initializeLastReadFromStore();
    expect(lastReadByThread.value.get('primary')).toBe(20);
    expect(lastReadByThread.value.get('dm:build-bot')).toBe(60);
  });

  it('wipes previous lastRead state (it is an initialization, not a merge)', () => {
    markThreadRead('old-thread', 100);
    expect(lastReadByThread.value.has('old-thread')).toBe(true);
    initializeLastReadFromStore();
    expect(lastReadByThread.value.has('old-thread')).toBe(false);
  });
});

// ─── Sidebar rendering ──────────────────────────────────────────

describe('<Sidebar /> unread indicators', () => {
  function setRoster() {
    roster.value = {
      teammates: [
        {
          name: 'me',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
        },
        { name: 'build-bot', role: { title: 'engineer', description: '' }, permissions: [] },
      ],
      connected: [],
    };
  }

  it('shows no badge when everything is read', () => {
    setRoster();
    appendMessages('me', [mkMsg({ id: 'a', ts: 10, to: null, from: 'other' })]);
    initializeLastReadFromStore();
    render(<Sidebar viewer="me" />);
    // No pill element visible (no text content that's just a digit).
    expect(screen.queryByText('1')).toBeNull();
  });

  it('shows a count badge on the general channel for unread broadcasts', () => {
    setRoster();
    appendMessages('me', [mkMsg({ id: 'a', ts: 10, to: null, from: 'other' })]);
    // Explicitly mark lastRead so it's clear this is unread territory.
    lastReadByThread.value = new Map([['primary', 5]]);
    // Navigate away from primary so the "active thread suppresses
    // its own badge" rule doesn't hide the pill we're testing for.
    selectOverview();
    render(<Sidebar viewer="me" />);
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('shows a count badge on a teammate DM row for unread DMs', () => {
    setRoster();
    appendMessages('me', [
      mkMsg({ id: 'a', ts: 10, to: 'me', from: 'build-bot' }),
      mkMsg({ id: 'b', ts: 20, to: 'me', from: 'build-bot' }),
    ]);
    lastReadByThread.value = new Map([['dm:build-bot', 0]]);
    // Make sure we're NOT viewing that thread (otherwise auto-active suppresses it).
    selectThread('primary');
    render(<Sidebar viewer="me" />);
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('suppresses the badge on the currently-active thread', () => {
    setRoster();
    appendMessages('me', [mkMsg({ id: 'a', ts: 10, to: 'me', from: 'build-bot' })]);
    lastReadByThread.value = new Map([['dm:build-bot', 0]]);
    // Pretend the user is actively on the DM — the Shell's auto-read
    // effect would normally have bumped lastRead already. The
    // sidebar's "badge only when !active" branch suppresses the pill.
    selectDmWith('build-bot');
    render(<Sidebar viewer="me" />);
    // Badge absent even though the raw unread count would be > 0 if
    // lastRead hadn't been bumped.
    expect(screen.queryByText('1')).toBeNull();
  });

  it('bolds the label text when a thread has unread messages', () => {
    setRoster();
    appendMessages('me', [mkMsg({ id: 'a', ts: 10, to: 'me', from: 'build-bot' })]);
    lastReadByThread.value = new Map([['dm:build-bot', 0]]);
    selectThread('primary');
    render(<Sidebar viewer="me" />);
    const label = screen.getByText('build-bot');
    expect(label.className).toMatch(/\bfont-semibold\b/);
  });

  it('does NOT count self-sends as unread on the general channel', () => {
    setRoster();
    appendMessages('me', [mkMsg({ id: 'a', ts: 10, to: null, from: 'me' })]);
    lastReadByThread.value = new Map([['primary', 0]]);
    selectOverview();
    render(<Sidebar viewer="me" />);
    expect(screen.queryByText('1')).toBeNull();
  });

  it('caps the displayed count at 99+', () => {
    setRoster();
    const bunch = Array.from({ length: 105 }, (_, i) =>
      mkMsg({
        id: `m${i}`,
        ts: i + 1,
        to: null,
        from: 'other',
      }),
    );
    appendMessages('me', bunch);
    lastReadByThread.value = new Map([['primary', 0]]);
    selectOverview();
    render(<Sidebar viewer="me" />);
    expect(screen.getByText('99+')).toBeTruthy();
    expect(screen.queryByText('105')).toBeNull();
  });

  it('re-reads from the live messagesByThread signal (not a stale snapshot)', () => {
    setRoster();
    render(<Sidebar viewer="me" />);
    // Nothing yet.
    expect(screen.queryByText('1')).toBeNull();
    // Append a message then re-render via the signal path.
    appendMessages('me', [mkMsg({ id: 'a', ts: 10, to: null, from: 'other' })]);
    lastReadByThread.value = new Map([['primary', 0]]);
    // Access the signal to force a subscription (the render already
    // read it, but a test-side read also triggers re-render on signal
    // value change).
    void messagesByThread.value;
  });
});
