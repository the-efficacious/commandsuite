/**
 * Stream-status → toast bridge.
 *
 * Despite the legacy filename, this component renders nothing of its
 * own — it just subscribes to the live-stream signals and emits (or
 * dismisses) a tagged sticky toast as the connection state changes.
 *
 * State machine:
 *   - Healthy steady state                 → no toast
 *   - Connected, then dropped              → "Disconnected" sticky toast
 *                                            (after a short grace window,
 *                                            so backgrounded-tab churn
 *                                            on focus return doesn't
 *                                            flash the warning)
 *   - Reconnected with backfill loss       → "Reconnected" auto-dismiss toast
 *
 * The pre-first-open race (signal starts `false` until the WebSocket's
 * first `open` event) is gated behind `streamEverConnected` so the
 * shell doesn't shout "disconnected" during the normal connect window.
 *
 * The post-resume race (a previously-connected tab returning from the
 * background briefly reads `connected: false` until the WebSocket
 * re-opens) is gated by `DISCONNECT_GRACE_MS`. If reconnect lands
 * within that window we never raise the toast at all.
 *
 * Dedup is handled by the `stream-status` tag — re-emitting replaces
 * any previous stream-status toast in place. Healthy reconnect with
 * no backfill loss explicitly clears the tag.
 */

import { useEffect } from 'preact/hooks';
import { streamBackfillError, streamConnected, streamEverConnected } from '../lib/live.js';
import { dismissToastsByTag, toast } from '../lib/toast.js';

const STATUS_TAG = 'stream-status';

/**
 * How long to wait after a disconnect before raising the toast. Tuned
 * to absorb the typical tab-resume reconnect window (often <1 s) and
 * brief network blips, without making real outages feel silent.
 */
const DISCONNECT_GRACE_MS = 3000;

export function DisconnectedBanner() {
  // Read all three signals so the effect re-runs on any change.
  const connected = streamConnected.value;
  const everConnected = streamEverConnected.value;
  const backfillErr = streamBackfillError.value;

  useEffect(() => {
    // Pre-first-open: stay quiet.
    if (!connected && !everConnected) return;

    if (!connected) {
      // Defer the toast — if the stream reconnects within the grace
      // window, the cleanup below clears the timer and the user sees
      // nothing. This swallows the focus-return flash on browsers
      // that pause WebSockets in backgrounded tabs.
      const timer = setTimeout(() => {
        toast.warn({
          tag: STATUS_TAG,
          title: 'Disconnected',
          body: 'The live update stream is offline — trying to reconnect…',
          duration: null,
        });
      }, DISCONNECT_GRACE_MS);
      return () => clearTimeout(timer);
    }

    // Reconnected, but backfill failed — surface a transient warning,
    // then let it auto-dismiss. The user can click Refresh to recover
    // any history that landed during the outage.
    if (backfillErr !== null) {
      toast.warn({
        tag: STATUS_TAG,
        title: 'Reconnected',
        body: `Live stream is back but missed some history: ${backfillErr}.`,
        action: {
          label: 'Refresh',
          onClick: () => {
            window.location.reload();
          },
        },
      });
      return;
    }

    // Healthy steady state — clear any stream-status toast we left up.
    dismissToastsByTag(STATUS_TAG);
  }, [connected, everConnected, backfillErr]);

  return null;
}
