/**
 * ChannelSettings — inline panel below the ChannelHeader. Admins
 * see rename + members + archive; non-admins see only "Leave
 * channel". General has no settings panel at all (the header
 * suppresses the toggle for it).
 *
 * Member management uses the live channel detail (`getChannel`) for
 * the source of truth on the current member list — the channels
 * signal carries `memberCount` but not the names. We fetch on
 * mount and refresh after each mutation.
 */

import { signal } from '@preact/signals';
import type { ChannelMember, ChannelSummary, Teammate } from 'csuite-sdk/types';
import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import {
  addChannelMember,
  archiveChannel,
  leaveChannel,
  removeChannelMember,
  renameChannel,
} from '../lib/channels.js';
import { getClient } from '../lib/client.js';
import { roster } from '../lib/roster.js';
import { selectChannelsBrowse } from '../lib/view.js';
import { AlertCircle, X } from './icons/index.js';

interface ChannelSettingsProps {
  channel: ChannelSummary;
  viewer: string;
  onClose: () => void;
}

const renameInput = signal('');
const renameError = signal<string | null>(null);
const renameBusy = signal(false);

const memberError = signal<string | null>(null);
const memberBusy = signal<string | null>(null);
const addInput = signal('');

const archiveBusy = signal(false);
const leaveBusy = signal(false);

const detailMembers = signal<ChannelMember[]>([]);
const detailLoading = signal(false);
const detailError = signal<string | null>(null);

