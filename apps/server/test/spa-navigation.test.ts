/**
 * The web UI and REST API share several root paths. A document navigation
 * chooses the SPA by Accept preference; machine callers keep the existing
 * REST response at the same URL. This suite exercises the real Node binding
 * because registration order -- static host before the inner API app -- is
 * the property under test.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatRoute, PROFILE_TABS, type Route } from '../../../packages/web-ui/src/lib/routes.js';
import { defaultHttpsConfig } from '../src/members.js';
import { type RunningServer, runServer } from '../src/run.js';
import { silentLogger } from './helpers/logger.js';
import { seedStores } from './helpers/test-stores.js';

const BROWSER_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const INDEX =
  '<!doctype html><html><head><title>CommandSuite</title></head><body>spa</body></html>';

type RouteOf<K extends Route['kind']> = Extract<Route, { kind: K }>;
type EveryRouteKind = { [K in Route['kind']]: RouteOf<K> };

// A mapped type makes adding a Route union member a compile failure here.
const ONE_PER_KIND = {
  home: { kind: 'home' },
  inbox: { kind: 'inbox' },
  account: { kind: 'account' },
  'thread-channel': { kind: 'thread-channel', slug: 'commandsuite' },
  'thread-dm': { kind: 'thread-dm', name: 'alice' },
  'channels-browse': { kind: 'channels-browse' },
  'channel-create': { kind: 'channel-create' },
  'objectives-list': { kind: 'objectives-list' },
  'objective-create': { kind: 'objective-create' },
  'objective-detail': { kind: 'objective-detail', id: 'obj-example-1' },
  members: { kind: 'members' },
  'member-profile': { kind: 'member-profile', name: 'alice', tab: 'overview' },
  'tool-sources': { kind: 'tool-sources' },
  'tool-source-detail': { kind: 'tool-source-detail', slug: 'missing-source' },
  environment: { kind: 'environment' },
  'secret-detail': { kind: 'secret-detail', slug: 'github-token' },
  'variable-detail': { kind: 'variable-detail', slug: 'node-env' },
  notifications: { kind: 'notifications' },
  'notification-detail': { kind: 'notification-detail', slug: 'missing-endpoint' },
  files: { kind: 'files', path: '/alice/notes.md' },
} satisfies EveryRouteKind;

const ROUTES: Route[] = [
  ...Object.values(ONE_PER_KIND),
  ...PROFILE_TABS.map((tab): Route => ({ kind: 'member-profile', name: 'alice', tab })),
  // The optional team prefix is part of every Route shape. One collision and
  // one non-collision pin its formatting without multiplying the whole table.
  { kind: 'objectives-list', team: 'demo-team' },
  { kind: 'home', team: 'demo-team' },
];

const servers: RunningServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(): Promise<RunningServer> {
  const publicRoot = mkdtempSync(join(tmpdir(), 'csuite-spa-navigation-'));
  dirs.push(publicRoot);
  writeFileSync(join(publicRoot, 'index.html'), INDEX);
  const seeded = await seedStores({
    team: { name: 'demo-team', context: '' },
    members: [
      {
        name: 'alice',
        role: { title: 'engineer', description: '' },
        rawPermissions: [],
        permissions: [],
        token: 'csuite_spa_navigation_alice',
      },
    ],
  });
  const running = await runServer({
    db: seeded.db,
    https: { ...defaultHttpsConfig(), mode: 'off' },
    webPush: null,
    port: 0,
    host: '127.0.0.1',
    publicRoot,
    logger: silentLogger(),
  });
  servers.push(running);
  return running;
}

function url(server: RunningServer, path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

describe('SPA document navigation', () => {
  it('serves index.html for every typed UI route, including API-colliding paths', async () => {
    const server = await boot();
    for (const route of ROUTES) {
      const path = formatRoute(route);
      const response = await fetch(url(server, path), {
        headers: { Accept: BROWSER_ACCEPT },
      });
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toContain('text/html');
      expect(await response.text(), path).toBe(INDEX);
    }
  });

  it.each([['application/json'], ['*/*'], ['text/html, application/json']])(
    'keeps colliding REST GETs byte-identical for Accept: %s',
    async (accept) => {
      const server = await boot();
      const expected = [
        ['/objectives', 401, 'application/json', '{"error":"missing credentials"}'],
        ['/objectives/obj-example-1', 401, 'application/json', '{"error":"missing credentials"}'],
        ['/objectives/new', 401, 'application/json', '{"error":"missing credentials"}'],
        ['/members', 401, 'application/json', '{"error":"missing credentials"}'],
        ['/channels', 401, 'application/json', '{"error":"missing credentials"}'],
        ['/channels/new', 401, 'application/json', '{"error":"missing credentials"}'],
        ['/notifications', 404, 'text/plain; charset=UTF-8', '404 Not Found'],
        ['/notifications/missing-endpoint', 404, 'text/plain; charset=UTF-8', '404 Not Found'],
      ] as const;
      for (const [path, status, contentType, body] of expected) {
        const baseline = await fetch(url(server, path));
        const baselineBytes = Buffer.from(await baseline.arrayBuffer());
        expect(baseline.status, path).toBe(status);
        expect(baseline.headers.get('content-type'), path).toBe(contentType);
        expect(baselineBytes.toString('utf8'), path).toBe(body);
        const negotiated = await fetch(url(server, path), { headers: { Accept: accept } });
        expect(negotiated.status, path).toBe(baseline.status);
        expect(negotiated.headers.get('content-type'), path).toBe(
          baseline.headers.get('content-type'),
        );
        expect(Buffer.from(await negotiated.arrayBuffer()), path).toEqual(baselineBytes);
      }
    },
  );

  it('does not treat text/html;q=0 or a wildcard preferred over HTML as navigation', async () => {
    const server = await boot();
    for (const accept of ['text/html;q=0, */*;q=1', 'text/html;q=0.5, */*;q=0.8']) {
      const response = await fetch(url(server, '/objectives'), { headers: { Accept: accept } });
      expect(response.status, accept).toBe(401);
      expect(response.headers.get('content-type'), accept).toContain('application/json');
    }
  });
});
