/**
 * Objective detail view — full state, action buttons, inline
 * discussion thread, trace review, and the lifecycle event log,
 * organized as a tabbed interface so each concern owns its own pane.
 *
 *   ┌────────────────────────────────────────────┐
 *   │  ← Objectives › obj-123                    │  breadcrumb (.crumbs)
 *   │  Title                                      │  display h1
 *   │  [status] · assignee · originator           │  badge + meta
 *   ├────────────────────────────────────────────┤
 *   │  Overview · Actions · Discussion · …        │  .tabs .tab
 *   ├────────────────────────────────────────────┤
 *   │   tab content — scrolls independently       │
 *   └────────────────────────────────────────────┘
 *
 * All buttons / inputs / cards / tabs use canonical theme.css classes.
 * Action groups only render when the viewer can take them.
 */

import { signal } from '@preact/signals';
import type { Message, Objective, ObjectiveEvent } from 'csuite-sdk/types';
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import { messagesByThread, objectiveThreadKey, threadMessages } from '../lib/messages.js';
import {
  cancelObjective,
  completeObjective,
  discussObjective,
  fetchObjectiveDetail,
  loadObjectives,
  reassignObjective,
  updateObjective,
  updateObjectiveWatchers,
} from '../lib/objectives.js';
import { roster } from '../lib/roster.js';
import { selectObjectivesList } from '../lib/view.js';
import { AlertCircle, AlertTriangle, X } from './icons/index.js';
import { MessageAttachments } from './MessageAttachments.js';
import { MessageLine } from './MessageLine.js';
import { TracePanel } from './TracePanel.js';
import { Mention } from './ui/Mention.js';

export interface ObjectiveDetailProps {
  id: string;
  viewer: string;
}

type Tab = 'overview' | 'actions' | 'discussion' | 'trace' | 'audit';

const detailLoading = signal(true);
const detailError = signal<string | null>(null);
const detailObjective = signal<Objective | null>(null);
const detailEvents = signal<ObjectiveEvent[]>([]);
const activeTab = signal<Tab>('overview');
const auditExpanded = signal(false);

const actionResult = signal('');
const actionBlockReason = signal('');
const actionReassignTo = signal('');
const actionCancelReason = signal('');
const actionWatcherAdd = signal('');
const actionBusy = signal(false);
const actionError = signal<string | null>(null);

const discussDraft = signal('');
const discussSending = signal(false);
const discussError = signal<string | null>(null);

async function loadDetail(id: string): Promise<void> {
  detailLoading.value = true;
  detailError.value = null;
  try {
    const { objective, events } = await fetchObjectiveDetail(id);
    detailObjective.value = objective;
    detailEvents.value = events;
  } catch (err) {
    detailError.value = err instanceof Error ? err.message : String(err);
  } finally {
    detailLoading.value = false;
  }
}

function resetInputs(): void {
  actionResult.value = '';
  actionBlockReason.value = '';
  actionReassignTo.value = '';
  actionCancelReason.value = '';
  actionWatcherAdd.value = '';
  actionError.value = null;
  discussDraft.value = '';
  discussError.value = null;
  discussSending.value = false;
}

function resetDetailState(): void {
  detailLoading.value = true;
  detailError.value = null;
  detailObjective.value = null;
  detailEvents.value = [];
  activeTab.value = 'overview';
  auditExpanded.value = false;
  resetInputs();
}

