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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('runSetupCommand', () => {
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
