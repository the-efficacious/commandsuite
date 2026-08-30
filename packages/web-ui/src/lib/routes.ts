/**
 * Typed route table — URL is the single source of truth for view state.
 *
 * Every in-app navigation goes through `navigate(route)` in ./router.ts,
 * which pushes to the History API and updates the `currentRoute` signal.
 *
 * Multi-team: routes accept an optional `/t/:team` prefix for hosts
 * that mount the shell against more than one team. `parseRoute`
 * strips the prefix into `route.team`; `formatRoute` re-emits it only
 * when `route.team` is set. Single-team deployments simply leave
 * `team` unset — the prefix never appears and URLs live at the origin
 * root.
 *
 * Unknown paths resolve to `home` so stale links don't strand users.
 */

export type ProfileTab =
  | 'overview'
  | 'acceptance-undeclared'
  | 'activity'
  | 'objectives'
  | 'files'
  | 'manage';

export const PROFILE_TABS: readonly ProfileTab[] = [
  'overview',
  'acceptance-undeclared',
  'activity',
  'objectives',
  'files',
  'manage',
];

export type Route =
  | (RouteBase & { kind: 'home' })
  | (RouteBase & { kind: 'inbox' })
  | (RouteBase & { kind: 'account' })
  | (RouteBase & { kind: 'thread-channel'; slug: string })
  | (RouteBase & { kind: 'thread-dm'; name: string })
  | (RouteBase & { kind: 'channels-browse' })
  | (RouteBase & { kind: 'channel-create' })
  | (RouteBase & { kind: 'objectives-list' })
  | (RouteBase & { kind: 'objective-create' })
  | (RouteBase & { kind: 'objective-detail'; id: string })
  | (RouteBase & { kind: 'members' })
  | (RouteBase & { kind: 'member-profile'; name: string; tab: ProfileTab })
  | (RouteBase & { kind: 'tool-sources' })
  | (RouteBase & { kind: 'tool-source-detail'; slug: string })
  | (RouteBase & { kind: 'environment' })
  // Detail routes stay per-kind because `slug` is unique per STORE, not
  // across the pair — a secret and a variable may both be `git-token`,
  // so one `/environment/:slug` route could not name either of them.
  | (RouteBase & { kind: 'secret-detail'; slug: string })
  | (RouteBase & { kind: 'variable-detail'; slug: string })
  | (RouteBase & { kind: 'notifications' })
  | (RouteBase & { kind: 'notification-detail'; slug: string })
  | (RouteBase & { kind: 'files'; path: string });

interface RouteBase {
  /**
   * Optional team slug. When present, URLs are prefixed with
   * `/t/:team/`. Single-team hosts leave this unset; multi-team
   * hosts set it globally so every navigation carries team scope.
   */
  team?: string;
}

