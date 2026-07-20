/**
 * Router — browser history ↔ `currentRoute` signal.
 *
 * URL is the single source of truth for view state. On module load
 * we boot the signal from `window.location.pathname` and subscribe
 * to `popstate` so the back/forward buttons update the app state.
 * In-app navigation goes through `navigate(route)`, which pushes to
 * the History API and updates the signal.
 *
 * Derived concerns (the legacy `view` signal, drawer state, etc.)
 * read from `currentRoute` — they never set it directly. The only
 * writers are this module's `navigate` + the popstate listener.
 *
 * Team-slug prefix: when an embedding host calls
 * `setRouterTeamSlug('acme')`, every outbound `navigate(...)` that
 * didn't already carry a `team` field auto-gets one. The URL shape
 * under a team slug becomes `/t/acme/objectives`, `/t/acme/c/team-chat`,
 * etc. — `lib/routes.ts` already handles the prefix. Single-team
 * deployments leave the slug unset so URLs live at the origin root.
 */

import { signal } from '@preact/signals';
import { formatRoute, parseRoute, type Route, routesEqual } from './routes.js';

function initialRoute(): Route {
  if (typeof window === 'undefined') return { kind: 'home' };
  return parseRoute(window.location.pathname);
}

export const currentRoute = signal<Route>(initialRoute());

/**
 * Current team-slug prefix. Host code (TeamShell) calls
 * `setRouterTeamSlug` on mount to pin this; `navigate` reads it to
 * auto-inject `team` into routes that don't already carry one.
 */
const currentTeamSlug = signal<string | null>(null);

export function setRouterTeamSlug(slug: string | null): void {
  currentTeamSlug.value = slug;
}

export function getRouterTeamSlug(): string | null {
  return currentTeamSlug.value;
}

let popstateInstalled = false;
function installPopstate(): void {
  if (popstateInstalled || typeof window === 'undefined') return;
  window.addEventListener('popstate', () => {
    currentRoute.value = parseRoute(window.location.pathname);
  });
  popstateInstalled = true;
}
installPopstate();

/**
 * In-app navigation. No-ops when the target matches the current
 * route (so repeated clicks on the same nav item don't pile history
 * entries). Pass `{ replace: true }` for redirects (e.g. mapping an
 * unknown URL to home without polluting the back stack).
 *
 * If a team slug is active (set by `setRouterTeamSlug`) and the
 * target route doesn't already carry `team`, we inject the slug so
 * every in-shell navigation stays under `/t/<slug>/...`.
 */
export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const slug = currentTeamSlug.value;
  const effective: Route =
    slug !== null && route.team === undefined ? { ...route, team: slug } : route;
  if (routesEqual(currentRoute.value, effective)) return;
  currentRoute.value = effective;
  if (typeof window === 'undefined') return;
  const url = formatRoute(effective);
  if (options.replace) {
    window.history.replaceState(null, '', url);
  } else {
    window.history.pushState(null, '', url);
  }
}

/**
 * Reset to the initial state — test-only. Restores the `/` URL and
 * resets both route + team-slug signals so each test starts clean.
 */
export function __resetRouterForTests(): void {
  currentRoute.value = { kind: 'home' };
  currentTeamSlug.value = null;
  if (typeof window !== 'undefined') {
    window.history.replaceState(null, '', '/');
  }
}
