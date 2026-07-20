/**
 * MembersPanel — admin-only list of every team member with an
 * entrypoint to create new ones.
 *
 * Per-member admin (role edit, rotate token, TOTP, delete) has moved
 * to the Manage tab on `/@:name`. This panel is just "who is on the
 * team" plus the Add Member flow. Rows link through to the profile.
 */

import { signal } from '@preact/signals';
import type { Member, Permission, PermissionPresets } from 'csuite-sdk/types';
import { hasPermission } from 'csuite-sdk/types';
import { useEffect } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import { getClient } from '../lib/client.js';
import { summarizePermissions as summarize } from '../lib/permissions.js';
import { loadRoster } from '../lib/roster.js';
import { selectMemberProfile } from '../lib/view.js';
import { PendingEnrollments } from './members/PendingEnrollments.js';
import { PermissionsEditor } from './members/PermissionsEditor.js';
import { type Reveal, RevealBanner, revealTargetName } from './members/Reveal.js';
import { EmptyState, ErrorCallout, Loading, PageHeader } from './ui/index.js';

const members = signal<Member[] | null>(null);
const loadError = signal<string | null>(null);
const reveal = signal<Reveal | null>(null);
const formOpen = signal(false);
const formName = signal('');
const formRoleTitle = signal('engineer');
const formRoleDescription = signal('');
const formInstructions = signal('');
const formPermissions = signal<Permission[]>([]);
const formError = signal<string | null>(null);
const formBusy = signal(false);

async function refresh(): Promise<void> {
  loadError.value = null;
  try {
    members.value = await getClient().listMembers();
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  }
}

