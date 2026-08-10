/**
 * InboxPanel — aggregated attention feed at `/inbox`.
 *
 *   ┌───────────────────────────────────────┐
 *   │ Inbox                                 │
 *   │ 5 items need your attention           │
 *   ├───────────────────────────────────────┤
 *   │ @alice            · 2 unread          │ → opens DM thread
 *   │   "can you take a look at…"           │
 *   └───────────────────────────────────────┘
 */

import { type InboxItem, inboxItems } from '../lib/inbox.js';
import { selectThread } from '../lib/view.js';
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
          message="Nothing is waiting on you. Unread threads will land here."
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
          <div class="notif-title truncate">{item.title}</div>
          <div class="notif-meta truncate">
            {item.preview} · {relativeTime(item.ts)}
          </div>
        </div>
        <span class="count-badge" title={`${item.unread} unread`}>
          {item.unread}
        </span>
      </button>
    </li>
  );
}

function openItem(item: InboxItem): void {
  selectThread(item.threadKey);
}

function ariaFor(item: InboxItem): string {
  return `Open ${item.title} (${item.unread} unread)`;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}
