/**
 * MemberAdminForm — permission-gated controls for one member.
 *
 * Role title edit, permission leaves, rotate token, enroll TOTP, delete.
 * Used inside MemberProfile's Manage tab and inside MembersPanel's
 * list rows — one source of truth for "how does a member manager mutate a
 * member."
 *
 * Mutations call the SDK directly; parents pass `onChanged` to refresh
 * their local state (list, instructions, roster) after a successful write.
 * Reveal state for tokens/TOTP is owned by the parent so the banner
 * can render wherever the parent prefers (inline next to the card, at
 * the top of the page, etc.).
 */

import { signal } from '@preact/signals';
import type { Member, Permission } from 'csuite-sdk/types';
import { useState } from 'preact/hooks';
import { getClient } from '../../lib/client.js';
import { confirmDialog } from '../../lib/confirm.js';
import { loadInstructions } from '../../lib/instructions.js';
import { loadRoster, roster } from '../../lib/roster.js';
import { TextMetrics } from '../ui/index.js';
import { MemberTokenList } from './MemberTokenList.js';
import { PermissionsEditor } from './PermissionsEditor.js';
import type { Reveal } from './Reveal.js';

// After any member mutation we refresh three sources so stale reads
// don't bite:
//   - the parent's onChanged() (typically the /members list)
//   - roster  (presence + Teammate[] everywhere in the sidebar)
//   - instructions (teammates + the viewer's own permissions)
// instructions especially — it was booted once at Shell mount and used
// to be stale after every mutation, which broke the sole-manager guard and any
// other caller that read `instructions.value.teammates`.
async function refreshSharedStores(): Promise<void> {
  await Promise.allSettled([loadRoster(), loadInstructions()]);
}

export interface MemberAdminFormProps {
  member: Member;
  /** True when this member is the sole holder of `members.manage`. */
  isSoleMemberManager: boolean;
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
  isSoleMemberManager,
  isSelf,
  onChanged,
  onReveal,
  style,
}: MemberAdminFormProps) {
  const rowKey = member.name;
  const busy = actionBusy.value;
  const disabled = busy !== null;
  const [roleDescription, setRoleDescription] = useState(member.role.description);
  const [instructions, setInstructions] = useState(member.instructions);

  async function onChangePermissions(next: Permission[]): Promise<void> {
    if (isSoleMemberManager && !next.includes('members.manage')) {
      alert('Cannot remove members.manage from its sole holder. Grant it to another member first.');
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
      !(await confirmDialog({
        title: `Rotate bearer token for '${member.name}'?`,
        body: 'The existing token will be invalidated immediately.',
        verb: 'Rotate',
      }))
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
      !(await confirmDialog({
        title: `(Re-)enroll TOTP for '${member.name}'?`,
        body: 'Any authenticator app currently bound to this member will stop working.',
        verb: 'Re-enroll',
      }))
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
    if (isSoleMemberManager) {
      alert('Cannot remove the sole members.manage holder. Grant it to another member first.');
      return;
    }
    if (isSelf) {
      if (
        !(await confirmDialog({
          title: `Delete YOURSELF ('${member.name}')?`,
          body: 'You will be signed out immediately.',
          verb: 'Delete',
        }))
      )
        return;
    } else if (
      !(await confirmDialog({
        title: `Delete member '${member.name}'?`,
        body: 'Their bearer token and TOTP secret will be invalidated; their files and message history remain.',
        verb: 'Delete',
      }))
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
          style="font-family:var(--ef-font-mono);font-size:11px;letter-spacing:.04em;color:var(--ef-text-muted);text-transform:uppercase"
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

        <label style="display:flex;flex-direction:column;gap:4px;font-family:var(--ef-font-mono);font-size:11px;letter-spacing:.04em;color:var(--ef-text-muted);text-transform:uppercase">
          <span>role description</span>
          <textarea
            class="input"
            rows={2}
            style="font-size:13px;font-family:var(--ef-font-body);text-transform:none;letter-spacing:normal;color:var(--ef-text)"
            value={roleDescription}
            disabled={disabled}
            onInput={(e) => setRoleDescription((e.currentTarget as HTMLTextAreaElement).value)}
            onBlur={(e) =>
              void onChangeRoleDescription((e.currentTarget as HTMLTextAreaElement).value)
            }
          />
          <TextMetrics text={roleDescription} />
        </label>

        <label style="display:flex;flex-direction:column;gap:4px;font-family:var(--ef-font-mono);font-size:11px;letter-spacing:.04em;color:var(--ef-text-muted);text-transform:uppercase">
          <span>personal instructions</span>
          <textarea
            class="input"
            rows={6}
            placeholder="Standing instructions for this member. Pinned into the agent's system prompt at runner startup."
            style="font-size:13px;font-family:var(--ef-font-body);text-transform:none;letter-spacing:normal;color:var(--ef-text);white-space:pre-wrap"
            value={instructions}
            disabled={disabled}
            onInput={(e) => setInstructions((e.currentTarget as HTMLTextAreaElement).value)}
            onBlur={(e) =>
              void onChangeInstructions((e.currentTarget as HTMLTextAreaElement).value)
            }
          />
          <TextMetrics text={instructions} />
        </label>

        {/* Role, description, and personal instructions are pinned
            into the agent's system prompt at session start. The broker
            versions the composed text and reports restart-pending on
            the roster, so this card shows the LIVE state for this
            member rather than a standing warning a manager has to
            evaluate themselves. */}
        {roster.value?.restartPending?.includes(member.name) === true ? (
          <div
            class="card"
            style="padding:8px 10px;font-family:var(--ef-font-mono);font-size:11px;line-height:1.4;color:var(--ef-text-muted);border-left:3px solid var(--ef-lamp-caution)"
          >
            <span style="color:var(--ef-lamp-caution)">Restart pending</span> — this member's live
            session runs superseded instructions. The current text applies from their next session.
          </div>
        ) : (
          <div
            class="card"
            style="padding:8px 10px;font-family:var(--ef-font-mono);font-size:11px;line-height:1.4;color:var(--ef-text-muted)"
          >
            Instructions apply from the member's next session. If a live session falls behind an
            edit, the broker lists the member restart-pending here and on the roster.
          </div>
        )}

        <div style="display:flex;flex-direction:column;gap:6px">
          <span style="font-family:var(--ef-font-mono);font-size:11px;letter-spacing:.04em;color:var(--ef-text-muted);text-transform:uppercase">
            Permissions
          </span>
          <PermissionsEditor
            value={member.permissions}
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
            disabled={disabled || isSoleMemberManager}
            style="color:var(--ef-lamp-alarm)"
            title={
              isSoleMemberManager
                ? 'Cannot delete the sole members.manage holder'
                : 'Delete this member'
            }
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
