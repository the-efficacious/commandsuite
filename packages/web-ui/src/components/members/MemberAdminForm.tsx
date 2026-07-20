/**
 * MemberAdminForm — the per-member admin controls.
 *
 * Role title edit, perms preset, rotate token, enroll TOTP, delete.
 * Used inside MemberProfile's Manage tab and inside MembersPanel's
 * list rows — one source of truth for "how does an admin mutate a
 * member."
 *
 * Mutations call the SDK directly; parents pass `onChanged` to refresh
 * their local state (list, briefing, roster) after a successful write.
 * Reveal state for tokens/TOTP is owned by the parent so the banner
 * can render wherever the parent prefers (inline next to the card, at
 * the top of the page, etc.).
 */

import { signal } from '@preact/signals';
import type { Member, Permission, PermissionPresets } from 'csuite-sdk/types';
import { loadBriefing } from '../../lib/briefing.js';
import { getClient } from '../../lib/client.js';
import { loadRoster } from '../../lib/roster.js';
import { MemberTokenList } from './MemberTokenList.js';
import { PermissionsEditor } from './PermissionsEditor.js';
import type { Reveal } from './Reveal.js';

// After any member mutation we refresh three sources so stale reads
// don't bite:
//   - the parent's onChanged() (typically the /members list)
//   - roster  (presence + Teammate[] everywhere in the sidebar)
//   - briefing (teammates + the viewer's own permissions)
// briefing especially — it was booted once at Shell mount and used
// to be stale after every mutation, which broke isLastAdmin and any
// other caller that read `briefing.value.teammates`.
async function refreshSharedStores(): Promise<void> {
  await Promise.allSettled([loadRoster(), loadBriefing()]);
}

export interface MemberAdminFormProps {
  member: Member;
  presets: PermissionPresets;
  /** Self-serve guard — true if this is the last admin on the team. Disables demote + delete. */
  isLastAdmin: boolean;
  /** True when viewer is this member. Delete gets an extra confirmation; no other restrictions. */
  isSelf: boolean;
  /** Called after any successful mutation so the parent refreshes its lists. */
  onChanged: () => Promise<void> | void;
  /** Called when a reveal-worthy mutation completes (rotate/enroll). */
  onReveal: (r: Reveal) => void;
  /** Optional inline style passthrough. */
  style?: string;
}

const actionBusy = signal<string | null>(null);

async function withBusy<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  if (actionBusy.value !== null) return null;
  actionBusy.value = key;
  try {
    return await fn();
  } finally {
    actionBusy.value = null;
  }
}

