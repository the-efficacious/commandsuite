/**
 * Objectives ledger — the full record for a user (or team-wide for
 * admins), grouped by whether the work is still live.
 *
 *   ┌───────────────────────────────────────────────┐
 *   │ OBJECTIVES                          [+ New]   │
 *   │ 4 live · 1 blocked          [ All │ Mine ]    │
 *   ├───────────────────────────────────────────────┤
 *   │ LIVE — 4                                      │
 *   │ [blocked] Ship the thing   ⓶   → rune · 2h    │  blocked floats up
 *   │ [active]  Fix the login…       (you) · 40m    │
 *   ├───────────────────────────────────────────────┤
 *   │ ▸ Closed — 59 done · 16 cancelled             │  collapsed ledger
 *   └───────────────────────────────────────────────┘
 *
 * Live rows sort blocked-first (they need attention), then by last
 * activity. Closed rows keep the record without crowding the working
 * set. The count-badge is the objective thread's unread count — the
 * "what moved since you last looked" signal, fed by the same
 * machinery as the chat sidebar.
 */

import { signal } from '@preact/signals';
import type { Message, Objective } from 'csuite-sdk/types';
import { useEffect } from 'preact/hooks';
import { instructions } from '../lib/instructions.js';
import { messagesByThread, objectiveThreadKey } from '../lib/messages.js';
import { loadObjectives, objectives, objectivesLoaded } from '../lib/objectives.js';
import { absoluteTime, relativeTime } from '../lib/time.js';
import { lastReadByThread, unreadCount } from '../lib/unread.js';
import { selectObjectiveCreate, selectObjectiveDetail } from '../lib/view.js';
import { AlertTriangle, ChevronDown, ChevronRight } from './icons/index.js';
import { EmptyState, ErrorCallout, PageHeader } from './ui/index.js';

export interface ObjectivesPanelProps {
  viewer: string;
}

const STATUS_BADGE: Record<Objective['status'], string> = {
  active: 'badge solid',
  blocked: 'badge caution solid',
  done: 'badge soft',
  cancelled: 'badge muted',
};

const panelError = signal<string | null>(null);
const scopeFilter = signal<'all' | 'mine'>('all');
const closedOpen = signal(false);

/** Last movement on an objective: lifecycle change or, when the
 * viewer's message store has the thread, its latest discussion post
 * (discussion doesn't bump `updatedAt` server-side). */
function lastActivity(o: Objective, msgMap: Map<string, Message[]>): number {
  const msgs = msgMap.get(objectiveThreadKey(o.id)) ?? [];
  const lastMsg = msgs.length > 0 ? (msgs[msgs.length - 1]?.ts ?? 0) : 0;
  return Math.max(o.updatedAt, lastMsg);
}

