/**
 * Vite config for csuite-web-host.
 *
 * Build output lands directly in `apps/server/public/` so Hono's
 * static-file middleware can serve it without a copy step. Dev mode
 * proxies every csuite HTTP API path to the server running on
 * `:8717`, so `pnpm dev` at the root gives you:
 *
 *   - Vite dev server on :5173 (hot reload, fast refresh)
 *   - Hono server on :8717 (broker API)
 *   - Full local loop with cookies and WebSocket upgrades working through the proxy
 *
 * PWA (Phase 6): `vite-plugin-pwa` in `injectManifest` mode. The SW
 * source lives at `src/sw.ts` — we write our own handlers (push,
 * notificationclick, etc in Phase 7) and the plugin only injects the
 * precache manifest into it. `generateSW` mode is a trap here
 * because it doesn't let us add push event handlers.
 */

import { resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { PATHS } from 'csuite-sdk/protocol';
import unocss from 'unocss/vite';
import { defineConfig, type PluginOption } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Dev-mode proxy target: the broker's default bind port. Matches
// `DEFAULT_PORT` (8717) from the SDK so `pnpm dev` at the repo root
// just works with no env vars.
const PROXY_TARGET = 'http://127.0.0.1:8717';

/**
 * Paths whose top-level segment is *also* a SPA route — proxying the
 * top-level prefix would steal that page from Vite. We forward only
 * subpaths via a regex below, leaving the bare path for the SPA.
 *
 *   `/enroll`        → SPA page (the verify-code form an operator hits
 *                      from a CLI deep link); see apps/web-host/src/App.tsx.
 *   `/enroll/poll` etc → API endpoints (must reach the broker).
 *
 * Add to this set if you ever introduce another shared prefix.
 */
const SPA_SHARED_PREFIXES = new Set<string>(['/enroll']);

/**
 * Derive the dev-proxy rule set from `PATHS` so adding a new API
 * surface to the broker requires no change here. We map every value
 * to its top-level segment (`/team/presets` → `/team`), de-dupe, and
 * proxy each to the broker. Top-level segments that conflict with a
 * SPA route fall back to a subpath-only regex (`^/enroll/`) so the
 * bare path is still served by Vite as the SPA.
 */
function deriveProxyRules(): Record<string, { target: string; changeOrigin: false; ws: true }> {
  const topLevel = new Set<string>();
  for (const value of Object.values(PATHS)) {
    const seg = value.split('/')[1];
    if (seg) topLevel.add(`/${seg}`);
  }
  const rules: Record<string, { target: string; changeOrigin: false; ws: true }> = {};
  for (const prefix of topLevel) {
    const key = SPA_SHARED_PREFIXES.has(prefix) ? `^${prefix}/` : prefix;
    rules[key] = {
      target: PROXY_TARGET,
      // Session cookies are SameSite=Strict, so we preserve the
      // browser-visible host; `changeOrigin: false` ensures the
      // Origin header reaches Hono unchanged.
      changeOrigin: false,
      // `/subscribe` and `/members/:name/activity/stream` upgrade to
      // WebSocket; `ws: true` on every rule is harmless for HTTP-only
      // paths and required for upgrades.
      ws: true,
    };
  }
  return rules;
}

// `vite-plugin-pwa` ships with its own nested copy of Vite's types,
// so its `Plugin<any>[]` return is a distinct-but-structurally-identical
// type from Vite's own `Plugin`. Without the explicit `PluginOption[]`
// annotation, TS 5.x hits "Excessive stack depth" trying to unify them.
const plugins: PluginOption[] = [
  preact(),
  unocss(),
  VitePWA({
    // `injectManifest` = we own the service worker; the plugin just
    // stamps the precache list into `self.__WB_MANIFEST`. Required
    // for Web Push support (generateSW can't host custom `push`
    // event handlers cleanly).
    strategies: 'injectManifest',
    srcDir: 'src',
    filename: 'sw.ts',
    registerType: 'autoUpdate',
    // Disable the plugin's dev-mode service worker so tests and the
    // dev server don't try to register a half-baked SW against the
    // Vite HMR socket. In prod builds the real SW ships.
    devOptions: {
      enabled: false,
    },
    injectManifest: {
      // Default glob picks up JS/CSS/HTML/assets. Include the
      // manifest icons too so the shell works fully offline.
      globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
    },
    includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
    manifest: {
      name: 'CommandSuite',
      short_name: 'csuite',
      description: 'Self-hosted agent control plane.',
      theme_color: '#3E5C76',
      background_color: '#F6F3EC',
      display: 'standalone',
      orientation: 'any',
      start_url: '/',
      scope: '/',
      icons: [
        {
          src: 'icons/icon-192.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any maskable',
        },
        {
          src: 'icons/icon-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any maskable',
        },
      ],
    },
  }),
];

export default defineConfig({
  plugins,
  // Output into the server's static dir. `emptyOutDir: true` makes
  // `vite build` idempotent across rebuilds — stale hashed assets
  // from prior builds get cleaned up instead of piling up.
  build: {
    outDir: resolve(__dirname, '../server/public'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    // Bind on all interfaces so on-LAN / tailnet devices (iPhone via
    // Tailscale, etc.) can reach the dev server for cross-device
    // testing. The dev server is only ever expected to run inside a
    // trusted network — not behind a public IP — so the wider bind
    // is the right default for an internal tool.
    host: true,
    proxy: deriveProxyRules(),
  },
});
