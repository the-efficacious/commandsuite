/**
 * ChannelBrowse — list every active channel on the team. Each row
 * carries an Open/Join action depending on whether the viewer is
 * already a member. Mounted at `/channels`.
 *
 * Joining triggers a re-list against the server so the new
 * membership shows up across the rest of the UI (the channels
 * signal feeds NavColumn). The viewer is then routed straight into
 * the channel they joined — fewer clicks to first message.
 */

import { signal } from '@preact/signals';
import {
  channels,
  channelsError,
  channelsLoading,
  joinChannel,
  loadChannels,
} from '../lib/channels.js';
import { selectChannel, selectChannelCreate } from '../lib/view.js';

const joinError = signal<string | null>(null);
const joiningSlug = signal<string | null>(null);

export function ChannelBrowse() {
  const list = channels.value;
  const loading = channelsLoading.value;
  const loadErr = channelsError.value;

  const onJoin = async (slug: string) => {
    joinError.value = null;
    joiningSlug.value = slug;
    try {
      await joinChannel(slug);
      selectChannel(slug);
    } catch (err) {
      joinError.value = err instanceof Error ? err.message : 'failed to join';
    } finally {
      joiningSlug.value = null;
    }
  };

  return (
    <div class="flex-1 overflow-y-auto" style="padding:32px">
      <div class="max-w-2xl mx-auto" style="display:flex;flex-direction:column;gap:16px">
        <header class="flex items-end justify-between" style="gap:12px">
          <div>
            <h1
              class="font-display"
              style="font-size:22px;font-weight:700;letter-spacing:-0.01em;color:var(--ink);margin:0"
            >
              Channels
            </h1>
            <p style="font-family:var(--f-sans);font-size:13.5px;color:var(--muted);margin:6px 0 0;line-height:1.5">
              Every active channel on the team. Open one you're in, or join one you aren't.
            </p>
          </div>
          <button type="button" onClick={selectChannelCreate} class="btn btn-secondary">
            + New channel
          </button>
        </header>

        {loadErr !== null && (
          <div
            role="alert"
            style="font-family:var(--f-sans);font-size:13px;color:var(--err);background:rgba(211,47,47,0.08);border:1px solid var(--err);border-radius:var(--r-sm);padding:10px 12px"
          >
            {loadErr}
            <button
              type="button"
              onClick={() => void loadChannels()}
              style="margin-left:10px;background:transparent;border:0;color:var(--err);font-family:var(--f-mono);font-size:11.5px;cursor:pointer;text-decoration:underline"
            >
              retry
            </button>
          </div>
        )}

        {joinError.value !== null && (
          <div
            role="alert"
            style="font-family:var(--f-sans);font-size:13px;color:var(--err);background:rgba(211,47,47,0.08);border:1px solid var(--err);border-radius:var(--r-sm);padding:10px 12px"
          >
            {joinError.value}
          </div>
        )}

        {list === null && loading && (
          <div class="eyebrow" style="color:var(--muted);font-style:italic">
            loading channels…
          </div>
        )}

        {list !== null && (
          <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px">
            {list.map((c) => {
              const isJoining = joiningSlug.value === c.slug;
              return (
                <li
                  key={c.id}
                  class="flex items-center"
                  style="gap:10px;padding:12px 14px;border:1px solid var(--rule);border-radius:var(--r-sm);background:var(--paper)"
                >
                  <span
                    aria-hidden="true"
                    style="color:var(--muted);font-family:var(--f-mono);font-size:13px;width:14px;text-align:center;flex:0 0 auto"
                  >
                    #
                  </span>
                  <div class="flex-1 min-w-0">
                    <div
                      class="font-display"
                      style="font-size:14.5px;font-weight:600;color:var(--ink);letter-spacing:-0.005em;line-height:1.2"
                    >
                      {c.slug}
                    </div>
                    <div style="font-family:var(--f-sans);font-size:11.5px;color:var(--muted);margin-top:2px">
                      {c.id === 'general'
                        ? 'team channel · everyone'
                        : `${c.memberCount} member${c.memberCount === 1 ? '' : 's'}`}
                    </div>
                  </div>
                  {c.joined ? (
                    <button
                      type="button"
                      onClick={() => selectChannel(c.slug)}
                      class="btn btn-ghost btn-sm"
                    >
                      Open
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void onJoin(c.slug)}
                      disabled={isJoining}
                      class="btn btn-primary btn-sm"
                    >
                      {isJoining ? 'Joining…' : 'Join'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
