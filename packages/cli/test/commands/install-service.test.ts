/**
 * install-service / cycle — the pure pieces and the refusal paths.
 * The end-to-end path (real systemd, real broker, real liveness) runs
 * in CI with the stub verb; what lives here is everything decidable
 * without root: renders, URL resolution, the auth preflight refusal,
 * liveness polling semantics, and the no-root hand-off.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cycleWorkerArgs,
  detectInstallPrivilege,
  execStartToken,
  formatOperatorHandoff,
  renderRunnerSudoers,
  renderRunnerUnit,
  resolveServiceUrl,
  runInstallServiceCommand,
  snapshotPrivilegedFile,
  sudoersFilePathFor,
  systemdValue,
  UsageError,
  unitFilePathFor,
  unitNameFor,
  waitForMemberLive,
} from '../../src/commands/install-service.js';

const RENDER = {
  user: 'builder',
  verb: 'stub' as const,
  url: 'http://127.0.0.1:8719',
  workspace: '/home/builder/work',
  execArgv: ['/usr/bin/csuite'],
  home: '/home/builder',
};

describe('unit render', () => {
  it('carries the auth-keying pair, restart posture, and journald identity', () => {
    const unit = renderRunnerUnit(RENDER);
    expect(unit).toContain('Environment=CSUITE_URL=http://127.0.0.1:8719');
    expect(unit).toContain('WorkingDirectory=/home/builder/work');
    expect(unit).toContain(
      'ExecStart=/usr/bin/csuite stub --url http://127.0.0.1:8719 --cwd /home/builder/work',
    );
    // The stub rejects --resume (nothing to resume); real verbs carry it
    // so a cycle keeps the conversation. CI caught the stub unit
    // restart-looping on this flag.
    expect(unit).not.toContain('--resume');
    const claudeUnit = renderRunnerUnit({ ...RENDER, verb: 'claude' });
    expect(claudeUnit).toContain('--cwd /home/builder/work --resume');
    const codexUnit = renderRunnerUnit({ ...RENDER, verb: 'codex' });
    expect(codexUnit).toContain('--cwd /home/builder/work --resume');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('StartLimitIntervalSec=0');
    expect(unit).toContain('SyslogIdentifier=csuite-builder');
    expect(unit).toContain('User=builder');
  });

  it('honours an exec override for main-build deploy trees', () => {
    const unit = renderRunnerUnit({ ...RENDER, execArgv: ['/opt/csuite-main/bin/csuite.mjs'] });
    expect(unit).toContain('ExecStart=/opt/csuite-main/bin/csuite.mjs stub ');
  });

  it('quotes a space-containing exec path as ONE token and spacey env values', () => {
    const unit = renderRunnerUnit({
      ...RENDER,
      execArgv: ['/usr/bin/node', '/opt/my tools/dist/index.js'],
      home: '/home/my builder',
    });
    expect(unit).toContain('ExecStart=/usr/bin/node "/opt/my tools/dist/index.js" stub ');
    expect(unit).toContain('Environment="HOME=/home/my builder"');
    expect(unit).toContain('Environment="PATH=/home/my builder/.local/bin:');
  });
});

describe('sudoers render', () => {
  it('scopes exactly five systemctl verbs to exactly one unit, no wildcards', () => {
    const text = renderRunnerSudoers('builder');
    for (const verb of ['start', 'stop', 'restart', 'is-active', 'status']) {
      expect(text).toContain(`/usr/bin/systemctl ${verb} csuite-builder`);
    }
    expect(text).not.toContain('*');
    expect(text).toContain('builder ALL=(root) NOPASSWD:');
  });
});

describe('paths', () => {
  it('derives unit and sudoers locations from the user', () => {
    expect(unitNameFor('builder')).toBe('csuite-builder');
    expect(unitFilePathFor('builder')).toBe('/etc/systemd/system/csuite-builder.service');
    expect(sudoersFilePathFor('builder')).toBe('/etc/sudoers.d/builder-csuite-runner');
  });
});

describe('broker URL resolution', () => {
  const entries = [
    { url: 'http://a:1', workspace: '/home/builder/work' },
    { url: 'http://b:2', workspace: '/home/builder/other' },
    { url: 'http://c:3', workspace: null },
  ];

  it('explicit URL wins', () => {
    expect(
      resolveServiceUrl({ explicit: 'http://x:9', workspace: '/home/builder/work', entries }),
    ).toBe('http://x:9');
  });

  it('a single workspace-scoped entry decides', () => {
    expect(resolveServiceUrl({ workspace: '/home/builder/work/sub', entries })).toBe('http://a:1');
  });

  it('zero candidates refuse with the enrol pointer', () => {
    expect(() => resolveServiceUrl({ workspace: '/srv/elsewhere', entries })).toThrow(
      /no saved auth entry.*csuite connect/s,
    );
  });

  it('several candidates refuse naming them all (never guess a broker)', () => {
    const many = [
      { url: 'http://a:1', workspace: '/home/builder' },
      { url: 'http://b:2', workspace: '/home/builder/work' },
    ];
    expect(() => resolveServiceUrl({ workspace: '/home/builder/work', entries: many })).toThrow(
      /2 brokers.*http:\/\/a:1.*http:\/\/b:2/s,
    );
  });
});

describe('privilege detection', () => {
  it('maps sudo -n success to sudo and failure to none', () => {
    const okProbe = vi.fn().mockReturnValue({ status: 0 });
    const failProbe = vi.fn().mockReturnValue({ status: 1 });
    expect(detectInstallPrivilege(okProbe as never)).toBe('sudo');
    expect(detectInstallPrivilege(failProbe as never)).toBe('none');
    expect(okProbe).toHaveBeenCalledWith('sudo', ['-n', 'true'], expect.anything());
  });
});

describe('broker-side liveness', () => {
  const presence = (lastSeen: number, connected = 1) => ({
    connected: [{ name: 'builder', connected, lastSeen }],
    teammates: [],
  });

  it('a live pid with a stale lastSeen is not a live agent', async () => {
    // Roster keeps answering, but lastSeen predates the restart — the
    // stuck-wizard shape. Must time out, not pass.
    const client = { roster: vi.fn().mockResolvedValue(presence(1_000)) };
    const live = await waitForMemberLive(client as never, 'builder', 5_000, 1, async () => {});
    expect(live).toBe(false);
  });

  it('passes only once lastSeen is fresh and connected >= 1', async () => {
    const client = {
      roster: vi
        .fn()
        .mockResolvedValueOnce(presence(1_000))
        .mockResolvedValueOnce(presence(9_000, 0))
        .mockResolvedValue(presence(9_000)),
    };
    const live = await waitForMemberLive(client as never, 'builder', 5_000, 60_000, async () => {});
    expect(live).toBe(true);
    expect(client.roster).toHaveBeenCalledTimes(3);
  });

  it('keeps polling through a briefly unreachable broker (mid-restart)', async () => {
    const client = {
      roster: vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValue(presence(9_000)),
    };
    const live = await waitForMemberLive(client as never, 'builder', 5_000, 60_000, async () => {});
    expect(live).toBe(true);
  });
});

describe('operator hand-off', () => {
  it('prints both files, both install commands, and the visudo check', () => {
    const text = formatOperatorHandoff({
      user: 'builder',
      unitText: renderRunnerUnit(RENDER),
      sudoersText: renderRunnerSudoers('builder'),
    });
    expect(text).toContain('nothing outside $HOME was written');
    expect(text).toContain('/etc/systemd/system/csuite-builder.service');
    expect(text).toContain('visudo -c -f');
    expect(text).toContain('sudo install -m 440');
    expect(text).toContain('sudo systemctl enable --now csuite-builder');
  });
});

describe('systemd value hygiene', () => {
  it('refuses control characters (directive injection) and escapes %', () => {
    expect(() => systemdValue('a\nExecStart=/bin/evil', 'workspace')).toThrow(/control characters/);
    expect(() => systemdValue('a\rb', 'workspace')).toThrow(/control characters/);
    expect(systemdValue('/srv/100%cpu', 'workspace')).toBe('/srv/100%%cpu');
  });

  it('quotes ExecStart tokens containing whitespace and refuses quotes/backslashes', () => {
    expect(execStartToken('/opt/my tools/csuite', 'exec path')).toBe('"/opt/my tools/csuite"');
    expect(execStartToken('/usr/bin/csuite', 'exec path')).toBe('/usr/bin/csuite');
    expect(() => execStartToken('/opt/a"b', 'exec path')).toThrow(/quotes or backslashes/);
  });

  it('renders a spacey workspace as quoted ExecStart tokens', () => {
    const unit = renderRunnerUnit({ ...RENDER, workspace: '/home/builder/my work' });
    expect(unit).toContain('--cwd "/home/builder/my work"');
    expect(unit).toContain('WorkingDirectory=/home/builder/my work');
  });
});

describe('component-aware workspace scoping', () => {
  it('a sibling directory sharing a prefix is not under the workspace', () => {
    const entries = [{ url: 'http://a:1', workspace: '/home/builder/work' }];
    expect(() => resolveServiceUrl({ workspace: '/home/builder/workother', entries })).toThrow(
      /no saved auth entry/,
    );
    expect(resolveServiceUrl({ workspace: '/home/builder/work', entries })).toBe('http://a:1');
    expect(resolveServiceUrl({ workspace: '/home/builder/work/sub', entries })).toBe('http://a:1');
  });
});

describe('replacement safety (delete nothing, previous runner untouched)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(
    previousUnit: string | null,
    options: { unitWasEnabled?: boolean; unitWasActive?: boolean; instructionsError?: Error } = {},
  ) {
    const home = mkdtempSync(join(tmpdir(), 'csuite-svc-'));
    dirs.push(home);
    const workspace = join(home, 'work');
    const store = join(home, 'auth.json');
    writeFileSync(
      store,
      JSON.stringify({
        schema: 2,
        entries: [{ url: 'http://x:1', workspace, token: 'tok', savedAt: 1 }],
      }),
    );
    const commands: string[] = [];
    const runSync = vi.fn((cmd: string, args: string[]) => {
      commands.push([cmd, ...args].join(' '));
      if (args[0] === 'is-enabled')
        return { status: options.unitWasEnabled === false ? 1 : 0, stderr: '' };
      if (args[0] === 'is-active')
        return { status: options.unitWasActive === false ? 1 : 0, stderr: '' };
      return { status: 0, stderr: '' };
    });
    const deps = {
      stdout: () => {},
      clientFor: () => ({
        instructions: options.instructionsError
          ? vi.fn().mockRejectedValue(options.instructionsError)
          : vi.fn().mockResolvedValue({ name: 'builder' }),
        roster: vi.fn().mockResolvedValue({ teammates: [], connected: [] }),
      }),
      runSync: runSync as never,
      readExisting: (path: string) => (path.endsWith('.service') ? previousUnit : null),
      authStorePath: store,
      user: 'builder',
      home,
      sleep: async () => {},
    };
    return { deps, commands, workspace, home };
  }

  it('restores and restarts a previously active unit when liveness fails', async () => {
    const { deps, commands, workspace, home } = fixture('[Unit]\n# the old unit\n');
    await expect(
      runInstallServiceCommand(
        { verb: 'stub', url: 'http://x:1', workspace, timeoutMs: 1, execPath: '/usr/bin/csuite' },
        deps as never,
      ),
    ).rejects.toThrow(/restored the previous .*and restarted it/);
    const joined = commands.join('\n');
    // Restore sequence: stop new → install previous bytes back → reload → start.
    expect(joined).toMatch(
      /systemctl stop csuite-builder[\s\S]*\.previous \/etc\/systemd\/system\/csuite-builder\.service[\s\S]*daemon-reload[\s\S]*systemctl start csuite-builder/,
    );
    // The restore staged the exact previous bytes; the new render stays staged.
    expect(
      readFileSync(join(home, '.config/csuite/service/csuite-builder.service.previous'), 'utf8'),
    ).toBe('[Unit]\n# the old unit\n');
    expect(
      readFileSync(join(home, '.config/csuite/service/csuite-builder.service'), 'utf8'),
    ).toContain('ExecStart=');
  });

  it('a previously DISABLED unit is restored disabled and not started', async () => {
    const { deps, commands, workspace } = fixture('[Unit]\n# old\n', {
      unitWasEnabled: false,
      unitWasActive: false,
    });
    await expect(
      runInstallServiceCommand(
        { verb: 'stub', url: 'http://x:1', workspace, timeoutMs: 1, execPath: '/usr/bin/csuite' },
        deps as never,
      ),
    ).rejects.toThrow(/left disabled, as found/);
    const joined = commands.join('\n');
    expect(joined).toMatch(/\.previous[\s\S]*daemon-reload[\s\S]*systemctl disable csuite-builder/);
    expect(joined).not.toMatch(/systemctl start csuite-builder/);
  });

  it('an exception from the broker identity call rolls back like a liveness failure', async () => {
    const { deps, commands, workspace } = fixture('[Unit]\n# old\n', {
      instructionsError: new Error('broker exploded'),
    });
    await expect(
      runInstallServiceCommand(
        { verb: 'stub', url: 'http://x:1', workspace, timeoutMs: 1, execPath: '/usr/bin/csuite' },
        deps as never,
      ),
    ).rejects.toThrow(
      /installing or verifying the unit failed \(broker exploded\)[\s\S]*restored the previous/,
    );
    expect(commands.join('\n')).toMatch(
      /systemctl stop csuite-builder[\s\S]*\.previous[\s\S]*systemctl start csuite-builder/,
    );
  });

  it('a failure at the sudoers install rolls back both files without touching the running previous unit', async () => {
    const { deps, commands, workspace } = fixture('[Unit]\n# old\n', {});
    // Inject: the privileged sudoers install fails.
    const inner = deps.runSync as unknown as ReturnType<typeof vi.fn>;
    const original = inner.getMockImplementation() as (
      cmd: string,
      args: string[],
    ) => { status: number; stderr: string };
    inner.mockImplementation(((cmd: string, args: string[]) => {
      if (
        args.includes('-m') &&
        args.includes('440') &&
        !String(args.join(' ')).includes('.previous')
      ) {
        commands.push([cmd, ...args].join(' '));
        return { status: 1, stderr: 'disk full' };
      }
      return original(cmd, args);
    }) as never);
    await expect(
      runInstallServiceCommand(
        { verb: 'stub', url: 'http://x:1', workspace, timeoutMs: 1, execPath: '/usr/bin/csuite' },
        deps as never,
      ),
    ).rejects.toThrow(
      /installing or verifying the unit failed[\s\S]*restored the previous \/etc\/systemd\/system\/csuite-builder\.service[\s\S]*removed the fresh \/etc\/sudoers\.d/,
    );
    const joined = commands.join('\n');
    // The previous runner's process was never ours to stop: started=false.
    expect(joined).not.toMatch(/systemctl (stop|start|restart) csuite-builder/);
    expect(joined).toMatch(/\.previous \/etc\/systemd\/system\/csuite-builder\.service/);
  });

  it('sudoers is snapshotted too: a prior rule is restored byte-exact on rollback', async () => {
    const { deps, commands, workspace, home } = fixture('[Unit]\n# old\n', {});
    (deps as { readExisting: (p: string) => string | null }).readExisting = (p: string) =>
      p.endsWith('.service') ? '[Unit]\n# old\n' : '# old sudoers rule\n';
    await expect(
      runInstallServiceCommand(
        { verb: 'stub', url: 'http://x:1', workspace, timeoutMs: 1, execPath: '/usr/bin/csuite' },
        deps as never,
      ),
    ).rejects.toThrow(/restored the previous \/etc\/sudoers\.d\/builder-csuite-runner/);
    expect(
      readFileSync(join(home, '.config/csuite/service/builder-csuite-runner.previous'), 'utf8'),
    ).toBe('# old sudoers rule\n');
    expect(commands.join('\n')).toMatch(
      /440 .*builder-csuite-runner\.previous \/etc\/sudoers\.d\/builder-csuite-runner/,
    );
  });

  it('flow: a failed snapshot refuses BEFORE any privileged mutation', async () => {
    const { deps, commands, workspace } = fixture(null);
    (deps as { readExisting: (p: string) => string | null }).readExisting = () => {
      throw new UsageError(
        'install-service: cannot snapshot /etc/sudoers.d/x — refusing before any mutation',
      );
    };
    await expect(
      runInstallServiceCommand(
        { verb: 'stub', url: 'http://x:1', workspace, timeoutMs: 1, execPath: '/usr/bin/csuite' },
        deps as never,
      ),
    ).rejects.toThrow(/refusing before any mutation/);
    expect(commands.join('\n')).not.toMatch(
      /install -m|rm -f|systemctl (stop|start|restart|enable|disable|daemon-reload)/,
    );
  });

  it('stops and disables a fresh install when liveness fails and nothing preceded it', async () => {
    const { deps, commands, workspace } = fixture(null);
    await expect(
      runInstallServiceCommand(
        { verb: 'stub', url: 'http://x:1', workspace, timeoutMs: 1, execPath: '/usr/bin/csuite' },
        deps as never,
      ),
    ).rejects.toThrow(/removed the fresh \/etc\/systemd\/system\/csuite-builder\.service/);
    const joined = commands.join('\n');
    // Fresh rollback: disable (unlink wants), stop, remove BOTH fresh
    // privileged artifacts, reload; nothing restored, staging kept.
    expect(joined).toMatch(
      /systemctl disable csuite-builder[\s\S]*systemctl stop csuite-builder[\s\S]*rm -f \/etc\/systemd\/system\/csuite-builder\.service[\s\S]*rm -f \/etc\/sudoers\.d\/builder-csuite-runner[\s\S]*daemon-reload/,
    );
    expect(joined).not.toContain('.previous');
  });
});

describe('privileged snapshot (root-0440 sudoers)', () => {
  const enoent = () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
  const eacces = () => {
    const err = new Error('EACCES') as NodeJS.ErrnoException;
    err.code = 'EACCES';
    throw err;
  };

  it('a readable file is its own snapshot', () => {
    expect(snapshotPrivilegedFile('/x', { read: () => 'bytes', privRead: () => null })).toBe(
      'bytes',
    );
  });

  it('ENOENT is the only unprivileged reading of absent', () => {
    expect(snapshotPrivilegedFile('/x', { read: enoent, privRead: () => 'never' })).toBe(null);
  });

  it('EACCES falls back to the privileged reader', () => {
    expect(snapshotPrivilegedFile('/x', { read: eacces, privRead: () => 'root bytes' })).toBe(
      'root bytes',
    );
    expect(snapshotPrivilegedFile('/x', { read: eacces, privRead: () => null })).toBe(null);
  });

  it('an undecidable snapshot refuses (never absent-by-assumption)', () => {
    expect(() =>
      snapshotPrivilegedFile('/x', {
        read: eacces,
        privRead: () => {
          throw new UsageError('cannot snapshot');
        },
      }),
    ).toThrow(/cannot snapshot/);
  });
});

describe('cycle worker argv', () => {
  it('forwards --url and --timeout to the detached worker', () => {
    expect(cycleWorkerArgs({ verb: 'stub', url: 'http://x:1', timeoutMs: 90_000 })).toEqual([
      'stub',
      'cycle',
      '--worker',
      '--url',
      'http://x:1',
      '--timeout',
      '90',
    ]);
  });

  it('omits what the caller did not pass (env/default paths stay intact)', () => {
    expect(cycleWorkerArgs({ verb: 'codex' })).toEqual(['codex', 'cycle', '--worker']);
  });
});

describe('UsageError export', () => {
  it('is the shared CLI usage error', () => {
    expect(new UsageError('x')).toBeInstanceOf(Error);
  });
});
