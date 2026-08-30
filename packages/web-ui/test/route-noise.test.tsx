/**
 * Two views that produced failed requests for a baseline member on the
 * kit's route walk (obj-mtfkktdr-7), fixed under obj-mtfo3k5f-b:
 *
 *   - #214: the DM view mounts the right-rail ActivityInspector for the
 *     peer, which opened the peer's activity WebSocket — a 403 handshake
 *     for anyone without `activity.read`, retried forever. The inspector
 *     now decides from the identity packet and renders "Restricted"
 *     without dialling.
 *   - #216: the Files root route carries `''`, which the panel sent as
 *     `/fs/ls?path=` — a 400 rendered as a bare "400". The panel now asks
 *     for `/`.
 *
 * Each negative has its positive control beside it.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { Client } from 'csuite-sdk/client';
import type { InstructionsResponse } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityInspector } from '../src/components/ActivityInspector.js';
import { __resetAgentTimelineForTests } from '../src/components/AgentTimeline.js';
import { FilesPanel } from '../src/components/FilesPanel.js';
import { NotificationDetail } from '../src/components/NotificationDetail.js';
import { NotificationsPanel } from '../src/components/NotificationsPanel.js';
import { __resetClientForTests, setClient } from '../src/lib/client.js';
import { instructions } from '../src/lib/instructions.js';
import { __resetMemberActivityForTests } from '../src/lib/member-activity.js';

const originalFetch = globalThis.fetch;
const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

class StubWebSocket {
  static instances: StubWebSocket[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    StubWebSocket.instances.push(this);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
  send(): void {}
}

const BASE: InstructionsResponse = {
  name: 'engineer-1',
  role: { title: 'engineer', description: '' },
  permissions: [],
  team: { name: 'demo-team', context: '', permissionPresets: {} },
  teammates: [
    {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['activity.read'],
    },
    { name: 'engineer-1', role: { title: 'engineer', description: '' }, permissions: [] },
  ],
  openObjectives: [],
  toolSources: [],
  processDocument: null,
  instructions: '',
};

let requested: string[] = [];

beforeEach(() => {
  __resetClientForTests();
  __resetMemberActivityForTests();
  __resetAgentTimelineForTests();
  requested = [];
  StubWebSocket.instances = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = StubWebSocket;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requested.push(
      new URL(url, 'http://localhost').pathname + new URL(url, 'http://localhost').search,
    );
    return Promise.resolve(
      new Response(JSON.stringify({ activity: [], entries: [], inferences: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  // The SDK binds fetch at construction: install the client after the stub.
  setClient(new Client({ url: 'http://localhost', useCookies: true }));
});

afterEach(() => {
  cleanup();
  instructions.value = null;
  __resetMemberActivityForTests();
  __resetAgentTimelineForTests();
  globalThis.fetch = originalFetch;
  if (originalWebSocket === undefined) delete (globalThis as { WebSocket?: unknown }).WebSocket;
  else (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
});

describe('ActivityInspector on a DM (#214)', () => {
  it('a baseline viewer gets "Restricted" and no socket, no activity fetch', async () => {
    instructions.value = BASE; // engineer-1, no activity.read
    render(<ActivityInspector agentName="director-1" />);
    expect(await screen.findByText('Restricted')).toBeTruthy();
    expect(screen.getByText(/activity\.read permission/)).toBeTruthy();
    // Give any effect a tick to (wrongly) dial.
    await new Promise((r) => setTimeout(r, 20));
    expect(StubWebSocket.instances).toHaveLength(0);
    expect(requested.filter((p) => p.includes('/members/director-1/activity'))).toHaveLength(0);
  });

  it('positive control: the same viewer looking at their own activity subscribes', async () => {
    instructions.value = BASE;
    render(<ActivityInspector agentName="engineer-1" />);
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));
    expect(StubWebSocket.instances[0]?.url).toContain('/members/engineer-1/activity/stream');
    expect(screen.queryByText('Restricted')).toBeNull();
  });

  it('positive control: a viewer holding activity.read subscribes to the peer', async () => {
    instructions.value = { ...BASE, name: 'director-1', permissions: ['activity.read'] };
    render(<ActivityInspector agentName="engineer-1" />);
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));
    expect(StubWebSocket.instances[0]?.url).toContain('/members/engineer-1/activity/stream');
    expect(screen.queryByText('Restricted')).toBeNull();
  });
});

describe('FilesPanel root (#216)', () => {
  it("the root route's '' is sent as '/', never as an empty path", async () => {
    instructions.value = BASE;
    render(<FilesPanel viewer="engineer-1" path="" />);
    await waitFor(() => expect(requested.some((p) => p.startsWith('/fs/ls'))).toBe(true));
    const ls = requested.filter((p) => p.startsWith('/fs/ls'));
    expect(ls.every((p) => p === '/fs/ls?path=%2F')).toBe(true);
    expect(ls.some((p) => p === '/fs/ls?path=')).toBe(false);
  });

  it('positive control: a real path is passed through unchanged', async () => {
    instructions.value = BASE;
    render(<FilesPanel viewer="engineer-1" path="/engineer-1" />);
    await waitFor(() => expect(requested.some((p) => p.startsWith('/fs/ls'))).toBe(true));
    expect(requested.filter((p) => p.startsWith('/fs/ls'))[0]).toBe('/fs/ls?path=%2Fengineer-1');
  });
});

describe('Notifications pages for a member without notifications.manage', () => {
  it('render "Restricted" without asking the broker', async () => {
    instructions.value = BASE;
    render(<NotificationsPanel />);
    expect(await screen.findByText('Restricted')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(requested.filter((p) => p.startsWith('/notifications'))).toHaveLength(0);
    cleanup();
    render(<NotificationDetail slug="anything" />);
    expect(await screen.findByText('Restricted')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(requested.filter((p) => p.startsWith('/notifications'))).toHaveLength(0);
  });

  it('positive control: a notifications.manage holder does load endpoints and profiles', async () => {
    instructions.value = { ...BASE, permissions: ['notifications.manage'] };
    render(<NotificationsPanel />);
    await waitFor(() => expect(requested.some((p) => p.startsWith('/notifications'))).toBe(true));
  });
});
