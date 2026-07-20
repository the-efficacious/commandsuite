import { Client } from 'csuite-sdk/client';
import type { ChannelSummary } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetChannelsForTests,
  channelById,
  channelBySlug,
  channels,
  createChannel,
  joinedChannels,
  loadChannels,
} from '../src/lib/channels.js';
import { __resetClientForTests, setClient } from '../src/lib/client.js';

const originalFetch = globalThis.fetch;

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
  setClient(new Client({ url: 'http://localhost', useCookies: true }));
}

const GENERAL: ChannelSummary = {
  id: 'general',
  slug: 'general',
  createdBy: '__system__',
  createdAt: 0,
  archivedAt: null,
  joined: true,
  myRole: 'member',
  memberCount: 0,
};

const OPS: ChannelSummary = {
  id: 'ops-uuid',
  slug: 'ops',
  createdBy: 'alice',
  createdAt: 1000,
  archivedAt: null,
  joined: true,
  myRole: 'admin',
  memberCount: 1,
};

beforeEach(() => {
  __resetChannelsForTests();
  __resetClientForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('loadChannels', () => {
  it('populates the channels signal from the server response', async () => {
    stubFetch({
      '/channels': () => ({ status: 200, body: { channels: [GENERAL, OPS] } }),
    });
    await loadChannels();
    expect(channels.value?.map((c) => c.slug)).toEqual(['general', 'ops']);
  });

  it('populates channelsError when the server fails', async () => {
    stubFetch({
      '/channels': () => ({ status: 500, body: { error: 'boom' } }),
    });
    await loadChannels();
    expect(channels.value).toBeNull();
  });
});

describe('joinedChannels', () => {
  it('puts general first regardless of createdAt', () => {
    channels.value = [
      { ...OPS, createdAt: 5000 },
      { ...GENERAL, createdAt: 1000 },
    ];
    const result = joinedChannels();
    expect(result.map((c) => c.slug)).toEqual(['general', 'ops']);
  });

  it('filters out non-joined channels', () => {
    channels.value = [GENERAL, { ...OPS, joined: false, myRole: null }];
    const result = joinedChannels();
    expect(result.map((c) => c.slug)).toEqual(['general']);
  });

  it('returns empty when not loaded', () => {
    channels.value = null;
    expect(joinedChannels()).toEqual([]);
  });
});

describe('channelBySlug / channelById', () => {
  it('finds a channel by slug', () => {
    channels.value = [GENERAL, OPS];
    expect(channelBySlug('ops')?.id).toBe('ops-uuid');
  });

  it('finds a channel by id', () => {
    channels.value = [GENERAL, OPS];
    expect(channelById('ops-uuid')?.slug).toBe('ops');
  });

  it('returns null when channels are unloaded', () => {
    channels.value = null;
    expect(channelBySlug('ops')).toBeNull();
  });
});

describe('createChannel', () => {
  it('creates the channel and refreshes the list', async () => {
    let listCalls = 0;
    stubFetch({
      '/channels': (init) => {
        if ((init.method ?? 'GET') === 'POST') {
          return {
            status: 201,
            body: {
              id: 'new-id',
              slug: 'eng',
              createdBy: 'alice',
              createdAt: 2000,
              archivedAt: null,
            },
          };
        }
        listCalls++;
        return {
          status: 200,
          body: {
            channels: [
              GENERAL,
              {
                id: 'new-id',
                slug: 'eng',
                createdBy: 'alice',
                createdAt: 2000,
                archivedAt: null,
                joined: true,
                myRole: 'admin',
                memberCount: 1,
              },
            ],
          },
        };
      },
    });
    const created = await createChannel('eng');
    expect(created.slug).toBe('eng');
    expect(created.joined).toBe(true);
    expect(channels.value?.find((c) => c.slug === 'eng')).toBeDefined();
    expect(listCalls).toBe(1); // re-list ran exactly once
  });
});
