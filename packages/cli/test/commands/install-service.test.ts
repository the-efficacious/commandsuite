/**
 * install-service / cycle — the pure pieces and the refusal paths.
 * The end-to-end path (real systemd, real broker, real liveness) runs
 * in CI with the stub verb; what lives here is everything decidable
 * without root: renders, URL resolution, the auth preflight refusal,
 * liveness polling semantics, and the no-root hand-off.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  detectInstallPrivilege,
  formatOperatorHandoff,
  renderRunnerSudoers,
  renderRunnerUnit,
  resolveServiceUrl,
  sudoersFilePathFor,
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
  execPath: 'csuite',
  home: '/home/builder',
};

describe('unit render', () => {
  it('carries the auth-keying pair, restart posture, and journald identity', () => {
    const unit = renderRunnerUnit(RENDER);
    expect(unit).toContain('Environment=CSUITE_URL=http://127.0.0.1:8719');
    expect(unit).toContain('WorkingDirectory=/home/builder/work');
    expect(unit).toContain(
      'ExecStart=csuite stub --url http://127.0.0.1:8719 --cwd /home/builder/work --resume',
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('StartLimitIntervalSec=0');
    expect(unit).toContain('SyslogIdentifier=csuite-builder');
    expect(unit).toContain('User=builder');
  });

  it('honours an exec override for main-build deploy trees', () => {
    const unit = renderRunnerUnit({ ...RENDER, execPath: '/opt/csuite-main/bin/csuite.mjs' });
    expect(unit).toContain('ExecStart=/opt/csuite-main/bin/csuite.mjs stub ');
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

describe('UsageError export', () => {
  it('is the shared CLI usage error', () => {
    expect(new UsageError('x')).toBeInstanceOf(Error);
  });
});
