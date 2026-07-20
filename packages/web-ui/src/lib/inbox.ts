/**
 * Inbox — aggregated "what needs my attention" feed.
 *
 * Pulls from three existing sources:
 *   - Unread threads (primary + DMs) via `messagesByThread` + `lastRead`.
 *   - Objectives assigned to the viewer that are active or blocked.
 *   - Objectives the viewer watches that moved into `blocked`.
 *
 * This is a pure computed: no new network traffic. The SSE stream and
 * the existing objective/message signals are authoritative; the inbox
 * is just a view over them.
 */

import { computed } from '@preact/signals';
import type { Objective } from 'csuite-sdk/types';
import { identity } from './identity.js';
import { DM_PREFIX, isDmThread, messagesByThread, PRIMARY_THREAD } from './messages.js';
import { objectives as objectivesSignal } from './objectives.js';
import { lastReadByThread, unreadCount } from './unread.js';

export type InboxItem =
  | {
      kind: 'thread-unread';
      id: string;
      threadKey: string;
      title: string;
      /** The last message's preview, trimmed for the row. */
      preview: string;
      /** Timestamp of the most recent unread message (ms). */
      ts: number;
      unread: number;
    }
  | {
      kind: 'objective-assigned';
      id: string;
      objective: Objective;
      ts: number;
    }
  | {
      kind: 'objective-watched-blocked';
      id: string;
      objective: Objective;
      ts: number;
    };

export const inboxItems = computed<InboxItem[]>(() => {
  const id = identity.value;
  if (id === null) return [];
  const viewer = id.member;
  const items: InboxItem[] = [];

  // Unread threads.
  const msgMap = messagesByThread.value;
  const lastRead = lastReadByThread.value;
  for (const [threadKey, messages] of msgMap.entries()) {
    if (messages.length === 0) continue;
    const count = unreadCount(threadKey, viewer, lastRead, msgMap);
    if (count === 0) continue;
    const latest = messages[messages.length - 1];
    if (!latest) continue;
    items.push({
      kind: 'thread-unread',
      id: `t:${threadKey}`,
      threadKey,
      title: threadTitle(threadKey),
      preview: previewOf(latest.body),
      ts: latest.ts,
      unread: count,
    });
  }

  // Objectives assigned to the viewer that are still open.
  for (const o of objectivesSignal.value) {
    if (o.assignee !== viewer) continue;
    if (o.status !== 'active' && o.status !== 'blocked') continue;
    items.push({
      kind: 'objective-assigned',
      id: `o:${o.id}`,
      objective: o,
      ts: o.updatedAt,
    });
  }

  // Objectives I watch that are blocked (someone needs help).
  for (const o of objectivesSignal.value) {
    if (o.assignee === viewer) continue;
    if (o.status !== 'blocked') continue;
    if (!o.watchers.includes(viewer)) continue;
    items.push({
      kind: 'objective-watched-blocked',
      id: `w:${o.id}`,
      objective: o,
      ts: o.updatedAt,
    });
  }

  return items.sort((a, b) => b.ts - a.ts);
});

export const inboxCount = computed(() => inboxItems.value.length);

function threadTitle(key: string): string {
  if (key === PRIMARY_THREAD) return 'Team Chat';
  if (isDmThread(key)) return `@${key.slice(DM_PREFIX.length)}`;
  return key;
}

function previewOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= 80) return flat;
  return `${flat.slice(0, 77)}…`;
}
