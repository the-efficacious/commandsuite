/**
 * Push fanout — takes a freshly-delivered message plus the
 * push-subscription store and fires Web Push notifications to every
 * recipient the policy approves.
 *
 * Concurrency: capped at 20 parallel HTTPS requests via `p-limit`
 * so a broadcast-to-100-subscribers can't open 100 simultaneous TLS
 * connections to FCM.
 *
 * Error handling:
 *   - 404 / 410 Gone → the push endpoint is dead, delete the row
 *   - 429 / 5xx      → leave the row in place, mark last_error_code
 *   - anything else  → log and mark; don't rethrow (we never want
 *                      a push failure to bubble into the main request)
 */

import type { Message } from 'csuite-sdk/types';
import pLimit from 'p-limit';
import type { Logger } from './logger.js';
// Default-import for the same CJS reason as vapid.ts.
import type { MemberStore } from './members-domain.js';
import { shouldPush } from './push-policy.js';
import type { PushSender } from './push-sender.js';
import type { PushSubscriptionRow, PushSubscriptionStore } from './push-subscription-store.js';

const PARALLEL_SENDS = 20;

/**
 * Shape of the JSON payload our service worker expects inside the
 * push event. Kept small — FCM enforces a 4KB encrypted payload cap
 * and the SW re-fetches full message content from the broker if it
 * needs more than this.
 */
export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  severity: 'normal' | 'high';
  messageId: string;
}

export interface DispatchDeps {
  sessions: PushSubscriptionStore;
  members: MemberStore;
  sender: PushSender;
  logger: Logger;
  /** Returns true if `name` currently has at least one live subscriber. */
  isLive: (name: string) => boolean;
}

/**
 * Fan out a single message as push notifications. Returns a promise
 * that resolves when every send attempt has completed (successfully
 * or not) — you can safely fire-and-forget with `.catch(logger.error)`.
 */
export async function dispatchPush(message: Message, deps: DispatchDeps): Promise<void> {
  const { sessions: store, members, logger, isLive } = deps;

  // Fan out to every team member that isn't the sender; per-member
  // policy + per-subscription looping happens inside the limiter.
  const limit = pLimit(PARALLEL_SENDS);
  const tasks: Promise<unknown>[] = [];

  for (const member of members.members()) {
    const decision = shouldPush({
      message,
      recipient: member.name,
      recipientIsLive: isLive(member.name),
    });
    if (!decision) continue;

    const subs = await store.listForMember(member.name);
    if (subs.length === 0) continue;

    const payload = buildPayload(message);
    for (const sub of subs) {
      tasks.push(
        limit(async () => {
          await sendOne(sub, payload, deps.sender, store, logger);
        }),
      );
    }
  }

  await Promise.allSettled(tasks);
}

function buildPayload(message: Message): PushPayload {
  const severity: PushPayload['severity'] =
    message.level === 'warning' || message.level === 'error' || message.level === 'critical'
      ? 'high'
      : 'normal';
  const title = message.from ? `${message.from}${titleSuffix(message)}` : 'csuite';
  const body = truncate(message.body, 180);
  // Tag collapses rapid notifications on the same thread into one
  // surfaced entry in the OS notification tray.
  const tag = message.to === null ? 'csuite:team' : `csuite:dm:${message.from ?? message.to}`;
  const url = message.to === null ? '/' : `/?thread=dm:${message.from ?? message.to}`;
  return { title, body, tag, url, severity, messageId: message.id };
}

function titleSuffix(message: Message): string {
  if (message.to === null) return ' → #team';
  return message.title ? ` — ${message.title}` : '';
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

async function sendOne(
  sub: PushSubscriptionRow,
  payload: PushPayload,
  sender: PushSender,
  store: PushSubscriptionStore,
  logger: Logger,
): Promise<void> {
  try {
    const outcome = await sender.send(
      { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
      JSON.stringify(payload),
      { ttlSeconds: 60 * 60 }, // drop on the push service if not delivered within 1h
    );
    if (outcome.kind === 'ok') {
      await store.markSuccess(sub.id);
      return;
    }
    if (outcome.kind === 'gone') {
      await store.deleteByEndpoint(sub.endpoint);
      logger.info('push subscription expired, removed', {
        endpoint: redactEndpoint(sub.endpoint),
        status: outcome.status,
      });
      return;
    }
    await store.markError(sub.id, outcome.status);
    logger.warn('push send failed', {
      endpoint: redactEndpoint(sub.endpoint),
      status: outcome.status,
    });
  } catch (err) {
    logger.error('push send crashed', {
      endpoint: redactEndpoint(sub.endpoint),
      error: err instanceof Error ? err.message : String(err),
    });
    await store.markError(sub.id, -1);
  }
}

/**
 * Redact the endpoint URL in logs — the full URL is a capability
 * token (anyone holding it can push). Log only the service + last
 * 8 chars so ops can correlate without leaking.
 */
function redactEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    const tail = u.pathname.slice(-8);
    return `${u.host}/…${tail}`;
  } catch {
    return '<invalid>';
  }
}
