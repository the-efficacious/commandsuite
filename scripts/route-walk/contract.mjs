#!/usr/bin/env node
// The router ↔ manifest contract for the route walk
// (obj-mtg1kwxb-m). Extracts the Route union's kinds AND the
// concrete variant tables the router builds URLs from (today:
// PROFILE_TABS), and validates the manifest against them in both
// directions — so a new page, a new profile tab, a duplicate or
// misdeclared row all fail the build BY NAME, not by silence.
//
// Parsing is deliberately dumb and anchored: the union block between
// `export type Route =` and its terminating `);`, kinds as
// `kind: '<literal>'`; PROFILE_TABS as the literal string-array
// initializer. If either shape changes enough to break this, the job
// fails loudly rather than passing on an empty list.
//
// CLI: node contract.mjs                  → {kinds, profileTabs} JSON
//      node contract.mjs --check <path>   → validate a manifest file
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTES_TS = new URL('../../packages/web-ui/src/lib/routes.ts', import.meta.url);

function routerSource() {
  return readFileSync(ROUTES_TS, 'utf8');
}

export function extractRouteKinds(source = routerSource()) {
  const start = source.indexOf('export type Route =');
  if (start === -1) throw new Error('contract.mjs: `export type Route =` not found in routes.ts');
  const end = source.indexOf(');', start);
  if (end === -1) throw new Error('contract.mjs: unterminated Route union in routes.ts');
  const block = source.slice(start, end);
  const kinds = [...block.matchAll(/kind:\s*'([^']+)'/g)].map((m) => m[1]);
  if (kinds.length === 0) throw new Error('contract.mjs: Route union parsed to zero kinds');
  return [...new Set(kinds)];
}

export function extractProfileTabs(source = routerSource()) {
  const match = /export const PROFILE_TABS[^=]*=\s*\[([^\]]+)\]/.exec(source);
  if (!match) throw new Error('contract.mjs: PROFILE_TABS initializer not found in routes.ts');
  const tabs = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (tabs.length === 0) throw new Error('contract.mjs: PROFILE_TABS parsed to zero tabs');
  return tabs;
}

/**
 * The URL templates the manifest must declare for `member-profile`,
 * derived from the router's own tab table: `overview` is the bare
 * profile URL, every other tab is a path segment. Adding a tab to
 * PROFILE_TABS therefore adds a required template here, and a
 * manifest that has not declared the new page fails by name.
 */
export function expectedProfileUrls(source = routerSource()) {
  return extractProfileTabs(source).map((tab) =>
    tab === 'overview' ? '/@{selfName}' : `/@{selfName}/${tab}`,
  );
}

const ROLES = ['baseline', 'admin'];
const EXPECTATIONS = new Set(['clean', 'restricted']);

/**
 * A marker is text unique to a view, declared either as one string or
 * as one string per role. Only roles that expect a CLEAN render need a
 * marker: a restricted row asserts the Restricted callout instead, and
 * demanding view text for a page the role is refused would be asking
 * for a string that must not be there.
 */
function markerErrors(declaration, row, label) {
  const errors = [];
  const needed = ROLES.filter((role) => row.roles?.[role] === 'clean');
  if (declaration === undefined || declaration === null) {
    return [
      `${label}: renders clean for ${needed.join(', ')} but declares no marker — a clean pass would assert only that the shell mounted`,
    ];
  }
  if (typeof declaration === 'string') {
    if (declaration.length === 0) errors.push(`${label}: marker must be non-empty text`);
    return errors;
  }
  if (typeof declaration !== 'object') {
    return [`${label}: marker must be text, or an object of text per role`];
  }
  for (const role of needed) {
    const value = declaration[role];
    if (typeof value !== 'string' || value.length === 0) {
      errors.push(`${label}: no marker for role '${role}', which expects a clean render`);
    }
  }
  for (const role of Object.keys(declaration)) {
    if (!ROLES.includes(role)) errors.push(`${label}: marker names unknown role '${role}'`);
  }
  return errors;
}

/**
 * Validate a parsed manifest against the router source. Returns a
 * list of human-readable errors (empty = contract satisfied). Rules:
 *  - every router kind is declared exactly once
 *  - every non-pseudo manifest kind exists in the router; pseudo rows
 *    (contracts outside the Route union, e.g. unknown-path
 *    fallthrough) must say why they are pseudo and must NOT shadow a
 *    router kind
 *  - no duplicate kinds or URLs
 *  - every row declares non-empty urls and a clean|restricted
 *    expectation for both roles; restricted requires a `why`
 *  - member-profile's URL set equals the PROFILE_TABS-derived set
 *  - allowRestrictedPanel names only known roles
 */
