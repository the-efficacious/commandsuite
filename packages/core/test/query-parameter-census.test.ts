/**
 * The query-parameter census — every name the broker reads off a query
 * string, attributed to the route that reads it.
 *
 * Why a census and not per-route assertions. D44 made query parameters
 * `snake_case`, and the four camelCase survivors (`stalledMs`,
 * `clientKind`, `clientVersion`, `parentOrigin`) were not a decision —
 * they were four places nobody swept, on four routes with four separate
 * test files. A rule with no instrument is a rule that decays one
 * endpoint at a time, and the next camelCase parameter would arrive the
 * same way the last four did: added by someone who never read this
 * page, on a route whose own test suite is perfectly happy.
 *
 * So the shape of this file is: read the router's source, extract every
 * literal it passes to `c.req.query` / `c.req.queries` and every entry
 * in its deprecation tables, attribute each to the route it sits in,
 * and compare against the pinned map below. A new parameter fails here
 * until someone writes it down; a camelCase one fails the grammar
 * assertion whatever they write down.
 *
 * Scanning source rather than probing responses is deliberate: a
 * behavioural probe can only find a parameter you already suspect, and
 * the whole failure mode here is a name nobody knew to look for. The
 * behavioural half — that each name is actually honoured, and that the
 * legacy spellings still answer identically — is
 * `apps/server/test/query-parameter-grammar.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app.ts');

/**
 * `app.get(` / `app.post(` … and the route expression that follows it —
 * a template literal, a quoted path, or a `PATHS.*` constant.
 */
