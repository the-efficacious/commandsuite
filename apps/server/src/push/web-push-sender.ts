/**
 * `PushSender` over the `web-push` library — the Node binding of
 * csuite-core's push delivery seam. VAPID configuration stays in
 * `vapid.ts`; `web-push` reads the process-wide details set there.
 */

import type { PushSender } from 'csuite-core';
import webpush from 'web-push';

const { sendNotification, WebPushError } = webpush;

export function createWebPushSender(): PushSender {
  return {
    async send(subscription, payload, options) {
      try {
        await sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
          { TTL: options.ttlSeconds },
        );
        return { kind: 'ok' };
      } catch (err) {
        if (err instanceof WebPushError) {
          const status = err.statusCode;
          if (status === 404 || status === 410) return { kind: 'gone', status };
          return { kind: 'failed', status };
        }
        throw err;
      }
    },
  };
}
