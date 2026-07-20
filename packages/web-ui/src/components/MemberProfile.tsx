/**
 * MemberProfile — the one page that represents a team member.
 *
 * Replaces the admin-only AgentPage. Everyone can open a teammate's
 * profile (`/@:name`); progressive disclosure shows admins the extra
 * tabs (Activity, Manage). Non-admins see Overview / Objectives /
 * Files.
 *
 *   ← Home › @alice
 *   ┌───────────────────────────────────────────────┐
 *   │ [AV] alice  · ENGINEER · ●ONLINE              │
 *   │      "ships the billing service"              │
 *   │                         [→ DM] [→ Files]      │
 *   ├───────────────────────────────────────────────┤
 *   │ Overview  Objectives  Activity*  Files  Manage*│  (*admin)
 *   ├───────────────────────────────────────────────┤
 *   │  tab content                                   │
 *   └───────────────────────────────────────────────┘
 */

import { signal } from '@preact/signals';
import type { Member, Objective, Teammate } from 'csuite-sdk/types';
import { hasPermission } from 'csuite-sdk/types';
import { useEffect } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import { getClient } from '../lib/client.js';
import { memberActivityError, startMemberActivitySubscribe } from '../lib/member-activity.js';
import { objectives as objectivesSignal } from '../lib/objectives.js';
import { PERMISSION_META, sortLeaves, summarizePermissions } from '../lib/permissions.js';
import { roster as rosterSignal } from '../lib/roster.js';
import type { ProfileTab } from '../lib/routes.js';
import {
  selectDmWith,
  selectFiles,
  selectMemberProfile,
  selectObjectiveDetail,
  selectOverview,
} from '../lib/view.js';
import { AgentTimeline } from './AgentTimeline.js';
import { MemberAdminForm } from './members/MemberAdminForm.js';
import { type Reveal, RevealBanner } from './members/Reveal.js';
import { EmptyState, ErrorCallout, Loading, Mention } from './ui/index.js';

/** Full Member detail for the active Manage tab. Loaded on demand. */
const manageMember = signal<Member | null>(null);
/**
 * Full team roster as returned by `/members`. Kept alongside
 * `manageMember` so the "is this the last admin?" guard reads from
 * a fresh list fetched by the same call that hydrated the form —
 * `briefing.teammates` used to be the source here and was stale
 * between mount and the next briefing refresh, incorrectly blocking
 * legitimate demotes.
 */
const manageAllMembers = signal<Member[]>([]);
const manageLoading = signal(false);
const manageError = signal<string | null>(null);
const manageReveal = signal<Reveal | null>(null);

export interface MemberProfileProps {
  name: string;
  tab: ProfileTab;
  viewer: string;
}

