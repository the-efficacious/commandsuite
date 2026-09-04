/**
 * `csuite tools` — the advertised subcommand surface.
 *
 * Two hand-written lists name these subcommands: the `csuite tools`
 * line of the top-level `--help` usage (`src/index.ts`) and the
 * `UsageError` `runToolsCommand` throws when called with no argument.
 * They drifted. The usage line omitted `cred-rm` — implemented in
 * `commands/tools.ts`, named in that module's header, and documented in
 * `docs/reference/cli.mdx` — so the only way to remove a stored
 * credential was invisible to anyone reading `--help`.
 *
 * These assert the two lists are the SAME list, and that the list
 * covers every subcommand the dispatcher implements. A test that only
 * checked `cred-rm` is mentioned would pass against a usage line
 * missing the next subcommand somebody adds.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexSrc = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
const toolsSrc = readFileSync(new URL('../../src/commands/tools.ts', import.meta.url), 'utf8');

/**
 * The undocumented aliases: `create` is `add`, `remove`/`delete` are
 * `rm`, `credential` is `cred`, `define` is `def`. They dispatch but
 * are deliberately not advertised; naming them here is what lets the
 * completeness assertion below be an equality rather than a subset.
 */
const ALIASES = ['create', 'remove', 'delete', 'credential', 'define'];

/** The subcommands on the `csuite tools` line of the top-level usage. */
function advertised(): string[] {
  const line = indexSrc.split('\n').find((l) => l.startsWith('  csuite tools '));
  expect(line).toBeDefined();
  const list = /^ {2}csuite tools\s+(\S+)/.exec(line ?? '')?.[1];
  expect(list).toBeDefined();
  return (list ?? '').split('|');
}

/** The subcommands named in the `tools subcommand required` error. */
function offeredOnError(): string[] {
  const match = /'tools subcommand required\. Use: ([^']+)'/.exec(toolsSrc);
  expect(match).not.toBeNull();
  return (match?.[1] ?? '').split('|').map((s) => s.trim());
}

/** Every `case '<name>':` label in `runToolsCommand`'s switch. */
function dispatched(): string[] {
  const body = toolsSrc.slice(toolsSrc.indexOf('export async function runToolsCommand'));
  return [...body.matchAll(/^ {4}case '([a-z-]+)':$/gm)].map((m) => m[1] as string);
}

describe('csuite tools subcommand surface', () => {
  it('advertises the same subcommands in --help and in the usage error, in the same order', () => {
    expect(advertised()).toEqual(offeredOnError());
  });

  it('advertises every subcommand the dispatcher implements, aliases excepted', () => {
    const implemented = dispatched();
    expect(implemented.length).toBeGreaterThan(0);
    expect(implemented.filter((sub) => !ALIASES.includes(sub)).sort()).toEqual(
      [...advertised()].sort(),
    );
  });
});
