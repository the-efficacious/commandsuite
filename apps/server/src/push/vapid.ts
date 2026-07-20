/**
 * VAPID keypair management.
 *
 * VAPID keys authenticate our server to the browser push services
 * (FCM, Mozilla autopush, Apple). They're generated once, persisted
 * forever, and MUST NOT be rotated casually — every existing push
 * subscription is bound to the key that signed its creation, so a
 * rotation invalidates every notification until each device
 * re-subscribes.
 *
 * Storage: a top-level `webPush` block in the team config file.
 * Auto-generated on first boot and written back via the same atomic
 * rewrite path we already use for slot migrations. Subsequent boots
 * see the existing block and reuse it verbatim.
 *
 * The on-disk shape uses `vapidPublicKey`/`vapidPrivateKey`/
 * `vapidSubject` so config files are self-documenting. This matches
 * the `WebPushConfig` type exported from `members.ts`.
 */

// web-push is a CommonJS module whose named exports can't be
// re-exported as ESM bindings by Node — tsup's pass-through import
// form fails at runtime with "Named export not found". Default-import
// the whole namespace and destructure at call sites instead.
import webpush from 'web-push';
import type { WebPushConfig } from '../members.js';

const { generateVAPIDKeys, setVapidDetails } = webpush;

/**
 * Default subject for fresh VAPID generations. VAPID requires a
 * contact URL in `mailto:` or `https:` form — the push services use
 * it to reach the server operator if a key abuses the network. We
 * ship a placeholder; operators can override in config.json.
 */
export const DEFAULT_VAPID_SUBJECT = 'mailto:admin@csuite.local';

/**
 * Generate a fresh VAPID keypair. Returns a `WebPushConfig` ready to
 * be persisted directly into the team config file — no field
 * renaming on the way to disk.
 */
export function generateVapidKeys(subject: string = DEFAULT_VAPID_SUBJECT): WebPushConfig {
  const { publicKey, privateKey } = generateVAPIDKeys();
  return {
    vapidPublicKey: publicKey,
    vapidPrivateKey: privateKey,
    vapidSubject: subject,
  };
}

/**
 * Configure web-push's global state with our VAPID credentials. Must
 * be called before any `sendNotification()` or the library throws at
 * request time. Idempotent — safe to call on every runServer().
 */
export function configureVapid(keys: WebPushConfig): void {
  setVapidDetails(keys.vapidSubject, keys.vapidPublicKey, keys.vapidPrivateKey);
}