export function ObjectiveDetail({ id, viewer }: ObjectiveDetailProps) {
  const b = briefing.value;
  const current = detailObjective.value;
  const events = detailEvents.value;
  const loading = detailLoading.value;
  const err = detailError.value;
  const tab = activeTab.value;

  useEffect(() => {
    resetDetailState();
    void loadDetail(id);
    return () => {
      resetDetailState();
    };
  }, [id]);

  if (loading) {
    return (
      <div
        class="flex-1 flex items-center justify-center"
        style="color:var(--muted);font-size:14px"
      >
        loading objective…
      </div>
    );
  }
  if (err !== null) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:20px max(1rem,env(safe-area-inset-right)) 20px max(1rem,env(safe-area-inset-left))"
      >
        <Breadcrumb id={id} />
        <div class="callout err" role="alert" style="margin-top:14px">
          <div class="icon" aria-hidden="true">
            <AlertCircle size={16} />
          </div>
          <div class="body">
            <div class="msg">{err}</div>
          </div>
        </div>
      </div>
    );
  }
  if (!current || !b) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:20px max(1rem,env(safe-area-inset-right)) 20px max(1rem,env(safe-area-inset-left))"
      >
        <Breadcrumb id={id} />
        <div class="empty" style="margin-top:14px">
          <h4>Objective not found</h4>
          <p>It may have been deleted, or you don't have access.</p>
        </div>
      </div>
    );
  }

  const isAssignee = current.assignee === viewer;
  const isOriginator = current.originator === viewer;
  const isAdmin = b.permissions.includes('members.manage');
  const canCancelPerm = b.permissions.includes('objectives.cancel');
  const canReassignPerm = b.permissions.includes('objectives.reassign');
  const canWatchPerm = b.permissions.includes('objectives.watch');
  const isWatching = current.watchers.includes(viewer);
  const isTerminal = current.status === 'done' || current.status === 'cancelled';
  const canUpdateStatus = !isTerminal && (isAssignee || isAdmin);
  const canComplete = !isTerminal && isAssignee;
  const canCancel = !isTerminal && (canCancelPerm || isOriginator);
  const canReassign = !isTerminal && canReassignPerm;
  const canManageWatchers = canWatchPerm || isOriginator;
  const canDiscuss = isAssignee || isOriginator || isAdmin || isWatching;
  const hasAnyAction =
    canUpdateStatus || canComplete || canCancel || canReassign || canManageWatchers;

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    if (actionBusy.value) return null;
    actionBusy.value = true;
    actionError.value = null;
    try {
      const r = await fn();
      await loadDetail(id);
      await loadObjectives();
      return r;
    } catch (e) {
      actionError.value = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      actionBusy.value = false;
    }
  }

  return (
    <div class="flex-1 flex flex-col min-h-0">
      {/* Header — non-scrolling, breadcrumb + title + status + meta */}
      <div
        class="flex-shrink-0"
        style="padding:18px max(1rem,env(safe-area-inset-right)) 16px max(1rem,env(safe-area-inset-left));border-bottom:1px solid var(--rule)"
      >
        <Breadcrumb id={current.id} />
        <div class="flex items-start gap-3 flex-wrap" style="margin-top:8px">
          <h1
            class="font-display flex-1 min-w-0"
            style="font-size:30px;font-weight:700;letter-spacing:-0.02em;color:var(--ink);line-height:1.15"
          >
            {current.title}
          </h1>
          <StatusBadge status={current.status} />
        </div>
        <div
          class="flex flex-wrap"
          style="gap:4px 14px;margin-top:10px;font-family:var(--f-sans);font-size:13.5px;color:var(--graphite)"
        >
          <span>
            assignee: <Mention name={current.assignee} plain />
          </span>
          <span class="hidden sm:inline" style="color:var(--rule-strong)">
            ·
          </span>
          <span>
            originator: <Mention name={current.originator} plain />
          </span>
        </div>
      </div>

      {/* Tabs row */}
      <div
        class="flex-shrink-0 overflow-x-auto"
        style="padding:0 max(0.5rem,env(safe-area-inset-right)) 0 max(0.5rem,env(safe-area-inset-left));background:var(--paper)"
      >
        <div class="tabs" style="border-bottom:1px solid var(--rule);min-width:fit-content">
          <Tabs
            active={tab}
            onChange={(t) => {
              activeTab.value = t;
            }}
            show={{ trace: isAdmin, actions: hasAnyAction }}
          />
        </div>
      </div>

      {/* Tab content — only scrolling region */}
      <div
        class="flex-1 overflow-y-auto"
        style="padding:18px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left));display:flex;flex-direction:column;gap:14px"
      >
        {tab === 'overview' && (
          <OverviewTab objective={current} canManageWatchers={canManageWatchers} run={run} />
        )}
        {tab === 'actions' && hasAnyAction && (
          <ActionsTab
            objective={current}
            id={id}
            canUpdateStatus={canUpdateStatus}
            canComplete={canComplete}
            canCancel={canCancel}
            canReassign={canReassign}
            run={run}
          />
        )}
        {tab === 'discussion' && (
          <DiscussionTab id={id} viewer={viewer} canPost={canDiscuss} terminal={isTerminal} />
        )}
        {tab === 'trace' && isAdmin && <TracePanel objective={current} />}
        {tab === 'audit' && <AuditTab events={events} />}
      </div>
    </div>
  );
}

