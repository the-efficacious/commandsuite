/**
 * Doctor checks that are properties of the MACHINE, and the two that
 * are properties of one agent framework.
 *
 * `test/runtime/doctor.test.ts` covers the report shape end to end
 * against the real box. This file covers the individual checks at every
 * status each can produce — which is the part that rots, because the
 * branch a healthy dev machine takes is never the branch whose wording
 * matters. A FAIL detail nobody has ever rendered is a sentence nobody
 * has read.
 *
 * `commands/doctor.ts` has no probe indirection — it calls node
 * builtins directly — so these tests do not invent one. Every state is
 * produced for real:
 *
 *   - version strings are just arguments, because the two checks that
 *     have unreachable branches (`node >= 22`, `git identity`) are
 *     deliberately pure over their inputs;
 *   - uid 0 is produced by replacing `process.getuid`, which is a
 *     writable property of `process` and the only honest way to be root
 *     without being root;
 *   - tmpfs is produced by pointing `$XDG_CACHE_HOME` at `/dev/shm`,
 *     which really is a tmpfs on any Linux box — no mocked `statfs`,
 *     the check runs a real `fs.statfs` and gets a real answer.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DoctorCheck,
  gitIdentityCheck,
  nodeVersionCheck,
  runAgentDoctor,
} from '../../src/commands/doctor.js';
import type {
  AgentAdapter,
  AgentAdapterMeta,
  AgentDoctorCheck,
  AgentProcess,
} from '../../src/runtime/agents/adapter.js';
import { createClaudeAdapter } from '../../src/runtime/agents/claude-agent.js';
import { createCodexAdapter } from '../../src/runtime/agents/codex/codex-agent.js';

/** `/dev/shm` is a tmpfs on Linux and absent elsewhere. */
const HAS_TMPFS = existsSync('/dev/shm');

function byName(checks: readonly DoctorCheck[] | readonly AgentDoctorCheck[], name: string) {
  return checks.find((c) => c.name === name);
}

describe('nodeVersionCheck', () => {
  it('PASSes at and above the supported floor', () => {
    expect(nodeVersionCheck('22.0.0').status).toBe('PASS');
    expect(nodeVersionCheck('24.3.1')).toEqual({
      name: 'node >= 22',
      status: 'PASS',
      detail: 'node 24.3.1',
    });
  });

  it('FAILs below the floor and says what breaks', () => {
    const check = nodeVersionCheck('20.11.1');
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('20.11.1');
    expect(check.detail).toContain('below the supported minimum 22');
  });

  it('WARNs rather than guessing when the version is unparseable', () => {
    const check = nodeVersionCheck('not-a-version');
    expect(check.status).toBe('WARN');
    expect(check.detail).toContain('not-a-version');
  });

  it('tolerates a leading v', () => {
    expect(nodeVersionCheck('v22.11.0').status).toBe('PASS');
  });
});

describe('gitIdentityCheck', () => {
  it('PASSes when both halves are set, echoing the identity', () => {
    expect(gitIdentityCheck('Platform Scout', 'platform-scout@example.com')).toEqual({
      name: 'git identity',
      status: 'PASS',
      detail: 'Platform Scout <platform-scout@example.com>',
    });
  });

  it('WARNs and names only the half that is missing', () => {
    const noName = gitIdentityCheck(null, 'someone@example.com');
    expect(noName.status).toBe('WARN');
    expect(noName.detail).toContain('git user.name is unset');
    expect(noName.detail).not.toContain('user.email');

    const noEmail = gitIdentityCheck('Someone', null);
    expect(noEmail.status).toBe('WARN');
    expect(noEmail.detail).toContain('git user.email is unset');
  });

  it('WARNs about both halves when neither is set', () => {
    const check = gitIdentityCheck(null, null);
    expect(check.status).toBe('WARN');
    expect(check.detail).toContain('user.name and user.email');
  });
});

/**
 * A stand-in adapter: enough surface to run the doctor, and `versionArgs:
 * null` so the shared version probe never tries to spawn anything.
 */