export function MemberProfile({ name, tab, viewer }: MemberProfileProps) {
  const b = briefing.value;
  const rosterResp = rosterSignal.value;
  const objectives = objectivesSignal.value;
  const isAdmin = b !== null && hasPermission(b.permissions, 'members.manage');
  const isSelf = viewer === name;

  const teammate: Teammate | undefined =
    rosterResp?.teammates.find((t) => t.name === name) ?? b?.teammates.find((t) => t.name === name);
  const connected = rosterResp?.connected.find((c) => c.name === name)?.connected ?? 0;
  const online = connected > 0;

  const availableTabs = tabsFor({ isAdmin, isSelf });
  const effectiveTab = availableTabs.includes(tab) ? tab : 'overview';

  // Start/stop the activity subscription only while the Activity
  // tab is visible. Avoids eating server bandwidth from members the
  // viewer isn't actively inspecting.
  useEffect(() => {
    if (effectiveTab !== 'activity') return;
    if (!isAdmin) return;
    return startMemberActivitySubscribe({ name });
  }, [name, effectiveTab, isAdmin]);

  if (!b) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:18px max(1rem,env(safe-area-inset-right)) 18px max(1rem,env(safe-area-inset-left))"
      >
        <div class="eyebrow">Loading briefing…</div>
      </div>
    );
  }

  // Not-found: the briefing has loaded but this name isn't on the team.
  if (!teammate && b.name !== name) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:18px max(1rem,env(safe-area-inset-right)) 18px max(1rem,env(safe-area-inset-left));display:flex;flex-direction:column;gap:14px"
      >
        <Crumbs name={name} />
        <EmptyState
          title="No such member"
          message={`There's no teammate called "${name}" on this team.`}
          action={
            <button type="button" class="btn btn-ghost btn-sm" onClick={selectOverview}>
              ← Back to Home
            </button>
          }
        />
      </div>
    );
  }

  // Use the viewer's own briefing identity when viewing self — the
  // roster may not include the viewer.
  const displayRole = teammate?.role ?? (isSelf ? b.role : { title: '—', description: '' });
  const displayPerms = teammate?.permissions ?? (isSelf ? b.permissions : []);
  const permSummary = summarizePermissions(displayPerms, b.team.permissionPresets);

  return (
    <div class="flex-1 flex flex-col min-h-0">
      <div
        class="flex-shrink-0"
        style="padding:18px max(1rem,env(safe-area-inset-right)) 0 max(1rem,env(safe-area-inset-left));border-bottom:1px solid var(--rule)"
      >
        <Crumbs name={name} />

        <div class="flex items-center gap-3 flex-wrap" style="margin-top:10px">
          <span class="avatar" aria-hidden="true" style="width:42px;height:42px;font-size:16px">
            {initials(name)}
          </span>
          <h1
            class="font-display"
            style="font-size:26px;font-weight:700;letter-spacing:-0.02em;color:var(--ink);line-height:1.15;margin:0"
          >
            {name}
            {isSelf && (
              <span style="font-family:var(--f-mono);font-size:11px;letter-spacing:.14em;color:var(--muted);text-transform:uppercase;margin-left:8px">
                (you)
              </span>
            )}
          </h1>
          <span class={`badge ${badgeClassFor(permSummary)}`}>
            {displayRole.title.toUpperCase()}
          </span>
          <span class={`badge ${online ? 'soft' : 'muted'}`}>
            {online ? '● ONLINE' : '◇ OFFLINE'}
          </span>
        </div>

        {displayRole.description.length > 0 && (
          <div style="margin-top:8px;font-family:var(--f-sans);font-size:14px;color:var(--graphite);line-height:1.45;font-style:italic">
            {displayRole.description}
          </div>
        )}

        <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <span class="eyebrow" style="margin:0" title={`Permission preset: ${permSummary.label}`}>
            {permSummary.label}
          </span>
          <span style="color:var(--rule-strong)" aria-hidden="true">
            ·
          </span>
          {displayPerms.length === 0 ? (
            <span style="font-family:var(--f-mono);font-size:11px;color:var(--muted);letter-spacing:.04em;font-style:italic">
              no elevated permissions
            </span>
          ) : (
            <div class="flex flex-wrap gap-1">
              {sortLeaves(displayPerms).map((p) => (
                <span
                  key={p}
                  class="badge soft"
                  style="font-family:var(--f-mono);font-size:10px;letter-spacing:.04em;padding:2px 6px"
                  title={labelFor(p)}
                >
                  {p}
                </span>
              ))}
            </div>
          )}
        </div>

        <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
          {!isSelf && (
            <button type="button" onClick={() => selectDmWith(name)} class="btn btn-ghost btn-sm">
              → DM {name}
            </button>
          )}
          <button
            type="button"
            onClick={() => selectFiles(`/${name}`)}
            class="btn btn-ghost btn-sm"
            title={`Browse ${name}'s files`}
          >
            → Browse files
          </button>
        </div>

        <TabBar available={availableTabs} active={effectiveTab} name={name} />
      </div>

      <div
        class="flex-1 overflow-y-auto"
        style="padding:18px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left));display:flex;flex-direction:column;gap:14px"
      >
        {effectiveTab === 'overview' && (
          <OverviewTab
            name={name}
            objectives={objectives}
            teammate={teammate}
            isSelf={isSelf}
            selfBrief={b.name === name ? b.role : null}
          />
        )}
        {effectiveTab === 'objectives' && <ObjectivesTab name={name} objectives={objectives} />}
        {effectiveTab === 'activity' && <ActivityTab error={memberActivityError.value} />}
        {effectiveTab === 'files' && (
          <EmptyState
            title="Files"
            message={`${name}'s home is /${name}. Open the Files browser to view them.`}
            action={
              <button
                type="button"
                class="btn btn-primary btn-sm"
                onClick={() => selectFiles(`/${name}`)}
              >
                Open Files →
              </button>
            }
          />
        )}
        {effectiveTab === 'manage' && (
          <ManageTab name={name} viewer={viewer} presets={b.team.permissionPresets} />
        )}
      </div>
    </div>
  );
}