// ─────────────────────────── Header ───────────────────────────

function Breadcrumb({ id }: { id: string }) {
  return (
    <nav aria-label="Breadcrumb" class="crumbs">
      <button type="button" onClick={selectObjectivesList} class="text-link">
        ← Objectives
      </button>
      <span class="sep" aria-hidden="true">
        ›
      </span>
      <span class="current">{id}</span>
    </nav>
  );
}

function Tabs({
  active,
  onChange,
  show,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
  show: { trace: boolean; actions: boolean };
}) {
  const entries: Array<{ id: Tab; label: string; visible: boolean }> = [
    { id: 'overview', label: 'Overview', visible: true },
    { id: 'actions', label: 'Actions', visible: show.actions },
    { id: 'discussion', label: 'Discussion', visible: true },
    { id: 'trace', label: 'Trace', visible: show.trace },
    { id: 'audit', label: 'Audit', visible: true },
  ];
  return (
    <>
      {entries
        .filter((e) => e.visible)
        .map((e) => {
          const isActive = e.id === active;
          return (
            <button
              key={e.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(e.id)}
              class={`tab${isActive ? ' active' : ''}`}
              style="white-space:nowrap"
            >
              {e.label}
            </button>
          );
        })}
    </>
  );
}

// ─────────────────────────── Tab content ───────────────────────────

function OverviewTab({
  objective,
  canManageWatchers,
  run,
}: {
  objective: Objective;
  canManageWatchers: boolean;
  run: <T>(fn: () => Promise<T>) => Promise<T | null>;
}) {
  return (
    <>
      <section class="card">
        <div class="eyebrow" style="margin-bottom:10px">
          Outcome
        </div>
        <div style="font-family:var(--f-sans);font-size:14.5px;color:var(--ink);white-space:pre-wrap;line-height:1.55">
          {objective.outcome}
        </div>
      </section>

      {objective.body && (
        <section class="card">
          <div class="eyebrow" style="margin-bottom:10px">
            Body
          </div>
          <div style="font-family:var(--f-sans);font-size:14.5px;color:var(--ink);white-space:pre-wrap;line-height:1.55">
            {objective.body}
          </div>
        </section>
      )}

      {objective.attachments.length > 0 && (
        <section class="card">
          <div class="eyebrow" style="margin-bottom:10px">
            Attachments ({objective.attachments.length})
          </div>
          <MessageAttachments attachments={objective.attachments} />
        </section>
      )}

      {objective.blockReason && (
        <div class="callout warn" role="status">
          <div class="icon" aria-hidden="true">
            <AlertTriangle size={16} />
          </div>
          <div class="body">
            <div class="title">Blocked</div>
            <div class="msg" style="white-space:pre-wrap;line-height:1.55">
              {objective.blockReason}
            </div>
          </div>
        </div>
      )}

      {objective.result && (
        <div class="callout success">
          <div class="icon" aria-hidden="true">
            ●
          </div>
          <div class="body">
            <div class="title">Result</div>
            <div class="msg" style="white-space:pre-wrap;line-height:1.55">
              {objective.result}
            </div>
          </div>
        </div>
      )}

      <WatchersSection
        objectiveId={objective.id}
        watchers={objective.watchers}
        canManage={canManageWatchers}
        run={run}
      />
    </>
  );
}