export function MembersPanel() {
  const b = briefing.value;

  useEffect(() => {
    void refresh();
  }, []);

  if (!b) return <Loading label="Loading members…" />;

  if (!hasPermission(b.permissions, 'members.manage')) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:24px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left))"
      >
        <ErrorCallout
          title="Restricted"
          message="Managing members requires the members.manage permission."
        />
      </div>
    );
  }

  const list = members.value;
  const err = loadError.value;
  const revealed = reveal.value;

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <PageHeader
        eyebrow="Team"
        title="Members"
        actions={
          <button
            type="button"
            class="btn btn-primary btn-sm"
            onClick={() => {
              formOpen.value = true;
              formError.value = null;
              formName.value = '';
              formRoleTitle.value = 'engineer';
              formRoleDescription.value = '';
              formInstructions.value = '';
              formPermissions.value = [];
            }}
            disabled={formBusy.value}
          >
            + New member
          </button>
        }
      />

      {err !== null && (
        <ErrorCallout title="Failed to load members" message={err} style="margin-bottom:18px" />
      )}

      {revealed !== null &&
        (list === null || !list.some((m) => m.name === revealTargetName(revealed))) && (
          <RevealBanner
            reveal={revealed}
            onDismiss={() => {
              reveal.value = null;
            }}
          />
        )}

      {formOpen.value && <CreateMemberForm presets={b.team.permissionPresets} />}

      <PendingEnrollments style="margin-bottom:18px" />

      {list === null && err === null && <Loading label="Loading…" />}

      {list !== null && list.length === 0 && (
        <EmptyState title="No members yet" message="Click + New member to add one." />
      )}

      {list !== null && list.length > 0 && (
        <div class="panel">
          <ul style="display:flex;flex-direction:column;list-style:none;padding:0;margin:0">
            {list.map((m, idx) => (
              <MemberListRow
                key={m.name}
                member={m}
                isSelf={m.name === b.name}
                isLast={idx === list.length - 1}
                presets={b.team.permissionPresets}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MemberListRow({
  member,
  isSelf,
  isLast,
  presets,
}: {
  member: Member;
  isSelf: boolean;
  isLast: boolean;
  presets: PermissionPresets;
}) {
  const border = isLast ? '' : 'border-bottom:1px solid var(--rule);';
  const summary = summarize(member.permissions, presets);
  return (
    <li>
      <button
        type="button"
        onClick={() => selectMemberProfile(member.name, 'manage')}
        class="hover-row w-full flex items-center justify-between gap-3"
        style={`padding:14px 16px;${border};background:transparent;text-align:left;cursor:pointer`}
        aria-label={`Manage ${member.name}`}
      >
        <div class="min-w-0 flex items-center gap-3 flex-wrap">
          <span
            class="font-display"
            style="font-weight:700;letter-spacing:-0.01em;font-size:15px;color:var(--ink)"
          >
            {member.name}
          </span>
          {isSelf && (
            <span style="font-family:var(--f-mono);font-size:10px;letter-spacing:.14em;color:var(--muted);text-transform:uppercase">
              (you)
            </span>
          )}
          <span class={`badge ${badgeVariantFor(summary)}`}>{summary.label}</span>
          <span style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);letter-spacing:.04em">
            {member.role.title}
          </span>
        </div>
        <span style="font-family:var(--f-mono);font-size:11px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;flex-shrink-0">
          → Manage
        </span>
      </button>
    </li>
  );
}

function badgeVariantFor(summary: {
  kind: 'baseline' | 'preset' | 'custom';
  isAdmin: boolean;
}): string {
  if (summary.isAdmin) return 'solid';
  if (summary.kind === 'custom' || summary.kind === 'preset') return 'ember solid';
  return 'soft';
}

function CreateMemberForm({ presets }: { presets: PermissionPresets }) {
  const err = formError.value;
  const busy = formBusy.value;

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const name = formName.value.trim();
    const title = formRoleTitle.value.trim();
    const description = formRoleDescription.value.trim();
    const instructions = formInstructions.value.trim();
    if (!name) {
      formError.value = 'Name is required.';
      return;
    }
    if (!title) {
      formError.value = 'Role title is required.';
      return;
    }
    formBusy.value = true;
    try {
      const response = await getClient().createMember({
        name,
        role: { title, description },
        instructions,
        permissions: formPermissions.value,
      });
      reveal.value = { kind: 'create', response };
      formOpen.value = false;
      await refresh();
      await loadRoster();
    } catch (ex) {
      formError.value = ex instanceof Error ? ex.message : String(ex);
    } finally {
      formBusy.value = false;
    }
  }

  return (
    <form class="panel" onSubmit={(e) => void onSubmit(e)} style="padding:16px;margin-bottom:18px">
      <div class="eyebrow" style="margin-bottom:10px">
        New member
      </div>
      {err !== null && <ErrorCallout message={err} style="margin-bottom:10px" />}
      <div style="display:flex;flex-direction:column;gap:10px">
        <Labeled label="Name" hint="Alphanumeric, . _ - allowed">
          <input
            class="input"
            value={formName.value}
            onInput={(e) => {
              formName.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="engineer-1"
          />
        </Labeled>
        <Labeled label="Role title" hint="Freeform — director, engineer, qa-lead, …">
          <input
            class="input"
            value={formRoleTitle.value}
            onInput={(e) => {
              formRoleTitle.value = (e.currentTarget as HTMLInputElement).value;
            }}
          />
        </Labeled>
        <Labeled label="Role description" hint="What this role does on the team (public)">
          <textarea
            class="input"
            rows={2}
            value={formRoleDescription.value}
            onInput={(e) => {
              formRoleDescription.value = (e.currentTarget as HTMLTextAreaElement).value;
            }}
          />
        </Labeled>
        <Labeled label="Instructions" hint="Personal working directives (private)">
          <textarea
            class="input"
            rows={3}
            value={formInstructions.value}
            onInput={(e) => {
              formInstructions.value = (e.currentTarget as HTMLTextAreaElement).value;
            }}
          />
        </Labeled>
        <div style="display:flex;flex-direction:column;gap:4px">
          <div class="eyebrow">Permissions</div>
          <PermissionsEditor
            value={formPermissions.value}
            presets={presets}
            onChange={(next) => {
              formPermissions.value = next;
            }}
            disabled={busy}
          />
          <div style="font-family:var(--f-sans);font-size:11.5px;color:var(--muted);font-style:italic;margin-top:2px">
            Tick individual leaves or click a quick-apply preset above.
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2" style="margin-top:14px">
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Creating…' : 'Create member'}
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={() => {
            formOpen.value = false;
            formError.value = null;
          }}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Labeled({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: preact.ComponentChildren;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the input/select/textarea is passed in as a child
    <label style="display:flex;flex-direction:column;gap:4px">
      <div class="eyebrow">{label}</div>
      {children}
      <div style="font-family:var(--f-sans);font-size:11.5px;color:var(--muted);font-style:italic">
        {hint}
      </div>
    </label>
  );
}

export function __resetMembersPanelForTests(): void {
  members.value = null;
  loadError.value = null;
  reveal.value = null;
  formOpen.value = false;
  formName.value = '';
  formRoleTitle.value = 'engineer';
  formRoleDescription.value = '';
  formInstructions.value = '';
  formPermissions.value = [];
  formError.value = null;
  formBusy.value = false;
}
