/**
 * Push notification policy — which messages should actually fire a
 * notification, and for whom.
 *
 * Rules (v1, intentionally simple):
 *
 *   1. Never push to the sender. Own sends are echoes — no self-buzz.
 *   2. Never push to a recipient who already has a live SSE
 *      subscription. They're looking at the app;
 *      another buzz is redundant.
 *   3. DMs addressed to the recipient always push (if rules 1+2 allow).
 *   4. Broadcasts push only if the level is `warning` or higher OR
 *      the body mentions the recipient's name with an `@` prefix.
 *      Lower-severity chatter stays quiet unless specifically called out.
 *
 * Everything else does NOT push. In particular: DMs addressed to
 * someone else (even if you happen to be online) — the third party
 * has no business knowing you're there.
 *
 * Future: per-member preferences, per-thread mute, quiet hours. All
 * live off this function's return value so they're easy to bolt on.
 */

import type { LogLevel, Message } from 'csuite-sdk/types';

const HIGH_PRIORITY_LEVELS: ReadonlySet<LogLevel> = new Set<LogLevel>([
  'warning',
  'error',
  'critical',
]);

export interface ShouldPushOptions {
  message: Message;
  /** Name we're considering notifying. */
  recipient: string;
  /**
   * Whether `recipient` already has a live SSE subscriber attached.
   * The broker's agent registry tracks this; the dispatcher queries
   * it per-recipient before calling us.
   */
  recipientIsLive: boolean;
}

export function shouldPush(opts: ShouldPushOptions): boolean {
  const { message, recipient, recipientIsLive } = opts;

  // Rule 1: no self-echo pushes.
  if (message.from === recipient) return false;

  // Rule 2: if they have a live tab, they'll see it through SSE.
  if (recipientIsLive) return false;

  // Rule 3: direct DMs always go through.
  if (message.to === recipient) return true;

  // Rule 4: broadcasts get filtered.
  if (message.to === null) {
    if (HIGH_PRIORITY_LEVELS.has(message.level)) return true;
    // Simple word-boundary match for @name. We don't care about
    // capitalization; names are case-sensitive but mentioning
    // "@director-1" vs "@Director-1" should both notify.
    const needle = `@${recipient}`.toLowerCase();
    if (message.body.toLowerCase().includes(needle)) return true;
    return false;
  }

  // DMs addressed to a third party — not your business.
  return false;
}