export function MemberAdminForm({
  member,
  presets,
  isLastAdmin,
  isSelf,
  onChanged,
  onReveal,
  style,
}: MemberAdminFormProps) {
  const rowKey = member.name;
  const busy = actionBusy.value;
  const disabled = busy !== null;

  async function onChangePermissions(next: Permission[]): Promise<void> {
    if (isLastAdmin && !next.includes('members.manage')) {
      alert(
        'Cannot strip members.manage from the last admin. Promote another member to admin first.',
      );
      return;
    }
    await withBusy(`update:${rowKey}`, async () => {
      try {
        await getClient().updateMember(member.name, { permissions: next });
        await onChanged();
        await refreshSharedStores();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function onChangeRoleTitle(next: string): Promise<void> {
    const trimmed = next.trim();
    if (!trimmed || trimmed === member.role.title) return;
    await withBusy(`update:${rowKey}`, async () => {
      try {
        await getClient().updateMember(member.name, {
          role: { title: trimmed, description: member.role.description },
        });
        await onChanged();
        await refreshSharedStores();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function onChangeRoleDescription(next: string): Promise<void> {
    const trimmed = next.trim();
    if (trimmed === member.role.description) return;
    await withBusy(`update:${rowKey}`, async () => {
      try {
        await getClient().updateMember(member.name, {
          role: { title: member.role.title, description: trimmed },
        });
        await onChanged();
        await refreshSharedStores();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function onChangeInstructions(next: string): Promise<void> {
    if (next === member.instructions) return;
    await withBusy(`update:${rowKey}`, async () => {
      try {
        await getClient().updateMember(member.name, { instructions: next });
        await onChanged();
        await refreshSharedStores();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function onRotate(): Promise<void> {
    if (
      !confirm(
        `Rotate bearer token for '${member.name}'?\n\nThe existing token will be invalidated immediately.`,
      )
    )
      return;
    await withBusy(`rotate:${rowKey}`, async () => {
      try {
        const response = await getClient().rotateToken(member.name);
        onReveal({ kind: 'rotate', name: member.name, response });
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function onEnrollTotp(): Promise<void> {
    if (
      !confirm(
        `(Re-)enroll TOTP for '${member.name}'?\n\nAny authenticator app currently bound to this member will stop working.`,
      )
    )
      return;
    await withBusy(`totp:${rowKey}`, async () => {
      try {
        const response = await getClient().enrollTotp(member.name);
        onReveal({ kind: 'totp', name: member.name, response });
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function onDelete(): Promise<void> {
    if (isLastAdmin) {
      alert('Cannot remove the last admin. Promote another member to admin first.');
      return;
    }
    if (isSelf) {
      if (!confirm(`Delete YOURSELF ('${member.name}')?\n\nYou will be signed out immediately.`))
        return;
    } else if (
      !confirm(
        `Delete member '${member.name}'?\n\nTheir bearer token and TOTP secret will be invalidated; their files and message history remain.`,
      )
    ) {
      return;
    }
    await withBusy(`delete:${rowKey}`, async () => {
      try {
        await getClient().deleteMember(member.name);
        await onChanged();
        await refreshSharedStores();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <section class="card" style={`padding:16px;${style ?? ''}`}>
      <div class="eyebrow" style="margin-bottom:12px">
        Manage {member.name}
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <label
          class="flex items-center gap-2"
          style="font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase"
        >
          <span>role</span>
          <input
            class="input"
            style="padding:4px 8px;font-size:12px;width:18ch"
            defaultValue={member.role.title}
            disabled={disabled}
            onBlur={(e) => void onChangeRoleTitle((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
            }}
          />
        </label>

        <label style="display:flex;flex-direction:column;gap:4px;font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase">
          <span>role description</span>
          <textarea
            class="input"
            rows={2}
            style="font-size:13px;font-family:var(--f-sans);text-transform:none;letter-spacing:normal;color:var(--ink)"
            defaultValue={member.role.description}
            disabled={disabled}
            onBlur={(e) =>
              void onChangeRoleDescription((e.currentTarget as HTMLTextAreaElement).value)
            }
          />
        </label>

        <label style="display:flex;flex-direction:column;gap:4px;font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase">
          <span>personal instructions</span>
          <textarea
            class="input"
            rows={6}
            maxLength={8192}
            placeholder="Standing instructions for this member. Pinned into the agent's system prompt at runner startup."
            style="font-size:13px;font-family:var(--f-sans);text-transform:none;letter-spacing:normal;color:var(--ink);white-space:pre-wrap"
            defaultValue={member.instructions}
            disabled={disabled}
            onBlur={(e) =>
              void onChangeInstructions((e.currentTarget as HTMLTextAreaElement).value)
            }
          />
        </label>

        {/* Role title, role description, and personal instructions are
            snapshotted into the runner's system prompt (claude's
            --append-system-prompt) at the moment `csuite claude-code`
            starts. Editing them here updates the team record
            immediately, but the running agent won't see the change
            until it's rerun. The MemberProfile header already shows
            the member's online/offline state via the presence dot —
            admins can use that to tell whether a rerun is pending. */}
        <div
          class="card"
          style="padding:8px 10px;font-family:var(--f-mono);font-size:11px;line-height:1.4;color:var(--muted);border-left:3px solid var(--warn)"
        >
          Role and instructions are pinned into the agent's system prompt at runner startup. Restart
          any running agents for changes to take effect.
        </div>

        <div style="display:flex;flex-direction:column;gap:6px">
          <span style="font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase">
            Permissions
          </span>
          <PermissionsEditor
            value={member.permissions}
            presets={presets}
            onChange={(next) => void onChangePermissions(next)}
            disabled={disabled}
          />
        </div>

        <MemberTokenList memberName={member.name} style="margin-top:6px" />

        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => void onRotate()}
            disabled={disabled}
            title="Rotate this member's token: invalidates ALL active tokens for them and mints a fresh one"
          >
            {busy === `rotate:${rowKey}` ? '…' : 'Rotate all tokens'}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => void onEnrollTotp()}
            disabled={disabled}
            title="Generate a fresh TOTP secret for web UI login"
          >
            {busy === `totp:${rowKey}` ? '…' : 'Enroll TOTP'}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => void onDelete()}
            disabled={disabled || isLastAdmin}
            style="color:var(--err, #b42b2b)"
            title={isLastAdmin ? 'Cannot delete the last admin' : 'Delete this member'}
          >
            {busy === `delete:${rowKey}` ? '…' : 'Delete'}
          </button>
        </div>
      </div>
    </section>
  );
}

export function __resetMemberAdminFormForTests(): void {
  actionBusy.value = null;
}
