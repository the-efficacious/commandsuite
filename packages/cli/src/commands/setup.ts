/**
 * `csuite setup` — seed a team and its first member, interactively or not.
 *
 * Two paths, one seed:
 *
 *   - Interactive (default): walk the operator through team + first
 *     member setup at a TTY. The wizard mints the bearer token (shown
 *     once, then wiped from scrollback) and enrolls TOTP with a
 *     confirmed code.
 *   - `--non-interactive`: no TTY, no prompts. Identity comes from
 *     `--team` and `--member` (required — a bootstrap member is not
 *     something to default silently). The bearer token is written to
 *     `--token-file` (required) at mode 0600 and never printed; the
 *     token is what a provisioning script, container entrypoint, or CI
 *     job needs to reach the broker, and stdout is where it would leak.
 *     TOTP is optional: pass `--totp-secret-file` to have a secret
 *     generated, enrolled, and written 0600 (an agent can then sign in
 *     to the web UI); omit it and the summary says how to enroll later.
 *
 * Both paths open the SQLite DB at the resolved path, seed the team
 * singleton + bootstrap member + bearer token, and write the slim
 * infra-only config file alongside.
 *
 * Resolution of the config path:
 *   1. explicit `--config-path` on the command line
 *   2. `$CSUITE_CONFIG_PATH` in the environment
 *   3. `./csuite.json` relative to the caller's cwd
 *
 * Refuses to touch a setup that's already complete: if the config
 * file exists AND the referenced DB has a team singleton, we print a
 * diagnostic and exit. Re-running would mint a fresh bootstrap token and
 * invalidate every active credential — explicit `rm csuite.json && rm
 * csuite.db` is the way to start over.
 */

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ENV } from 'csuite-sdk/protocol';
import type { Permission, Role } from 'csuite-sdk/types';
import { PERMISSIONS } from 'csuite-sdk/types';
import { UsageError } from './errors.js';

export { UsageError };

export interface SetupCommandInput {
  configPath?: string;
  /** Seed without prompting. Requires `team`, `member`, and `tokenFile`. */
  nonInteractive?: boolean;
  /** Team name (non-interactive only). 1–128 characters. */
  team?: string;
  /** Bootstrap member name (non-interactive only). Alphanumeric plus `. _ -`. */
  member?: string;
  /** Where to write the bearer token, mode 0600 (non-interactive only). */
  tokenFile?: string;
  /**
   * Where to write the generated base32 TOTP secret, mode 0600
   * (non-interactive only). Omit to skip TOTP enrollment.
   */
  totpSecretFile?: string;
}

const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
const BOOTSTRAP_ROLE_TITLE = 'member';

/** Everything the seed needs, whichever path captured it. */
interface BootstrapSeed {
  team: { name: string; context: string };
  member: {
    name: string;
    role: Role;
    instructions: string;
    rawPermissions: string[];
    permissions: Permission[];
    token: string;
    /** `null` when no TOTP is enrolled (non-interactive without a secret file). */
    totpSecret: string | null;
  };
}

