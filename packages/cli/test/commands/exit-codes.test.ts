/**
 * The CLI's exit-code contract, as a matrix (commandsuite#253).
 *
 * `docs/reference/cli.mdx` publishes 1 = failure and 2 = usage error,
 * and a supervisor branches on exactly that split: 2 will never succeed
 * on a retry, 1 might. Before this suite the split was asserted nowhere
 * — no test in `packages/cli/test` pinned any exit code but 1 — and the
 * code had drifted in two directions at once: an unreachable broker and
 * a missing agent binary were converted to `UsageError` and exited 2,
 * and "nothing enrolled for (url, cwd)" exited 1 from a runner verb and
 * 2 from `install-service` on the same lookup key.
 *
 * So this is written as a MATRIX, not a list of cases: every failure
 * class is run through every entry point, and the table below states
 * the code for every cell. A cell that cannot be reached from an entry
 * point must say why, in `UNREACHABLE_BECAUSE` — the completeness test
 * fails if any cell is neither asserted nor explained. Adding a runner
 * verb or a service subcommand without covering it is a red build,
 * which is the only thing that keeps one entry point from drifting.
 *
 * These drive the BUILT CLI as a process (`packages/cli/dist`), because
 * the exit code is the contract and only a process has one. CI builds
 * before it tests; run `pnpm build` locally. They fail loudly rather
 * than skip if the build is missing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = resolve(__dirname, '../../dist/index.js');

/** Reachable, refuses instantly: the "broker is down" case, deterministically. */
const DOWN_BROKER = 'http://127.0.0.1:1';
/** Never dialled — every case here fails before any request would be made. */
const BROKER = 'http://broker.example:7';

/**
 * `csuite <verb> cycle` is listed by its WORKER half. The dispatcher
 * half is a detached-spawn-and-return: it exits 0 by design and the
 * worker's own code lands in `~/.local/var/csuite-cycle.log`, so the
 * dispatcher has no failure code to contract about and the worker is
 * where the (url, cwd) refusal actually happens.
 */
const ENTRY_POINTS = [
  'claude',
  'codex',
  'claude install-service',
  'claude cycle --worker',
] as const;
type EntryPoint = (typeof ENTRY_POINTS)[number];

const FAILURE_CLASSES = [
  'bad-argv',
  'no-saved-auth',
  'broker-unreachable',
  'agent-binary-missing',
] as const;
type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * The published contract, one cell per (failure class, entry point).
 *
 * `2` is argv and only argv. Everything else is the environment, which
 * can be true now and false in thirty seconds, so it is `1`.
 */
const EXPECTED: Record<FailureClass, Record<EntryPoint, 1 | 2 | 'unreachable'>> = {
  'bad-argv': {
    claude: 2,
    codex: 2,
    'claude install-service': 2,
    'claude cycle --worker': 2,
  },
  'no-saved-auth': {
    claude: 1,
    codex: 1,
    'claude install-service': 1,
    'claude cycle --worker': 1,
  },
  'broker-unreachable': {
    claude: 1,
    codex: 1,
    'claude install-service': 'unreachable',
    'claude cycle --worker': 'unreachable',
  },
  'agent-binary-missing': {
    claude: 1,
    codex: 1,
    'claude install-service': 'unreachable',
    'claude cycle --worker': 'unreachable',
  },
};

/** Why a cell has no code to assert. An undocumented hole fails the build. */
const UNREACHABLE_BECAUSE: Partial<Record<`${FailureClass}/${EntryPoint}`, string>> = {
  'broker-unreachable/claude install-service':
    '--print renders the unit and returns; the broker is contacted only by the liveness check after a real install',
  'broker-unreachable/claude cycle --worker':
    'the saved-auth refusal precedes the systemctl restart, so no broker call is reached',
  'agent-binary-missing/claude install-service':
    'install-service writes a unit naming the verb; it never locates the agent binary',
  'agent-binary-missing/claude cycle --worker':
    'cycle restarts a unit; it never locates the agent binary',
};

const dirsToClean: string[] = [];
afterEach(() => {
  for (const dir of dirsToClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'csuite-exit-codes-'));
  dirsToClean.push(dir);
  return dir;
}

/** An auth store holding one entry that resolves for (url, dir). */
function storeWith(dir: string, url: string): string {
  const path = join(dir, 'auth.json');
  writeFileSync(
    path,
    JSON.stringify({
      schema: 2,
      entries: [{ url, workspace: dir, token: 'csuite_exit_code_test', savedAt: Date.now() }],
    }),
  );
  return path;
}

function run(args: string[], env: Record<string, string | undefined>, cwd: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    // stdin from /dev/null: exactly what systemd, CI and a container give.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    timeout: 60_000,
  });
}

/** Argv prefix for an entry point, minus the case's own arguments. */
function argvFor(entry: EntryPoint): string[] {
  return entry.split(' ');
}

interface Case {
  argv: string[];
  env: Record<string, string | undefined>;
  /** Proves the run failed for the class under test and not by accident. */
  stderr: RegExp;
}

