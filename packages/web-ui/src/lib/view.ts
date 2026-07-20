/**
 * View signal — which thread or panel is active.
 *
 * `view` is now derived from the router's `currentRoute`. The URL is
 * the source of truth; this computed is a translation layer that lets
 * existing components keep reading a `View` discriminated-union
 * without caring about URL parsing.
 *
 * All the legacy `select*` helpers are preserved as thin wrappers
 * around `navigate(route)` so callers never touch the router module
 * directly. Each also closes the mobile sidebar drawer — tapping a
 * nav item and staring at the sidebar on top of the new view would
 * feel broken.
 */

import { computed, effect, signal } from '@preact/signals';
import { channelBySlug } from './channels.js';
import { closeInspector } from './inspector.js';
import {
  CHAN_PREFIX,
  channelThreadKey,
  DM_PREFIX,
  dmThreadKey,
  GENERAL_CHANNEL_ID,
  GENERAL_THREAD,
  isChannelThread,
  isDmThread,
  PRIMARY_THREAD,
} from './messages.js';
import { currentRoute, navigate } from './router.js';
import type { ProfileTab, Route } from './routes.js';

export type View =
  | { kind: 'thread'; key: string; channelSlug?: string }
  | { kind: 'overview' }
  | { kind: 'inbox' }
  | { kind: 'account' }
  | { kind: 'channels-browse' }
  | { kind: 'channel-create' }
  | { kind: 'objectives-list' }
  | { kind: 'objective-detail'; id: string }
  | { kind: 'objective-create' }
  | { kind: 'member-profile'; name: string; tab: ProfileTab }
  | { kind: 'files'; path: string }
  | { kind: 'members' }
  | { kind: 'tool-sources' }
  | { kind: 'tool-source-detail'; slug: string }
  | { kind: 'secrets' }
  | { kind: 'secret-detail'; slug: string }
  | { kind: 'notifications' }
  | { kind: 'notification-detail'; slug: string };

export const view = computed<View>(() => viewFromRoute(currentRoute.value));

/**
 * Routes that render as modal overlays rather than full-screen
 * panels — the previous (non-modal) view stays visible behind them.
 * Today: just the account settings page. Settings flows that get
 * modalized in the future should be added here so the underlay
 * tracking picks them up.
 */
const MODAL_ROUTE_KINDS: ReadonlySet<Route['kind']> = new Set<Route['kind']>(['account']);

/**
 * Most recent non-modal route the viewer was on. The `account`
 * modal renders the view derived from this route as its underlay so
 * closing the modal returns the viewer to where they were instead
 * of dropping them on a default landing.
 *
 * Defaults to `home` for the very first render (or a direct deep
 * link to /account) — there's no real "previous" then, so the team
 * overview is the most predictable fallback.
 */
const lastNonModalRouteSignal = signal<Route>({ kind: 'home' });

if (typeof window !== 'undefined') {
  effect(() => {
    const r = currentRoute.value;
    if (!MODAL_ROUTE_KINDS.has(r.kind)) {
      lastNonModalRouteSignal.value = r;
    }
  });

  // The inspector overlay is contextual to a thread. Navigating to
  // anything else — a panel, the browse page, an objective — should
  // auto-close it so it doesn't reopen inappropriately on the next
  // thread visit. Likewise the navcol drawer collapses on every
  // navigation so a tap on a row doesn't leave the drawer obscuring
  // the just-revealed view.
  let lastRouteKey: string | null = null;
  effect(() => {
    const r = currentRoute.value;
    const key = JSON.stringify(r);
    if (lastRouteKey !== null && lastRouteKey !== key) {
      closeInspector();
      isSidebarOpen.value = false;
    }
    lastRouteKey = key;
  });
}

export const lastNonModalView = computed<View>(() => viewFromRoute(lastNonModalRouteSignal.value));

export function isModalView(v: View): boolean {
  return v.kind === 'account';
}

/**
 * Navigate back to the underlay (most recent non-modal route).
 * Used as the close handler for modalized routes.
 */
export function closeModalView(): void {
  navigate(lastNonModalRouteSignal.value);
}

function viewFromRoute(route: Route): View {
  switch (route.kind) {
    case 'home':
      return { kind: 'overview' };
    case 'inbox':
      return { kind: 'inbox' };
    case 'account':
      return { kind: 'account' };
    case 'thread-channel': {
      // Map a `/c/<slug>` URL to its internal thread key. General has
      // a known fixed key (legacy `'primary'`); other channels need a
      // slug → id lookup against the channels signal. If the lookup
      // misses (channel not yet loaded, or a stale URL referencing an
      // archived/unknown channel), we fall through to a placeholder
      // key derived from the slug — the Transcript renders the
      // resulting thread as "no messages yet" while the load resolves.
      if (route.slug === GENERAL_CHANNEL_ID) {
        return { kind: 'thread', key: GENERAL_THREAD, channelSlug: route.slug };
      }
      const ch = channelBySlug(route.slug);
      if (ch) {
        return { kind: 'thread', key: channelThreadKey(ch.id), channelSlug: ch.slug };
      }
      return { kind: 'thread', key: `${CHAN_PREFIX}${route.slug}`, channelSlug: route.slug };
    }
    case 'thread-dm':
      return { kind: 'thread', key: dmThreadKey(route.name) };
    case 'channels-browse':
      return { kind: 'channels-browse' };
    case 'channel-create':
      return { kind: 'channel-create' };
    case 'objectives-list':
      return { kind: 'objectives-list' };
    case 'objective-create':
      return { kind: 'objective-create' };
    case 'objective-detail':
      return { kind: 'objective-detail', id: route.id };
    case 'members':
      return { kind: 'members' };
    case 'tool-sources':
      return { kind: 'tool-sources' };
    case 'tool-source-detail':
      return { kind: 'tool-source-detail', slug: route.slug };
    case 'secrets':
      return { kind: 'secrets' };
    case 'secret-detail':
      return { kind: 'secret-detail', slug: route.slug };
    case 'notifications':
      return { kind: 'notifications' };
    case 'notification-detail':
      return { kind: 'notification-detail', slug: route.slug };
    case 'member-profile':
      return { kind: 'member-profile', name: route.name, tab: route.tab };
    case 'files':
      return { kind: 'files', path: route.path };
  }
}