export function validateManifest(manifest, source = routerSource()) {
  const errors = [];
  const routerKinds = extractRouteKinds(source);
  const rows = manifest?.routes;
  if (!Array.isArray(rows) || rows.length === 0) {
    return ['manifest has no routes array'];
  }

  const seenKinds = new Map();
  const seenUrls = new Map();
  for (const row of rows) {
    const kind = row.kind ?? '(missing kind)';
    if (seenKinds.has(kind)) errors.push(`duplicate manifest declaration for kind '${kind}'`);
    seenKinds.set(kind, row);
    if (!Array.isArray(row.urls) || row.urls.length === 0) {
      errors.push(`kind '${kind}' declares no urls`);
    } else {
      for (const url of row.urls) {
        if (seenUrls.has(url)) {
          errors.push(`url '${url}' declared by both '${seenUrls.get(url)}' and '${kind}'`);
        }
        seenUrls.set(url, kind);
      }
    }
    for (const role of ROLES) {
      const expectation = row.roles?.[role];
      if (!EXPECTATIONS.has(expectation)) {
        errors.push(
          `kind '${kind}' role '${role}': expectation must be clean|restricted (got ${JSON.stringify(expectation)})`,
        );
      } else if (expectation === 'restricted' && !row.why) {
        errors.push(`kind '${kind}' is restricted for '${role}' but declares no why`);
      }
    }
    // A marker is text unique to the row's own view. It is what makes a
    // clean pass mean "this route rendered itself" rather than "a shell
    // is on screen", and the shell is present on every URL including
    // ones with no route at all. Required wherever some role expects a
    // clean render; `markers` must line up with `urls` one-for-one when
    // a row's URLs render different views (member-profile's tabs).
    const cleanForSomeRole = ROLES.some((role) => row.roles?.[role] === 'clean');
    if (cleanForSomeRole) {
      if (Array.isArray(row.markers)) {
        if (!Array.isArray(row.urls) || row.markers.length !== row.urls.length) {
          errors.push(
            `kind '${kind}' declares ${row.markers.length} markers for ${row.urls?.length ?? 0} urls — they must correspond one-for-one`,
          );
        }
        row.markers.forEach((marker, i) => {
          for (const error of markerErrors(marker, row, `url '${row.urls?.[i]}'`)) {
            errors.push(`kind '${kind}' ${error}`);
          }
        });
      } else {
        for (const error of markerErrors(row.marker, row, 'marker')) {
          errors.push(`kind '${kind}' ${error}`);
        }
      }
      if (row.marker !== undefined && row.markers !== undefined) {
        errors.push(`kind '${kind}' declares both marker and markers — use one`);
      }
    }
    for (const role of row.allowRestrictedPanel ?? []) {
      if (!ROLES.includes(role)) {
        errors.push(`kind '${kind}' allowRestrictedPanel names unknown role '${role}'`);
      }
    }
    if (row.pseudo !== undefined) {
      if (typeof row.pseudo !== 'string' || row.pseudo.length === 0) {
        errors.push(`pseudo row '${kind}' must say why it is outside the Route union`);
      }
      if (routerKinds.includes(kind)) {
        errors.push(`row '${kind}' is marked pseudo but shadows a real router kind`);
      }
    } else if (!routerKinds.includes(kind)) {
      errors.push(`manifest declares kind '${kind}' which is not in the router's Route union`);
    }
  }

  for (const kind of routerKinds) {
    if (!seenKinds.has(kind)) {
      errors.push(`route kind '${kind}' is in the router but absent from the manifest`);
    }
  }

  // Variant parity for the kinds whose URL set is derived from a
  // router-side table. Today that is member-profile ← PROFILE_TABS.
  const profileRow = seenKinds.get('member-profile');
  if (profileRow && Array.isArray(profileRow.urls)) {
    const expected = expectedProfileUrls(source);
    for (const url of expected) {
      if (!profileRow.urls.includes(url)) {
        errors.push(
          `member-profile is missing url '${url}' (PROFILE_TABS declares this tab — the new page needs a permission story)`,
        );
      }
    }
    for (const url of profileRow.urls) {
      if (!expected.includes(url)) {
        errors.push(`member-profile declares url '${url}' which no PROFILE_TABS tab produces`);
      }
    }
  }

  return errors;
}

// ── CLI ─────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  const checkIndex = process.argv.indexOf('--check');
  if (checkIndex !== -1) {
    const manifestPath = process.argv[checkIndex + 1];
    if (!manifestPath) {
      console.error('contract.mjs: --check requires a manifest path');
      process.exit(2);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const errors = validateManifest(manifest);
    if (errors.length > 0) {
      console.error('manifest does not match the router contract:');
      for (const error of errors) console.error(`  - ${error}`);
      process.exit(1);
    }
    console.log(
      `manifest ok: ${manifest.routes.length} declarations cover ${extractRouteKinds().length} router kinds (profile tabs: ${extractProfileTabs().join(', ')})`,
    );
  } else {
    console.log(
      JSON.stringify({ kinds: extractRouteKinds(), profileTabs: extractProfileTabs() }, null, 2),
    );
  }
}
