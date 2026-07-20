/**
 * `csuite setup` — run the first-time wizard and seed the DB.
 *
 * Walks the operator through team + admin setup, opens the SQLite DB
 * at the resolved path, seeds the team singleton + permission presets
 * + admin member + admin bearer token, and writes the slim infra-only
 * config file alongside.
 *
 * Resolution of the config path:
 *   1. explicit `--config-path` on the command line
 *   2. `$CSUITE_CONFIG_PATH` in the environment
 *   3. `./csuite.json` relative to the caller's cwd
 *
 * Refuses to touch a setup that's already complete: if the config
 * file exists AND the referenced DB has a team singleton, we print a
 * diagnostic and exit. Re-running would mint a fresh admin token and
 * invalidate every active credential — explicit `rm csuite.json && rm
 * csuite.db` is the way to start over.
 */

import { dirname, join } from 'node:path';
import { ENV } from 'csuite-sdk/protocol';
import { UsageError } from './errors.js';

export { UsageError };

export interface SetupCommandInput {
  configPath?: string;
}

export async function runSetupCommand(
  input: SetupCommandInput,
  stdout: (line: string) => void,
): Promise<void> {
  const server = await loadServerModule();
  const configPath = input.configPath ?? process.env[ENV.configPath] ?? server.defaultConfigPath();

  // KEK first — encrypted-at-rest TOTP / VAPID values round-trip
  // cleanly through the wizard's write path.
  try {
    server.setKek(server.resolveKek(configPath));
  } catch (err) {
    if (err instanceof server.KekResolutionError) {
      throw new UsageError(`setup: ${err.message}`);
    }
    throw err;
  }

  // Refuse to overwrite an existing setup. We check both: file
  // presence AND a populated team singleton in the DB. If only the
  // file exists but the DB is empty, fall through and let the wizard
  // re-seed (operator probably bricked their DB and is recovering).
  let existingConfig: Awaited<ReturnType<typeof server.loadServerConfigFromFile>> | null = null;
  try {
    existingConfig = server.loadServerConfigFromFile(configPath);
  } catch (err) {
    if (err instanceof server.ConfigNotFoundError) {
      // Happy path — no file, run the wizard.
    } else if (err instanceof server.MemberLoadError) {
      throw new UsageError(`setup: existing config at ${configPath} is invalid: ${err.message}`);
    } else {
      throw err;
    }
  }

  // Relative paths in the loaded config resolve against the config
  // file's directory so seeding lands next to the config file
  // regardless of cwd. New setups default to `<configDir>/csuite.db`.
  const dbPath = existingConfig?.dbPath
    ? (server.resolveConfigPath(configPath, existingConfig.dbPath) ??
      join(dirname(configPath), 'csuite.db'))
    : join(dirname(configPath), 'csuite.db');

  if (existingConfig !== null) {
    const probeDb = server.openDatabase(dbPath);
    try {
      const stores = server.openTeamAndMembers(probeDb);
      if (stores.team.hasTeam()) {
        const team = stores.team.getTeam();
        const memberNames = stores.members.names();
        throw new UsageError(
          `setup: ${configPath} already points to a populated team\n` +
            `  team:    ${team.name}\n` +
            `  members: ${stores.members.size()} (${memberNames.join(', ')})\n` +
            `  db:      ${dbPath}\n\n` +
            `  Running the wizard now would mint a fresh admin and invalidate all\n` +
            `  existing tokens. If that is what you want, remove both first:\n` +
            `    rm ${configPath} ${dbPath}`,
        );
      }
    } finally {
      probeDb.close();
    }
  }

  const { io, close } = server.createTtyWizardIO();
  if (!io.isInteractive) {
    close();
    throw new UsageError(
      'setup: stdin is not a TTY — the wizard needs interactive input.\n' +
        '  Run this command in a real terminal (not piped / under turbo).',
    );
  }

  try {
    const wizard = await server.runFirstRunWizard({ configPath, io });

    // Seed DB with the wizard's captured team + admin.
    const db = server.openDatabase(dbPath);
    try {
      const stores = server.openTeamAndMembers(db);
      stores.team.setTeam({
        name: wizard.team.name,
        directive: wizard.team.directive,
        context: wizard.team.context,
      });
      for (const [name, leaves] of Object.entries(wizard.team.permissionPresets)) {
        stores.team.setPreset(name, leaves);
      }
      stores.members.addMember({
        name: wizard.admin.name,
        role: wizard.admin.role,
        instructions: wizard.admin.instructions,
        rawPermissions: wizard.admin.rawPermissions,
        permissions: wizard.admin.permissions,
        totpSecret: wizard.admin.totpSecret,
      });
      const tokens = new server.TokenStore(db);
      tokens.insert({
        memberName: wizard.admin.name,
        rawToken: wizard.admin.token,
        label: 'wizard',
        origin: 'bootstrap',
        createdBy: null,
      });
    } finally {
      db.close();
    }

    // Write the slim infra-only config file with sensible defaults.
    // Store dbPath relative to the config file when we placed the DB
    // alongside it (the new-setup case); preserve whatever shape the
    // existing config used otherwise (recovery-from-empty-DB path).
    const configuredDbPath =
      existingConfig?.dbPath ??
      (dbPath === join(dirname(configPath), 'csuite.db') ? './csuite.db' : dbPath);
    server.writeServerConfigFile(configPath, {
      dbPath: configuredDbPath,
      activityDbPath: null,
      filesRoot: null,
      https: server.defaultHttpsConfig(),
      webPush: null,
      jwt: null,
      files: null,
    });

    stdout('');
    stdout('✓ setup complete');
    stdout(`  team:    ${wizard.team.name}`);
    stdout(`  admin:   ${wizard.admin.name}`);
    stdout(`  config:  ${configPath}`);
    stdout(`  db:      ${dbPath}`);
    stdout('');
    stdout('Next steps:');
    stdout('  csuite serve         # start the broker against this config');
    stdout('');
  } catch (err) {
    if (err instanceof server.MemberLoadError) {
      throw new UsageError(`setup: ${err.message}`);
    }
    throw err;
  } finally {
    close();
  }
}

async function loadServerModule(): Promise<typeof import('csuite-server')> {
  try {
    return await import('csuite-server');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new UsageError(
        'setup: csuite-server is not installed.\n' +
          '  This command needs the broker package. Install it alongside the CLI:\n' +
          '    npm install -g csuite-server\n' +
          '  Or install the full ecosystem in one step:\n' +
          '    npm install -g csuite',
      );
    }
    throw err;
  }
}
