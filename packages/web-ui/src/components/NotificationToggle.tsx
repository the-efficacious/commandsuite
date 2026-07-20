/**
 * Notification toggle — small badge in the Header that enables /
 * disables Web Push for the current device.
 *
 * Reads the `pushState` signal set up by `lib/push.ts` and renders one
 * of: nothing (truly unsupported), "install to enable" hint (iOS),
 * "blocked" hint, "subscribing" placeholder, "on" button (subscribed),
 * error button, or idle "enable" button.
 *
 * All visual states use canonical .badge variants so the header strip
 * keeps a consistent vocabulary.
 */

import { disablePush, enablePush, pushState } from '../lib/push.js';
import { AlertTriangle } from './icons/index.js';

export function NotificationToggle() {
  const state = pushState.value;

  if (state.kind === 'unsupported') {
    if (state.reason === 'ios-needs-install') {
      return (
        <span
          class="badge soft"
          title="Add csuite to your home screen to enable notifications on iOS"
        >
          ◈ Install to enable
        </span>
      );
    }
    return null;
  }
  if (state.kind === 'denied') {
    return (
      <span class="badge muted" title="Notifications are blocked in your browser settings">
        ◇ Blocked
      </span>
    );
  }
  if (state.kind === 'subscribing') {
    return <span class="badge muted">…</span>;
  }
  if (state.kind === 'subscribed') {
    return (
      <button
        type="button"
        onClick={() => {
          void disablePush();
        }}
        class="badge soft"
        style="cursor:pointer"
        title="Click to disable notifications for this device"
      >
        ● On
      </button>
    );
  }
  if (state.kind === 'error') {
    return (
      <button
        type="button"
        onClick={() => {
          void enablePush();
        }}
        class="badge ember flex items-center"
        style="cursor:pointer;gap:4px"
        title={state.message}
      >
        <AlertTriangle size={11} aria-hidden="true" />
        Notif error
      </button>
    );
  }
  // idle
  return (
    <button
      type="button"
      onClick={() => {
        void enablePush();
      }}
      class="badge"
      style="cursor:pointer"
    >
      ◇ Enable notifications
    </button>
  );
}
