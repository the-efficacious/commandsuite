/**
 * Entry point for csuite-web-host. Renders the Preact app into #app
 * and pulls in UnoCSS + a minimal reset.
 *
 * Also registers the Phase 6 service worker via
 * `virtual:pwa-register`. `autoUpdate` policy: the plugin auto-accepts
 * the new worker on next navigation, and the `onNeedRefresh` hook
 * below forwards SKIP_WAITING so updates activate without a second
 * full page reload. No toast UI yet — we'll add one if members
 * report missing updates.
 *
 * Keep this file boring — anything that needs to know about config,
 * routing, or auth belongs in `App.tsx` or the route modules.
 */

import '@unocss/reset/tailwind.css';
import 'uno.css';
import 'csuite-web-ui/styles.css';
import { registerSW } from 'virtual:pwa-register';
import { initTheme } from 'csuite-web-ui';
import { render } from 'preact';
import { App } from './App.js';

// Set `<html data-theme>` from persisted preference + system prefs
// before the first render, so styled content paints with the correct
// palette on first frame.
initTheme();

const root = document.getElementById('app');
if (!root) {
  throw new Error('#app root element is missing from index.html');
}
render(<App />, root);

// Service worker registration. `registerType: 'autoUpdate'` in the
// Vite config means this will automatically apply new builds on the
// next reload; we just wire the skip-waiting handshake so the worker
// doesn't linger in `waiting` state.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // The plugin's registerSW returns a function that takes the
    // update. Calling it here applies the new SW immediately.
    // No prompt in v1 — we're OK with mid-session updates because
    // the shell is small and the transport state is all server-side.
    void updateSW(true);
  },
});