export async function runSetupCommand(
  input: SetupCommandInput,
  stdout: (line: string) => void,
): Promise<void> {
  const server = await loadServerModule();
  const configPath = input.configPath ?? process.env[ENV.configPath] ?? server.defaultConfigPath();

  // Validate the non-interactive inputs before touching anything, so a
  // typo fails with nothing on disk. Passing identity flags without
  // `--non-interactive` is refused rather than silently ignored.
  const nonInteractive = validateNonInteractiveInput(input);

  // Note: the KEK is installed later, right before seeding.
  // `resolveKek` mints `csuite-kek.bin` on first use, so resolving it
  // up front would leave a stray key file behind whenever setup bails
  // early (non-TTY stdin, already-populated team). None of the probe
  // reads below decrypt anything, so nothing here needs it.

  // Refuse to overwrite an existing setup. We check both: file
  // presence AND a populated team singleton in the DB. If only the
  // file exists but the DB is empty, fall through and let the seed
  // re-run (operator probably bricked their DB and is recovering).
  let existingConfig: Awaited<ReturnType<typeof server.loadServerConfigFromFile>> | null = null;
  try {
    existingConfig = server.loadServerConfigFromFile(configPath);
  } catch (err) {
    if (err instanceof server.ConfigNotFoundError) {
      // Happy path — no file, seed from scratch.
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
            `  Running setup now would mint a fresh bootstrap member and invalidate all\n` +
            `  existing tokens. If that is what you want, remove both first:\n` +
            `    rm ${configPath} ${dbPath}`,
        );
      }
    } finally {
      probeDb.close();
    }
  }

  if (nonInteractive !== null) {
    await runNonInteractive(server, { configPath, dbPath, existingConfig }, nonInteractive, stdout);
    return;
  }

  const { io, close } = server.createTtyWizardIO();
  if (!io.isInteractive) {
    close();
    throw new UsageError(
      'setup: stdin is not a TTY — the wizard needs interactive input.\n' +
        '  Run this command in a real terminal (not piped / under turbo), or seed without\n' +
        '  prompts:\n' +
        '    csuite setup --non-interactive --team <name> --member <name> --token-file <path>',
    );
  }

  try {
    // The wizard is definitely running now. Make sure the server
    // directory exists (fresh bootstraps default to `./csuite/`;
    // no-op with unchanged permissions when it already does), then
    // mint/read the KEK so encrypted-at-rest TOTP / VAPID values
    // round-trip through the seed writes below.
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
    server.setKek(server.resolveKek(configPath));

    const wizard = await server.runFirstRunWizard({ configPath, io });
    await seedBootstrap(
      server,
      { configPath, dbPath, existingConfig },
      {
        team: wizard.team,
        member: { ...wizard.bootstrapMember },
      },
    );

    stdout('');
    stdout('✓ setup complete');
    stdout(`  team:    ${wizard.team.name}`);
    stdout(`  member:  ${wizard.bootstrapMember.name}`);
    stdout(`  config:  ${configPath}`);
    stdout(`  db:      ${dbPath}`);
    stdout('');
    stdout('Next steps:');
    stdout('  csuite serve         # start the broker against this config');
    stdout('');
    stdout('Then flesh out the team from the web UI or CLI whenever you like:');
    stdout('  csuite team set --context "..."     # team-level standing context');
    stdout('  csuite member update --name <n> ... # roles + personal instructions');
    stdout('');
  } catch (err) {
    if (err instanceof server.MemberLoadError || err instanceof server.KekResolutionError) {
      throw new UsageError(`setup: ${err.message}`);
    }
    throw err;
  } finally {
    close();
  }
}

interface NonInteractiveInput {
  team: string;
  member: string;
  tokenFile: string;
  totpSecretFile: string | null;
}

/**
 * Returns the validated non-interactive inputs, or `null` when the
 * interactive path applies. Every failure names the flag to fix.
 */
function validateNonInteractiveInput(input: SetupCommandInput): NonInteractiveInput | null {
  const identityFlags: string[] = [];
  if (input.team !== undefined) identityFlags.push('--team');
  if (input.member !== undefined) identityFlags.push('--member');
  if (input.tokenFile !== undefined) identityFlags.push('--token-file');
  if (input.totpSecretFile !== undefined) identityFlags.push('--totp-secret-file');

  if (!input.nonInteractive) {
    if (identityFlags.length > 0) {
      throw new UsageError(`setup: ${identityFlags.join(', ')} only apply with --non-interactive`);
    }
    return null;
  }

  const missing: string[] = [];
  if (!input.team) missing.push('--team <name>');
  if (!input.member) missing.push('--member <name>');
  if (!input.tokenFile) missing.push('--token-file <path>');
  if (missing.length > 0) {
    throw new UsageError(
      `setup: --non-interactive requires ${missing.join(', ')}\n` +
        '  The bootstrap identity is never defaulted silently, and the bearer token is\n' +
        '  written to a file (mode 0600) rather than printed.',
    );
  }
  const team = input.team as string;
  const member = input.member as string;
  if (team.length > 128) {
    throw new UsageError('setup: --team must be 1-128 characters');
  }
  if (member.length > 128 || !NAME_REGEX.test(member)) {
    throw new UsageError(
      `setup: invalid --member '${member}' (must be alphanumeric with . _ - allowed, 128 max)`,
    );
  }
  return {
    team,
    member,
    tokenFile: resolve(input.tokenFile as string),
    totpSecretFile: input.totpSecretFile !== undefined ? resolve(input.totpSecretFile) : null,
  };
}