function Crumbs({ name }: { name: string }) {
  return (
    <nav aria-label="Breadcrumb" class="crumbs">
      <button type="button" onClick={selectOverview} class="text-link">
        ← Home
      </button>
      <span class="sep" aria-hidden="true">
        ›
      </span>
      <span class="current">@{name}</span>
    </nav>
  );
}

function TabBar({
  available,
  active,
  name,
}: {
  available: ProfileTab[];
  active: ProfileTab;
  name: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="Profile sections"
      class="flex flex-wrap"
      style="gap:0;margin-top:18px;margin-bottom:-1px"
    >
      {available.map((t) => {
        const isActive = t === active;
        return (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => selectMemberProfile(name, t)}
            class="flex-shrink-0"
            style={`padding:8px 14px;background:transparent;border:none;border-bottom:2px solid ${isActive ? 'var(--ink)' : 'transparent'};font-family:var(--f-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${isActive ? 'var(--ink)' : 'var(--muted)'};font-weight:${isActive ? 700 : 500};cursor:pointer`}
          >
            {TAB_LABELS[t]}
          </button>
        );
      })}
    </div>
  );
}

function OverviewTab({
  name,
  objectives,
  teammate,
  isSelf,
  selfBrief,
}: {
  name: string;
  objectives: Objective[];
  teammate: Teammate | undefined;
  isSelf: boolean;
  selfBrief: { title: string; description: string } | null;
}) {
  const assignedCount = objectives.filter(
    (o) => o.assignee === name && o.status !== 'done' && o.status !== 'cancelled',
  ).length;
  const watchingCount = objectives.filter(
    (o) => o.assignee !== name && o.watchers.includes(name),
  ).length;

  const b = briefing.value;
  const permsLabel = teammate
    ? summarizePermissions(teammate.permissions, b?.team.permissionPresets ?? {}).label
    : isSelf && selfBrief
      ? 'self'
      : 'member';

  return (
    <section class="card">
      <div class="eyebrow" style="margin-bottom:12px">
        Summary
      </div>
      <dl style="display:grid;grid-template-columns:max-content 1fr;gap:8px 16px;font-family:var(--f-sans);font-size:13.5px">
        <dt style="color:var(--muted);font-family:var(--f-mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase">
          Permissions
        </dt>
        <dd style="color:var(--ink);margin:0">{permsLabel}</dd>
        <dt style="color:var(--muted);font-family:var(--f-mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase">
          Active objectives
        </dt>
        <dd style="color:var(--ink);margin:0">{assignedCount}</dd>
        <dt style="color:var(--muted);font-family:var(--f-mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase">
          Watching
        </dt>
        <dd style="color:var(--ink);margin:0">{watchingCount}</dd>
      </dl>
    </section>
  );
}

function ObjectivesTab({ name, objectives }: { name: string; objectives: Objective[] }) {
  const assigned = objectives.filter(
    (o) => o.assignee === name && o.status !== 'done' && o.status !== 'cancelled',
  );
  const watching = objectives.filter(
    (o) =>
      o.assignee !== name &&
      o.watchers.includes(name) &&
      o.status !== 'done' &&
      o.status !== 'cancelled',
  );
  const done = objectives.filter(
    (o) => o.assignee === name && (o.status === 'done' || o.status === 'cancelled'),
  );
  return (
    <>
      <section class="card">
        <ObjectiveList title="Assigned" objectives={assigned} emptyLabel="none assigned" />
      </section>
      <section class="card">
        <ObjectiveList title="Watching" objectives={watching} emptyLabel="nothing on watch" />
      </section>
      {done.length > 0 && (
        <section class="card">
          <ObjectiveList title="Closed" objectives={done} emptyLabel="none" />
        </section>
      )}
    </>
  );
}

