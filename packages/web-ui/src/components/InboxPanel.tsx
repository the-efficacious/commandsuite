/**
 * InboxPanel — aggregated attention feed at `/inbox`.
 *
 *   ┌───────────────────────────────────────┐
 *   │ Inbox                                 │
 *   │ 5 items need your attention           │
 *   ├───────────────────────────────────────┤
 *   │ @alice            · 2 unread          │ → opens DM thread
 *   │   "can you take a look at…"           │
 *   ├───────────────────────────────────────┤
 *   │ [blocked] Ship the thing              │ → opens objective detail
 *   │   assigned to you · 3h ago            │
 *   └───────────────────────────────────────┘
 */

import { type InboxItem, inboxItems } from '../lib/inbox.js';
import { isObjectiveThread, OBJ_PREFIX } from '../lib/messages.js';
import { selectObjectiveDetail, selectThread } from '../lib/view.js';
import { EmptyState, PageHeader } from './ui/index.js';

export function InboxPanel() {
  const items = inboxItems.value;
  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <PageHeader
        eyebrow="Inbox"
        title={
          items.length === 0
            ? 'All caught up'
            : `${items.length} ${items.length === 1 ? 'item' : 'items'} need your attention`
        }
      />
      {items.length === 0 ? (
        <EmptyState
          title="Inbox zero"
          message="Nothing is waiting on you. Unread threads and objectives assigned to you will land here."
        />
      ) : (
        <ul
          class="panel"
          style="display:flex;flex-direction:column;list-style:none;padding:0;margin:0"
        >
          {items.map((item, idx) => (
            <InboxRow key={item.id} item={item} isLast={idx === items.length - 1} />
          ))}
        </ul>
      )}
    </div>
  );
}

function InboxRow({ item, isLast }: { item: InboxItem; isLast: boolean }) {
  const border = isLast ? '' : 'border-bottom:1px solid var(--rule);';
  return (
    <li>
      <button
        type="button"
        onClick={() => openItem(item)}
        class="hover-row w-full flex items-start gap-3"
        style={`padding:14px 16px;${border};background:transparent;text-align:left;cursor:pointer`}
        aria-label={ariaFor(item)}
      >
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            {item.kind === 'thread-unread' && (
              <>
                <span
                  class="font-display truncate"
                  style="font-weight:700;letter-spacing:-0.01em;color:var(--ink);font-size:14.5px"
                >
                  {item.title}
                </span>
                <span
                  class="badge solid"
                  style="font-size:10px;padding:2px 6px"
                  title={`${item.unread} unread`}
                >
                  {item.unread}
                </span>
              </>
            )}
            {item.kind === 'objective-assigned' && (
              <>
                <span class={statusBadgeClass(item.objective.status)}>{item.objective.status}</span>
                <span
                  class="font-display truncate"
                  style="font-weight:700;letter-spacing:-0.01em;color:var(--ink);font-size:14.5px"
                >
                  {item.objective.title}
                </span>
              </>
            )}
            {item.kind === 'objective-watched-blocked' && (
              <>
                <span class="badge ember solid">blocked</span>
                <span
                  class="font-display truncate"
                  style="font-weight:700;letter-spacing:-0.01em;color:var(--ink);font-size:14.5px"
                >
                  {item.objective.title}
                </span>
              </>
            )}
          </div>
          <div
            class="truncate"
            style="margin-top:4px;font-family:var(--f-sans);font-size:13px;color:var(--graphite);line-height:1.4"
          >
            {previewFor(item)}
          </div>
        </div>
        <span
          class="flex-shrink-0"
          style="font-family:var(--f-mono);font-size:10.5px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase;margin-top:2px"
        >
          {relativeTime(item.ts)}
        </span>
      </button>
    </li>
  );
}

function openItem(item: InboxItem): void {
  if (item.kind === 'thread-unread') {
    // Objective threads (`obj:<id>`) don't have a standalone URL — they
    // surface inside the objective detail view, so route there instead;
    // `selectThread` would silently no-op on them.
    if (isObjectiveThread(item.threadKey)) {
      selectObjectiveDetail(item.threadKey.slice(OBJ_PREFIX.length));
      return;
    }
    selectThread(item.threadKey);
    return;
  }
  selectObjectiveDetail(item.objective.id);
}

function ariaFor(item: InboxItem): string {
  switch (item.kind) {
    case 'thread-unread':
      return `Open ${item.title} (${item.unread} unread)`;
    case 'objective-assigned':
      return `Open objective ${item.objective.title}`;
    case 'objective-watched-blocked':
      return `Open watched objective ${item.objective.title}`;
  }
}

function previewFor(item: InboxItem): string {
  switch (item.kind) {
    case 'thread-unread':
      return item.preview;
    case 'objective-assigned':
      return `Assigned to you · ${item.objective.outcome || 'no outcome'}`;
    case 'objective-watched-blocked':
      return `Assigned to ${item.objective.assignee} — ${item.objective.blockReason ?? 'blocked'}`;
  }
}

function statusBadgeClass(status: string): string {
  if (status === 'blocked') return 'badge ember solid';
  if (status === 'done' || status === 'cancelled') return 'badge soft';
  return 'badge solid';
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}