const FAKE_META: AgentAdapterMeta = {
  id: 'fake',
  displayName: 'Fake Agent',
  captureTier: 0,
  signals: 'teardown',
  testedVersions: null,
  versionArgs: null,
};

function fakeAdapter(doctor?: () => Promise<AgentDoctorCheck[]>): AgentAdapter {
  return {
    meta: FAKE_META,
    locate: () => {},
    binaryPath: () => '/fake/agent',
    prepare: () => ({ cleanup: () => {} }),
    async spawn(): Promise<AgentProcess> {
      throw new Error('doctor tests never spawn');
    },
    doctor,
  };
}

describe('runAgentDoctor composition', () => {
  it('gives every runner the host checks, whether or not it declares any of its own', async () => {
    const report = await runAgentDoctor(fakeAdapter());
    const names = report.checks.map((c) => c.name);
    expect(names).toEqual([
      'fake binary',
      'runner identity',
      'node >= 22',
      '$TMPDIR writable',
      'loopback hook server bindable',
      'git identity',
    ]);
  });

  it('appends adapter checks after the host checks', async () => {
    const report = await runAgentDoctor(
      fakeAdapter(async () => [{ name: 'fake posture', status: 'PASS', detail: 'ok' }]),
    );
    const names = report.checks.map((c) => c.name);
    expect(names[names.length - 1]).toBe('fake posture');
    expect(names.indexOf('git identity')).toBeLessThan(names.indexOf('fake posture'));
  });

  it('an adapter FAIL sets anyFail; an adapter WARN does not', async () => {
    const warned = await runAgentDoctor(
      fakeAdapter(async () => [{ name: 'fake posture', status: 'WARN', detail: 'meh' }]),
    );
    expect(warned.anyFail).toBe(false);

    const failed = await runAgentDoctor(
      fakeAdapter(async () => [{ name: 'fake posture', status: 'FAIL', detail: 'nope' }]),
    );
    expect(failed.anyFail).toBe(true);
  });

  it('a throwing doctor() degrades to one WARN instead of losing the report', async () => {
    const report = await runAgentDoctor(
      fakeAdapter(async () => {
        throw new Error('probe exploded');
      }),
    );
    const check = byName(report.checks, 'fake adapter checks');
    expect(check?.status).toBe('WARN');
    expect(check?.detail).toContain('probe exploded');
    expect(report.anyFail).toBe(false);
  });

  it('reports the real machine git identity as PASS or WARN, never FAIL', async () => {
    const report = await runAgentDoctor(fakeAdapter());
    const git = byName(report.checks, 'git identity');
    expect(git).toBeDefined();
    expect(git?.status).not.toBe('FAIL');
  });
});

/**
 * uid and the cache mount are ambient process state; every test that
 * cares sets it explicitly so the suite behaves the same for a developer
 * on a laptop and for CI running as root in a container.
 */
