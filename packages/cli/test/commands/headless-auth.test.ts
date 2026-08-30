/**
 * Headless runner start with nothing to authenticate with (commandsuite#199).
 *
 * Two layers, because the defect lived between them:
 *
 *   - the pure pieces (`savedAuthCheck`, `formatHeadlessNoAuth`) at
 *     every state each can produce, since the branch a healthy dev
 *     machine takes is never the branch whose wording matters;
 *   - the built CLI driven as a process with stdin not a TTY, asserting
 *     the exit status and the stream — the only two things a supervisor
 *     observes. Before this change the same invocation printed the
 *     wizard's URL prompt and exited 0, which `Restart=always` loops
 *     forever.
 *
 * The process tests need `packages/cli/dist` (CI builds before it
 * tests; `pnpm build` locally). They fail loudly rather than skip if it
 * is missing: a skipped process test is a green that proves nothing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatHeadlessNoAuth } from '../../src/commands/auth-config.js';
import { savedAuthCheck } from '../../src/commands/doctor.js';

const CLI = resolve(__dirname, '../../dist/index.js');
const BROKER = 'http://broker.example:7';

const dirsToClean: string[] = [];
afterEach(() => {
  for (const dir of dirsToClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'csuite-headless-auth-'));
  dirsToClean.push(dir);
  return dir;
}

describe('savedAuthCheck', () => {
  const base = { url: BROKER, urlDefaulted: false, cwd: '/srv/agent', tokenFromEnv: false };

  it('PASSes on an env token without consulting the store', () => {
    const c = savedAuthCheck({ ...base, tokenFromEnv: true, entry: null, interactive: false });
    expect(c.status).toBe('PASS');
    expect(c.detail).toContain('$CSUITE_TOKEN');
  });

  it('PASSes on a resolving entry and names its scope', () => {
    const scoped = savedAuthCheck({
      ...base,
      entry: { workspace: '/srv' },
      interactive: false,
    });
    expect(scoped.status).toBe('PASS');
    expect(scoped.detail).toContain('entry for /srv');
    expect(scoped.detail).toContain(`${BROKER} scoped to /srv/agent`);
    const global = savedAuthCheck({ ...base, entry: { workspace: null }, interactive: false });
    expect(global.status).toBe('PASS');
    expect(global.detail).toContain('machine-wide');
  });

  it('WARNs at a TTY when nothing resolves — the wizard will run', () => {
    const c = savedAuthCheck({ ...base, entry: null, interactive: true });
    expect(c.status).toBe('WARN');
    expect(c.detail).toContain('wizard will run');
  });

  it('FAILs headless when nothing resolves, naming the key and both fixes', () => {
    const c = savedAuthCheck({ ...base, entry: null, interactive: false });
    expect(c.status).toBe('FAIL');
    expect(c.detail).toContain(`${BROKER} scoped to /srv/agent`);
    expect(c.detail).toContain('not a TTY');
    expect(c.detail).toContain(`csuite connect --url ${BROKER} --workspace /srv/agent`);
    expect(c.detail).toContain('$CSUITE_TOKEN');
    // Not defaulted: no talk of the default URL.
    expect(c.detail).not.toContain('default');
  });

  it('adds the default-URL hint only when the URL was defaulted', () => {
    const c = savedAuthCheck({
      ...base,
      url: 'http://127.0.0.1:8717',
      urlDefaulted: true,
      entry: null,
      interactive: false,
    });
    expect(c.status).toBe('FAIL');
    expect(c.detail).toContain('is the default');
    expect(c.detail).toContain('$CSUITE_URL');
  });
});

describe('formatHeadlessNoAuth', () => {
  it('names the URL, the directory, the connect command with --workspace, and auth list', () => {
    const msg = formatHeadlessNoAuth({ url: BROKER, cwd: '/srv/agent', urlDefaulted: false });
    expect(msg).toContain(`no saved auth for ${BROKER} scoped to /srv/agent`);
    expect(msg).toContain(`csuite connect --url ${BROKER} --workspace /srv/agent`);
    expect(msg).toContain('CSUITE_TOKEN');
    expect(msg).toContain('csuite auth list');
    expect(msg).not.toContain('default broker URL');
  });

  it('explains the loopback default when nothing pointed at a broker', () => {
    const msg = formatHeadlessNoAuth({
      url: 'http://127.0.0.1:8717',
      cwd: '/srv/agent',
      urlDefaulted: true,
    });
    expect(msg).toContain('http://127.0.0.1:8717 is the default broker URL');
    expect(msg).toContain('set $CSUITE_URL or --url');
  });
});

describe('csuite claude, headless, nothing resolves (built CLI as a process)', () => {
  it('has a built CLI to drive', () => {
    expect(existsSync(CLI), `${CLI} missing — run pnpm build first`).toBe(true);
  });

  function run(args: string[], env: Record<string, string | undefined>, cwd: string) {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      // stdin from /dev/null: exactly what systemd, CI, and a container give.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...env,
      },
      timeout: 30_000,
    });
  }

  it('exits 1 on stderr with the (url, cwd) key and the fixes — never the wizard, never 0', () => {
    const dir = sandbox();
    const store = join(dir, 'auth.json'); // absent: nothing enrolled anywhere
    const r = run(
      ['claude', '--skip-doctor'],
      { CSUITE_AUTH_CONFIG_PATH: store, CSUITE_URL: BROKER },
      dir,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`no saved auth for ${BROKER} scoped to ${dir}`);
    expect(r.stderr).toContain(`csuite connect --url ${BROKER} --workspace ${dir}`);
    // The wizard's prompt is the regression: it must not appear on either stream.
    expect(r.stdout + r.stderr).not.toContain('Broker URL [');
    expect(r.stdout + r.stderr).not.toContain('running `csuite connect`');
  });

  it('names the loopback default when CSUITE_URL is unset — the systemd trap', () => {
    const dir = sandbox();
    const r = run(
      ['claude', '--skip-doctor'],
      { CSUITE_AUTH_CONFIG_PATH: join(dir, 'auth.json'), CSUITE_URL: undefined },
      dir,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('http://127.0.0.1:8717 is the default broker URL');
  });

  it('--doctor reports [FAIL] saved auth headless with nothing enrolled, and exits 1', () => {
    const dir = sandbox();
    const r = run(
      ['claude', '--doctor'],
      { CSUITE_AUTH_CONFIG_PATH: join(dir, 'auth.json'), CSUITE_URL: BROKER },
      dir,
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\[FAIL\]\s+saved auth/);
    expect(r.stdout).toContain(`${BROKER} scoped to ${dir}`);
  });

  for (const verb of ['claude', 'codex']) {
    it(`${verb} --doctor reports the explicit model the runner would use`, () => {
      const dir = sandbox();
      const r = run(
        [verb, '--doctor', '--model', 'acceptance-model'],
        { CSUITE_AUTH_CONFIG_PATH: join(dir, 'auth.json'), CSUITE_URL: BROKER },
        dir,
      );
      expect(r.stdout).toContain(`${verb} · acceptance-model`);
      expect(r.stdout).not.toContain(`${verb} · agent default — not resolved locally`);
    });
  }

  it('positive control: with an entry for (url, cwd) the same --doctor line is [PASS]', () => {
    const dir = sandbox();
    const store = join(dir, 'auth.json');
    writeFileSync(
      store,
      JSON.stringify({
        schema: 2,
        entries: [{ url: BROKER, workspace: dir, token: 'csuite_test', savedAt: Date.now() }],
      }),
    );
    const r = run(
      ['claude', '--doctor'],
      { CSUITE_AUTH_CONFIG_PATH: store, CSUITE_URL: BROKER },
      dir,
    );
    expect(r.stdout).toMatch(/\[PASS\]\s+saved auth/);
    expect(r.stdout).toContain(`entry for ${dir}`);
  });

  it('positive control: $CSUITE_TOKEN satisfies the lookup without a store', () => {
    const dir = sandbox();
    const r = run(
      ['claude', '--doctor'],
      {
        CSUITE_AUTH_CONFIG_PATH: join(dir, 'auth.json'),
        CSUITE_URL: BROKER,
        CSUITE_TOKEN: 'csuite_env',
      },
      dir,
    );
    expect(r.stdout).toMatch(/\[PASS\]\s+saved auth/);
    expect(r.stdout).toContain('$CSUITE_TOKEN');
  });
});