async function runNonInteractive(
  server: typeof import('csuite-server'),
  paths: SeedPaths,
  input: NonInteractiveInput,
  stdout: (line: string) => void,
): Promise<void> {
  try {
    mkdirSync(dirname(paths.configPath), { recursive: true, mode: 0o700 });
    server.setKek(server.resolveKek(paths.configPath));

    const token = server.generateBearerToken();
    const totpSecret = input.totpSecretFile !== null ? server.generateTotpSecret() : null;

    // Secrets land on disk BEFORE the DB is seeded: if the token file
    // cannot be created (exists already, unwritable dir), nothing has
    // been minted that the operator can no longer reach.
    writeSecretFile(input.tokenFile, token, '--token-file');
    if (input.totpSecretFile !== null && totpSecret !== null) {
      writeSecretFile(input.totpSecretFile, totpSecret, '--totp-secret-file');
    }

    await seedBootstrap(server, paths, {
      team: { name: input.team, context: '' },
      member: {
        name: input.member,
        role: { title: BOOTSTRAP_ROLE_TITLE, description: '' },
        instructions: '',
        rawPermissions: [...PERMISSIONS],
        permissions: [...PERMISSIONS],
        token,
        totpSecret,
      },
    });

    stdout('');
    stdout('✓ setup complete (non-interactive)');
    stdout(`  team:    ${input.team}`);
    stdout(`  member:  ${input.member}`);
    stdout(`  config:  ${paths.configPath}`);
    stdout(`  db:      ${paths.dbPath}`);
    stdout(`  token:   ${input.tokenFile}  (mode 0600 — the only copy; the DB stores a hash)`);
    if (input.totpSecretFile !== null) {
      stdout(`  totp:    ${input.totpSecretFile}  (mode 0600 — base32 secret for web UI sign-in)`);
    } else {
      stdout('  totp:    not enrolled — once the broker is running:');
      stdout(`             csuite enroll --member ${input.member}`);
    }
    stdout('');
    stdout('Next steps:');
    stdout(`  csuite serve --config-path ${paths.configPath}`);
    stdout(`  CSUITE_TOKEN=$(cat ${input.tokenFile}) csuite roster`);
    stdout('');
  } catch (err) {
    if (err instanceof server.MemberLoadError || err instanceof server.KekResolutionError) {
      throw new UsageError(`setup: ${err.message}`);
    }
    throw err;
  }
}

interface SeedPaths {
  configPath: string;
  dbPath: string;
  existingConfig: { dbPath: string | null } | null;
}

/**
 * Seed the DB with the team + bootstrap member + bearer token and
 * write the slim infra-only config file. Shared by both paths so the
 * wizard and the non-interactive flag cannot drift apart.
 */
async function seedBootstrap(
  server: typeof import('csuite-server'),
  paths: SeedPaths,
  seed: BootstrapSeed,
): Promise<void> {
  const { configPath, dbPath, existingConfig } = paths;
  const db = server.openDatabase(dbPath);
  try {
    const stores = server.openTeamAndMembers(db);
    stores.team.setTeam({
      name: seed.team.name,
      context: seed.team.context,
    });
    stores.members.addMember({
      name: seed.member.name,
      role: seed.member.role,
      instructions: seed.member.instructions,
      rawPermissions: seed.member.rawPermissions,
      permissions: seed.member.permissions,
      totpSecret: seed.member.totpSecret,
    });
    const tokens = new server.SqliteTokenStore(db);
    // `insert` hashes the raw token (async) before the row lands —
    // awaited inside the try so `db.close()` cannot run first.
    await tokens.insert({
      memberName: seed.member.name,
      rawToken: seed.member.token,
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
}

/**
 * Create `path` with mode 0600 and write one line. `wx` refuses an
 * existing file: a secret file is never overwritten, because the
 * operator may have pointed the flag at something that matters.
 */
function writeSecretFile(path: string, value: string, flag: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new UsageError(
        `setup: ${flag} ${path} already exists — refusing to overwrite a secret file.\n` +
          '  Remove it or point the flag at a fresh path.',
      );
    }
    throw new UsageError(`setup: cannot create ${flag} ${path}: ${(err as Error).message}`);
  }
  try {
    writeSync(fd, `${value}\n`);
  } finally {
    closeSync(fd);
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
