/**
 * Foreground in-app notifications for incoming live messages.
 *
 * Paired with the shell's push-notification story (service worker on
 * the host origin shows a system notification when the tab is in the
 * background). When the tab IS visible, surfacing a second OS
 * notification is annoying — the user is already looking at the app.
 * This module fires a toast instead, and only when the user isn't
 * already staring at the thread the message landed in.
 *
 * Gating:
 *   - Ignores messages from the viewer themselves.
 *   - Ignores when the tab isn't visible (the push path covers that).
 *   - Ignores when the target thread is the currently-active view.
 *
 * The toast deep-links to the thread. Tagged by thread key so a rapid
 * burst of messages in the same channel collapses to one rolling
 * toast instead of a stack.
 */

import type { Message } from 'csuite-sdk/types';
import { identity } from './identity.js';
import {
  dmOther,
  isDmThread,
  isObjectiveThread,
  OBJ_PREFIX,
  PRIMARY_THREAD,
  threadKeyOf,
} from './messages.js';
import { toast } from './toast.js';
import { selectDmWith, selectObjectiveDetail, selectThread, view } from './view.js';

/** Keep toast body readable — long messages get clipped with an ellipsis. */
const MAX_BODY = 140;

/** Overridable for tests — default reads document.visibilityState. */
type VisibilityGetter = () => boolean;
let isTabVisible: VisibilityGetter = () =>
  typeof document === 'undefined' ? true : document.visibilityState === 'visible';

/**
 * Fire a toast for a freshly-arrived live message if the gates pass.
 * Backfill / history loads should NOT call this — only the live WS
 * message handler.
 */
export function notifyNewMessage(msg: Message): void {
  const viewer = identity.value?.member ?? null;
  if (viewer === null) return;
  if (msg.from === viewer) return;
  if (!isTabVisible()) return;

  const threadKey = threadKeyOf(msg, viewer);
  if (isActiveThread(threadKey)) return;

  const title = titleFor(msg, threadKey);
  const body = truncate(msg.body ?? '', MAX_BODY);
  // Empty-body tickles (payload-less push fallback) still surface but
  // with a generic line so the toast is never visually empty.
  const finalBody = body.length > 0 ? body : 'New activity';

  toast.info({
    title,
    body: finalBody,
    tag: `msg:${threadKey}`,
    action: {
      label: 'View',
      onClick: () => routeToThread(threadKey),
    },
  });
}

function isActiveThread(threadKey: string): boolean {
  const v = view.value;
  if (v.kind === 'thread' && v.key === threadKey) return true;
  // Objective threads surface inside the objective detail view — treat
  // the matching detail route as "active" so we don't toast when the
  // viewer is reading the objective.
  if (v.kind === 'objective-detail' && threadKey === `${OBJ_PREFIX}${v.id}`) return true;
  return false;
}

function titleFor(msg: Message, threadKey: string): string {
  const sender = msg.from ?? 'Someone';
  if (threadKey === PRIMARY_THREAD) return `${sender} · #team`;
  if (isDmThread(threadKey)) return `${sender} · DM`;
  if (isObjectiveThread(threadKey)) return `${sender} · objective`;
  return sender;
}

function routeToThread(threadKey: string): void {
  if (threadKey === PRIMARY_THREAD) {
    selectThread(threadKey);
    return;
  }
  const dm = dmOther(threadKey);
  if (dm !== null) {
    selectDmWith(dm);
    return;
  }
  if (isObjectiveThread(threadKey)) {
    selectObjectiveDetail(threadKey.slice(OBJ_PREFIX.length));
    return;
  }
  // Unknown scheme — best effort.
  selectThread(threadKey);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Test hook: swap the visibility check. Pass `null` to reset. */
export function __setVisibilityForTests(fn: VisibilityGetter | null): void {
  isTabVisible =
    fn ?? (() => (typeof document === 'undefined' ? true : document.visibilityState === 'visible'));
}
