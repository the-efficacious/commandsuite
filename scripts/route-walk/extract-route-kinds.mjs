#!/usr/bin/env node
// Extract every route kind from the web UI's Route union
// (packages/web-ui/src/lib/routes.ts). The route-walk CI job compares
// this list against the manifest: a kind present in the router but
// absent from the manifest fails the build BY NAME — a new page cannot
// merge without declaring its permission story.
//
// Parsing is deliberately dumb and anchored: the union block between
// `export type Route =` and its terminating `;`, kinds as
// `kind: '<literal>'`. If the union's shape changes enough to break
// this, the job fails loudly rather than passing on an empty list.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(import.meta.dirname, '../../packages/web-ui/src/lib/routes.ts'),
  'utf8',
);
const start = source.indexOf('export type Route =');
if (start < 0) {
  console.error('extract-route-kinds: `export type Route =` not found — routes.ts moved?');
  process.exit(2);
}
// The union's variants carry inline `;` separators (`kind: 'x'; slug`),
// so the statement terminator is the first `});` after the block opens.
const end = source.indexOf('});', start);
const union = source.slice(start, end);
const kinds = [...union.matchAll(/kind:\s*'([a-z-]+)'/g)].map((m) => m[1]);
if (kinds.length === 0) {
  console.error('extract-route-kinds: zero kinds parsed — refusing an empty gate');
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(kinds, null, 2)}\n`);