const ROUTE_RE = /app\.(get|post|put|delete|patch)\(\s*(`[^`]*`|'[^']*'|[A-Za-z_$][\w$.]*)/g;
const QUERY_RE = /c\.req\.quer(?:y|ies)\(\s*'([^']+)'/g;
const RENAME_TABLE_RE = /readRenamedQuery\(\s*c,\s*([A-Z_]+)/g;
const RENAME_PAIR_RE = /current:\s*'([^']+)',\s*legacy:\s*'([^']+)'/g;

interface RouteQueries {
  /** Names a caller should send today. */
  readonly current: string[];
  /** Names accepted for the compatibility window and no longer documented. */
  readonly legacy: string[];
}

/**
 * Every route that reads a query string, with the exact names it
 * accepts. Legacy names are the D44/D46 renames and are REMOVED IN THE
 * NEXT MINOR — deleting a row from `legacy` here is the visible half of
 * that removal.
 */
const CENSUS: Record<string, RouteQueries> = {
  'GET /setup/connect-platform': {
    current: ['code', 'mode', 'parent_origin'],
    legacy: ['parentOrigin'],
  },
  'GET /platform-connect/lookup': { current: ['code'], legacy: [] },
  'GET /team/status': { current: ['stalled_ms'], legacy: ['stalledMs'] },
  'GET /subscribe': {
    current: ['client_kind', 'client_version', 'name'],
    legacy: ['clientKind', 'clientVersion'],
  },
  'GET /members/:name/telemetry': {
    current: ['after_id', 'after_ts', 'event', 'from', 'limit', 'signal', 'to'],
    legacy: ['cursor_id', 'cursor_ts'],
  },
  'GET /members/:name/genai': {
    current: ['after_id', 'after_ts', 'from', 'limit', 'to', 'view'],
    legacy: ['cursor_id', 'cursor_ts'],
  },
  'GET /members/:name/genai/:id/raw': { current: ['kind'], legacy: [] },
  'GET /members/:name/activity': {
    current: ['before_id', 'before_ts', 'from', 'kind', 'limit', 'to'],
    legacy: ['cursor_id', 'cursor_ts'],
  },
  'GET /notifications/endpoints/:slug/deliveries': {
    current: ['before_ts', 'limit'],
    legacy: ['before'],
  },
  'POST /hooks/:slug': { current: ['if_busy', 'if_offline', 'level'], legacy: [] },
  'GET /objectives': { current: ['assignee', 'related', 'status'], legacy: [] },
  'GET /history': {
    current: ['before_id', 'before_ts', 'channel', 'limit', 'with'],
    legacy: ['before'],
  },
  'GET /fs/ls': { current: ['path'], legacy: [] },
  'GET /fs/stat': { current: ['path'], legacy: [] },
  'POST /fs/write': { current: ['collide', 'mime', 'path'], legacy: [] },
  'DELETE /fs/rm': { current: ['path', 'recursive'], legacy: [] },
};

/**
 * The route expressions as they appear in `app.ts`, mapped to the
 * request line a reader of the REST reference would recognise. Keeping
 * the mapping explicit means a route whose path constant is renamed
 * shows up here rather than silently becoming a new census row.
 */
const ROUTE_LABELS: Record<string, string> = {
  "'/setup/connect-platform'": 'GET /setup/connect-platform',
  "'/platform-connect/lookup'": 'GET /platform-connect/lookup',
  'PATHS.teamStatus': 'GET /team/status',
  'PATHS.subscribe': 'GET /subscribe',
  "'/members/:name/telemetry'": 'GET /members/:name/telemetry',
  "'/members/:name/genai'": 'GET /members/:name/genai',
  "'/members/:name/genai/:id/raw'": 'GET /members/:name/genai/:id/raw',
  "'/members/:name/activity'": 'GET /members/:name/activity',
  '`${PATHS.notificationEndpoints}/:slug/deliveries`':
    'GET /notifications/endpoints/:slug/deliveries',
  '`${PATHS.hooks}/:slug`': 'POST /hooks/:slug',
  'PATHS.objectives': 'GET /objectives',
  'PATHS.history': 'GET /history',
  'PATHS.fsList': 'GET /fs/ls',
  'PATHS.fsStat': 'GET /fs/stat',
  'PATHS.fsWrite': 'POST /fs/write',
  'PATHS.fsRm': 'DELETE /fs/rm',
};

/** Query-parameter grammar: lowercase, digits and underscores only. */
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

interface ScannedRoute {
  readonly label: string;
  readonly current: Set<string>;
  readonly legacy: Set<string>;
}

/**
 * Read the router and return, per route, the query names it accepts.
 *
 * The renames live in module-level tables rather than at the call site,
 * so a route that calls `readRenamedQuery(c, X_RENAMES, …)` contributes
 * both halves of every pair in `X_RENAMES`.
 */
function scanRouter(): { routes: Map<string, ScannedRoute>; unlabelled: string[] } {
  const source = readFileSync(APP_SOURCE, 'utf8');

  const renameTables = new Map<string, Array<{ current: string; legacy: string }>>();
  for (const decl of source.matchAll(/const ([A-Z_]+RENAMES?|[A-Z_]+RENAME):[^=]*=\s*([^;]+);/g)) {
    const pairs = [...(decl[2] ?? '').matchAll(RENAME_PAIR_RE)].map((m) => ({
      current: m[1] as string,
      legacy: m[2] as string,
    }));
    if (pairs.length > 0) renameTables.set(decl[1] as string, pairs);
  }
  // A table may be composed from a single-pair constant (the subscribe
  // client identity reads `client_version` twice), so resolve those.
  for (const [name, pairs] of renameTables) {
    const decl = source.match(new RegExp(`const ${name}:[^=]*=\\s*([^;]+);`));
    for (const ref of (decl?.[1] ?? '').matchAll(/^\s*([A-Z_]+),\s*$/gm)) {
      const referenced = renameTables.get(ref[1] as string);
      if (referenced) pairs.push(...referenced);
    }
  }

  // Split the file at each route registration; everything up to the
  // next one belongs to that route.
  const starts: Array<{ index: number; expr: string; method: string }> = [];
  for (const m of source.matchAll(ROUTE_RE)) {
    starts.push({
      index: m.index ?? 0,
      expr: (m[2] ?? '').trim(),
      method: (m[1] ?? '').toUpperCase(),
    });
  }

  const routes = new Map<string, ScannedRoute>();
  const unlabelled: string[] = [];
  for (const [i, start] of starts.entries()) {
    const body = source.slice(start.index, starts[i + 1]?.index ?? source.length);
    const current = new Set<string>();
    const legacy = new Set<string>();
    for (const m of body.matchAll(QUERY_RE)) current.add(m[1] as string);
    for (const m of body.matchAll(RENAME_TABLE_RE)) {
      for (const pair of renameTables.get(m[1] as string) ?? []) {
        current.add(pair.current);
        legacy.add(pair.legacy);
      }
    }
    if (current.size === 0 && legacy.size === 0) continue;
    const label = ROUTE_LABELS[start.expr];
    if (label === undefined) {
      unlabelled.push(`${start.method} ${start.expr}`);
      continue;
    }
    const existing = routes.get(label);
    if (existing) {
      for (const n of current) existing.current.add(n);
      for (const n of legacy) existing.legacy.add(n);
    } else {
      routes.set(label, { label, current, legacy });
    }
  }
  return { routes, unlabelled };
}

const scanned = scanRouter();

describe('query-parameter census', () => {
  it('reaches the router at all', () => {
    // Positive control. Every assertion below is "the set matches", and
    // a scanner that found nothing would satisfy an empty expectation
    // just as happily as a correct one satisfies a full expectation.
    expect(scanned.routes.size).toBeGreaterThan(10);
    expect(scanned.routes.get('GET /members/:name/activity')?.current).toContain('before_ts');
  });

  it('attributes every query-reading route to a documented request line', () => {
    // A route the label map does not know about is a census gap, not a
    // pass: it would otherwise contribute its parameters to nothing.
    expect(scanned.unlabelled).toEqual([]);
  });

  it('accepts exactly the pinned parameter names, route by route', () => {
    const normalize = (
      entries: Array<[string, { current: Iterable<string>; legacy: Iterable<string> }]>,
    ): Record<string, RouteQueries> => {
      const out: Record<string, RouteQueries> = {};
      for (const [label, spec] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
        out[label] = { current: [...spec.current].sort(), legacy: [...spec.legacy].sort() };
      }
      return out;
    };
    const actual = normalize([...scanned.routes.values()].map((r) => [r.label, r]));
    const expected = normalize(Object.entries(CENSUS));
    expect(actual).toEqual(expected);
  });

  it('spells every current parameter in snake_case', () => {
    // The rule D44 decided, as an executable check. `stalledMs`,
    // `clientKind`, `clientVersion` and `parentOrigin` each failed this
    // for the life of the repository because nothing ever ran it.
    const offenders = Object.entries(CENSUS).flatMap(([label, spec]) =>
      spec.current.filter((name) => !SNAKE_CASE.test(name)).map((name) => `${label} ?${name}=`),
    );
    expect(offenders).toEqual([]);
  });

  it('never accepts a legacy name that is also another route\u2019s current name', () => {
    // A retired spelling that is still current somewhere else cannot be
    // deleted in the next minor without breaking the route that kept
    // it, which is how a compatibility window quietly becomes permanent.
    // `before` was exactly that until D46 gave `/history` the composite
    // cursor: legacy on the delivery receipts, current on `/history`.
    const current = new Set(Object.values(CENSUS).flatMap((spec) => spec.current));
    const legacy = new Set(Object.values(CENSUS).flatMap((spec) => spec.legacy));
    expect([...legacy].filter((name) => current.has(name))).toEqual([]);
  });

  it('holds every legacy spelling to the set the next minor removes', () => {
    // The compatibility window, enumerated once. Growing it is a
    // decision; growing it by accident is what this catches.
    const legacy = [...new Set(Object.values(CENSUS).flatMap((spec) => spec.legacy))].sort();
    expect(legacy).toEqual([
      'before',
      'clientKind',
      'clientVersion',
      'cursor_id',
      'cursor_ts',
      'parentOrigin',
      'stalledMs',
    ]);
  });
});