export function ChannelSettings({ channel, viewer, onClose }: ChannelSettingsProps) {
  const isAdmin = channel.myRole === 'admin';
  const members = detailMembers.value;
  const teammates: Teammate[] = roster.value?.teammates ?? briefing.value?.teammates ?? [];

  // Refresh on channel change so opening settings shows current
  // members. The signal lifetime spans the panel; we don't reset
  // it on close because reopening should be cheap.
  useEffect(() => {
    let cancelled = false;
    detailLoading.value = true;
    detailError.value = null;
    void (async () => {
      try {
        const resp = await getClient().getChannel(channel.slug);
        if (!cancelled) detailMembers.value = resp.members;
      } catch (err) {
        if (!cancelled) {
          detailError.value = err instanceof Error ? err.message : 'failed to load members';
        }
      } finally {
        if (!cancelled) detailLoading.value = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channel.slug]);

  // Re-pull members after a mutation succeeds so the list reflects
  // the just-updated state without a manual refresh.
  const refreshMembers = async () => {
    try {
      const resp = await getClient().getChannel(channel.slug);
      detailMembers.value = resp.members;
    } catch {
      /* ignore — error already surfaced by the calling mutation */
    }
  };

  const onRename = async (e: JSX.TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    const next = renameInput.value.trim();
    if (next.length === 0 || next === channel.slug) return;
    renameBusy.value = true;
    renameError.value = null;
    try {
      await renameChannel(channel.slug, next);
      renameInput.value = '';
      onClose();
    } catch (err) {
      renameError.value = err instanceof Error ? err.message : 'rename failed';
    } finally {
      renameBusy.value = false;
    }
  };

  const onAddMember = async (e: JSX.TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    const target = addInput.value.trim();
    if (target.length === 0) return;
    memberError.value = null;
    memberBusy.value = `add:${target}`;
    try {
      await addChannelMember(channel.slug, target);
      addInput.value = '';
      await refreshMembers();
    } catch (err) {
      memberError.value = err instanceof Error ? err.message : 'failed to add member';
    } finally {
      memberBusy.value = null;
    }
  };

  const onRemoveMember = async (name: string) => {
    memberError.value = null;
    memberBusy.value = `remove:${name}`;
    try {
      await removeChannelMember(channel.slug, name);
      await refreshMembers();
    } catch (err) {
      memberError.value = err instanceof Error ? err.message : 'failed to remove member';
    } finally {
      memberBusy.value = null;
    }
  };

  const onArchive = async () => {
    if (!confirm(`Archive #${channel.slug}? Messages stay visible to people who were in it.`)) {
      return;
    }
    archiveBusy.value = true;
    try {
      await archiveChannel(channel.slug);
      onClose();
      selectChannelsBrowse();
    } catch (err) {
      memberError.value = err instanceof Error ? err.message : 'archive failed';
    } finally {
      archiveBusy.value = false;
    }
  };

  const onLeave = async () => {
    if (!confirm(`Leave #${channel.slug}?`)) return;
    leaveBusy.value = true;
    try {
      await leaveChannel(channel.slug, viewer);
      onClose();
      selectChannelsBrowse();
    } catch (err) {
      memberError.value = err instanceof Error ? err.message : 'leave failed';
    } finally {
      leaveBusy.value = false;
    }
  };

  // Names available to add: any team member not already in the channel.
  const memberNames = new Set(members.map((m) => m.memberName));
  const addableTeammates = teammates.filter((t) => !memberNames.has(t.name));

  return (
    <div
      class="flex-shrink-0"
      style="background:var(--paper);border-bottom:1px solid var(--rule);padding:14px max(0.75rem,env(safe-area-inset-right)) 16px max(0.75rem,env(safe-area-inset-left));display:flex;flex-direction:column;gap:14px"
    >
      <div class="flex items-center justify-between">
        <div class="eyebrow">Channel settings</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          class="btn btn-ghost btn-sm"
          style="padding:4px 8px"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {memberError.value !== null && (
        <div role="alert" class="callout callout--compact err">
          <div class="icon" aria-hidden="true">
            <AlertCircle size={14} />
          </div>
          <div class="body">
            <div class="msg">{memberError.value}</div>
          </div>
        </div>
      )}

      {isAdmin && (
        <form onSubmit={onRename} style="display:flex;flex-direction:column;gap:6px">
          <span class="eyebrow" style="color:var(--graphite)">
            Rename
          </span>
          <div class="flex items-center" style="gap:6px">
            <input
              type="text"
              value={renameInput.value}
              onInput={(e) => {
                renameInput.value = e.currentTarget.value;
                renameError.value = null;
              }}
              placeholder={channel.slug}
              maxLength={32}
              autoComplete="off"
              spellcheck={false}
              style="flex:1;background:var(--ice);border:1px solid var(--rule);border-radius:var(--r-sm);padding:6px 10px;color:var(--ink);font-family:var(--f-mono);font-size:13px;outline:0"
            />
            <button
              type="submit"
              disabled={renameBusy.value || renameInput.value.length === 0}
              class="btn btn-secondary btn-sm"
            >
              {renameBusy.value ? 'Renaming…' : 'Rename'}
            </button>
          </div>
          {renameError.value !== null && (
            <span style="font-family:var(--f-sans);font-size:12px;color:var(--err)">
              {renameError.value}
            </span>
          )}
        </form>
      )}

      <div style="display:flex;flex-direction:column;gap:6px">
        <span class="eyebrow" style="color:var(--graphite)">
          Members ({members.length})
        </span>
        {detailLoading.value && (
          <span style="font-family:var(--f-sans);font-size:12px;color:var(--muted);font-style:italic">
            loading…
          </span>
        )}
        {detailError.value !== null && (
          <span style="font-family:var(--f-sans);font-size:12px;color:var(--err)">
            {detailError.value}
          </span>
        )}
        <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px">
          {members.map((m) => (
            <li key={m.memberName} class="flex items-center" style="gap:8px;padding:4px 0">
              <span
                class="font-display flex-1 truncate"
                style="font-size:13.5px;font-weight:600;color:var(--ink)"
              >
                {m.memberName}
              </span>
              <span style="font-family:var(--f-mono);font-size:10px;letter-spacing:.06em;color:var(--muted);text-transform:uppercase">
                {m.role}
              </span>
              {(isAdmin || m.memberName === viewer) && (
                <button
                  type="button"
                  onClick={() => void onRemoveMember(m.memberName)}
                  disabled={memberBusy.value === `remove:${m.memberName}`}
                  class="btn btn-ghost btn-sm"
                  aria-label={m.memberName === viewer ? 'Leave channel' : `Remove ${m.memberName}`}
                  style="padding:2px 8px;font-size:11.5px"
                >
                  {memberBusy.value === `remove:${m.memberName}`
                    ? '…'
                    : m.memberName === viewer
                      ? 'Leave'
                      : 'Remove'}
                </button>
              )}
            </li>
          ))}
        </ul>
        {isAdmin && addableTeammates.length > 0 && (
          <form onSubmit={onAddMember} class="flex items-center" style="gap:6px;margin-top:8px">
            <select
              value={addInput.value}
              onChange={(e) => {
                addInput.value = (e.currentTarget as HTMLSelectElement).value;
              }}
              style="flex:1;background:var(--ice);border:1px solid var(--rule);border-radius:var(--r-sm);padding:6px 8px;color:var(--ink);font-family:var(--f-sans);font-size:13px;outline:0"
            >
              <option value="">add a teammate…</option>
              {addableTeammates.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} · {t.role.title}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={addInput.value.length === 0 || memberBusy.value !== null}
              class="btn btn-secondary btn-sm"
            >
              Add
            </button>
          </form>
        )}
      </div>

      <div
        class="flex items-center"
        style="gap:8px;border-top:1px solid var(--rule);padding-top:12px"
      >
        {channel.joined && channel.id !== 'general' && (
          <button
            type="button"
            onClick={() => void onLeave()}
            disabled={leaveBusy.value}
            class="btn btn-ghost btn-sm"
          >
            {leaveBusy.value ? 'Leaving…' : 'Leave channel'}
          </button>
        )}
        {isAdmin && (
          <button
            type="button"
            onClick={() => void onArchive()}
            disabled={archiveBusy.value}
            class="btn btn-ghost btn-sm"
            style="color:var(--err)"
          >
            {archiveBusy.value ? 'Archiving…' : 'Archive channel'}
          </button>
        )}
      </div>
    </div>
  );
}