function ObjectiveList({
  title,
  objectives,
  emptyLabel,
}: {
  title: string;
  objectives: Objective[];
  emptyLabel: string;
}) {
  return (
    <div>
      <div class="eyebrow" style="margin-bottom:8px">
        {title} ({objectives.length})
      </div>
      {objectives.length === 0 ? (
        <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted);font-style:italic">
          {emptyLabel}
        </div>
      ) : (
        <ul style="display:flex;flex-direction:column;gap:4px;list-style:none;padding:0;margin:0">
          {objectives.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => selectObjectiveDetail(o.id)}
                class="text-link-steel"
                style="font-family:var(--f-sans);font-size:14px;text-align:left;padding:0;background:none;border:none;cursor:pointer"
              >
                <span style={`color:${statusColor(o.status)};font-weight:600`}>[{o.status}]</span>{' '}
                {o.title} <span style="color:var(--muted)">— assigned to </span>
                <Mention name={o.assignee} plain variant="text" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityTab({ error }: { error: string | null }) {
  return (
    <>
      {error && <ErrorCallout message={error} />}
      <AgentTimeline />
    </>
  );
}

function ManageTab({
  name,
  viewer,
  presets,
}: {
  name: string;
  viewer: string;
  presets: import('csuite-sdk/types').PermissionPresets;
}) {
  const member = manageMember.value;
  const loading = manageLoading.value;
  const err = manageError.value;
  const revealed = manageReveal.value;

  useEffect(() => {
    let cancelled = false;
    manageError.value = null;
    manageLoading.value = true;
    void (async () => {
      try {
        const list = await getClient().listMembers();
        if (cancelled) return;
        manageAllMembers.value = list;
        const m = list.find((x) => x.name === name) ?? null;
        manageMember.value = m;
        if (m === null) manageError.value = `Member '${name}' not found.`;
      } catch (e) {
        if (!cancelled) manageError.value = e instanceof Error ? e.message : String(e);
      } finally {
        if (!cancelled) manageLoading.value = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name]);

  async function refreshAfterChange(): Promise<void> {
    try {
      const list = await getClient().listMembers();
      manageAllMembers.value = list;
      const m = list.find((x) => x.name === name) ?? null;
      manageMember.value = m;
    } catch {
      // Non-fatal — the next manual refresh will recover.
    }
  }

  if (loading && member === null) return <Loading label={`Loading ${name}…`} />;
  if (err !== null) return <ErrorCallout title="Manage unavailable" message={err} />;
  if (member === null) return <EmptyState title="Member not found" message={name} />;

  // `manageAllMembers` is the list the Manage tab just fetched itself,
  // so it reflects the permission state right now (not the stale
  // briefing snapshot that's only refreshed at Shell boot). The guard
  // blocks "strip the last admin" when there's truly only one, but
  // correctly allows an admin demoting a peer when ≥2 admins exist.
  const totalAdmins = manageAllMembers.value.filter((m) =>
    m.permissions.includes('members.manage'),
  ).length;
  const isLastAdmin = member.permissions.includes('members.manage') && totalAdmins <= 1;

  return (
    <>
      {revealed && (
        <RevealBanner
          reveal={revealed}
          onDismiss={() => {
            manageReveal.value = null;
          }}
        />
      )}
      <MemberAdminForm
        member={member}
        presets={presets}
        isLastAdmin={isLastAdmin}
        isSelf={viewer === name}
        onChanged={refreshAfterChange}
        onReveal={(r) => {
          manageReveal.value = r;
        }}
      />
    </>
  );
}

export function __resetMemberProfileForTests(): void {
  manageMember.value = null;
  manageAllMembers.value = [];
  manageLoading.value = false;
  manageError.value = null;
  manageReveal.value = null;
}

const TAB_LABELS: Record<ProfileTab, string> = {
  overview: 'Overview',
  objectives: 'Objectives',
  activity: 'Activity',
  files: 'Files',
  manage: 'Manage',
};

function tabsFor({ isAdmin, isSelf }: { isAdmin: boolean; isSelf: boolean }): ProfileTab[] {
  const tabs: ProfileTab[] = ['overview', 'objectives', 'files'];
  if (isAdmin) tabs.splice(2, 0, 'activity');
  if (isAdmin && !isSelf) tabs.push('manage');
  return tabs;
}

function initials(name: string): string {
  const parts = name.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function badgeClassFor(summary: import('../lib/permissions.js').PermissionSummary): string {
  if (summary.isAdmin) return 'solid';
  if (summary.kind === 'preset' || summary.kind === 'custom') return 'ember';
  return 'soft';
}

function labelFor(leaf: string): string {
  const meta = PERMISSION_META.find((m) => m.key === leaf);
  return meta ? `${meta.label} — ${meta.description}` : leaf;
}

function statusColor(status: Objective['status']): string {
  switch (status) {
    case 'active':
      return 'var(--ok, #2e7d32)';
    case 'blocked':
      return 'var(--ember)';
    case 'done':
      return 'var(--muted)';
    case 'cancelled':
      return 'var(--muted)';
  }
}