export function parseRoute(pathname: string): Route {
  const clean = pathname.replace(/^\/+|\/+$/g, '');
  if (clean.length === 0) return { kind: 'home' };

  let parts = clean.split('/').map(safeDecode);
  let team: string | undefined;
  if (parts[0] === 't' && parts.length >= 2 && parts[1]) {
    team = parts[1];
    parts = parts.slice(2);
    if (parts.length === 0) return withTeam({ kind: 'home' }, team);
  }
  const head = parts[0];
  const rest = parts.slice(1);

  if (head === 'inbox' && rest.length === 0) return withTeam({ kind: 'inbox' }, team);

  if (head === 'account' && rest.length === 0) return withTeam({ kind: 'account' }, team);

  if (head === 'c' && rest.length === 1 && rest[0]) {
    return withTeam({ kind: 'thread-channel', slug: rest[0] }, team);
  }

  if (head === 'channels') {
    if (rest.length === 0) return withTeam({ kind: 'channels-browse' }, team);
    if (rest.length === 1 && rest[0] === 'new') return withTeam({ kind: 'channel-create' }, team);
  }

  if (head === 'dm' && rest.length === 1 && rest[0]) {
    return withTeam({ kind: 'thread-dm', name: rest[0] }, team);
  }

  if (head === 'objectives') {
    if (rest.length === 0) return withTeam({ kind: 'objectives-list' }, team);
    if (rest.length === 1 && rest[0] === 'new') return withTeam({ kind: 'objective-create' }, team);
    if (rest.length === 1 && rest[0])
      return withTeam({ kind: 'objective-detail', id: rest[0] }, team);
  }

  if (head === 'members' && rest.length === 0) return withTeam({ kind: 'members' }, team);

  if (head === 'tools') {
    if (rest.length === 0) return withTeam({ kind: 'tool-sources' }, team);
    if (rest.length === 1 && rest[0]) {
      return withTeam({ kind: 'tool-source-detail', slug: rest[0] }, team);
    }
  }

  // Every runner-environment view lives under `/environment`, and the
  // reason is the broker, not taste. API routes register BEFORE the
  // SPA fallback, so any client path that also names a REST route is
  // answered by the API: `/secrets/:slug` and `/variables/:slug` both
  // return 401 JSON on a hard load instead of the app. `/tools` is the
  // existing precedent — the client route differs from its `/tool-sources`
  // API path for exactly this reason. `/environment` has no REST
  // counterpart, so these deep-link and reload correctly.
  if (head === 'environment') {
    if (rest.length === 0) return withTeam({ kind: 'environment' }, team);
    if (rest.length === 2 && rest[1]) {
      if (rest[0] === 'secrets') {
        return withTeam({ kind: 'secret-detail', slug: rest[1] }, team);
      }
      if (rest[0] === 'variables') {
        return withTeam({ kind: 'variable-detail', slug: rest[1] }, team);
      }
    }
  }

  if (head === 'notifications') {
    if (rest.length === 0) return withTeam({ kind: 'notifications' }, team);
    if (rest.length === 1 && rest[0]) {
      return withTeam({ kind: 'notification-detail', slug: rest[0] }, team);
    }
  }

  if (head?.startsWith('@') && head.length > 1) {
    const name = head.slice(1);
    const tabSegment = rest[0];
    if (rest.length === 0) return withTeam({ kind: 'member-profile', name, tab: 'overview' }, team);
    if (rest.length === 1 && isProfileTab(tabSegment)) {
      return withTeam({ kind: 'member-profile', name, tab: tabSegment }, team);
    }
  }

  if (head === 'files') {
    const joined = rest.filter((p) => p.length > 0).join('/');
    return withTeam({ kind: 'files', path: joined.length === 0 ? '' : `/${joined}` }, team);
  }

  return withTeam({ kind: 'home' }, team);
}

function withTeam<R extends Route>(route: R, team: string | undefined): R {
  if (team === undefined) return route;
  return { ...route, team };
}

export function formatRoute(route: Route): string {
  const base = baseFor(route);
  if (route.team === undefined) return base;
  const teamPrefix = `/t/${encodeURIComponent(route.team)}`;
  return base === '/' ? teamPrefix : `${teamPrefix}${base}`;
}

function baseFor(route: Route): string {
  switch (route.kind) {
    case 'home':
      return '/';
    case 'inbox':
      return '/inbox';
    case 'account':
      return '/account';
    case 'thread-channel':
      return `/c/${encodeURIComponent(route.slug)}`;
    case 'thread-dm':
      return `/dm/${encodeURIComponent(route.name)}`;
    case 'channels-browse':
      return '/channels';
    case 'channel-create':
      return '/channels/new';
    case 'objectives-list':
      return '/objectives';
    case 'objective-create':
      return '/objectives/new';
    case 'objective-detail':
      return `/objectives/${encodeURIComponent(route.id)}`;
    case 'members':
      return '/members';
    case 'tool-sources':
      return '/tools';
    case 'tool-source-detail':
      return `/tools/${encodeURIComponent(route.slug)}`;
    case 'environment':
      return '/environment';
    case 'secret-detail':
      return `/environment/secrets/${encodeURIComponent(route.slug)}`;
    case 'variable-detail':
      return `/environment/variables/${encodeURIComponent(route.slug)}`;
    case 'notifications':
      return '/notifications';
    case 'notification-detail':
      return `/notifications/${encodeURIComponent(route.slug)}`;
    case 'member-profile':
      return route.tab === 'overview'
        ? `/@${encodeURIComponent(route.name)}`
        : `/@${encodeURIComponent(route.name)}/${route.tab}`;
    case 'files': {
      if (route.path === '' || route.path === '/') return '/files';
      const segments = route.path
        .split('/')
        .filter((p) => p.length > 0)
        .map(encodeURIComponent);
      return `/files/${segments.join('/')}`;
    }
  }
}

/** Stable equality for routes — used to dedupe navigate() no-ops. */
export function routesEqual(a: Route, b: Route): boolean {
  return formatRoute(a) === formatRoute(b);
}

function isProfileTab(value: string | undefined): value is ProfileTab {
  return typeof value === 'string' && (PROFILE_TABS as readonly string[]).includes(value);
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
