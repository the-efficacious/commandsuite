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
import { relativeTime } from '../lib/time.js';
import { selectObjectiveDetail, selectThread } from '../lib/view.js';
import { EmptyState, PageHeader } from './ui/index.js';

export function InboxPanel() {
  const items = inboxItems.value;
  return (
    <div
      class="flex-1 overflow-y-auto measured"
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
        <ul style="display:flex;flex-direction:column;gap:4px;list-style:none;padding:0;margin:0">
          {items.map((item) => (
            <InboxRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

function InboxRow({ item }: { item: InboxItem }) {
  // Every inbox item is, by construction, unhandled — handled items
  // leave the feed — so each row takes the unread treatment.
  return (
    <li>
      <button
        type="button"
        onClick={() => openItem(item)}
        class="notif notif--unread"
        aria-label={ariaFor(item)}
      >
        <span class="notif-dot" />
        <div class="min-w-0">
          <div class="notif-title truncate">
            {item.kind === 'thread-unread' && item.title}
            {item.kind === 'objective-assigned' && (
              <>
                <span class={statusBadgeClass(item.objective.status)}>{item.objective.status}</span>{' '}
                {item.objective.title}
              </>
            )}
            {item.kind === 'objective-watched-blocked' && (
              <>
                <span class="badge caution solid">blocked</span> {item.objective.title}
              </>
            )}
          </div>
          <div class="notif-meta truncate">
            {previewFor(item)} · {relativeTime(item.ts)}
          </div>
        </div>
        {item.kind === 'thread-unread' && (
          <span class="count-badge" title={`${item.unread} unread`}>
            {item.unread}
          </span>
        )}
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
  if (status === 'blocked') return 'badge caution solid';
  if (status === 'done' || status === 'cancelled') return 'badge soft';
  return 'badge solid';
}
