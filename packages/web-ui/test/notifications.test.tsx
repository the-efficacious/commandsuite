/**
 * External Notifications UI tests — permission gating, endpoint list
 * rendering, endpoint creation (with @/# target parsing), and the
 * detail view's write-only secret + delivery replay actions, driven
 * through a stubbed fetch + real SDK Client so schema validation runs
 * end-to-end.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { Client } from 'csuite-sdk/client';
import type {
  BriefingResponse,
  NotificationDelivery,
  NotificationEndpointSummary,
} from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetNotificationDetailForTests,
  NotificationDetail,
} from '../src/components/NotificationDetail.js';
import {
  __resetNotificationsPanelForTests,
  NotificationsPanel,
  parseTargetsInput,
} from '../src/components/NotificationsPanel.js';
import { __resetBriefingForTests, briefing } from '../src/lib/briefing.js';
import { __resetClientForTests, setClient } from '../src/lib/client.js';
import { __resetNotificationsForTests } from '../src/lib/notifications.js';

const originalFetch = globalThis.fetch;

function mkBriefing(permissions: BriefingResponse['permissions']): BriefingResponse {
  return {
    name: 'director-1',
    role: { title: 'director', description: '' },
    permissions,
    instructions: '',
    team: { name: 'demo', directive: 'ship', context: '', permissionPresets: {} },
    teammates: [
      { name: 'director-1', role: { title: 'director', description: '' }, permissions: [] },
      { name: 'builder', role: { title: 'engineer', description: '' }, permissions: [] },
    ],
    openObjectives: [],
    toolSources: [],
  };
}

function mkEndpoint(
  overrides: Partial<NotificationEndpointSummary> = {},
): NotificationEndpointSummary {
  return {
    id: 'ep-1',
    slug: 'ci-alerts',
    displayName: 'CI Alerts',
    description: '',
    enabled: true,
    auth: { kind: 'hmac-sha256', headerName: null, prefix: null },
    authProfile: null,
    targets: [{ member: 'builder' }],
    level: 'warning',
    title: null,
    template: null,
    filters: [],
    policy: {
      ifOffline: 'queue',
      ifBusy: 'now',
      debounceMs: 0,
      debounceMax: 20,
      queueTtlMs: 86_400_000,
      maxWaitMs: 900_000,
    },
    dedupeHeader: null,
    createdBy: 'director-1',
    createdAt: 1,
    updatedAt: 1,
    hasSecret: true,
    ...overrides,
  };
}

function mkDelivery(overrides: Partial<NotificationDelivery> = {}): NotificationDelivery {
  return {
    id: 'd-1',
    endpointSlug: 'ci-alerts',
    receivedAt: 1_700_000_000_000,
    status: 'rejected',
    statusReason: 'signature mismatch',
    dedupeKey: null,
    messageIds: [],
    bodyPreview: '{"state":"failed"}',
    contentType: 'application/json',
    overrides: null,
    deliveredAt: null,
    replayOf: null,
    ...overrides,
  };
}

interface Captured {
  url: string;
  init: RequestInit;
}

function stubFetch(
  routes: Array<[method: string, suffix: string, body: unknown, status?: number]>,
  captured?: Captured[],
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    captured?.push({ url, init });
    for (const [m, suffix, body, status] of routes) {
      if (m === method && url.includes(suffix)) {
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: status ?? 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
    }
    return Promise.resolve(new Response('{"error":"no stub route"}', { status: 500 }));
  }) as typeof fetch;
  setClient(new Client({ url: 'http://localhost', useCookies: true }));
}

beforeEach(() => {
  __resetBriefingForTests();
  __resetClientForTests();
  __resetNotificationsForTests();
  __resetNotificationsPanelForTests();
  __resetNotificationDetailForTests();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('parseTargetsInput', () => {
  it('parses @members, #channels, and bare names', () => {
    expect(parseTargetsInput('@builder #ops bare, @two')).toEqual([
      { member: 'builder' },
      { channel: 'ops' },
      { member: 'bare' },
      { member: 'two' },
    ]);
  });
});

describe('NotificationsPanel', () => {
  it('shows a restricted callout without notifications.manage', () => {
    briefing.value = mkBriefing(['members.manage']);
    stubFetch([
      ['GET', '/notifications/endpoints', { endpoints: [] }],
      ['GET', '/notifications/profiles', { profiles: [] }],
    ]);
    render(<NotificationsPanel />);
    expect(screen.getByText(/requires the notifications\.manage permission/i)).toBeTruthy();
  });

  it('lists endpoints with targets, badges, and a no-secret warning', async () => {
    briefing.value = mkBriefing(['notifications.manage']);
    stubFetch([
      [
        'GET',
        '/notifications/endpoints',
        {
          endpoints: [
            mkEndpoint(),
            mkEndpoint({
              id: 'ep-2',
              slug: 'deploys',
              hasSecret: false,
              enabled: false,
              policy: {
                ifOffline: 'drop',
                ifBusy: 'now',
                debounceMs: 0,
                debounceMax: 20,
                queueTtlMs: 86_400_000,
                maxWaitMs: 900_000,
              },
            }),
          ],
        },
      ],
      ['GET', '/notifications/profiles', { profiles: [] }],
    ]);
    render(<NotificationsPanel />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /manage endpoint ci-alerts/i })).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: /manage endpoint deploys/i })).toBeTruthy();
    expect(screen.getByText('Queue offline')).toBeTruthy();
    expect(screen.getByText('No secret')).toBeTruthy();
    expect(screen.getByText('Disabled')).toBeTruthy();
  });

  it('creates an endpoint from the form, parsing targets', async () => {
    briefing.value = mkBriefing(['notifications.manage']);
    const captured: Captured[] = [];
    stubFetch(
      [
        ['GET', '/notifications/endpoints', { endpoints: [] }],
        ['GET', '/notifications/profiles', { profiles: [] }],
        ['POST', '/notifications/endpoints', mkEndpoint(), 201],
      ],
      captured,
    );
    render(<NotificationsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /new endpoint/i }));
    fireEvent.input(screen.getByPlaceholderText('ci-alerts'), {
      target: { value: 'ci-alerts' },
    });
    fireEvent.input(screen.getByPlaceholderText('@builder #ops'), {
      target: { value: '@builder #ops' },
    });
    fireEvent.click(screen.getByRole('button', { name: /register endpoint/i }));
    await waitFor(() => {
      const post = captured.find(
        (c) => (c.init.method ?? 'GET') === 'POST' && c.url.includes('/notifications/endpoints'),
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post?.init.body ?? '{}'));
      expect(body.slug).toBe('ci-alerts');
      expect(body.targets).toEqual([{ member: 'builder' }, { channel: 'ops' }]);
    });
  });
});

describe('NotificationDetail', () => {
  it('sets the write-only secret and clears the input', async () => {
    briefing.value = mkBriefing(['notifications.manage']);
    const captured: Captured[] = [];
    stubFetch(
      [
        ['GET', '/notifications/endpoints/ci-alerts/deliveries', { deliveries: [] }],
        ['GET', '/notifications/endpoints', { endpoints: [mkEndpoint({ hasSecret: false })] }],
        ['GET', '/notifications/profiles', { profiles: [] }],
        ['PUT', '/secret', { ok: true }],
      ],
      captured,
    );
    render(<NotificationDetail slug="ci-alerts" />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/paste secret/i)).toBeTruthy();
    });
    const input = screen.getByPlaceholderText(/paste secret/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'hook-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /set secret/i }));
    await waitFor(() => {
      const put = captured.find((c) => (c.init.method ?? 'GET') === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(String(put?.init.body ?? '{}'))).toEqual({ secret: 'hook-secret' });
    });
    await waitFor(() => {
      expect(input.value).toBe('');
    });
  });

  it('renders delivery receipts and replays one', async () => {
    briefing.value = mkBriefing(['notifications.manage']);
    const captured: Captured[] = [];
    stubFetch(
      [
        [
          'GET',
          '/notifications/endpoints/ci-alerts/deliveries',
          {
            deliveries: [
              mkDelivery(),
              mkDelivery({
                id: 'd-2',
                status: 'delivered',
                statusReason: null,
                messageIds: ['m-1'],
              }),
            ],
          },
        ],
        ['GET', '/notifications/endpoints', { endpoints: [mkEndpoint()] }],
        ['GET', '/notifications/profiles', { profiles: [] }],
        [
          'POST',
          '/notifications/deliveries/d-1/replay',
          { delivery: mkDelivery({ id: 'd-3', status: 'delivered', replayOf: 'd-1' }) },
        ],
      ],
      captured,
    );
    render(<NotificationDetail slug="ci-alerts" />);
    await waitFor(() => {
      expect(screen.getByText('signature mismatch')).toBeTruthy();
    });
    expect(screen.getByText('rejected')).toBeTruthy();
    expect(screen.getByText('delivered')).toBeTruthy();

    const replayButtons = screen.getAllByRole('button', { name: /^replay$/i });
    fireEvent.click(replayButtons[0] as HTMLButtonElement);
    await waitFor(() => {
      const post = captured.find(
        (c) => (c.init.method ?? 'GET') === 'POST' && c.url.includes('/replay'),
      );
      expect(post).toBeTruthy();
      expect(post?.url).toContain('/notifications/deliveries/d-1/replay');
    });
  });
});
