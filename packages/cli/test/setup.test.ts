/**
 * Tests for `csuite setup`.
 *
 * The CLI wrapper around the wizard. End-to-end paths that drive the
 * full wizard (team capture → DB seed → slim config write) are
 * covered by `apps/server/test/wizard.test.ts` and the server-side
 * boot path. Here we focus on the CLI's guard-rails:
 *
 *   - non-TTY stdin yields a clear UsageError (no raw stack)
 *   - an invalid existing slim config surfaces as a UsageError
 *   - an existing config that points to a populated DB refuses to
 *     overwrite, with a readable summary that includes the team
 *     name and member count
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERMISSIONS } from 'csuite-sdk/types';
import { afterEach, describe, expect, it } from 'vitest';
import { runSetupCommand, UsageError } from '../src/commands/setup.js';

const dirsToClean: string[] = [];

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'csuite-setup-test-'));
  dirsToClean.push(dir);
  return dir;
}

// The dynamic import('csuite-server') these tests ride grew with the
// runtime-neutral core refactor; under a parallel root test run the
// module graph alone can eat most of vitest's 5s default.
describe('runSetupCommand', { timeout: 20_000 }, () => {
  it('throws a friendly UsageError when stdin is not a TTY', async () => {
    // Vitest runs with stdin non-TTY, so the wizard's interactive
    // guard fires once we get past the "config exists" check.
    const dir = tmpDir();
    const configPath = join(dir, 'csuite.json');
    await expect(runSetupCommand({ configPath }, () => {})).rejects.toThrow(/not a TTY/);
  });

  it('reports an invalid existing config as a UsageError', async () => {
    const dir = tmpDir();
    const configPath = join(dir, 'csuite.json');
    // Bad shape — `dbPath` must be a string, here it's a number.
    writeFileSync(configPath, JSON.stringify({ dbPath: 123 }));
    await expect(runSetupCommand({ configPath }, () => {})).rejects.toThrow(UsageError);
  });

  it('refuses to overwrite when the config + DB are populated', async () => {
    const dir = tmpDir();
    const configPath = join(dir, 'csuite.json');
    const dbPath = join(dir, 'csuite.db');

    // Stand up a real DB with a seeded team via the server module so
    // the setup probe finds a hasTeam() true. Importing the server
    // module dynamically keeps this aligned with how the CLI loads it.
    const server = await import('csuite-server');
    const db = server.openDatabase(dbPath);
    try {
      const stores = server.openTeamAndMembers(db);
      stores.team.setTeam({
        name: 'demo-team',
        context: '',
      });
      stores.members.addMember({
        name: 'director-1',
        role: { title: 'director', description: '' },
        instructions: '',
        rawPermissions: [],
        permissions: ['members.manage'],
      });
      stores.members.addMember({
        name: 'engineer-1',
        role: { title: 'engineer', description: '' },
        instructions: '',
        rawPermissions: [],
        permissions: [],
      });
    } finally {
      db.close();
    }

    server.writeServerConfigFile(configPath, {
      dbPath,
      activityDbPath: null,
      filesRoot: null,
      https: server.defaultHttpsConfig(),
      webPush: null,
      jwt: null,
      files: null,
    });

    try {
      await runSetupCommand({ configPath }, () => {});
      throw new Error('expected runSetupCommand to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const message = (err as Error).message;
      expect(message).toContain('demo-team');
      expect(message).toContain('director-1');
      expect(message).toContain('engineer-1');
      expect(message).toContain(`rm ${configPath} ${dbPath}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// `--non-interactive` — the seed with no TTY (commandsuite#198).
//
// The contract under test is completeness, not presence: the DB must
// hold the team AND a member holding every leaf AND a token that
// authenticates, the secret files must be 0600 and hold exactly what
// the DB hashed / encrypted, and the token must appear on stdout
// nowhere. Each negative has a positive control beside it.
// ─────────────────────────────────────────────────────────────────────

async function loadServer() {
  return await import('csuite-server');
}

function captured(): { lines: string[]; stdout: (line: string) => void } {
  const lines: string[] = [];
  return { lines, stdout: (line) => lines.push(line) };
}

describe('runSetupCommand --non-interactive', { timeout: 30_000 }, () => {
  it('seeds team + member + token and writes the token file at 0600, never to stdout', async () => {
    const dir = tmpDir();
    const configPath = join(dir, 'srv', 'csuite.json');
    const tokenFile = join(dir, 'secrets', 'admin.token');
    const out = captured();

    await runSetupCommand(
      { configPath, nonInteractive: true, team: 'demo', member: 'admin', tokenFile },
      out.stdout,
    );

    // The file is the only copy: exactly one line, a csuite_ token, mode 0600.
    const token = readFileSync(tokenFile, 'utf8');
    expect(token).toMatch(/^csuite_[A-Za-z0-9_-]{43}\n$/);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const raw = token.trim();
    expect(out.lines.join('\n')).not.toContain(raw);
    // The summary must still tell the operator where the token went.
    expect(out.lines.join('\n')).toContain(tokenFile);

    const server = await loadServer();
    const config = server.loadServerConfigFromFile(configPath);
    expect(config.dbPath).toBe('./csuite.db');
    const db = server.openDatabase(join(dir, 'srv', 'csuite.db'));
    try {
      const stores = server.openTeamAndMembers(db);
      expect(stores.team.hasTeam()).toBe(true);
      expect(stores.team.getTeam().name).toBe('demo');
      const member = stores.members.findByName('admin');
      expect(member).not.toBeNull();
      // Every leaf, not "some permissions": a bootstrap member missing
      // members.manage could never approve the next device.
      expect([...(member?.permissions ?? [])].sort()).toEqual([...PERMISSIONS].sort());
      expect(member?.totpSecret ?? null).toBeNull();
      // The token on disk is the token the DB hashed — the positive
      // control for "written 0600" being the *right* secret.
      const tokens = new server.SqliteTokenStore(db);
      const rows = await tokens.listForMember('admin');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.origin).toBe('bootstrap');
      const resolved = await tokens.resolve(raw);
      expect(resolved?.memberName).toBe('admin');
      // Negative control for the positive one above: a token that was
      // never minted does not resolve.
      expect(await tokens.resolve(`${raw.slice(0, -1)}x`)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('enrolls TOTP when --totp-secret-file is given, and the file holds the enrolled secret', async () => {
    const dir = tmpDir();
    const configPath = join(dir, 'csuite.json');
    const tokenFile = join(dir, 'admin.token');
    const totpSecretFile = join(dir, 'admin.totp');
    const out = captured();

    await runSetupCommand(
      {
        configPath,
        nonInteractive: true,
        team: 'demo',
        member: 'admin',
        tokenFile,
        totpSecretFile,
      },
      out.stdout,
    );

    const secret = readFileSync(totpSecretFile, 'utf8');
    expect(secret).toMatch(/^[A-Z2-7]{16,}\n$/);
    expect(statSync(totpSecretFile).mode & 0o777).toBe(0o600);
    expect(out.lines.join('\n')).not.toContain(secret.trim());

    const server = await loadServer();
    // The KEK setup installed is what decrypts the stored secret; reuse it.
    server.setKek(server.resolveKek(configPath));
    const db = server.openDatabase(join(dir, 'csuite.db'));
    try {
      const member = server.openTeamAndMembers(db).members.findByName('admin');
      expect(member?.totpSecret).toBe(secret.trim());
    } finally {
      db.close();
    }
    // And a code from that secret verifies — the sign-in the file exists for.
    const code = server.currentTotpCode(secret.trim());
    expect(server.verifyTotpCode(secret.trim(), code, 0, Date.now()).ok).toBe(true);
  });

  it('refuses without --team/--member/--token-file, naming what is missing, and writes nothing', async () => {
    const dir = tmpDir();
    const configPath = join(dir, 'csuite.json');
    await expect(
      runSetupCommand({ configPath, nonInteractive: true, team: 'demo' }, () => {}),
    ).rejects.toThrow(/--member <name>, --token-file <path>/);
    expect(() => statSync(configPath)).toThrow();
    expect(() => statSync(join(dir, 'csuite.db'))).toThrow();
  });

  it('refuses identity flags without --non-interactive', async () => {
    const dir = tmpDir();
    const configPath = join(dir, 'csuite.json');
    await expect(
      runSetupCommand({ configPath, team: 'demo', member: 'admin' }, () => {}),
    ).rejects.toThrow(/--team, --member only apply with --non-interactive/);
  });

  it('refuses an invalid member name', async () => {
    const dir = tmpDir();
    await expect(
      runSetupCommand(
        {
          configPath: join(dir, 'csuite.json'),
          nonInteractive: true,
          team: 'demo',
          member: 'not ok',
          tokenFile: join(dir, 't'),
        },
        () => {},
      ),
    ).rejects.toThrow(/invalid --member 'not ok'/);
  });

  it('refuses to overwrite an existing token file and leaves the DB unseeded', async () => {
    const dir = tmpDir();
    const configPath = join(dir, 'csuite.json');
    const tokenFile = join(dir, 'admin.token');
    writeFileSync(tokenFile, 'precious\n');
    await expect(
      runSetupCommand(
        { configPath, nonInteractive: true, team: 'demo', member: 'admin', tokenFile },
        () => {},
      ),
    ).rejects.toThrow(/already exists — refusing to overwrite/);
    expect(readFileSync(tokenFile, 'utf8')).toBe('precious\n');
    expect(() => statSync(join(dir, 'csuite.db'))).toThrow();
  });

  it('a pre-existing TOTP file leaves nothing behind, and the corrected retry succeeds', async () => {
    // Rune's reproduction on PR #206: the token file was created before
    // the TOTP collision was noticed, and the retry then failed on it.
    const dir = tmpDir();
    const configPath = join(dir, 'srv', 'csuite.json');
    const tokenFile = join(dir, 'admin.token');
    const totpSecretFile = join(dir, 'admin.totp');
    writeFileSync(totpSecretFile, 'preexisting\n');
    await expect(
      runSetupCommand(
        { configPath, nonInteractive: true, team: 't', member: 'admin', tokenFile, totpSecretFile },
        () => {},
      ),
    ).rejects.toThrow(/--totp-secret-file .* already exists/);
    // Nothing this run would have created exists: token, config, DB, KEK.
    for (const path of [
      tokenFile,
      configPath,
      join(dir, 'srv', 'csuite.db'),
      join(dir, 'srv', 'csuite-kek.bin'),
    ]) {
      expect(existsSync(path), path).toBe(false);
    }
    // The pre-existing file is untouched.
    expect(readFileSync(totpSecretFile, 'utf8')).toBe('preexisting\n');
    // The corrected retry — same token path, fresh TOTP path — succeeds.
    await runSetupCommand(
      {
        configPath,
        nonInteractive: true,
        team: 't',
        member: 'admin',
        tokenFile,
        totpSecretFile: join(dir, 'admin-2.totp'),
      },
      () => {},
    );
    expect(readFileSync(tokenFile, 'utf8')).toMatch(/^csuite_/);
    expect(existsSync(configPath)).toBe(true);
  });

  it('refuses identical --token-file and --totp-secret-file before writing anything', async () => {
    const dir = tmpDir();
    const same = join(dir, 'both');
    await expect(
      runSetupCommand(
        {
          configPath: join(dir, 'csuite.json'),
          nonInteractive: true,
          team: 't',
          member: 'admin',
          tokenFile: same,
          totpSecretFile: same,
        },
        () => {},
      ),
    ).rejects.toThrow(/must be different files/);
    expect(existsSync(same)).toBe(false);
    expect(existsSync(join(dir, 'csuite.json'))).toBe(false);
  });

  it('rolls back the secret files when a later step fails for real', async () => {
    // The config directory exists but is read-only, so minting the KEK
    // fails AFTER the secrets were written — the branch the path
    // preflight cannot reach. Root ignores directory modes, so the
    // failure cannot be produced there; say so rather than pass vacuously.
    if (process.getuid?.() === 0) {
      console.warn('skipping: running as root, read-only dir cannot fail');
      return;
    }
    const dir = tmpDir();
    const srv = join(dir, 'srv');
    mkdirSync(srv, { mode: 0o500 });
    const tokenFile = join(dir, 'admin.token');
    const totpSecretFile = join(dir, 'admin.totp');
    try {
      await expect(
        runSetupCommand(
          {
            configPath: join(srv, 'csuite.json'),
            nonInteractive: true,
            team: 't',
            member: 'admin',
            tokenFile,
            totpSecretFile,
          },
          () => {},
        ),
      ).rejects.toThrow(/Nothing this run created was left behind/);
      expect(existsSync(tokenFile)).toBe(false);
      expect(existsSync(totpSecretFile)).toBe(false);
      expect(existsSync(join(srv, 'csuite-kek.bin'))).toBe(false);
      expect(existsSync(join(srv, 'csuite.json'))).toBe(false);
    } finally {
      chmodSync(srv, 0o700);
    }
  });

  it('still refuses when the config already points to a populated team', async () => {
    const dir = tmpDir();
    const configPath = join(dir, 'csuite.json');
    const first = join(dir, 'first.token');
    await runSetupCommand(
      { configPath, nonInteractive: true, team: 'demo', member: 'admin', tokenFile: first },
      () => {},
    );
    await expect(
      runSetupCommand(
        {
          configPath,
          nonInteractive: true,
          team: 'other',
          member: 'admin2',
          tokenFile: join(dir, 'second.token'),
        },
        () => {},
      ),
    ).rejects.toThrow(/already points to a populated team/);
    // The first token is untouched and the second was never created.
    expect(readFileSync(first, 'utf8')).toMatch(/^csuite_/);
    expect(() => statSync(join(dir, 'second.token'))).toThrow();
  });
});
