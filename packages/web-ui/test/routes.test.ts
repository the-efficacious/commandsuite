import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute, type Route, routesEqual } from '../src/lib/routes.js';

describe('parseRoute / formatRoute', () => {
  const cases: Array<[string, Route]> = [
    ['/', { kind: 'home' }],
    ['/inbox', { kind: 'inbox' }],
    ['/c/general', { kind: 'thread-channel', slug: 'general' }],
    ['/c/customer-research', { kind: 'thread-channel', slug: 'customer-research' }],
    ['/channels', { kind: 'channels-browse' }],
    ['/channels/new', { kind: 'channel-create' }],
    ['/dm/alice', { kind: 'thread-dm', name: 'alice' }],
    ['/objectives', { kind: 'objectives-list' }],
    ['/objectives/new', { kind: 'objective-create' }],
    ['/objectives/abc-123', { kind: 'objective-detail', id: 'abc-123' }],
    ['/members', { kind: 'members' }],
    ['/tools', { kind: 'tool-sources' }],
    ['/tools/jira', { kind: 'tool-source-detail', slug: 'jira' }],
    ['/environment', { kind: 'environment' }],
    ['/environment/secrets/github-token', { kind: 'secret-detail', slug: 'github-token' }],
    [
      '/environment/variables/git-author-name',
      { kind: 'variable-detail', slug: 'git-author-name' },
    ],
    ['/notifications', { kind: 'notifications' }],
    ['/notifications/ci-alerts', { kind: 'notification-detail', slug: 'ci-alerts' }],
    ['/@alice', { kind: 'member-profile', name: 'alice', tab: 'overview' }],
    ['/@alice/activity', { kind: 'member-profile', name: 'alice', tab: 'activity' }],
    ['/@alice/manage', { kind: 'member-profile', name: 'alice', tab: 'manage' }],
    ['/files', { kind: 'files', path: '' }],
    ['/files/alice/uploads', { kind: 'files', path: '/alice/uploads' }],
  ];

  it('parse is correct for canonical URLs', () => {
    for (const [url, expected] of cases) {
      expect(parseRoute(url)).toEqual(expected);
    }
  });

  it('format is correct for each route', () => {
    for (const [url, route] of cases) {
      expect(formatRoute(route)).toBe(url);
    }
  });

  it('parse ∘ format is identity', () => {
    for (const [, route] of cases) {
      expect(parseRoute(formatRoute(route))).toEqual(route);
    }
  });

  it('falls back to home for unknown paths', () => {
    expect(parseRoute('/nope/weird/path')).toEqual({ kind: 'home' });
    expect(parseRoute('/@')).toEqual({ kind: 'home' });
    expect(parseRoute('/objectives/abc/extra')).toEqual({ kind: 'home' });
  });

  it('strips duplicate and trailing slashes', () => {
    expect(parseRoute('//inbox//')).toEqual({ kind: 'inbox' });
    expect(parseRoute('/objectives/')).toEqual({ kind: 'objectives-list' });
  });

  it('handles encoded names and paths', () => {
    expect(parseRoute('/dm/al%20ice')).toEqual({ kind: 'thread-dm', name: 'al ice' });
    expect(formatRoute({ kind: 'thread-dm', name: 'al ice' })).toBe('/dm/al%20ice');
    expect(parseRoute('/files/bob/my%20files/x.txt')).toEqual({
      kind: 'files',
      path: '/bob/my files/x.txt',
    });
    expect(formatRoute({ kind: 'files', path: '/bob/my files/x.txt' })).toBe(
      '/files/bob/my%20files/x.txt',
    );
  });

  it('routesEqual compares structurally', () => {
    expect(routesEqual({ kind: 'home' }, { kind: 'home' })).toBe(true);
    expect(
      routesEqual(
        { kind: 'member-profile', name: 'alice', tab: 'overview' },
        { kind: 'member-profile', name: 'alice', tab: 'overview' },
      ),
    ).toBe(true);
    expect(
      routesEqual(
        { kind: 'member-profile', name: 'alice', tab: 'overview' },
        { kind: 'member-profile', name: 'alice', tab: 'activity' },
      ),
    ).toBe(false);
  });

  describe('team prefix', () => {
    it('parses /t/:slug as a home route with team set', () => {
      expect(parseRoute('/t/alpha')).toEqual({ kind: 'home', team: 'alpha' });
    });

    it('strips /t/:slug and preserves the rest of the route', () => {
      expect(parseRoute('/t/alpha/objectives/abc')).toEqual({
        kind: 'objective-detail',
        id: 'abc',
        team: 'alpha',
      });
      expect(parseRoute('/t/beta/@alice/activity')).toEqual({
        kind: 'member-profile',
        name: 'alice',
        tab: 'activity',
        team: 'beta',
      });
    });

    it('formats routes with team when set', () => {
      expect(formatRoute({ kind: 'home', team: 'alpha' })).toBe('/t/alpha');
      expect(formatRoute({ kind: 'inbox', team: 'alpha' })).toBe('/t/alpha/inbox');
      expect(
        formatRoute({ kind: 'member-profile', name: 'alice', tab: 'overview', team: 'alpha' }),
      ).toBe('/t/alpha/@alice');
    });

    it('parse ∘ format remains identity for team-scoped routes', () => {
      const routes: Route[] = [
        { kind: 'home', team: 'alpha' },
        { kind: 'inbox', team: 'alpha' },
        { kind: 'thread-dm', name: 'alice', team: 'alpha' },
        { kind: 'files', path: '/alice/docs', team: 'alpha' },
      ];
      for (const r of routes) {
        expect(parseRoute(formatRoute(r))).toEqual(r);
      }
    });

    it('unprefixed URLs parse to routes with team undefined', () => {
      const r = parseRoute('/inbox');
      expect(r.team).toBeUndefined();
      expect(r.kind).toBe('inbox');
    });
  });

  describe('the runner-environment routes', () => {
    it('keeps every environment view under /environment', () => {
      // Not cosmetic. The broker registers its REST routes BEFORE the
      // SPA fallback, so a client path that also names an API route is
      // answered by the API — `/secrets/:slug` returns 401 JSON on a
      // hard load rather than the app. `/environment` has no REST
      // counterpart, which is what makes these deep-linkable.
      expect(formatRoute({ kind: 'environment' })).toBe('/environment');
      expect(formatRoute({ kind: 'secret-detail', slug: 'github-token' })).toBe(
        '/environment/secrets/github-token',
      );
      expect(formatRoute({ kind: 'variable-detail', slug: 'git-name' })).toBe(
        '/environment/variables/git-name',
      );
    });

    it('never formats a route onto a path the broker answers', () => {
      // The API prefixes that shadow the SPA. A regression here is
      // invisible in-app — pushState never touches the server — and
      // only shows up when someone reloads or shares a link.
      const shadowed = [/^\/secrets(\/|$)/, /^\/variables(\/|$)/];
      const routes: Route[] = [
        { kind: 'environment' },
        { kind: 'secret-detail', slug: 'github-token' },
        { kind: 'variable-detail', slug: 'git-name' },
      ];
      for (const r of routes) {
        const path = formatRoute(r);
        for (const shadow of shadowed) expect(path).not.toMatch(shadow);
      }
    });

    it('routes a secret and a variable of the SAME slug to different views', () => {
      // `slug` is unique per store, not across the pair — the schema
      // has one unique index per table. A single `/environment/:slug`
      // detail route could not name either of them, which is why the
      // detail routes stay per-kind.
      const secret = parseRoute('/environment/secrets/shared-name');
      const variable = parseRoute('/environment/variables/shared-name');
      expect(secret).toEqual({ kind: 'secret-detail', slug: 'shared-name' });
      expect(variable).toEqual({ kind: 'variable-detail', slug: 'shared-name' });
      expect(routesEqual(secret, variable)).toBe(false);
    });

    it('team-scopes the environment routes', () => {
      expect(parseRoute('/t/alpha/environment/variables/git-name')).toEqual({
        kind: 'variable-detail',
        slug: 'git-name',
        team: 'alpha',
      });
      expect(formatRoute({ kind: 'environment', team: 'alpha' })).toBe('/t/alpha/environment');
    });

    it('sends an unknown environment path home rather than stranding it', () => {
      expect(parseRoute('/environment/nonsense/x').kind).toBe('home');
    });
  });
});