function ActionsTab({
  objective,
  id,
  canUpdateStatus,
  canComplete,
  canCancel,
  canReassign,
  run,
}: {
  objective: Objective;
  id: string;
  canUpdateStatus: boolean;
  canComplete: boolean;
  canCancel: boolean;
  canReassign: boolean;
  run: <T>(fn: () => Promise<T>) => Promise<T | null>;
}) {
  const teammates = roster.value?.teammates ?? [];
  return (
    <section style="display:flex;flex-direction:column;gap:18px">
      {actionError.value && (
        <div class="callout err" role="alert">
          <div class="icon" aria-hidden="true">
            <AlertCircle size={16} />
          </div>
          <div class="body">
            <div class="msg">{actionError.value}</div>
          </div>
        </div>
      )}

      {canUpdateStatus && objective.status === 'active' && (
        <div class="card">
          <div class="eyebrow" style="margin-bottom:10px">
            Block this objective
          </div>
          <div class="flex flex-col sm:flex-row gap-2 sm:items-center">
            <input
              type="text"
              value={actionBlockReason.value}
              onInput={(e) => {
                actionBlockReason.value = (e.currentTarget as HTMLInputElement).value;
              }}
              placeholder="block reason"
              class="input flex-1 min-w-0"
            />
            <button
              type="button"
              disabled={actionBusy.value || actionBlockReason.value.trim().length === 0}
              onClick={() =>
                void run(() =>
                  updateObjective(id, {
                    status: 'blocked',
                    blockReason: actionBlockReason.value.trim(),
                  }),
                )
              }
              class="btn btn-accent flex-shrink-0 flex items-center"
              style="gap:6px"
            >
              <AlertTriangle size={14} aria-hidden="true" />
              Mark blocked
            </button>
          </div>
        </div>
      )}

      {canUpdateStatus && objective.status === 'blocked' && (
        <div class="card">
          <div class="eyebrow" style="margin-bottom:10px">
            Unblock
          </div>
          <button
            type="button"
            disabled={actionBusy.value}
            onClick={() => void run(() => updateObjective(id, { status: 'active' }))}
            class="btn btn-secondary"
          >
            ● Unblock
          </button>
        </div>
      )}

      {canComplete && (
        <div class="card">
          <div class="eyebrow" style="margin-bottom:10px">
            Complete
          </div>
          <textarea
            rows={3}
            value={actionResult.value}
            onInput={(e) => {
              actionResult.value = (e.currentTarget as HTMLTextAreaElement).value;
            }}
            placeholder="result — how was the outcome met? (required)"
            class="textarea"
            style="margin-bottom:10px;min-height:84px"
          />
          <button
            type="button"
            disabled={actionBusy.value || actionResult.value.trim().length === 0}
            onClick={() => void run(() => completeObjective(id, actionResult.value.trim()))}
            class="btn btn-primary"
          >
            ● Mark complete
          </button>
        </div>
      )}

      {canReassign && (
        <div class="card">
          <div class="eyebrow" style="margin-bottom:10px">
            Reassign
          </div>
          <div class="flex flex-col sm:flex-row gap-2 sm:items-center">
            <select
              value={actionReassignTo.value}
              onChange={(e) => {
                actionReassignTo.value = (e.currentTarget as HTMLSelectElement).value;
              }}
              class="select flex-1 min-w-0"
            >
              <option value="">Reassign to…</option>
              {teammates
                .filter((t) => t.name !== objective.assignee)
                .map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name} ({t.role.title})
                  </option>
                ))}
            </select>
            <button
              type="button"
              disabled={actionBusy.value || actionReassignTo.value.length === 0}
              onClick={() => void run(() => reassignObjective(id, { to: actionReassignTo.value }))}
              class="btn btn-secondary flex-shrink-0"
            >
              → Reassign
            </button>
          </div>
        </div>
      )}

      {canCancel && (
        <div class="card" style="border-color:rgba(176,74,52,0.25)">
          <div class="eyebrow" style="margin-bottom:10px;color:var(--err)">
            Cancel objective
          </div>
          <div class="flex flex-col sm:flex-row gap-2 sm:items-center">
            <input
              type="text"
              value={actionCancelReason.value}
              onInput={(e) => {
                actionCancelReason.value = (e.currentTarget as HTMLInputElement).value;
              }}
              placeholder="cancel reason (optional)"
              class="input flex-1 min-w-0"
            />
            <button
              type="button"
              disabled={actionBusy.value}
              onClick={() =>
                void run(() =>
                  cancelObjective(id, {
                    ...(actionCancelReason.value.trim()
                      ? { reason: actionCancelReason.value.trim() }
                      : {}),
                  }),
                )
              }
              class="btn btn-destructive flex-shrink-0"
            >
              ◇ Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function DiscussionTab({
  id,
  viewer,
  canPost,
  terminal,
}: {
  id: string;
  viewer: string;
  canPost: boolean;
  terminal: boolean;
}) {
  const threadKey = objectiveThreadKey(id);
  const _map = messagesByThread.value;
  void _map;
  const messages = threadMessages(threadKey);

  const stickyRef = useRef(true);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickyRef.current = gap < 80;
  };

  useEffect(() => {
    if (!stickyRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, threadKey]);

  const onInput = (event: JSX.TargetedInputEvent<HTMLTextAreaElement>) => {
    discussDraft.value = event.currentTarget.value;
  };

  const send = async () => {
    const body = discussDraft.value.trim();
    if (!body || discussSending.value) return;
    discussSending.value = true;
    discussError.value = null;
    try {
      await discussObjective(id, { body });
      discussDraft.value = '';
    } catch (err) {
      discussError.value = err instanceof Error ? err.message : String(err);
    } finally {
      discussSending.value = false;
    }
  };

  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const onFocus = () => {
    const el = textareaRef.current;
    if (!el) return;
    setTimeout(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 100);
  };

  return (
    <section style="display:flex;flex-direction:column;gap:12px">
      <div
        class="panel"
        style="display:flex;flex-direction:column;min-height:240px;max-height:60vh"
      >
        <div class="panel-head">
          <span>Discussion</span>
          <span>{messages.length} posts</span>
        </div>
        <div
          ref={containerRef}
          onScroll={onScroll}
          aria-live="polite"
          aria-atomic="false"
          class="panel-body overflow-y-auto"
          style="background:var(--ice);padding:12px 14px;flex:1;min-height:0"
        >
          {messages.length === 0 ? (
            <div class="min-h-full flex items-center justify-center" style="padding:24px 0">
              <div class="empty" style="border:none;background:transparent;padding:12px">
                <p>◇ No discussion yet — the objective thread is quiet</p>
              </div>
            </div>
          ) : (
            <div style="display:flex;flex-direction:column;gap:1px">
              {messages.map((m: Message, i: number) => (
                <MessageLine
                  key={m.id}
                  message={m}
                  viewer={viewer}
                  {...(i > 0 && messages[i - 1] ? { previousMessage: messages[i - 1] } : {})}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {canPost && !terminal && (
        <div>
          {discussError.value && (
            <div class="callout err" role="alert" style="margin-bottom:10px">
              <div class="icon" aria-hidden="true">
                <AlertCircle size={16} />
              </div>
              <div class="body">
                <div class="msg">{discussError.value}</div>
              </div>
            </div>
          )}
          <div class="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              rows={2}
              value={discussDraft.value}
              onInput={onInput}
              onKeyDown={onKeyDown}
              onFocus={onFocus}
              placeholder={`message the obj-${id.replace(/^obj-/, '')} thread — enter to send, shift+enter for newline`}
              class="textarea flex-1"
              style="min-height:auto;font-size:16px;resize:none"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={discussSending.value || discussDraft.value.trim().length === 0}
              class="btn btn-primary flex-shrink-0"
            >
              {discussSending.value ? '…' : 'Send →'}
            </button>
          </div>
        </div>
      )}
      {canPost && terminal && (
        <div style="font-family:var(--f-mono);font-size:11.5px;letter-spacing:.14em;color:var(--muted);text-transform:uppercase">
          ◇ Discussion closed — objective is {detailObjective.value?.status}
        </div>
      )}
    </section>
  );
}

function AuditTab({ events }: { events: ObjectiveEvent[] }) {
  const expanded = auditExpanded.value;
  const summary = summarizeEvents(events);
  const visibleEvents = expanded ? events : events.slice(-5);

  return (
    <section style="display:flex;flex-direction:column;gap:12px">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="eyebrow">Lifecycle log</div>
        <div style="font-family:var(--f-mono);font-size:11px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase">
          {summary}
        </div>
      </div>
      {events.length === 0 ? (
        <div class="empty">
          <p>(no events)</p>
        </div>
      ) : (
        <>
          {!expanded && events.length > 5 && (
            <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted);font-style:italic">
              showing last 5 of {events.length} — click expand to see all
            </div>
          )}
          <ol
            class="audit-log"
            style="display:flex;flex-direction:column;gap:4px;list-style:none;padding:0;margin:0"
          >
            {visibleEvents.map((ev, i) => (
              <li
                key={`${ev.ts}-${i}`}
                style="font-family:var(--f-mono);font-size:12px;color:var(--graphite);border-left:2px solid var(--rule);padding:6px 12px;word-break:break-word;transition:border-color .15s var(--ease)"
              >
                <span style="color:var(--muted)">
                  {new Date(ev.ts).toISOString().replace('T', ' ').slice(0, 19)}
                </span>{' '}
                <span style="color:var(--steel);font-weight:600">{ev.actor}</span>{' '}
                <span style="color:var(--ink)">{ev.kind}</span>{' '}
                {Object.keys(ev.payload).length > 0 && (
                  <span style="color:var(--muted)">{JSON.stringify(ev.payload)}</span>
                )}
              </li>
            ))}
          </ol>
          {events.length > 5 && (
            <div>
              <button
                type="button"
                onClick={() => {
                  auditExpanded.value = !expanded;
                }}
                class="btn btn-ghost btn-sm"
              >
                {expanded ? '▲ Collapse' : '▼ Expand full log'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function summarizeEvents(events: ObjectiveEvent[]): string {
  if (events.length === 0) return '';
  const counts = new Map<string, number>();
  for (const ev of events) {
    counts.set(ev.kind, (counts.get(ev.kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, n]) => `${k}:${n}`).join(' · ');
}

// ─────────────────────────── Watchers ───────────────────────────

function WatchersSection({
  objectiveId,
  watchers,
  canManage,
  run,
}: {
  objectiveId: string;
  watchers: string[];
  canManage: boolean;
  run: <T>(fn: () => Promise<T>) => Promise<T | null>;
}) {
  const r = roster.value;
  const teammates = r?.teammates ?? [];
  const candidates = teammates.filter((t) => !watchers.includes(t.name));

  return (
    <section class="card">
      <div class="eyebrow" style="margin-bottom:12px">
        Watchers
      </div>
      {watchers.length === 0 ? (
        <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted)">
          No explicit watchers{' '}
          <span style="color:var(--frost);color:var(--rule-strong)">
            (admins see everything automatically)
          </span>
        </div>
      ) : (
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          {watchers.map((w) => (
            <span key={w} class="chip">
              <span>{w}</span>
              {canManage && (
                <button
                  type="button"
                  class="x"
                  aria-label={`Remove watcher ${w}`}
                  title={`Remove ${w}`}
                  style="background:transparent;border:0;padding:0;cursor:pointer"
                  onClick={() =>
                    void run(() => updateObjectiveWatchers(objectiveId, { remove: [w] }))
                  }
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {canManage && candidates.length > 0 && (
        <div class="flex flex-col sm:flex-row gap-2 sm:items-center" style="margin-top:14px">
          <select
            value={actionWatcherAdd.value}
            onChange={(e) => {
              actionWatcherAdd.value = (e.currentTarget as HTMLSelectElement).value;
            }}
            class="select flex-1 min-w-0"
          >
            <option value="">Add watcher…</option>
            {candidates.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} ({t.role.title})
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={actionBusy.value || actionWatcherAdd.value.length === 0}
            onClick={() => {
              const cs = actionWatcherAdd.value;
              if (!cs) return;
              void run(async () => {
                const r = await updateObjectiveWatchers(objectiveId, { add: [cs] });
                actionWatcherAdd.value = '';
                return r;
              });
            }}
            class="btn btn-secondary btn-sm flex-shrink-0"
          >
            + Add
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Status badge — distinct visual states so an admin scanning the
 * detail can identify state without reading the label.
 */
function StatusBadge({ status }: { status: Objective['status'] }) {
  const variant: Record<Objective['status'], string> = {
    active: 'badge solid',
    blocked: 'badge ember solid',
    done: 'badge soft',
    cancelled: 'badge muted',
  };
  return <span class={`${variant[status]} flex-shrink-0`}>{status}</span>;
}

export function __resetObjectiveDetailForTests(): void {
  resetDetailState();
  actionBusy.value = false;
}
