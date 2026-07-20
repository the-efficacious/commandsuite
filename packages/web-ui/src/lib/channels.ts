/**
 * Channels signal — list of channels visible to the current viewer,
 * keyed by slug. Mirrors the server's `GET /channels` projection.
 *
 * Used by:
 *   - `NavColumn` to render the joined-channels list and the
 *     "browse channels" affordance
 *   - `view.ts` to map a `thread-channel { slug }` route into the
 *     internal thread key (`primary` for general, `chan:<id>` for
 *     everything else)
 *   - `Composer` to derive the `data.thread` tag on a per-channel
 *     send so the server can fan out to the right recipient set
 *
 * Mutation helpers (`createChannel`, `archiveChannel`, etc.) are
 * intentionally simple wrappers around `Client` methods — they call
 * the server, then re-list to refresh the signal. We don't try to
 * patch the local cache surgically; channels are a low-volume,
 * low-frequency concept and a re-list keeps the source-of-truth
 * cheap to reason about.
 */

import { signal } from '@preact/signals';
import type { ChannelSummary } from 'csuite-sdk/types';
import { getClient } from './client.js';
import { GENERAL_CHANNEL_ID } from './messages.js';

/**
 * Channels visible to the viewer. `null` means "not yet loaded";
 * empty array means "loaded, no channels beyond general" (shouldn't
 * happen since general is always present).
 */
export const channels = signal<ChannelSummary[] | null>(null);

/** Most-recent channel-load failure, surfaced inline if non-null. */
export const channelsError = signal<string | null>(null);

/** True while the initial load (or a refresh) is in flight. */
export const channelsLoading = signal(false);

export async function loadChannels(): Promise<void> {
  channelsLoading.value = true;
  try {
    const list = await getClient().listChannels();
    channels.value = list;
    channelsError.value = null;
  } catch (err) {
    channelsError.value = err instanceof Error ? err.message : String(err);
  } finally {
    channelsLoading.value = false;
  }
}

/** Look up a channel by slug. Returns null when unknown or unloaded. */
export function channelBySlug(slug: string): ChannelSummary | null {
  const list = channels.value;
  if (list === null) return null;
  return list.find((c) => c.slug === slug) ?? null;
}

/** Look up a channel by id. Returns null when unknown or unloaded. */
export function channelById(id: string): ChannelSummary | null {
  const list = channels.value;
  if (list === null) return null;
  return list.find((c) => c.id === id) ?? null;
}

/**
 * Channels the caller has joined, with general guaranteed first.
 * Returns an empty array when channels haven't loaded — callers that
 * need a non-loading-aware list should check `channels.value === null`
 * before rendering.
 */
export function joinedChannels(): ChannelSummary[] {
  const list = channels.value ?? [];
  const joined = list.filter((c) => c.joined);
  // Stable sort: general first, then created-at descending.
  return joined.slice().sort((a, b) => {
    if (a.id === GENERAL_CHANNEL_ID) return -1;
    if (b.id === GENERAL_CHANNEL_ID) return 1;
    return b.createdAt - a.createdAt;
  });
}

/**
 * Create a new channel and immediately refresh the channels list so
 * the new row appears in the nav. Returns the created channel so
 * the caller can navigate to it.
 */
export async function createChannel(slug: string): Promise<ChannelSummary> {
  const created = await getClient().createChannel({ slug });
  await loadChannels();
  // After re-list, the channel should be present with the caller's
  // membership flags. Fall back to the bare `Channel` projection if
  // the list hasn't propagated yet (rare race) — caller still gets
  // a usable object to navigate to.
  return (
    channelBySlug(created.slug) ?? {
      ...created,
      joined: true,
      myRole: 'admin',
      memberCount: 1,
    }
  );
}

export async function renameChannel(slug: string, newSlug: string): Promise<ChannelSummary> {
  const updated = await getClient().renameChannel(slug, { slug: newSlug });
  await loadChannels();
  return (
    channelBySlug(updated.slug) ?? {
      ...updated,
      joined: true,
      myRole: 'admin',
      memberCount: 1,
    }
  );
}

export async function archiveChannel(slug: string): Promise<void> {
  await getClient().archiveChannel(slug);
  await loadChannels();
}

export async function joinChannel(slug: string): Promise<void> {
  await getClient().joinChannel(slug);
  await loadChannels();
}

export async function addChannelMember(slug: string, member: string): Promise<void> {
  await getClient().addChannelMember(slug, { member });
  await loadChannels();
}

export async function leaveChannel(slug: string, viewer: string): Promise<void> {
  await getClient().removeChannelMember(slug, viewer);
  await loadChannels();
}

export async function removeChannelMember(slug: string, member: string): Promise<void> {
  await getClient().removeChannelMember(slug, member);
  await loadChannels();
}

/** Test-only reset so unit tests start clean. */
export function __resetChannelsForTests(): void {
  channels.value = null;
  channelsError.value = null;
  channelsLoading.value = false;
}