describe('adapter doctor() checks', () => {
  const savedGetuid = process.getuid;
  const savedSudoUser = process.env.SUDO_USER;
  const savedCacheHome = process.env.XDG_CACHE_HOME;
  // Cleared per test as well as restored: a developer running the suite
  // inside a devcontainer really does have IS_SANDBOX set, and the uid 0
  // expectations below would then be asserting the wrong branch on their
  // machine and the right one in CI.
  const savedIsSandbox = process.env.IS_SANDBOX;
  const savedConfigHome = process.env.XDG_CONFIG_HOME;

  function setUid(uid: number | null): void {
    if (uid === null) delete process.getuid;
    else process.getuid = () => uid;
  }

  beforeEach(() => {
    delete process.env.SUDO_USER;
    delete process.env.IS_SANDBOX;
  });

  afterEach(() => {
    if (savedGetuid === undefined) delete process.getuid;
    else process.getuid = savedGetuid;
    if (savedSudoUser === undefined) delete process.env.SUDO_USER;
    else process.env.SUDO_USER = savedSudoUser;
    if (savedCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = savedCacheHome;
    if (savedIsSandbox === undefined) delete process.env.IS_SANDBOX;
    else process.env.IS_SANDBOX = savedIsSandbox;
    if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedConfigHome;
  });

  async function claudeChecks(): Promise<AgentDoctorCheck[]> {
    const adapter = createClaudeAdapter({});
    expect(adapter.doctor).toBeDefined();
    return (await adapter.doctor?.()) ?? [];
  }

  async function codexChecks(): Promise<AgentDoctorCheck[]> {
    const adapter = createCodexAdapter({});
    expect(adapter.doctor).toBeDefined();
    return (await adapter.doctor?.()) ?? [];
  }

  describe('claude: not running as root', () => {
    it('PASSes as an ordinary user', async () => {
      setUid(1000);
      expect(byName(await claudeChecks(), 'not running as root')).toEqual({
        name: 'not running as root',
        status: 'PASS',
        detail: 'uid 1000',
      });
    });

    it('FAILs at uid 0 and names the flag claude refuses', async () => {
      setUid(0);
      const check = byName(await claudeChecks(), 'not running as root');
      expect(check?.status).toBe('FAIL');
      expect(check?.detail).toContain('--dangerously-skip-permissions');
      expect(check?.detail).toContain('uid 0');
      expect(check?.detail).toContain('ordinary user account');
    });

    it('still FAILs under sudo — the same process is the one that spawns claude', async () => {
      setUid(0);
      process.env.SUDO_USER = 'aprzy';
      const check = byName(await claudeChecks(), 'not running as root');
      expect(check?.status).toBe('FAIL');
      expect(check?.detail).toContain('Drop the sudo');
      expect(check?.detail).toContain('aprzy');
    });

    it('treats SUDO_USER=root as no sudo at all', async () => {
      setUid(0);
      process.env.SUDO_USER = 'root';
      const check = byName(await claudeChecks(), 'not running as root');
      expect(check?.status).toBe('FAIL');
      expect(check?.detail).not.toContain('Drop the sudo');
    });

    it('WARNs where the platform exposes no uid', async () => {
      setUid(null);
      const check = byName(await claudeChecks(), 'not running as root');
      expect(check?.status).toBe('WARN');
      expect(check?.detail).toContain('no effective uid');
    });

    it('demotes uid 0 to a WARN when IS_SANDBOX declares a root container', async () => {
      setUid(0);
      process.env.IS_SANDBOX = '1';
      const check = byName(await claudeChecks(), 'not running as root');
      expect(check?.status).toBe('WARN');
      expect(check?.detail).toContain('IS_SANDBOX');
      // The containment point survives the demotion — the session runs,
      // and nothing constrains what it writes.
      expect(check?.detail).toContain('whole filesystem');
    });

    it('reads IS_SANDBOX for presence, not truth — the vendor skips its refusal either way', async () => {
      setUid(0);
      process.env.IS_SANDBOX = '0';
      expect(byName(await claudeChecks(), 'not running as root')?.status).toBe('WARN');
    });

    it('treats an empty IS_SANDBOX as unset', async () => {
      setUid(0);
      process.env.IS_SANDBOX = '';
      expect(byName(await claudeChecks(), 'not running as root')?.status).toBe('FAIL');
    });

    it('does not abort the preflight in a declared sandbox', async () => {
      setUid(0);
      process.env.IS_SANDBOX = '1';
      const checks = await claudeChecks();
      expect(checks.every((c) => c.status !== 'FAIL')).toBe(true);
    });

    it('makes a root session a hard preflight failure', async () => {
      setUid(0);
      process.env.CLAUDE_PATH = '/nonexistent/claude';
      try {
        const report = await runAgentDoctor(createClaudeAdapter({}), {
          includeVersion: false,
        });
        expect(byName(report.checks, 'not running as root')?.status).toBe('FAIL');
        expect(report.anyFail).toBe(true);
      } finally {
        delete process.env.CLAUDE_PATH;
      }
    });
  });

  describe('codex: not running as root', () => {
    it('PASSes as an ordinary user', async () => {
      setUid(501);
      expect(byName(await codexChecks(), 'not running as root')?.status).toBe('PASS');
    });

    it('WARNs at uid 0 — codex runs, but nothing contains it', async () => {
      setUid(0);
      const check = byName(await codexChecks(), 'not running as root');
      expect(check?.status).toBe('WARN');
      expect(check?.detail).toContain('danger-full-access');
      expect(check?.detail).toContain('root-owned');
    });

    it('names the sudo invoker when there is one', async () => {
      setUid(0);
      process.env.SUDO_USER = 'aprzy';
      expect(byName(await codexChecks(), 'not running as root')?.detail).toContain(
        'Drop the sudo to run as aprzy',
      );
    });

    it('WARNs where the platform exposes no uid', async () => {
      setUid(null);
      const check = byName(await codexChecks(), 'not running as root');
      expect(check?.status).toBe('WARN');
      expect(check?.detail).toContain('no effective uid');
    });

    it('never FAILs the preflight over uid alone', async () => {
      setUid(0);
      const checks = await codexChecks();
      expect(checks.every((c) => c.status !== 'FAIL')).toBe(true);
    });
  });

  describe('codex: cache dir not tmpfs', () => {
    it('PASSes on a disk-backed cache, resolving through the nearest existing parent', async () => {
      setUid(1000);
      // The checkout itself: a directory that exists, on a real disk,
      // that the check only ever stats. The named cache dir under it
      // does not exist, which is the cold-machine case the walk-up
      // handles.
      process.env.XDG_CACHE_HOME = join(process.cwd(), 'csuite-doctor-absent-cache');
      const check = byName(await codexChecks(), 'codex cache dir not tmpfs');
      expect(check?.status).toBe('PASS');
      expect(check?.detail).toContain('via existing parent');
      expect(check?.detail).toContain('disk-backed');
    });

    it.skipIf(!HAS_TMPFS)('WARNs on a RAM-backed cache and names what is lost', async () => {
      setUid(1000);
      process.env.XDG_CACHE_HOME = '/dev/shm';
      const check = byName(await codexChecks(), 'codex cache dir not tmpfs');
      expect(check?.status).toBe('WARN');
      expect(check?.detail).toContain('RAM-backed');
      expect(check?.detail).toContain('apply-patch');
      expect(check?.detail).toContain('$XDG_CACHE_HOME');
    });

    it.skipIf(!HAS_TMPFS)('does not FAIL the preflight over a tmpfs cache', async () => {
      setUid(1000);
      process.env.XDG_CACHE_HOME = '/dev/shm';
      const checks = await codexChecks();
      expect(checks.every((c) => c.status !== 'FAIL')).toBe(true);
    });

    it('is a codex concern only — claude declares no cache check', async () => {
      setUid(1000);
      const names = (await claudeChecks()).map((c) => c.name);
      expect(names).toEqual(['not running as root']);
    });
  });

  describe('codex: local MCP servers', () => {
    it('lists enabled servers from the durable source without a credential', async () => {
      const root = mkdtempSync(join(tmpdir(), 'csuite-doctor-mcp-'));
      const dir = join(root, 'csuite', 'codex');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'mcp-servers.json'),
        JSON.stringify({
          version: 1,
          servers: {
            chrome: { command: 'node' },
            off: { command: 'node', enabled: false },
          },
        }),
      );
      process.env.XDG_CONFIG_HOME = root;
      const check = byName(await codexChecks(), 'codex local MCP servers');
      expect(check?.status).toBe('PASS');
      expect(check?.detail).toContain('chrome');
      expect(check?.detail).not.toContain('off');
      expect(check?.detail).toContain(join(dir, 'mcp-servers.json'));
    });

    it('FAILs invalid durable configuration with an actionable path', async () => {
      const root = mkdtempSync(join(tmpdir(), 'csuite-doctor-mcp-bad-'));
      const dir = join(root, 'csuite', 'codex');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'mcp-servers.json'), '{');
      process.env.XDG_CONFIG_HOME = root;
      const check = byName(await codexChecks(), 'codex local MCP servers');
      expect(check?.status).toBe('FAIL');
      expect(check?.detail).toContain(join(dir, 'mcp-servers.json'));
    });
  });
});
