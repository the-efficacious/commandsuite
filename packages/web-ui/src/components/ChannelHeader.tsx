/**
 * ChannelHeader — slim row above the channel transcript with the
 * channel name, member count, and a settings affordance for admins.
 *
 * Settings is rendered inline below the header (toggled by a signal)
 * rather than as a separate route. That keeps the chat→manage flow
 * fast — toggle, edit, dismiss — without losing scroll position in
 * the transcript.
 */

import { signal } from '@preact/signals';
import type { ChannelSummary } from 'csuite-sdk/types';
import { ChannelSettings } from './ChannelSettings.js';
import { Settings } from './icons/index.js';

const settingsOpen = signal(false);

export function openChannelSettings(): void {
  settingsOpen.value = true;
}

export function closeChannelSettings(): void {
  settingsOpen.value = false;
}

interface ChannelHeaderProps {
  channel: ChannelSummary;
  viewer: string;
}

export function ChannelHeader({ channel, viewer }: ChannelHeaderProps) {
  const open = settingsOpen.value;
  const canManage = channel.id !== 'general' && channel.myRole === 'admin';
  const canLeave = channel.id !== 'general' && channel.joined;

  return (
    <>
      <div
        class="flex items-center flex-shrink-0"
        style="background:var(--ice);border-bottom:1px solid var(--rule);padding:10px max(0.75rem,env(safe-area-inset-right)) 10px max(0.75rem,env(safe-area-inset-left));gap:10px"
      >
        <span
          aria-hidden="true"
          style="color:var(--muted);font-family:var(--f-mono);font-size:14px"
        >
          #
        </span>
        <div class="flex-1 min-w-0">
          <div
            class="font-display truncate"
            style="font-size:14.5px;font-weight:700;letter-spacing:-0.01em;color:var(--ink);line-height:1.15"
          >
            {channel.slug}
          </div>
          <div
            class="truncate"
            style="font-family:var(--f-mono);font-size:10.5px;letter-spacing:.04em;color:var(--muted);margin-top:1px"
          >
            {channel.id === 'general'
              ? 'team channel · everyone'
              : `${channel.memberCount} member${channel.memberCount === 1 ? '' : 's'}`}
          </div>
        </div>
        {(canManage || canLeave) && (
          <button
            type="button"
            onClick={() => {
              settingsOpen.value = !open;
            }}
            aria-label={open ? 'Close channel settings' : 'Open channel settings'}
            aria-expanded={open}
            title="Channel settings"
            class="btn btn-ghost btn-sm"
            style="padding:6px"
          >
            <Settings size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {open && <ChannelSettings channel={channel} viewer={viewer} onClose={closeChannelSettings} />}
    </>
  );
}

/** Test-only reset. */
export function __resetChannelHeaderForTests(): void {
  settingsOpen.value = false;
}
