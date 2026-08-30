/**
 * `scripts/bootstrap.sh down` — process ownership and proof of stop.
 *
 * A pid file names a number, and numbers are reused. Rune's review of
 * #211: `kill -0` alone let `down` SIGTERM whatever now holds a stale
 * pid, and `down` returned without waiting, so it never proved that
 * nothing remained. These tests drive the real script as a process:
 *
 *   - a pid file pointing at an unrelated live process: the process
 *     survives, the script says why, the stale file is removed;
 *   - a pid file pointing at nothing: handled, file removed;
 *   - positive control: a process whose command line carries our
 *     config path (the broker fingerprint) is stopped and is gone
 *     when `down` returns — asserted with kill(pid, 0) → ESRCH;
 *   - the same for the runner, whose fingerprint is its working
 *     directory.
 *
 * Nothing here needs a broker: `down` only touches the pid files.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../bootstrap.sh');
const children = [];
const dirs = [];

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      c.kill('SIGKILL');
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'csuite-bootstrap-down-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'server'), { recursive: true });
  mkdirSync(join(dir, 'runner'), { recursive: true });
  return dir;
}

/** A long-lived node process with the given argv tail and cwd. */
function idle(args, cwd) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...args], {
    cwd,
    stdio: 'ignore',
    detached: true,
  });
  children.push(child);
  return child;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/**
 * Resolve once the child has exited and been reaped. `down` runs under
 * spawnSync, which blocks this event loop, so a child it killed sits as
 * a zombie — still answering kill(pid, 0) — until the loop turns and
 * libuv reaps it. Awaiting the exit event is the honest "gone" check.
 */
function exited(child, ms = 5_000) {
  return new Promise((resolveExit, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveExit(child.signalCode);
    const t = setTimeout(
      () => reject(new Error(`pid ${child.pid} did not exit within ${ms}ms`)),
      ms,
    );
    child.once('exit', (_code, signal) => {
      clearTimeout(t);
      resolveExit(signal);
    });
  });
}

async function settled(child) {
  // Give the child a moment to exec so /proc/<pid>/cmdline is populated.
  await new Promise((r) => setTimeout(r, 300));
  return child.pid;
}

function down(dir) {
  return spawnSync('bash', [SCRIPT, 'down'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CSUITE_BOOTSTRAP_DIR: dir },
    timeout: 60_000,
  });
}

describe('bootstrap.sh down — ownership', { timeout: 60_000 }, () => {
  it('leaves an unrelated live process alone when the pid file points at it', async () => {
    const dir = stateDir();
    const stranger = idle(['not-ours'], dir);
    const pid = await settled(stranger);
    writeFileSync(join(dir, 'serve.pid'), `${pid}\n`);
    writeFileSync(join(dir, 'runner.pid'), `${pid}\n`);

    const r = down(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('is not our runner');
    expect(r.stdout).toContain('is not our broker');
    expect(alive(pid), 'the stranger must survive').toBe(true);
    expect(existsSync(join(dir, 'serve.pid'))).toBe(false);
    expect(existsSync(join(dir, 'runner.pid'))).toBe(false);
  });

  it('handles a pid file that names no process', () => {
    const dir = stateDir();
    // Highest plausible pid + 1 on Linux; fine on other kernels too.
    writeFileSync(join(dir, 'serve.pid'), '4194305\n');
    const r = down(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('is not running');
    expect(existsSync(join(dir, 'serve.pid'))).toBe(false);
  });

  it('positive control: stops the broker it fingerprints, and it is gone when down returns', async () => {
    const dir = stateDir();
    const config = join(dir, 'server', 'csuite.json');
    // The fingerprint: `serve` and our exact config path on the command line.
    const broker = idle(['serve', '--config-path', config, '--port', '1'], dir);
    const pid = await settled(broker);
    writeFileSync(join(dir, 'serve.pid'), `${pid}\n`);

    const r = down(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`stopped broker pid ${pid} (gone)`);
    expect(await exited(broker)).toBe('SIGTERM');
    expect(alive(pid), 'the broker must be gone').toBe(false);
    expect(existsSync(join(dir, 'serve.pid'))).toBe(false);
  });

  it('positive control: stops the runner it fingerprints by working directory', async () => {
    const dir = stateDir();
    const runner = idle(['claude', '--skip-doctor'], join(dir, 'runner'));
    const pid = await settled(runner);
    writeFileSync(join(dir, 'runner.pid'), `${pid}\n`);

    const r = down(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`stopped runner pid ${pid} (gone)`);
    expect(await exited(runner)).toBe('SIGTERM');
    expect(alive(pid)).toBe(false);
  });

  it('a runner-shaped process in the wrong directory is not ours', async () => {
    const dir = stateDir();
    const elsewhere = idle(['claude', '--skip-doctor'], dir); // not the runner workspace
    const pid = await settled(elsewhere);
    writeFileSync(join(dir, 'runner.pid'), `${pid}\n`);
    const r = down(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('is not our runner');
    expect(alive(pid)).toBe(true);
  });
});
