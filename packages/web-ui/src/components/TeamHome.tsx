/**
 * TeamHome — the landing page at `/`.
 *
 * Replaces RosterPanel as the default view. Shows:
 *   - Team name + context (the team's "about"), editable in place
 *     by members holding `team.manage`
 *   - At-a-glance stats (active objectives, blocked, total members)
 *   - Roster — click a row to open the member's profile
 *     (hover card reveals the DM action)
 *
 * The team chat + DMs live in the sidebar; TeamHome doesn't duplicate
 * them. The goal here is "what is this team about + who's on it" in a
 * single, scannable view.
 */

import { signal } from '@preact/signals';
import type { Presence } from 'csuite-sdk/types';
import { hasPermission } from 'csuite-sdk/types';
import { briefing, loadBriefing } from '../lib/briefing.js';
import { getClient } from '../lib/client.js';
import { objectives } from '../lib/objectives.js';
import { type PermissionSummary, summarizePermissions } from '../lib/permissions.js';
import { presenceActivity, roster } from '../lib/roster.js';
import { selectMemberProfile } from '../lib/view.js';
import { ErrorCallout, Loading, PageHeader } from './ui/index.js';

export interface TeamHomeProps {
  viewer: string;
}

export function TeamHome({ viewer }: TeamHomeProps) {
  const b = briefing.value;
  const r = roster.value;
  const obj = objectives.value;

  if (!b || !r) {
    return <Loading label="Loading team…" />;
  }

  const connectedByName = new Map<string, Presence>(r.connected.map((a) => [a.name, a]));
  const onlineCount = r.connected.filter((c) => c.connected > 0).length;
  const activeObjectives = obj.filter((o) => o.status === 'active').length;
  const blockedObjectives = obj.filter((o) => o.status === 'blocked').length;

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <PageHeader eyebrow="Team" title={b.team.name} />

      <TeamContextSection
        context={b.team.context}
        canManage={hasPermission(b.permissions, 'team.manage')}
      />

      <div
        class="grid"
        style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:24px"
      >
        <StatCard label="Members" value={r.teammates.length} />
        <StatCard label="Online" value={onlineCount} />
        <StatCard label="Active objectives" value={activeObjectives} />
        <StatCard
          label="Blocked"
          value={blockedObjectives}
          {...(blockedObjectives > 0 ? { accent: 'ember' as const } : {})}
        />
      </div>

      <div class="eyebrow" style="margin-bottom:10px">
        Roster
      </div>
      <div class="panel">
        <ul style="display:flex;flex-direction:column;list-style:none;padding:0;margin:0">
          {r.teammates.map((t, idx) => {
            const conn = connectedByName.get(t.name);
            const online = (conn?.connected ?? 0) > 0;
            // 3-state activity, orthogonal to the connection state above.
            const activity = presenceActivity(conn);
            const working = activity === 'working';
            const blocked = activity === 'blocked';
            const isSelf = t.name === viewer;
            const isLast = idx === r.teammates.length - 1;
            const rowBorder = isLast ? '' : 'border-bottom:1px solid var(--rule);';
            const summary = summarizePermissions(t.permissions, b.team.permissionPresets);

            return (
              <li key={t.name}>
                <button
                  type="button"
                  onClick={() => selectMemberProfile(t.name)}
                  class="hover-row w-full flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3"
                  style={`padding:14px 16px;${rowBorder};background:transparent;text-align:left;cursor:pointer`}
                  aria-label={`Open profile for ${t.name}`}
                >
                  <div class="flex items-center gap-3 min-w-0 flex-wrap">
                    <span class="avatar" aria-hidden="true">
                      {initials(t.name)}
                    </span>
                    <div class="min-w-0 flex flex-col gap-0.5">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span
                          class="font-display"
                          style="font-weight:700;letter-spacing:-0.01em;font-size:15px;line-height:1.1;color:var(--ink)"
                        >
                          {t.name}
                        </span>
                        {isSelf && (
                          <span style="font-family:var(--f-mono);font-size:10px;letter-spacing:.14em;color:var(--muted);text-transform:uppercase">
                            (you)
                          </span>
                        )}
                        <span class={`badge ${roleBadgeVariant(summary)}`}>
                          {t.role.title.toUpperCase()}
                        </span>
                        {summary.kind !== 'baseline' && (
                          <span
                            class="badge soft"
                            style="font-size:9.5px;letter-spacing:.06em"
                            title={`Permissions: ${summary.label}`}
                          >
                            {summary.label}
                          </span>
                        )}
                      </div>
                      {t.role.description.length > 0 && (
                        <div style="font-family:var(--f-sans);font-size:11.5px;color:var(--muted);line-height:1.4">
                          {t.role.description}
                        </div>
                      )}
                    </div>
                  </div>
                  <span
                    class="flex items-center gap-2 flex-shrink-0"
                    style="font-family:var(--f-mono);font-size:11.5px;letter-spacing:.08em;text-transform:uppercase"
                  >
                    {working ? (
                      // Actively processing a turn.
                      <span class="spinner sm" aria-hidden="true" />
                    ) : blocked ? (
                      // Waiting on a human — amber "needs input" attention
                      // dot (pulses) so an operator's eye is drawn to it.
                      <span class="dot warn pulse" aria-hidden="true" />
                    ) : (
                      // Idle: fall back to the connection dot.
                      <span class={`dot${online ? ' ok' : ' muted'}`} aria-hidden="true" />
                    )}
                    <span
                      style={`color:var(--${blocked ? 'ember' : working || online ? 'steel' : 'muted'})`}
                    >
                      {working
                        ? 'WORKING'
                        : blocked
                          ? 'NEEDS INPUT'
                          : online
                            ? 'ONLINE'
                            : 'OFFLINE'}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

const ctxEditing = signal(false);
const ctxDraft = signal('');
const ctxBusy = signal(false);
const ctxError = signal<string | null>(null);

/**
 * The team's standing context ("about"), with in-place editing for
 * `team.manage` holders. Saving PATCHes /team then reloads the
 * briefing so the page reflects the new prose immediately. Agents
 * pick the change up on their next session (the briefing string is
 * frozen per session by the MCP protocol).
 */
function TeamContextSection({ context, canManage }: { context: string; canManage: boolean }) {
  const busy = ctxBusy.value;

  async function onSave(e: Event): Promise<void> {
    e.preventDefault();
    ctxBusy.value = true;
    ctxError.value = null;
    try {
      await getClient().updateTeam({ context: ctxDraft.value.trim() });
      await loadBriefing();
      ctxEditing.value = false;
    } catch (err) {
      ctxError.value = err instanceof Error ? err.message : String(err);
    } finally {
      ctxBusy.value = false;
    }
  }

  if (ctxEditing.value) {
    return (
      <form class="panel" onSubmit={(e) => void onSave(e)} style="padding:16px;margin-bottom:24px">
        <div class="eyebrow" style="margin-bottom:8px">
          Team context
        </div>
        {ctxError.value !== null && (
          <ErrorCallout message={ctxError.value} style="margin-bottom:10px" />
        )}
        <textarea
          class="input w-full"
          rows={6}
          value={ctxDraft.value}
          onInput={(e) => {
            ctxDraft.value = (e.currentTarget as HTMLTextAreaElement).value;
          }}
          placeholder="What is this team here to do, and what should every member know?"
          disabled={busy}
        />
        <div style="font-family:var(--f-sans);font-size:11.5px;color:var(--muted);font-style:italic;margin-top:6px">
          Standing context every member inherits. Agents see edits on their next session.
        </div>
        <div class="flex items-center gap-2" style="margin-top:12px">
          <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => {
              ctxEditing.value = false;
              ctxError.value = null;
            }}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  const startEdit = () => {
    ctxDraft.value = context;
    ctxError.value = null;
    ctxEditing.value = true;
  };

  if (context.length === 0) {
    if (!canManage) return null;
    return (
      <div style="margin-bottom:24px">
        <button type="button" class="btn btn-ghost btn-sm" onClick={startEdit}>
          + Add team context
        </button>
      </div>
    );
  }

  return (
    <div style="margin-bottom:24px">
      <div style="font-family:var(--f-sans);font-size:13.5px;color:var(--muted);line-height:1.55;white-space:pre-wrap">
        {context}
      </div>
      {canManage && (
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          style="margin-top:8px"
          onClick={startEdit}
        >
          Edit context
        </button>
      )}
    </div>
  );
}

export function __resetTeamHomeForTests(): void {
  ctxEditing.value = false;
  ctxDraft.value = '';
  ctxBusy.value = false;
  ctxError.value = null;
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: 'ember' }) {
  const color = accent === 'ember' ? 'var(--ember)' : 'var(--ink)';
  return (
    <div class="card" style="padding:14px 16px">
      <div class="eyebrow" style="margin:0">
        {label}
      </div>
      <div
        class="font-display"
        style={`font-size:28px;font-weight:700;letter-spacing:-0.02em;color:${color};line-height:1.1;margin-top:4px`}
      >
        {value}
      </div>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function roleBadgeVariant(summary: PermissionSummary): string {
  if (summary.isAdmin) return 'solid';
  if (summary.kind === 'preset' || summary.kind === 'custom') return 'ember solid';
  return 'soft';
}