/**
 * Mobile sidebar drawer — not routing state. The desktop sidebar is
 * always visible; on narrow viewports it becomes an overlay that
 * opens/closes independently of the active view.
 */
export const isSidebarOpen = signal(false);

export function openSidebar(): void {
  isSidebarOpen.value = true;
}

export function closeSidebar(): void {
  isSidebarOpen.value = false;
}

export function selectThread(key: string): void {
  if (key === PRIMARY_THREAD) {
    navigate({ kind: 'thread-channel', slug: GENERAL_CHANNEL_ID });
  } else if (isDmThread(key)) {
    navigate({ kind: 'thread-dm', name: key.slice(DM_PREFIX.length) });
  } else if (isChannelThread(key)) {
    // Non-general channel keys are `chan:<id>` — find the matching
    // slug for a clean URL. If the lookup misses the user lands on
    // the placeholder thread; the URL is best-effort.
    const id = key.slice(CHAN_PREFIX.length);
    const ch = channelBySlug(id);
    navigate({ kind: 'thread-channel', slug: ch?.slug ?? id });
  }
  // `obj:<id>` threads don't have a top-level URL — they surface
  // inside the objective detail view. Ignore the call; callers
  // asking for such a thread should route to the objective instead.
  isSidebarOpen.value = false;
}

export function selectChannel(slug: string): void {
  navigate({ kind: 'thread-channel', slug });
  isSidebarOpen.value = false;
}

export function selectChannelsBrowse(): void {
  navigate({ kind: 'channels-browse' });
  isSidebarOpen.value = false;
}

export function selectChannelCreate(): void {
  navigate({ kind: 'channel-create' });
  isSidebarOpen.value = false;
}

export function selectDmWith(name: string): void {
  navigate({ kind: 'thread-dm', name });
  isSidebarOpen.value = false;
}

export function selectOverview(): void {
  navigate({ kind: 'home' });
  isSidebarOpen.value = false;
}

export function selectInbox(): void {
  navigate({ kind: 'inbox' });
  isSidebarOpen.value = false;
}

export function selectAccount(): void {
  navigate({ kind: 'account' });
  isSidebarOpen.value = false;
}

export function selectObjectivesList(): void {
  navigate({ kind: 'objectives-list' });
  isSidebarOpen.value = false;
}

export function selectObjectiveDetail(id: string): void {
  navigate({ kind: 'objective-detail', id });
  isSidebarOpen.value = false;
}

export function selectObjectiveCreate(): void {
  navigate({ kind: 'objective-create' });
  isSidebarOpen.value = false;
}

export function selectAgentDetail(name: string): void {
  selectMemberProfile(name);
}

export function selectMemberProfile(name: string, tab: ProfileTab = 'overview'): void {
  navigate({ kind: 'member-profile', name, tab });
  isSidebarOpen.value = false;
}

export function selectFiles(path: string): void {
  navigate({ kind: 'files', path });
  isSidebarOpen.value = false;
}

export function selectMembers(): void {
  navigate({ kind: 'members' });
  isSidebarOpen.value = false;
}

export function selectToolSources(): void {
  navigate({ kind: 'tool-sources' });
  isSidebarOpen.value = false;
}

export function selectToolSourceDetail(slug: string): void {
  navigate({ kind: 'tool-source-detail', slug });
  isSidebarOpen.value = false;
}

export function selectSecrets(): void {
  navigate({ kind: 'secrets' });
  isSidebarOpen.value = false;
}

export function selectSecretDetail(slug: string): void {
  navigate({ kind: 'secret-detail', slug });
  isSidebarOpen.value = false;
}

export function selectNotifications(): void {
  navigate({ kind: 'notifications' });
  isSidebarOpen.value = false;
}

export function selectNotificationDetail(slug: string): void {
  navigate({ kind: 'notification-detail', slug });
  isSidebarOpen.value = false;
}

export function __resetViewForTests(): void {
  // Clearing the router to `/` maps to view { kind: 'overview' } via
  // the computed above. The shell tests were originally written
  // against a default of primary-thread; we preserve that by
  // navigating explicitly to the general channel (its successor).
  navigate({ kind: 'thread-channel', slug: GENERAL_CHANNEL_ID }, { replace: true });
  isSidebarOpen.value = false;
}
