/// <reference lib="webworker" />

/**
 * csuite service worker.
 *
 * Runs in a Worker context — no DOM, no window. The `declare let self`
 * below narrows the ambient `self` to `ServiceWorkerGlobalScope` for
 * TypeScript without changing runtime behavior.
 *
 * Phase 6 responsibilities:
 *   - Precache the built SPA shell (injected at build time via
 *     `self.__WB_MANIFEST`)
 *   - Clean up stale Workbox caches from prior deploys
 *   - Handle a `SKIP_WAITING` message from the auto-update flow
 *
 * Phase 7 adds:
 *   - `push` event handler → `showNotification`
 *   - `notificationclick` handler → focus / open a tab
 *   - `pushsubscriptionchange` handler → re-POST the new subscription
 *
 * We deliberately DON'T register a runtime caching strategy for API
 * calls. The csuite broker is the source of truth for everything
 * in the SPA, and serving stale /briefing or /history responses from
 * a Workbox cache would confuse users during outages. The offline
 * story is "the shell loads offline; real data requires the server."
 */

import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// Precache the SPA shell. The manifest is injected by vite-plugin-pwa
// at build time with fingerprinted URLs, so an updated deploy
// invalidates everything automatically.
precacheAndRoute(self.__WB_MANIFEST);

// Remove caches from previous Workbox versions / stale builds so we
// don't accumulate megabytes of dead entries in users' browsers.
cleanupOutdatedCaches();

// Allow the client-side `registerSW({onNeedRefresh})` hook to ask us
// to activate immediately. Without this, a new SW waits in the
// `waiting` state until all tabs close — frustrating for dev and for
// users who hit "reload to update."
self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

// ─── Web Push handlers ───────────────────────────────────────────

/**
 * Payload shape the server dispatches (see
 * `apps/server/src/push/dispatch.ts::PushPayload`). Kept in a
 * TS interface rather than imported so the worker bundle doesn't
 * need to pull in server-side modules.
 */
interface CsuitePushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  severity: 'normal' | 'high';
  messageId: string;
}

self.addEventListener('push', (event) => {
  let payload: CsuitePushPayload;
  try {
    payload = (event.data?.json() as CsuitePushPayload) ?? fallbackPayload();
  } catch {
    payload = fallbackPayload();
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: payload.tag,
      data: { url: payload.url, messageId: payload.messageId },
      // High-severity messages stay on-screen until dismissed so
      // members don't miss a `warning`/`error`/`critical` broadcast
      // because their phone auto-hid the banner after a second.
      requireInteraction: payload.severity === 'high',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Prefer focusing an existing same-origin tab over opening a new
      // one — members running the PWA usually already have it open.
      for (const client of all) {
        if (client.url.startsWith(self.registration.scope)) {
          await client.focus();
          // Forward the click into the tab so the SPA can deep-link
          // into the right thread. The App listens for this via
          // navigator.serviceWorker.addEventListener('message', ...).
          client.postMessage({
            type: 'notification-click',
            url,
            messageId: (event.notification.data as { messageId?: string } | undefined)?.messageId,
          });
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

/**
 * The `pushsubscriptionchange` event fires when the browser's push
 * service rotates or invalidates the subscription out from under us
 * (rare, but does happen on Firefox when the user clears site data).
 * Re-subscribe and POST the new endpoint back to the server. We
 * swallow errors here because the next user action that tries to
 * notify will show them the problem more loudly.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  // `pushsubscriptionchange` isn't fully typed in lib.webworker.d.ts;
  // cast through unknown to pick out the old subscription's key.
  const ev = event as unknown as {
    oldSubscription?: PushSubscription;
    waitUntil: ServiceWorkerGlobalScope['addEventListener'] extends unknown
      ? (p: Promise<unknown>) => void
      : never;
  };
  ev.waitUntil?.(
    (async () => {
      try {
        const applicationServerKey = ev.oldSubscription?.options?.applicationServerKey;
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          ...(applicationServerKey ? { applicationServerKey } : {}),
        });
        // POST back to the server using the same endpoint the SPA uses.
        // No auth header — the session cookie rides along automatically.
        await fetch('/push/subscriptions', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: sub.endpoint,
            keys: {
              p256dh: arrayBufferToBase64Url(sub.getKey('p256dh')),
              auth: arrayBufferToBase64Url(sub.getKey('auth')),
            },
          }),
        });
      } catch {
        // Nothing graceful to do at this layer — rely on the client
        // to re-request on next load.
      }
    })(),
  );
});

function fallbackPayload(): CsuitePushPayload {
  return {
    title: 'csuite',
    body: 'new activity on the net',
    tag: 'csuite:generic',
    url: '/',
    severity: 'normal',
    messageId: '',
  };
}

function arrayBufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
