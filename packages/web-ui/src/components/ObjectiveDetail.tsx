/**
 * Objective detail — one page, no tabs, ordered the way the work
 * actually reads:
 *
 *   ┌────────────────────────────────────────────┐
 *   │  ← Objectives › obj-123                    │  breadcrumb (.crumbs)
 *   │  Title                          [status]   │  display h1
 *   │  assignee → originator · created 3d ago    │  meta line
 *   │  [● Complete…] [Block…] [Reassign…] [◇…]   │  action bar
 *   ├────────────────────────────────────────────┤
 *   │  OUTCOME            │  RESULT              │  the contract, and —
 *   │  definition of done │  (gold assert bar)   │  once done — the claim
 *   │                     │  or the result editor│  argued against it
 *   │  body · attachments · watchers             │
 *   │  ── Thread ─────────────────────────────── │  lifecycle events and
 *   │  ◆ lead-1 assigned to engineer-1           │  discussion merged into
 *   │  [engineer-1] on it, repro found           │  one chronological story
 *   │  ◆ engineer-1 blocked — waiting on keys    │
 *   │  [composer]                                │
 *   └────────────────────────────────────────────┘
 *
 * Actions live in the header as verbs, not as a place: Complete opens
 * the result editor NEXT TO the outcome (the result is read against
 * it), Block/Reassign/Cancel open one inline form at a time — cancel
 * commits on a second, explicit verb press, never on the first click.
 * Trace review stays a separate heavy surface behind an explicit
 * disclosure at the bottom.
 */

import { signal } from '@preact/signals';
import type { Message, Objective, ObjectiveEvent } from 'csuite-sdk/types';
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { instructions } from '../lib/instructions.js';
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
import { absoluteTime, relativeTime } from '../lib/time.js';
import { selectObjectivesList } from '../lib/view.js';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Send,
  X,
} from './icons/index.js';
import { MessageAttachments } from './MessageAttachments.js';
import { isContinuationOf, MessageLine } from './MessageLine.js';
import { TracePanel } from './TracePanel.js';
import { Mention } from './ui/Mention.js';

export interface ObjectiveDetailProps {
  id: string;
  viewer: string;
}

type OpenForm = 'none' | 'complete' | 'block' | 'reassign' | 'cancel';

const detailLoading = signal(true);
const detailError = signal<string | null>(null);
const detailObjective = signal<Objective | null>(null);
const detailEvents = signal<ObjectiveEvent[]>([]);
const openForm = signal<OpenForm>('none');
const traceOpen = signal(false);

const actionResult = signal('');
const actionBlockReason = signal('');
const actionReassignTo = signal('');
const actionReassignNote = signal('');
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
  actionReassignNote.value = '';
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
  openForm.value = 'none';
  traceOpen.value = false;
  resetInputs();
}

function toggleForm(form: Exclude<OpenForm, 'none'>): void {
  openForm.value = openForm.value === form ? 'none' : form;
}

