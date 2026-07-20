/**
 * Shared csuite-sdk Client instance for the whole SPA.
 *
 * One module-level singleton so every component and hook talks to
 * the same configured client. `useCookies: true` makes `fetch` send
 * the `csuite_session` cookie on every request — there's no bearer
 * token in the browser plane.
 *
 * URL: the SPA is served from the same origin as the API in production
 * (apps/server/public), and the Vite dev server proxies API paths in
 * dev. Either way, `location.origin` is the right base URL.
 */

import { Client } from 'csuite-sdk/client';

// Lazy so unit tests can mock `window.location` before the first
// access. Created once, cached forever.
let cached: Client | null = null;

export function getClient(): Client {
  if (cached !== null) return cached;
  cached = new Client({
    url: typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
    useCookies: true,
  });
  return cached;
}

/**
 * Test helper: clear the cached client so a test can rebuild it with
 * a stubbed fetch. Not exported from the package; only intended for
 * tests that import the `/lib/client.js` module path directly.
 */
export function __resetClientForTests(): void {
  cached = null;
}
