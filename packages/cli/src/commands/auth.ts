/**
 * `csuite auth` — inspect and maintain the local auth store.
 *
 * The store is user-global and holds one entry per `(broker URL,
 * workspace)` pair, so a single file can carry several member identities
 * for the same broker. That is strictly better than keeping a credential
 * inside each project tree, but it costs legibility: you can no longer
 * `cat` the file in the directory it governs to see which identity applies.
 * These subcommands buy that back.
 *
 *   csuite auth list       what is enrolled, and which directory each
 *                          enrollment serves — never the token itself
 *   csuite auth migrate    fold a legacy project-scoped `.csuite/auth.json`
 *                          into the global store
 *
 * Tokens are never printed. `list` exists so an operator can answer "which
 * member am I here?" without ever putting a bearer on a terminal that might
 * be recorded, shared, or scrolled back through.
 */

import {
  type AuthConfigEntry,
  authStorePath,
  findAuthEntry,
  inspectLegacyStore,
  listAuthEntries,
  migrateLegacyStore,
} from './auth-config.js';
import { UsageError } from './errors.js';

export interface AuthCommandInput {
  /** Read/write a specific store file instead of the global one. */
  authConfigPath?: string;
  /** Directory whose enrollment is "current". Defaults to cwd. */
  cwd?: string;
  /** Test-only clock for relative-age rendering. */
  now?: () => number;
}

/**
 * Render an epoch-ms timestamp as a coarse age. Coarse on purpose — the
 * useful question is "is this enrollment current or ancient", and a precise
 * timestamp invites reading meaning into token age that isn't there.
 */
function age(savedAt: number, now: number): string {
  const ms = Math.max(0, now - savedAt);
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.floor(ms / 60_000);
  return mins >= 1 ? `${mins}m ago` : 'just now';
}

/**
 * Value identity for an entry. `findAuthEntry` re-reads the store from disk,
 * so the object it returns is never reference-equal to one from
 * `listAuthEntries` — the marker has to compare by value or it silently
 * never fires. Deliberately excludes the token: keys end up in a Set, and a
 * bearer has no business in a data structure built for display.
 */
function entryKey(e: AuthConfigEntry): string {
  return `${e.url}\0${e.workspace ?? ''}\0${e.savedAt}`;
}

/**
 * Column-aligned table of the store's entries, tokens omitted. Entries in
 * `active` are flagged `*` — those are what a command run from the caller's
 * cwd would actually resolve to, which is the question `list` exists to
 * answer.
 */
function renderEntries(
  entries: readonly AuthConfigEntry[],
  active: ReadonlySet<string>,
  now: number,
): string[] {
  const rows = entries.map((e) => ({
    marker: active.has(entryKey(e)) ? '*' : ' ',
    url: e.url,
    scope: e.workspace ?? '(all directories)',
    saved: age(e.savedAt, now),
  }));
  const wUrl = Math.max(6, ...rows.map((r) => r.url.length));
  const wScope = Math.max(5, ...rows.map((r) => r.scope.length));
  return [
    `  ${'BROKER'.padEnd(wUrl)}  ${'SCOPE'.padEnd(wScope)}  SAVED`,
    ...rows.map((r) => `${r.marker} ${r.url.padEnd(wUrl)}  ${r.scope.padEnd(wScope)}  ${r.saved}`),
  ];
}

function runList(input: AuthCommandInput, stdout: (line: string) => void): number {
  const now = input.now?.() ?? Date.now();
  const cwd = input.cwd ?? process.cwd();
  const entries = listAuthEntries(input.authConfigPath);

  stdout(`store: ${authStorePath()}`);
  stdout('');
  if (entries.length === 0) {
    stdout('  no enrollments — run `csuite connect` to enroll this device.');
  } else {
    // Mark, per broker, the entry a command run from `cwd` would actually
    // resolve to. Without this the operator has to replay the
    // longest-prefix rule in their head to answer "which member am I here?".
    // Resolution runs against the same `findAuthEntry` the rest of the CLI
    // uses, so the marker cannot drift from real behavior.
    const brokers = [...new Set(entries.map((e) => e.url))];
    const active = new Set(
      brokers
        .map((url) => findAuthEntry(url, { cwd, path: input.authConfigPath, skipLegacy: true }))
        .filter((e): e is AuthConfigEntry => e !== null)
        .map(entryKey),
    );
    for (const line of renderEntries(entries, active, now)) stdout(line);
    stdout('');
    stdout(`  * = what resolves from ${cwd}`);
  }

  const legacy = inspectLegacyStore(cwd);
  if (legacy !== null && legacy.entries > 0) {
    stdout('');
    stdout(`legacy store found: ${legacy.path}`);
    stdout(`  ${legacy.entries} entry/entries, implicitly scoped to ${legacy.workspace}`);
    stdout('  run `csuite auth migrate` to fold it into the global store');
    if (legacy.inGitRepo) {
      stdout('  NOTE: it sits inside a git working tree — the token may be in history');
    }
  }
  return 0;
}

function runMigrate(
  input: AuthCommandInput,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): number {
  const cwd = input.cwd ?? process.cwd();
  const report = migrateLegacyStore({ cwd, path: input.authConfigPath });
  if (report === null) {
    stdout('no legacy `.csuite/auth.json` found — nothing to migrate.');
    return 0;
  }
  stdout(`migrated ${report.entries} entry/entries`);
  stdout(`  from:  ${report.path}`);
  stdout(`  scope: ${report.workspace}`);
  stdout(`  into:  ${input.authConfigPath ?? authStorePath()}`);
  stdout('');
  if (report.inGitRepo) {
    stderr(`csuite: warning: ${report.path} is inside a git working tree.`);
    stderr('  If that file was ever committed, the token is in your git history.');
    stderr('  Rotate it — `csuite rotate --member <name>` — rather than only deleting');
    stderr('  the file. A csuite bearer resolves every secret bound to its member.');
  } else {
    stdout('the old file is no longer consulted — safe to delete.');
  }
  return 0;
}

/**
 * Dispatch `csuite auth <subcommand>`. Returns the process exit code.
 * Unknown subcommands raise `UsageError` so the CLI exits 2 rather than
 * silently succeeding.
 */
export function runAuthCommand(
  subcommand: string | undefined,
  input: AuthCommandInput,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): number {
  switch (subcommand) {
    case 'list':
    case undefined:
      return runList(input, stdout);
    case 'migrate':
      return runMigrate(input, stdout, stderr);
    default:
      throw new UsageError(`auth: unknown subcommand '${subcommand}' (expected: list | migrate)`);
  }
}