export function ObjectiveDetail({ id, viewer }: ObjectiveDetailProps) {
  const b = instructions.value;
  const current = detailObjective.value;
  const events = detailEvents.value;
  const loading = detailLoading.value;
  const err = detailError.value;

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
        class="flex-1 overflow-y-auto measured record"
        style="padding:20px max(1rem,env(safe-area-inset-right)) 20px max(1rem,env(safe-area-inset-left))"
        aria-busy="true"
      >
        <Breadcrumb id={id} />
        <div class="ef-skeleton" style="height:36px;margin-top:14px" />
        <div class="ef-skeleton" style="height:120px;margin-top:14px" />
        <div class="ef-skeleton" style="height:220px;margin-top:14px" />
      </div>
    );
  }
  if (err !== null) {
    return (
      <div
        class="flex-1 overflow-y-auto measured record"
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
        class="flex-1 overflow-y-auto measured record"
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
  const canManageMembers = b.permissions.includes('members.manage');
  const canCancelPerm = b.permissions.includes('objectives.cancel');
  const canReassignPerm = b.permissions.includes('objectives.reassign');
  const canWatchPerm = b.permissions.includes('objectives.watch');
  const isWatching = current.watchers.includes(viewer);
  const isTerminal = current.status === 'done' || current.status === 'cancelled';
  // Mirrors the server's PATCH /objectives/:id gate exactly: the
  // assignee, or a member holding `objectives.cancel`.
  const canUpdateStatus = !isTerminal && (isAssignee || canCancelPerm);
  const canComplete = !isTerminal && isAssignee;
  const canCancel = !isTerminal && (canCancelPerm || isOriginator);
  const canReassign = !isTerminal && canReassignPerm;
  const canManageWatchers = canWatchPerm || isOriginator;
  const canDiscuss = isAssignee || isOriginator || canManageMembers || isWatching;

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
    // Single scroller at the record measure, like the sibling detail
    // views (NotificationDetail, ToolSourceDetail). The thread panel
    // keeps its own internal scroll for the sticky-bottom behavior.
    <div
      class="flex-1 overflow-y-auto measured record"
      style="padding:18px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left))"
    >
      {/* Header — breadcrumb, title, meta, verbs */}
      <div style="padding-bottom:16px;border-bottom:1px solid var(--ef-border)">
        <Breadcrumb id={current.id} />
        <div class="flex items-start gap-3 flex-wrap" style="margin-top:8px">
          <h1
            class={`font-display flex-1 min-w-0${current.status === 'cancelled' ? ' struck' : ''}`}
            style="font-size:30px;font-weight:700;letter-spacing:-0.02em;color:var(--ef-text);line-height:1.15"
          >
            {current.title}
          </h1>
          <StatusBadge status={current.status} />
        </div>
        <MetaLine objective={current} />
        {(canComplete || canUpdateStatus || canReassign || canCancel) && (
          <div class="flex flex-wrap items-center" style="gap:8px;margin-top:12px">
            {canComplete && current.status !== 'blocked' && (
              <button
                type="button"
                onClick={() => toggleForm('complete')}
                aria-expanded={openForm.value === 'complete'}
                class="btn btn-primary btn-sm"
              >
                ● Complete…
              </button>
            )}
            {canUpdateStatus && current.status === 'active' && (
              <button
                type="button"
                onClick={() => toggleForm('block')}
                aria-expanded={openForm.value === 'block'}
                class="btn btn-secondary btn-sm flex items-center"
                style="gap:6px"
              >
                <AlertTriangle size={13} aria-hidden="true" />
                Block…
              </button>
            )}
            {canUpdateStatus && current.status === 'blocked' && (
              <button
                type="button"
                disabled={actionBusy.value}
                onClick={() => void run(() => updateObjective(id, { status: 'active' }))}
                class="btn btn-secondary btn-sm"
              >
                ● Unblock
              </button>
            )}
            {canReassign && (
              <button
                type="button"
                onClick={() => toggleForm('reassign')}
                aria-expanded={openForm.value === 'reassign'}
                class="btn btn-ghost btn-sm flex items-center"
                style="gap:6px"
              >
                <ArrowRight size={13} aria-hidden="true" />
                Reassign…
              </button>
            )}
            {canCancel && (
              <button
                type="button"
                onClick={() => toggleForm('cancel')}
                aria-expanded={openForm.value === 'cancel'}
                class="btn btn-ghost btn-sm"
                style="color:var(--ef-lamp-alarm)"
              >
                ◇ Cancel…
              </button>
            )}
          </div>
        )}
        {actionError.value && (
          <div class="callout err" role="alert" style="margin-top:12px">
            <div class="icon" aria-hidden="true">
              <AlertCircle size={16} />
            </div>
            <div class="body">
              <div class="msg">{actionError.value}</div>
            </div>
          </div>
        )}
        {openForm.value === 'block' && <BlockForm id={id} run={run} />}
        {openForm.value === 'reassign' && (
          <ReassignForm id={id} assignee={current.assignee} run={run} />
        )}
        {openForm.value === 'cancel' && <CancelForm id={id} run={run} />}
      </div>

      <div style="margin-top:18px;display:flex;flex-direction:column;gap:14px">
        <OutcomeSection
          objective={current}
          events={events}
          completing={openForm.value === 'complete' && canComplete}
          run={run}
        />

        {current.status === 'blocked' && (
          <div class="callout warn" role="status">
            <div class="icon" aria-hidden="true">
              <AlertTriangle size={16} />
            </div>
            <div class="body">
              <div class="title">Blocked</div>
              <div class="msg" style="white-space:pre-wrap;line-height:1.55">
                {current.blockReason ?? 'No reason given.'}
              </div>
            </div>
          </div>
        )}

        {current.body && (
          <section class="card">
            <div class="eyebrow" style="margin-bottom:10px">
              Body
            </div>
            <div style="font-family:var(--ef-font-body);font-size:14.5px;color:var(--ef-text);white-space:pre-wrap;line-height:1.55">
              {current.body}
            </div>
          </section>
        )}

        {current.attachments.length > 0 && (
          <section class="card">
            <div class="eyebrow" style="margin-bottom:10px">
              Attachments ({current.attachments.length})
            </div>
            <MessageAttachments attachments={current.attachments} />
          </section>
        )}

        <WatchersSection
          objectiveId={current.id}
          watchers={current.watchers}
          canManage={canManageWatchers}
          run={run}
        />

        <ThreadSection
          id={id}
          viewer={viewer}
          events={events}
          canPost={canDiscuss}
          terminal={isTerminal}
          status={current.status}
        />

        {canManageMembers && (
          <section>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              aria-expanded={traceOpen.value}
              onClick={() => {
                traceOpen.value = !traceOpen.value;
              }}
            >
              {traceOpen.value ? (
                <ChevronDown size={13} aria-hidden="true" />
              ) : (
                <ChevronRight size={13} aria-hidden="true" />
              )}
              Trace review
            </button>
            {traceOpen.value && (
              <div style="margin-top:12px">
                <TracePanel objective={current} />
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────── Header ───────────────────────────

function Breadcrumb({ id }: { id: string }) {
  return (
    <nav aria-label="Breadcrumb" class="crumbs">
      <button type="button" onClick={selectObjectivesList} class="text-link">
        <ArrowLeft size={13} aria-hidden="true" />
        Objectives
      </button>
      <span class="sep" aria-hidden="true">
        <ChevronRight size={13} />
      </span>
      <span class="current">{id}</span>
    </nav>
  );
}

/** "just now" / "5m ago" — relativeTime with prose-safe zero case. */
function ago(ts: number): string {
  const rel = relativeTime(ts);
  return rel === 'now' ? 'just now' : `${rel} ago`;
}

function MetaLine({ objective }: { objective: Objective }) {
  const sep = (
    <span class="hidden sm:inline" style="color:var(--ef-border-strong)">
      ·
    </span>
  );
  return (
    <div
      class="flex flex-wrap items-baseline"
      style="gap:4px 14px;margin-top:10px;font-family:var(--ef-font-body);font-size:13.5px;color:var(--ef-text-faint)"
    >
      <span>
        assignee: <Mention name={objective.assignee} plain />
      </span>
      {sep}
      <span>
        originator: <Mention name={objective.originator} plain />
      </span>
      {sep}
      <span title={absoluteTime(objective.createdAt)}>created {ago(objective.createdAt)}</span>
      {objective.status === 'done' && objective.completedAt !== null && (
        <>
          {sep}
          <span title={absoluteTime(objective.completedAt)}>done {ago(objective.completedAt)}</span>
        </>
      )}
      {objective.status === 'cancelled' && (
        <>
          {sep}
          <span title={absoluteTime(objective.updatedAt)}>
            cancelled {ago(objective.updatedAt)}
          </span>
        </>
      )}
    </div>
  );
}

// ─────────────────────────── Inline action forms ───────────────────────────

function BlockForm({
  id,
  run,
}: {
  id: string;
  run: <T>(fn: () => Promise<T>) => Promise<T | null>;
}) {
  return (
    <div class="flex flex-col sm:flex-row gap-2 sm:items-center" style="margin-top:12px">
      <input
        type="text"
        value={actionBlockReason.value}
        onInput={(e) => {
          actionBlockReason.value = (e.currentTarget as HTMLInputElement).value;
        }}
        placeholder="what is it waiting on? (optional)"
        class="input flex-1 min-w-0"
      />
      <button
        type="button"
        disabled={actionBusy.value}
        onClick={() => {
          const reason = actionBlockReason.value.trim();
          void run(() =>
            updateObjective(id, {
              status: 'blocked',
              ...(reason ? { blockReason: reason } : {}),
            }),
          ).then((r) => {
            if (r !== null) openForm.value = 'none';
          });
        }}
        class="btn btn-secondary flex-shrink-0 flex items-center"
        style="gap:6px"
      >
        <AlertTriangle size={14} aria-hidden="true" />
        Mark blocked
      </button>
    </div>
  );
}

function ReassignForm({
  id,
  assignee,
  run,
}: {
  id: string;
  assignee: string;
  run: <T>(fn: () => Promise<T>) => Promise<T | null>;
}) {
  const teammates = roster.value?.teammates ?? [];
  return (
    <div class="flex flex-col sm:flex-row gap-2 sm:items-center" style="margin-top:12px">
      <select
        value={actionReassignTo.value}
        onChange={(e) => {
          actionReassignTo.value = (e.currentTarget as HTMLSelectElement).value;
        }}
        class="select flex-shrink-0"
      >
        <option value="">Reassign to…</option>
        {teammates
          .filter((t) => t.name !== assignee)
          .map((t) => (
            <option key={t.name} value={t.name}>
              {t.name} ({t.role.title})
            </option>
          ))}
      </select>
      <input
        type="text"
        value={actionReassignNote.value}
        onInput={(e) => {
          actionReassignNote.value = (e.currentTarget as HTMLInputElement).value;
        }}
        placeholder="why? goes in the thread (optional)"
        class="input flex-1 min-w-0"
      />
      <button
        type="button"
        disabled={actionBusy.value || actionReassignTo.value.length === 0}
        onClick={() => {
          const note = actionReassignNote.value.trim();
          void run(() =>
            reassignObjective(id, {
              to: actionReassignTo.value,
              ...(note ? { note } : {}),
            }),
          ).then((r) => {
            if (r !== null) openForm.value = 'none';
          });
        }}
        class="btn btn-secondary flex-shrink-0"
      >
        <ArrowRight size={14} aria-hidden="true" />
        Reassign
      </button>
    </div>
  );
}

/**
 * Cancel is two-step by construction: the header verb only opens this
 * form; nothing is destroyed until the explicit destructive verb here.
 */
function CancelForm({
  id,
  run,
}: {
  id: string;
  run: <T>(fn: () => Promise<T>) => Promise<T | null>;
}) {
  return (
    <div class="flex flex-col sm:flex-row gap-2 sm:items-center" style="margin-top:12px">
      <input
        type="text"
        value={actionCancelReason.value}
        onInput={(e) => {
          actionCancelReason.value = (e.currentTarget as HTMLInputElement).value;
        }}
        placeholder="cancel reason — lands in the thread (optional)"
        class="input flex-1 min-w-0"
      />
      <button
        type="button"
        onClick={() => {
          openForm.value = 'none';
        }}
        class="btn btn-ghost flex-shrink-0"
      >
        Belay
      </button>
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
          ).then((r) => {
            if (r !== null) openForm.value = 'none';
          })
        }
        class="btn btn-destructive flex-shrink-0"
      >
        ◇ Cancel objective
      </button>
    </div>
  );
}

// ─────────────────────────── Outcome / result ───────────────────────────

/**
 * The contract block. Alone while the work is live; once the
 * objective is done — or while the assignee is writing the result —
 * it pairs with the result side-by-side, because the result is read
 * AGAINST the outcome. The done result carries the view's one gold
 * assert bar: a verified claim, the page's assertion.
 */
function OutcomeSection({
  objective,
  events,
  completing,
  run,
}: {
  objective: Objective;
  events: ObjectiveEvent[];
  completing: boolean;
  run: <T>(fn: () => Promise<T>) => Promise<T | null>;
}) {
  const paired = completing || (objective.status === 'done' && objective.result !== null);
  const cancelReason = cancelReasonFor(objective, events);

  const outcomeCard = (
    <section class="card" style="margin:0">
      <div class="eyebrow" style="margin-bottom:10px">
        Outcome
      </div>
      <div style="font-family:var(--ef-font-body);font-size:14.5px;color:var(--ef-text);white-space:pre-wrap;line-height:1.55">
        {objective.outcome}
      </div>
    </section>
  );

  if (!paired) {
    return (
      <>
        {outcomeCard}
        {objective.status === 'cancelled' && (
          <div class="callout" role="status">
            <div class="icon" aria-hidden="true">
              ◇
            </div>
            <div class="body">
              <div class="title">Cancelled</div>
              <div class="msg" style="white-space:pre-wrap;line-height:1.55">
                {cancelReason ?? 'No reason recorded.'}
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;align-items:stretch">
      {outcomeCard}
      {completing ? (
        <section class="card" style="margin:0">
          <div class="eyebrow" style="margin-bottom:10px">
            Result
          </div>
          <div class="field-help" style="margin-bottom:8px">
            How was the outcome met? Argue it against the definition of done on the left — this is
            what gets verified.
          </div>
          <textarea
            rows={4}
            value={actionResult.value}
            onInput={(e) => {
              actionResult.value = (e.currentTarget as HTMLTextAreaElement).value;
            }}
            placeholder="what was delivered, and how it meets the outcome (required)"
            class="textarea"
            style="margin-bottom:10px;min-height:96px"
          />
          <div class="flex items-center" style="gap:8px">
            <button
              type="button"
              disabled={actionBusy.value || actionResult.value.trim().length === 0}
              onClick={() =>
                void run(() => completeObjective(objective.id, actionResult.value.trim())).then(
                  (r) => {
                    if (r !== null) openForm.value = 'none';
                  },
                )
              }
              class="btn btn-primary"
            >
              ● Mark complete
            </button>
            <button
              type="button"
              onClick={() => {
                openForm.value = 'none';
              }}
              class="btn btn-ghost"
            >
              Belay
            </button>
          </div>
        </section>
      ) : (
        <section class="card" style="margin:0;box-shadow:inset 3px 0 0 var(--ef-assert)">
          <div class="eyebrow" style="margin-bottom:10px">
            Result
          </div>
          <div style="font-family:var(--ef-font-body);font-size:14.5px;color:var(--ef-text);white-space:pre-wrap;line-height:1.55">
            {objective.result}
          </div>
        </section>
      )}
    </div>
  );
}

/** Cancelled objectives carry their reason in the event log, not on
 * the record — dig out the last `cancelled` event's payload. */
function cancelReasonFor(objective: Objective, events: ObjectiveEvent[]): string | null {
  if (objective.status !== 'cancelled') return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && ev.kind === 'cancelled') {
      const reason = ev.payload.reason;
      return typeof reason === 'string' && reason.length > 0 ? reason : null;
    }
  }
  return null;
}

// ─────────────────────────── Thread ───────────────────────────

type StreamEntry =
  | { kind: 'message'; ts: number; message: Message; previous?: Message }
  | { kind: 'event'; ts: number; event: ObjectiveEvent };

/**
 * Merge lifecycle events and discussion messages into one ascending
 * stream — the objective as its participants experienced it. Ties go
 * to the event (the assignment precedes the first post about it). A
 * message only renders as a continuation when it directly follows
 * another message; an interleaved event breaks the group.
 */
export function buildStream(events: ObjectiveEvent[], messages: Message[]): StreamEntry[] {
  const entries: StreamEntry[] = [
    ...events.map((event): StreamEntry => ({ kind: 'event', ts: event.ts, event })),
    ...messages.map((message): StreamEntry => ({ kind: 'message', ts: message.ts, message })),
  ].sort((a, z) => {
    if (a.ts !== z.ts) return a.ts - z.ts;
    if (a.kind !== z.kind) return a.kind === 'event' ? -1 : 1;
    return 0;
  });
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    const prev = entries[i - 1];
    if (entry?.kind === 'message' && prev?.kind === 'message') {
      if (isContinuationOf(entry.message, prev.message)) entry.previous = prev.message;
    }
  }
  return entries;
}

/** One line of story per lifecycle event — humanized, never raw JSON. */
export function describeEvent(ev: ObjectiveEvent): string {
  const p = ev.payload;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (ev.kind) {
    case 'assigned': {
      const watchers = Array.isArray(p.watchers) ? (p.watchers as string[]) : [];
      return `assigned to ${str(p.assignee)}${
        watchers.length > 0 ? ` · watching: ${watchers.join(', ')}` : ''
      }`;
    }
    case 'blocked':
      return str(p.reason) ? `blocked — ${str(p.reason)}` : 'blocked';
    case 'unblocked':
      return 'unblocked';
    case 'completed':
      return 'completed — result recorded';
    case 'cancelled':
      return str(p.reason) ? `cancelled — ${str(p.reason)}` : 'cancelled';
    case 'reassigned':
      return `reassigned ${str(p.from)} → ${str(p.to)}${str(p.note) ? ` — ${str(p.note)}` : ''}`;
    case 'watcher_added':
      return p.reason === 'reassigned-from'
        ? `${str(p.name)} stays on as watcher`
        : `watcher added: ${str(p.name)}`;
    case 'watcher_removed':
      return `watcher removed: ${str(p.name)}`;
    default:
      // Legacy kinds (`amended`, `event_corrected`) from old databases.
      return ev.kind.replace(/_/g, ' ');
  }
}

function EventLine({ event }: { event: ObjectiveEvent }) {
  const d = new Date(event.ts);
  const hhmm = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  return (
    <div
      style="display:grid;grid-template-columns:34px 1fr;gap:0 12px;padding:5px 0"
      title={absoluteTime(event.ts)}
    >
      <span
        class="tabular-nums"
        style="color:var(--ef-text-faint);font-family:var(--ef-font-mono);font-size:10px;text-align:right;align-self:baseline;margin-top:2px"
      >
        {hhmm}
      </span>
      <div
        class="min-w-0 break-words"
        style="font-family:var(--ef-font-mono);font-size:11.5px;letter-spacing:.04em;color:var(--ef-text-muted)"
      >
        <span aria-hidden="true" style="color:var(--ef-border-strong)">
          ◆{' '}
        </span>
        <span style="color:var(--ef-text-secondary);font-weight:600">{event.actor}</span>{' '}
        {describeEvent(event)}
      </div>
    </div>
  );
}

function ThreadSection({
  id,
  viewer,
  events,
  canPost,
  terminal,
  status,
}: {
  id: string;
  viewer: string;
  events: ObjectiveEvent[];
  canPost: boolean;
  terminal: boolean;
  status: Objective['status'];
}) {
  const threadKey = objectiveThreadKey(id);
  const _map = messagesByThread.value;
  void _map;
  const messages = threadMessages(threadKey);
  const stream = buildStream(events, messages);
  const postCount = messages.length;

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
  }, [stream.length, threadKey]);

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
        style="display:flex;flex-direction:column;min-height:260px;max-height:60vh"
      >
        <div class="panel-head">
          <span>Thread</span>
          <span>
            {postCount} {postCount === 1 ? 'post' : 'posts'}
          </span>
        </div>
        <div
          ref={containerRef}
          onScroll={onScroll}
          aria-live="polite"
          aria-atomic="false"
          class="panel-body overflow-y-auto"
          style="background:var(--ef-surface-raised);padding:12px 14px;flex:1;min-height:0"
        >
          {stream.length === 0 ? (
            <div class="min-h-full flex items-center justify-center" style="padding:24px 0">
              <div class="empty" style="border:none;background:transparent;padding:12px">
                <p>◇ Nothing yet — the objective thread is quiet</p>
              </div>
            </div>
          ) : (
            <div style="display:flex;flex-direction:column;gap:1px">
              {stream.map((entry) =>
                entry.kind === 'event' ? (
                  <EventLine key={entry.event.id} event={entry.event} />
                ) : (
                  <MessageLine
                    key={entry.message.id}
                    message={entry.message}
                    viewer={viewer}
                    {...(entry.previous ? { previousMessage: entry.previous } : {})}
                  />
                ),
              )}
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
              {discussSending.value ? '…' : 'Send'}
              {!discussSending.value && <Send size={13} aria-hidden="true" />}
            </button>
          </div>
        </div>
      )}
      {canPost && terminal && (
        <div style="font-family:var(--ef-font-mono);font-size:11.5px;letter-spacing:.14em;color:var(--ef-text-muted);text-transform:uppercase">
          ◇ Thread closed — objective is {status}
        </div>
      )}
    </section>
  );
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
        <div style="font-family:var(--ef-font-body);font-size:13px;color:var(--ef-text-muted)">
          No explicit watchers{' '}
          <span style="color:var(--ef-border-strong)">
            (members.manage holders see everything automatically)
          </span>
        </div>
      ) : (
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          {watchers.map((w) => (
            <span key={w} class="token">
              <span>{w}</span>
              {canManage && (
                <button
                  type="button"
                  class="x"
                  aria-label={`Remove watcher ${w}`}
                  title={`Remove ${w}`}
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
 * Status badge — distinct visual states so someone scanning the
 * detail can identify state without reading the label.
 */
function StatusBadge({ status }: { status: Objective['status'] }) {
  const variant: Record<Objective['status'], string> = {
    active: 'badge solid',
    blocked: 'badge caution solid',
    done: 'badge soft',
    cancelled: 'badge muted',
  };
  return <span class={`${variant[status]} flex-shrink-0`}>{status}</span>;
}

export function __resetObjectiveDetailForTests(): void {
  resetDetailState();
  actionBusy.value = false;
}
