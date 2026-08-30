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
import type { Presence, ProcessDocument } from 'csuite-sdk/types';
import { hasPermission } from 'csuite-sdk/types';
import { useEffect, useState } from 'preact/hooks';
import { getClient } from '../lib/client.js';
import { initials } from '../lib/initials.js';
import { instructions, loadInstructions } from '../lib/instructions.js';
import { objectives } from '../lib/objectives.js';
import { presenceActivity, presenceCaptureWarning, roster } from '../lib/roster.js';
import { loadTeamStatus, teamStatus } from '../lib/team-status.js';
import { selectMemberProfile } from '../lib/view.js';
import { ErrorCallout, Loading, PageHeader, TextMetrics } from './ui/index.js';

export interface TeamHomeProps {
  viewer: string;
}

function formatStatusTime(value: number | null): string {
  return value === null ? 'absent' : new Date(value).toLocaleString();
}

export function TeamHome({ viewer }: TeamHomeProps) {
  const b = instructions.value;
  const r = roster.value;
  const obj = objectives.value;
  const canReadTeamStatus = hasPermission(b?.permissions ?? [], 'members.manage');

  useEffect(() => {
    if (!canReadTeamStatus) return;
    void loadTeamStatus().catch(() => {
      // The roster remains usable if this read-only operator detail fails.
      // Baseline members never make this request at all.
    });
  }, [canReadTeamStatus, r]);

  if (!b || !r) {
    return <Loading label="Loading team…" />;
  }

  const connectedByName = new Map<string, Presence>(r.connected.map((a) => [a.name, a]));
  const onlineCount = r.connected.filter((c) => c.connected > 0).length;
  const activeObjectives = obj.filter((o) => o.status === 'active').length;
  const blockedObjectives = obj.filter((o) => o.status === 'blocked').length;

  return (
    <div
      class="flex-1 overflow-y-auto measured"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <PageHeader eyebrow="Team" title={b.team.name} />

      {(r.restartPending?.length ?? 0) > 0 && (
        <div class="banner" data-state="caution" style="margin-bottom:16px">
          <div>
            <div class="banner-title">Restart pending</div>
            <div class="banner-body">
              {(r.restartPending ?? []).join(', ')} — running superseded instructions until their
              next session.
            </div>
          </div>
        </div>
      )}

      <TeamContextSection
        context={b.team.context}
        canManage={hasPermission(b.permissions, 'team.manage')}
      />

      <TeamProcessSection
        doc={b.processDocument}
        canManage={hasPermission(b.permissions, 'process.manage')}
      />

      <div
        class="grid"
        style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:24px"
      >
        <div class="stat">
          <div class="stat-label">MEMBERS</div>
          <div class="stat-value">{r.teammates.length}</div>
        </div>
        <div class="stat">
          <div class="stat-label">ONLINE</div>
          <div class="stat-value">{onlineCount}</div>
        </div>
        <div class="stat">
          <div class="stat-label">ACTIVE OBJECTIVES</div>
          <div class="stat-value">{activeObjectives}</div>
        </div>
        <div class={`stat${blockedObjectives > 0 ? ' caution' : ''}`}>
          <div class="stat-label">BLOCKED</div>
          <div class="stat-value">{blockedObjectives}</div>
        </div>
      </div>

      <div class="eyebrow" style="margin-bottom:10px">
        Roster
      </div>
      <div class="panel">
        <ul style="display:flex;flex-direction:column;list-style:none;padding:0;margin:0">
          {r.teammates.map((t, idx) => {
            const conn = connectedByName.get(t.name);
            const status = canReadTeamStatus
              ? teamStatus.value?.members.find((row) => row.member.name === t.name)
              : undefined;
            const online = (conn?.connected ?? 0) > 0;
            // 3-state activity, orthogonal to the connection state above.
            const activity = presenceActivity(conn);
            // Capture health is orthogonal to BOTH connection and
            // activity: a member can be online, working, and silently
            // capturing nothing. That combination is exactly the failure
            // this badge exists for, so it renders alongside rather than
            // instead of the activity state.
            const captureWarning = presenceCaptureWarning(conn);
            const working = activity === 'working';
            const blocked = activity === 'blocked';
            const isSelf = t.name === viewer;
            const isLast = idx === r.teammates.length - 1;
            const rowBorder = isLast ? '' : 'border-bottom:1px solid var(--ef-surface-hairline);';
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
                    <span
                      class="avatar"
                      data-kind={t.kind ?? 'agent'}
                      data-size="34"
                      aria-hidden="true"
                    >
                      {initials(t.name)}
                    </span>
                    <div class="min-w-0 flex flex-col gap-0.5">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span
                          class="font-display"
                          style="font-weight:700;letter-spacing:-0.01em;font-size:15px;line-height:1.1;color:var(--ef-text)"
                        >
                          {t.name}
                        </span>
                        {isSelf && (
                          <span style="font-family:var(--ef-font-mono);font-size:10px;letter-spacing:.14em;color:var(--ef-text-muted);text-transform:uppercase">
                            (you)
                          </span>
                        )}
                        {t.role.title.trim().toLowerCase() !== 'member' && (
                          <span class="badge soft" title={`Team role: ${t.role.title}`}>
                            {t.role.title.toUpperCase()}
                          </span>
                        )}
                        {r.restartPending?.includes(t.name) === true && (
                          <span
                            class="badge warn"
                            style="font-size:9.5px;letter-spacing:.06em"
                            title="This member's live session runs superseded instructions. The current text applies from their next session."
                          >
                            RESTART PENDING
                          </span>
                        )}
                        {captureWarning === 'gap' && (
                          <span
                            class="badge warn"
                            style="font-size:9.5px;letter-spacing:.06em"
                            title="This member is producing turns whose request/response bodies are not reaching the broker. Their activity is recorded; the verbatim exchanges are not."
                          >
                            NO CAPTURE
                          </span>
                        )}
                        {captureWarning === 'unevaluated' && (
                          <span
                            class="badge soft"
                            style="font-size:9.5px;letter-spacing:.06em"
                            title="This broker cannot assess capture health for this member — not a claim that capture is healthy."
                          >
                            CAPTURE UNCHECKED
                          </span>
                        )}
                      </div>
                      {t.role.description.length > 0 && (
                        <div style="font-family:var(--ef-font-body);font-size:11.5px;color:var(--ef-text-muted);line-height:1.4">
                          {t.role.description}
                        </div>
                      )}
                      {online && conn?.clientReports === undefined && (
                        <div style="font-family:var(--ef-font-mono);font-size:10px;color:var(--ef-text-muted)">
                          client identity unreported · broker predates client identity
                        </div>
                      )}
                      {conn?.clientReports?.map((report) => (
                        <div
                          key={
                            report.kind === 'runner'
                              ? `runner:${report.runnerIdentity.runner}:${report.runnerIdentity.modelId}:${report.runnerIdentity.runnerVersion}`
                              : `${report.kind}:${report.clientVersion}`
                          }
                          style="font-family:var(--ef-font-mono);font-size:10px;color:var(--ef-text-muted)"
                        >
                          {report.kind === 'runner' ? (
                            <>
                              RUNNER/{report.runnerIdentity.runner.toUpperCase()}
                              {report.runnerIdentity.runner === 'stub'
                                ? ' · TEST/CI INSTRUMENT'
                                : ''}{' '}
                              ·{' '}
                              {report.runnerIdentity.modelId ??
                                'agent default — not resolved locally'}{' '}
                              · {report.runnerIdentity.runnerVersion} ·{' '}
                              {report.runnerIdentity.runnerBuildSource}
                              {report.versionSkew.skew
                                ? ` · SKEW (broker ${report.versionSkew.brokerVersion})`
                                : ''}
                            </>
                          ) : (
                            `${report.kind.toUpperCase()} · ${report.clientVersion} · connections=${report.connections}`
                          )}
                        </div>
                      ))}
                      {(conn?.unreportedConnections ?? 0) > 0 && (
                        <div style="font-family:var(--ef-font-mono);font-size:10px;color:var(--ef-lamp-caution)">
                          {conn?.unreportedConnections} connection(s) without client identity
                        </div>
                      )}
                      {status && (
                        <div style="font-family:var(--ef-font-mono);font-size:10px;color:var(--ef-text-muted);margin-top:3px">
                          auth blocked: {status.presence?.authBlocked ?? 'absent'} · last activity:{' '}
                          {formatStatusTime(status.lastActivityAt)}
                          {status.activeObjectives.length === 0
                            ? ' · no active objective'
                            : status.activeObjectives.map((objective) => (
                                <div key={objective.id}>
                                  {objective.id} · {objective.status}
                                  {objective.stalled
                                    ? ` · STALLED (${objective.staleSignals.join(', ')})`
                                    : ''}{' '}
                                  · post {formatStatusTime(objective.lastThreadPostAt)} · PR{' '}
                                  {formatStatusTime(objective.lastPrLinkAt)} · lifecycle{' '}
                                  {formatStatusTime(objective.lastLifecycleAt)}
                                </div>
                              ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <span class="state-word flex-shrink-0">
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
                      style={`color:${blocked ? 'var(--ef-lamp-caution)' : working ? 'var(--ef-lamp-working)' : online ? 'var(--ef-lamp-nominal)' : 'var(--ef-lamp-stood-down)'}`}
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

/**
 * Standing prose collapses to a few lines unless the reader opens it.
 * Team context and the process document both run to thousands of
 * characters; rendered whole they push the roster off-screen, and the
 * reading case for the full text is rare next to the scanning case.
 * The full text stays in the DOM (CSS clamp), so search-in-page still
 * finds it.
 */
const CLAMP_LINES = 4;
const CLAMP_CHARS = 320;

function ClampedProse({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const clampable = text.length > CLAMP_CHARS || text.split('\n').length > CLAMP_LINES;
  const clamp =
    clampable && !expanded
      ? `display:-webkit-box;-webkit-line-clamp:${CLAMP_LINES};-webkit-box-orient:vertical;overflow:hidden;`
      : '';
  return (
    <div>
      <div
        style={`font-family:var(--ef-font-body);font-size:13.5px;color:var(--ef-text-muted);line-height:1.55;white-space:pre-wrap;${clamp}`}
      >
        {text}
      </div>
      {clampable && (
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          style="margin-top:4px"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Collapse' : `Show all (${text.length.toLocaleString()} chars)`}
        </button>
      )}
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
 * instructions so the page reflects the new prose immediately. Agents
 * pick the change up on their next session (the instructions string is
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
      await loadInstructions();
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
        <div style="font-family:var(--ef-font-body);font-size:11.5px;color:var(--ef-text-muted);font-style:italic;margin-top:6px">
          Standing context every member inherits. Agents see edits on their next session.
        </div>
        <TextMetrics text={ctxDraft.value} />
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
      <ClampedProse text={context} />
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

const prcEditing = signal(false);
const prcDraft = signal('');
const prcReason = signal('');
const prcDisposition = signal<'scope_change' | 'correction'>('scope_change');
const prcBusy = signal(false);
const prcError = signal<string | null>(null);

/**
 * The team's process document, with in-place editing for
 * `process.manage` holders. Edits require a reason and disposition —
 * they land in the document's append-only history and fan out as an
 * instruction event, so every member's runner learns a restart is
 * owed.
 *
 * `doc` keeps the wire's three states: a document, `null` (no
 * document set — a real state), and `undefined` (this broker does not
 * report the field). Collapsing the last two would tell a member the
 * team has no process when the truth is the broker has no opinion.
 */
function TeamProcessSection({
  doc,
  canManage,
}: {
  doc: ProcessDocument | null | undefined;
  canManage: boolean;
}) {
  const busy = prcBusy.value;

  async function onSave(e: Event): Promise<void> {
    e.preventDefault();
    prcBusy.value = true;
    prcError.value = null;
    try {
      await getClient().writeProcessDocument({
        text: prcDraft.value,
        reason: prcReason.value.trim(),
        disposition: prcDisposition.value,
      });
      await loadInstructions();
      prcEditing.value = false;
    } catch (err) {
      prcError.value = err instanceof Error ? err.message : String(err);
    } finally {
      prcBusy.value = false;
    }
  }

  if (prcEditing.value) {
    return (
      <form class="panel" onSubmit={(e) => void onSave(e)} style="padding:16px;margin-bottom:24px">
        <div class="eyebrow" style="margin-bottom:8px">
          Team process
        </div>
        {prcError.value !== null && (
          <ErrorCallout message={prcError.value} style="margin-bottom:10px" />
        )}
        <textarea
          class="input w-full"
          rows={10}
          value={prcDraft.value}
          onInput={(e) => {
            prcDraft.value = (e.currentTarget as HTMLTextAreaElement).value;
          }}
          placeholder="How this team works — the process every member executes against."
          disabled={busy}
        />
        <TextMetrics text={prcDraft.value} />
        <label style="display:flex;flex-direction:column;gap:4px;margin-top:10px;font-family:var(--ef-font-mono);font-size:11px;letter-spacing:.04em;color:var(--ef-text-muted);text-transform:uppercase">
          <span>reason — recorded in the document's history</span>
          <input
            class="input w-full"
            style="font-size:13px;font-family:var(--ef-font-body);text-transform:none;letter-spacing:normal;color:var(--ef-text)"
            value={prcReason.value}
            onInput={(e) => {
              prcReason.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="Why this edit"
            disabled={busy}
            required
          />
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;margin-top:10px;font-family:var(--ef-font-mono);font-size:11px;letter-spacing:.04em;color:var(--ef-text-muted);text-transform:uppercase">
          <span>disposition</span>
          <select
            class="input"
            style="font-size:13px;font-family:var(--ef-font-body);text-transform:none;letter-spacing:normal;color:var(--ef-text)"
            value={prcDisposition.value}
            onInput={(e) => {
              prcDisposition.value = (e.currentTarget as HTMLSelectElement).value as
                | 'scope_change'
                | 'correction';
            }}
            disabled={busy}
          >
            <option value="scope_change">scope change — the process itself moved</option>
            <option value="correction">correction — the text was wrong about the process</option>
          </select>
        </label>
        <div class="flex items-center gap-2" style="margin-top:12px">
          <button
            type="submit"
            class="btn btn-primary btn-sm"
            disabled={busy || prcReason.value.trim().length === 0}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => {
              prcEditing.value = false;
              prcError.value = null;
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
    prcDraft.value = doc?.text ?? '';
    prcReason.value = '';
    prcDisposition.value = 'scope_change';
    prcError.value = null;
    prcEditing.value = true;
  };

  if (doc === undefined) {
    return (
      <div style="margin-bottom:24px;font-family:var(--ef-font-body);font-size:11.5px;color:var(--ef-text-muted);font-style:italic">
        Team process: unavailable — this broker does not report a process document.
      </div>
    );
  }

  if (doc === null) {
    if (!canManage) return null;
    return (
      <div style="margin-bottom:24px">
        <button type="button" class="btn btn-ghost btn-sm" onClick={startEdit}>
          + Add team process
        </button>
      </div>
    );
  }

  return (
    <div style="margin-bottom:24px">
      <div class="flex items-center gap-2" style="margin-bottom:6px">
        <div class="eyebrow" style="margin:0">
          Team process
        </div>
        <span style="font-family:var(--ef-font-mono);font-size:10.5px;letter-spacing:.06em;color:var(--ef-text-muted)">
          v{doc.version} · last edited by {doc.updatedBy}
        </span>
      </div>
      <ClampedProse text={doc.text} />
      {canManage && (
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          style="margin-top:8px"
          onClick={startEdit}
        >
          Edit process
        </button>
      )}
    </div>
  );
}

export function __resetTeamHomeForTests(): void {
  teamStatus.value = null;
  ctxEditing.value = false;
  ctxDraft.value = '';
  ctxBusy.value = false;
  ctxError.value = null;
  prcEditing.value = false;
  prcDraft.value = '';
  prcReason.value = '';
  prcDisposition.value = 'scope_change';
  prcBusy.value = false;
  prcError.value = null;
}