export function ObjectivesPanel({ viewer }: ObjectivesPanelProps) {
  const b = instructions.value;
  const list = objectives.value;
  const loaded = objectivesLoaded.value;
  const err = panelError.value;
  const lastReadMap = lastReadByThread.value;
  const msgMap = messagesByThread.value;

  useEffect(() => {
    if (!loaded) {
      panelError.value = null;
      void loadObjectives().catch((e) => {
        panelError.value = e instanceof Error ? e.message : String(e);
      });
    }
  }, [loaded]);

  const canCreate = b?.permissions.includes('objectives.manage') ?? false;

  if (!loaded && err === null) {
    // Skeleton rows hold the final row height so arrival doesn't reflow.
    return (
      <div
        class="flex-1 overflow-y-auto measured"
        style="padding:24px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left))"
        aria-busy="true"
      >
        {[0, 1, 2, 3].map((i) => (
          <div key={i} class="ef-skeleton" style="height:44px;margin-bottom:8px" />
        ))}
      </div>
    );
  }

  const retry = () => {
    panelError.value = null;
    void loadObjectives().catch((e) => {
      panelError.value = e instanceof Error ? e.message : String(e);
    });
  };

  const scoped = scopeFilter.value === 'mine' ? list.filter((o) => o.assignee === viewer) : list;
  const hasOthers = list.some((o) => o.assignee !== viewer);

  const live = scoped
    .filter((o) => o.status === 'active' || o.status === 'blocked')
    .sort((a, z) => {
      if (a.status !== z.status) return a.status === 'blocked' ? -1 : 1;
      return lastActivity(z, msgMap) - lastActivity(a, msgMap);
    });
  const closed = scoped
    .filter((o) => o.status === 'done' || o.status === 'cancelled')
    .sort((a, z) => (z.completedAt ?? z.updatedAt) - (a.completedAt ?? a.updatedAt));
  const blockedCount = live.filter((o) => o.status === 'blocked').length;
  const doneCount = closed.filter((o) => o.status === 'done').length;
  const cancelledCount = closed.length - doneCount;

  const title =
    live.length === 0
      ? 'All quiet'
      : `${live.length} live${blockedCount > 0 ? ` · ${blockedCount} blocked` : ''}`;

  return (
    <div
      class="flex-1 overflow-y-auto measured"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left))"
    >
      <PageHeader
        eyebrow="Objectives"
        title={title}
        actions={
          canCreate && (
            <button type="button" onClick={selectObjectiveCreate} class="btn btn-primary">
              + New
            </button>
          )
        }
      />

      {err !== null && (
        <ErrorCallout
          title="Couldn't load objectives"
          message={err}
          onRetry={retry}
          style="margin-bottom:16px"
        />
      )}

      {hasOthers && (
        // Block wrapper: `.measured > *` centres fit-content children,
        // and `.segmented` is inline-flex — the wrapper keeps it
        // aligned to the column like everything else.
        <div style="margin-bottom:18px">
          <div class="segmented">
            <button
              type="button"
              aria-pressed={scopeFilter.value === 'all'}
              onClick={() => {
                scopeFilter.value = 'all';
              }}
            >
              All
            </button>
            <button
              type="button"
              aria-pressed={scopeFilter.value === 'mine'}
              onClick={() => {
                scopeFilter.value = 'mine';
              }}
            >
              Mine
            </button>
          </div>
        </div>
      )}

      {scoped.length === 0 ? (
        <EmptyState
          title="No objectives yet"
          message={canCreate ? 'Click "+ New" to assign one.' : 'Nothing on your plate right now.'}
        />
      ) : (
        <>
          {live.length > 0 ? (
            <section aria-label="Live objectives">
              <div class="eyebrow" style="margin-bottom:10px">
                Live — {live.length}
              </div>
              <ul style="display:flex;flex-direction:column;gap:10px;list-style:none;padding:0;margin:0">
                {live.map((o) => (
                  <ObjectiveRow
                    key={o.id}
                    objective={o}
                    viewer={viewer}
                    unread={unreadCount(objectiveThreadKey(o.id), viewer, lastReadMap, msgMap)}
                    activityTs={lastActivity(o, msgMap)}
                  />
                ))}
              </ul>
            </section>
          ) : (
            <div style="font-family:var(--ef-font-mono);font-size:11.5px;letter-spacing:.14em;color:var(--ef-text-muted);text-transform:uppercase;padding:6px 0 2px">
              ◇ Nothing live — the board is clear
            </div>
          )}

          {closed.length > 0 && (
            <section aria-label="Closed objectives" style="margin-top:22px">
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                aria-expanded={closedOpen.value}
                onClick={() => {
                  closedOpen.value = !closedOpen.value;
                }}
              >
                {closedOpen.value ? (
                  <ChevronDown size={13} aria-hidden="true" />
                ) : (
                  <ChevronRight size={13} aria-hidden="true" />
                )}
                Closed — {doneCount} done
                {cancelledCount > 0 ? ` · ${cancelledCount} cancelled` : ''}
              </button>
              {closedOpen.value && (
                <ul style="display:flex;flex-direction:column;gap:10px;list-style:none;padding:0;margin:12px 0 0">
                  {closed.map((o) => (
                    <ObjectiveRow
                      key={o.id}
                      objective={o}
                      viewer={viewer}
                      unread={0}
                      activityTs={o.completedAt ?? o.updatedAt}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

export function __resetObjectivesPanelForTests(): void {
  panelError.value = null;
  scopeFilter.value = 'all';
  closedOpen.value = false;
}

function ObjectiveRow({
  objective,
  viewer,
  unread,
  activityTs,
}: {
  objective: Objective;
  viewer: string;
  unread: number;
  activityTs: number;
}) {
  const isMine = objective.assignee === viewer;
  const terminal = objective.status === 'done' || objective.status === 'cancelled';
  return (
    <li>
      <button
        type="button"
        onClick={() => selectObjectiveDetail(objective.id)}
        class="card hover-card w-full"
        style={`text-align:left;padding:14px 16px;display:block;cursor:pointer${terminal ? ';opacity:.72' : ''}`}
      >
        <div class="flex items-start justify-between gap-3 min-w-0">
          <div class="flex items-center gap-3 min-w-0 flex-wrap">
            <span class={STATUS_BADGE[objective.status]}>{objective.status}</span>
            <span
              class={`truncate${objective.status === 'cancelled' ? ' struck' : ''}`}
              style="font-family:var(--ef-font-display);font-weight:700;letter-spacing:-0.01em;font-size:15px"
            >
              {objective.title}
            </span>
            {unread > 0 && (
              // aria-hidden like the nav's UnreadBadge — the count is a
              // sighted-scan affordance; the row button names the work.
              <span
                class="count-badge"
                aria-hidden="true"
                title={`${unread} unread ${unread === 1 ? 'post' : 'posts'}`}
              >
                {unread}
              </span>
            )}
          </div>
          <span
            class="hidden sm:flex items-center flex-shrink-0"
            style="font-family:var(--ef-font-mono);font-size:11px;letter-spacing:.08em;color:var(--ef-text-muted);text-transform:uppercase;margin-top:2px;gap:10px"
          >
            <span>{isMine ? '(you)' : `→ ${objective.assignee}`}</span>
            <span title={`last activity ${absoluteTime(activityTs)}`}>
              {relativeTime(activityTs)}
            </span>
          </span>
        </div>
        <div
          class="truncate"
          style="font-family:var(--ef-font-body);font-size:13px;color:var(--ef-text-faint);margin-top:8px;line-height:1.4"
        >
          outcome: {objective.outcome}
        </div>
        <div
          class="sm:hidden"
          style="font-family:var(--ef-font-mono);font-size:11px;letter-spacing:.08em;color:var(--ef-text-muted);text-transform:uppercase;margin-top:6px"
        >
          {isMine ? '(you)' : `→ ${objective.assignee}`} ·{' '}
          <span title={`last activity ${absoluteTime(activityTs)}`}>
            {relativeTime(activityTs)}
          </span>
        </div>
        {objective.status === 'blocked' && (
          <div
            class="flex items-center"
            style="font-family:var(--ef-font-body);font-size:13px;color:var(--ef-lamp-caution);margin-top:6px;font-weight:500;gap:6px"
          >
            <AlertTriangle size={13} aria-hidden="true" class="flex-shrink-0" />
            <span>{objective.blockReason ? `blocked: ${objective.blockReason}` : 'blocked'}</span>
          </div>
        )}
      </button>
    </li>
  );
}
