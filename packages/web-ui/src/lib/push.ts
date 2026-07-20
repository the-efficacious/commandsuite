/**
 * Browser Web Push — subscription lifecycle + signal-backed state.
 *
 * Responsibilities:
 *   - Feature-detect Push API + ServiceWorker + Notification
 *   - Detect iOS-requires-standalone-install edge case
 *   - Enable: request permission → pushManager.subscribe → POST to server
 *   - Disable: pushManager.unsubscribe → DELETE from server
 *   - Maintain a `pushState` signal so UI components can render
 *
 * iOS quirk: Safari on iOS 16.4+ supports Web Push, but only after
 * the PWA is installed via "Add to Home Screen." Detection uses
 * `navigator.standalone` (iOS-specific) or the `display-mode` media
 * query. If the user is on iOS in a normal tab, we show an explainer
 * instead of the enable button.
 */

import { signal } from '@preact/signals';
import { getClient } from './client.js';

export type PushState =
  | { kind: 'unsupported'; reason: 'no-push-api' | 'no-service-worker' | 'ios-needs-install' }
  | { kind: 'idle'; permission: NotificationPermission }
  | { kind: 'subscribing' }
  | { kind: 'subscribed'; subscriptionId: number; endpoint: string }
  | { kind: 'denied' }
  | { kind: 'error'; message: string };

export const pushState = signal<PushState>({ kind: 'idle', permission: 'default' });

function isIos(): boolean {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) && !('MSStream' in window);
}

function isStandalone(): boolean {
  // `navigator.standalone` is iOS-only, older API.
  const iosStandalone = Boolean((navigator as unknown as { standalone?: boolean }).standalone);
  // `display-mode: standalone` works everywhere else.
  const mq =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches;
  return iosStandalone || mq;
}

/**
 * Single synchronous feature check. Returns `null` if push is supported
 * in this browser (caller may proceed to subscribe), or a typed reason
 * object the UI can render.
 */
export function detectSupport(): null | {
  reason: 'no-push-api' | 'no-service-worker' | 'ios-needs-install';
} {
  if (typeof navigator === 'undefined') return { reason: 'no-service-worker' };
  if (!('serviceWorker' in navigator)) return { reason: 'no-service-worker' };
  if (typeof PushManager === 'undefined') return { reason: 'no-push-api' };
  if (typeof Notification === 'undefined') return { reason: 'no-push-api' };
  if (isIos() && !isStandalone()) return { reason: 'ios-needs-install' };
  return null;
}

/** Initial sync call on shell mount. Populates `pushState` once. */
export async function initializePushState(): Promise<void> {
  const unsupported = detectSupport();
  if (unsupported) {
    pushState.value = { kind: 'unsupported', reason: unsupported.reason };
    return;
  }
  if (Notification.permission === 'denied') {
    pushState.value = { kind: 'denied' };
    return;
  }
  // Check if we already have an active subscription — a user who
  // refreshed the page shouldn't have to re-enable.
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      pushState.value = {
        kind: 'subscribed',
        // Without a DB roundtrip we don't know the subscription id;
        // use -1 as a sentinel meaning "live but not locally tracked."
        // The disable flow unsubscribes by endpoint so the id isn't
        // strictly required.
        subscriptionId: -1,
        endpoint: sub.endpoint,
      };
      return;
    }
  } catch {
    // SW not ready yet — stay idle, user can click the button later.
  }
  pushState.value = { kind: 'idle', permission: Notification.permission };
}

/**
 * Turn notifications ON. Handles: permission prompt → pushManager
 * subscribe → POST to server. Updates pushState throughout.
 */
export async function enablePush(): Promise<void> {
  const unsupported = detectSupport();
  if (unsupported) {
    pushState.value = { kind: 'unsupported', reason: unsupported.reason };
    return;
  }
  pushState.value = { kind: 'subscribing' };

  let permission: NotificationPermission = Notification.permission;
  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') {
    pushState.value = permission === 'denied' ? { kind: 'denied' } : { kind: 'idle', permission };
    return;
  }

  try {
    const client = getClient();
    const { publicKey } = await client.vapidPublicKey();
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const payload = subscriptionToPayload(sub);
    const resp = await client.registerPushSubscription(payload);
    pushState.value = {
      kind: 'subscribed',
      subscriptionId: resp.id,
      endpoint: resp.endpoint,
    };
  } catch (err) {
    pushState.value = {
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Turn notifications OFF. */
export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await sub.unsubscribe();
    }
    const current = pushState.value;
    if (current.kind === 'subscribed' && current.subscriptionId >= 0) {
      try {
        await getClient().deletePushSubscription(current.subscriptionId);
      } catch {
        // The server will also clean up on next 410 from the push
        // service — losing this call isn't fatal.
      }
    }
    pushState.value = { kind: 'idle', permission: Notification.permission };
  } catch (err) {
    pushState.value = {
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── helpers ────────────────────────────────────────────────────────

/**
 * VAPID public keys are base64url strings. pushManager.subscribe
 * requires a BufferSource of raw bytes. This decoder handles both
 * url-safe and normal base64 and returns a Uint8Array explicitly
 * backed by a fresh `ArrayBuffer` (not `SharedArrayBuffer`) so the
 * type checker narrows it correctly for `applicationServerKey`.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(normalized);
  const buffer = new ArrayBuffer(rawData.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}

function subscriptionToPayload(sub: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  return {
    endpoint: sub.endpoint,
    keys: {
      p256dh: arrayBufferToBase64Url(sub.getKey('p256dh')),
      auth: arrayBufferToBase64Url(sub.getKey('auth')),
    },
  };
}

function arrayBufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Test reset between it() blocks. */
export function __resetPushStateForTests(): void {
  pushState.value = { kind: 'idle', permission: 'default' };
}