/** The invocation that puts `entry` into `cls`, in a fresh `dir`. */
function caseFor(cls: FailureClass, entry: EntryPoint, dir: string): Case {
  const emptyStore = join(dir, 'auth.json'); // absent: nothing enrolled anywhere
  const prefix = argvFor(entry);
  switch (cls) {
    case 'bad-argv':
      // `--url` with nothing after it: the same argv mistake every
      // entry point can make, so the row compares like with like.
      return {
        argv: [...prefix, '--url'],
        env: { CSUITE_AUTH_CONFIG_PATH: emptyStore },
        stderr: /--url requires a value/,
      };
    case 'no-saved-auth':
      return {
        argv: [...prefix, ...(prefix.length === 1 ? ['--skip-doctor'] : []), '--url', BROKER],
        env: { CSUITE_AUTH_CONFIG_PATH: emptyStore },
        stderr: new RegExp(`no saved auth for ${BROKER} scoped to`),
      };
    case 'broker-unreachable':
      return {
        argv: [...prefix, '--skip-doctor', '--url', DOWN_BROKER],
        env: {
          CSUITE_AUTH_CONFIG_PATH: storeWith(dir, DOWN_BROKER),
          // An executable that exists, so `locate()` passes and the
          // failure under test is the broker and nothing else.
          CLAUDE_PATH: process.execPath,
          CODEX_PATH: process.execPath,
        },
        stderr: /instructions failed against/,
      };
    case 'agent-binary-missing':
      return {
        argv: [...prefix, '--skip-doctor', '--url', BROKER],
        env: {
          CSUITE_AUTH_CONFIG_PATH: storeWith(dir, BROKER),
          CLAUDE_PATH: join(dir, 'no-such-claude'),
          CODEX_PATH: join(dir, 'no-such-codex'),
        },
        stderr: /no file exists there|which does not exist/,
      };
  }
}

describe('CLI exit codes', () => {
  it('has a built CLI to drive', () => {
    expect(existsSync(CLI), `${CLI} missing — run pnpm build first`).toBe(true);
  });

  it('states a code or a reason for every (failure class, entry point) cell', () => {
    const cells = FAILURE_CLASSES.flatMap((cls) =>
      ENTRY_POINTS.map((entry) => `${cls}/${entry}` as const),
    );
    // The table covers the whole product, no more and no less.
    expect(Object.keys(EXPECTED).sort()).toEqual([...FAILURE_CLASSES].sort());
    for (const cls of FAILURE_CLASSES) {
      expect(Object.keys(EXPECTED[cls]).sort(), `row ${cls}`).toEqual([...ENTRY_POINTS].sort());
    }
    // Every cell is either an asserted code or an explained hole.
    const explained = cells.filter((cell) => {
      const [cls, entry] = cell.split('/') as [FailureClass, EntryPoint];
      return EXPECTED[cls][entry] === 'unreachable';
    });
    expect(Object.keys(UNREACHABLE_BECAUSE).sort()).toEqual([...explained].sort());
    for (const cell of explained) {
      expect(UNREACHABLE_BECAUSE[cell], `${cell} needs a reason`).toBeTruthy();
    }
  });

  for (const cls of FAILURE_CLASSES) {
    for (const entry of ENTRY_POINTS) {
      const expected = EXPECTED[cls][entry];
      if (expected === 'unreachable') continue;
      it(`${cls} from \`csuite ${entry}\` exits ${expected}`, () => {
        const dir = sandbox();
        const c = caseFor(cls, entry, dir);
        const r = run(c.argv, c.env, dir);
        expect(r.stderr, `stderr did not show ${cls}: ${r.stderr}`).toMatch(c.stderr);
        expect(
          r.status,
          `\`csuite ${entry}\` answered ${cls} with ${r.status}, contract says ${expected}`,
        ).toBe(expected);
        // Never the interactive fallback, on any of these.
        expect(r.stdout + r.stderr).not.toContain('Broker URL [');
      });
    }
  }

  it('one condition, one code: every entry point agrees on no-saved-auth', () => {
    const codes = ENTRY_POINTS.map((entry) => {
      const dir = sandbox();
      const c = caseFor('no-saved-auth', entry, dir);
      return [entry, run(c.argv, c.env, dir).status] as const;
    });
    // The #253 regression was 1 from the runner verb and 2 from
    // install-service on the identical formatter and lookup key.
    expect(Object.fromEntries(codes)).toEqual(
      Object.fromEntries(ENTRY_POINTS.map((entry) => [entry, 1])),
    );
  });

  it('a usage error still exits 2 and prints its message, not a stack', () => {
    const dir = sandbox();
    const r = run(
      ['claude', 'install-service', '--nonsense'],
      { CSUITE_AUTH_CONFIG_PATH: join(dir, 'auth.json') },
      dir,
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown argument --nonsense');
    expect(r.stderr).not.toContain('at Object.');
  });
});
