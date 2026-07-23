/**
 * `csuite-server` — CLI entry for the self-hosted broker.
 *
 * Boot sequence:
 *   1. Parse args + env. Determine the slim config-file path.
 *   2. Resolve the at-rest KEK so encrypted webPush keys / TOTP
 *      secrets round-trip correctly.
 *   3. Load the slim `ServerConfig` (storage paths, HTTPS, webPush,
 *      JWT, files). If the file is missing AND stdin is a TTY, run
 *      the first-run wizard to gather the team + admin, open the DB,
 *      seed both stores, write the slim file, and continue.
 *   4. Open the main DB and the DB-backed team + member stores.
 *      Refuse to boot if no team singleton exists (operator likely
 *      pointed us at a fresh DB but a populated config file — the
 *      authoritative state is the DB).
 *   5. Auto-flip HTTPS off → self-signed when binding non-loopback.
 *   6. Hand off to `runServer()`.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT, ENV } from 'csuite-sdk/protocol';
import type { Team } from 'csuite-sdk/types';
import { type DatabaseSyncInstance, openDatabase } from './db.js';
import { encryptField, KekResolutionError, resolveKek } from './kek.js';
import { logger } from './logger.js';
import {
  ConfigNotFoundError,
  defaultConfigPath,
  defaultHttpsConfig,
  generateMemberToken,
  getKek,
  type HttpsConfig,
  MemberLoadError,
  type MemberStore,
  setKek,
} from './members.js';
import { type ListenInfo, runServer } from './run.js';
import {
  loadServerConfigFromFile,
  resolveConfigPath,
  type ServerConfig,
  writeServerConfigFile,
} from './server-config.js';
import { openTeamAndMembers } from './team-store.js';
import { TokenStore } from './tokens.js';
import { createTtyWizardIO, runFirstRunWizard, type WizardResult } from './wizard.js';

const USAGE = `csuite-server

usage:
  csuite-server [--config-path <path>]

options:
  --config-path <path>   path to the server config file
                         (default: ./csuite.json, or $CSUITE_CONFIG_PATH)
  -h, --help             print this message and exit

env:
  ${ENV.port}      TCP port to listen on (default: ${DEFAULT_PORT})
  ${ENV.host}      hostname to bind (default: 127.0.0.1)
  ${ENV.dbPath}    SQLite path (default: ./csuite.db, or 'dbPath' in config)
  ${ENV.configPath}  config file path (overridden by --config-path)
`;

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** Wrap IPv6 addresses in brackets for URL display. */
function formatHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

function parseServerArgs(argv: string[]): { configPath?: string; help: boolean } {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        'config-path': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    });
    return {
      configPath: typeof values['config-path'] === 'string' ? values['config-path'] : undefined,
      help: values.help === true,
    };
  } catch (err) {
    process.stderr.write(`csuite-server: ${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
}

/**
 * Heuristic: if the bind host is neither a loopback nor a literal
 * 0.0.0.0/::, we assume the operator is trying to expose the server
 * on a LAN interface and we want HTTPS. Returns `null` for loopback
 * binds where HTTP is safe, or a non-null string (the LAN IP to use
 * as a SAN) when we should auto-flip to self-signed.
 */
function detectLanIpForSelfSign(host: string): string | null {
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return null;
  if (host === '0.0.0.0' || host === '::') {
    for (const iface of Object.values(networkInterfaces())) {
      for (const entry of iface ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) {
          return entry.address;
        }
      }
    }
    return '';
  }
  return host;
}

/**
 * Try to read the slim server config; if missing, run the wizard.
 * The wizard returns *just* the captured data — actual seeding into
 * the DB happens after we open it (we need the dbPath, which comes
 * from defaults or the wizard's prompts later if we add that prompt).
 */
async function loadOrCreateServerConfig(
  configPath: string,
): Promise<{ config: ServerConfig; wizard: WizardResult | null }> {
  try {
    const config = loadServerConfigFromFile(configPath);
    return { config, wizard: null };
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      const wizard = await runWizardOrFail(configPath);
      // First boot: seed a default ServerConfig. The operator can edit
      // it later for HTTPS, JWT, etc.; the wizard intentionally only
      // captures team identity + admin.
      const config: ServerConfig = {
        dbPath: null,
        activityDbPath: null,
        filesRoot: null,
        https: defaultHttpsConfig(),
        webPush: null,
        jwt: null,
        files: null,
      };
      return { config, wizard };
    }
    if (err instanceof MemberLoadError) {
      process.stderr.write(`csuite-server: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

function installKekOrExit(configPath: string): void {
  try {
    setKek(resolveKek(configPath));
  } catch (err) {
    if (err instanceof KekResolutionError) {
      process.stderr.write(`csuite-server: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

async function runWizardOrFail(configPath: string): Promise<WizardResult> {
  const { io, close } = createTtyWizardIO();
  if (!io.isInteractive) {
    close();
    process.stderr.write(
      `csuite-server: no config file at ${configPath}\n\n` +
        `stdin is not a TTY, so the first-run wizard can't prompt. Run the\n` +
        `server interactively to bootstrap, or seed the database directly\n` +
        `via the API once you have one running.\n`,
    );
    process.exit(1);
  }
  try {
    // The wizard is definitely running now. Make sure the server
    // directory exists (fresh bootstraps default to `./csuite/`;
    // no-op with unchanged permissions when it already does), then
    // mint/read the KEK for the encrypted-at-rest fields the caller
    // seeds from the result.
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
    installKekOrExit(configPath);
    return await runFirstRunWizard({ configPath, io });
  } catch (err) {
    if (err instanceof MemberLoadError) {
      process.stderr.write(`csuite-server: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  } finally {
    close();
  }
}

/**
 * Apply wizard data to a fresh DB: seed permission presets, the team
 * singleton, the admin member, and the admin's bootstrap token.
 * Idempotent on `presets` (PUT semantics) and the team row (upsert);
 * the admin insert will throw if the member already exists, which is
 * the right behavior — we should never overwrite an existing admin.
 */
function seedFromWizard(
  db: DatabaseSyncInstance,
  team: Team,
  members: MemberStore,
  tokens: TokenStore,
  wizard: WizardResult,
): void {
  // The team store was already constructed; we re-import here to keep
  // index.ts independent of the store object in the call graph above.
  // Pull `team` projection out of the wizard, then write it back.
  void team; // already used implicitly by the caller for the banner
  void db;
  // Persist team row + presets first so addMember's permission
  // resolution finds the 'admin' preset.
  const teamStore = members as unknown as { teamStoreRef?: never }; // type guard placeholder
  void teamStore;
  // We rely on the caller to have constructed `members` against the
  // same DB-backed `TeamStore`. This function operates only via the
  // public surface.
  members.addMember({
    name: wizard.admin.name,
    role: wizard.admin.role,
    instructions: wizard.admin.instructions,
    rawPermissions: wizard.admin.rawPermissions,
    permissions: wizard.admin.permissions,
    totpSecret: wizard.admin.totpSecret,
  });
  tokens.insert({
    memberName: wizard.admin.name,
    rawToken: wizard.admin.token,
    label: 'wizard',
    origin: 'bootstrap',
    createdBy: null,
  });
}

async function main(): Promise<void> {
  const args = parseServerArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const port = Number(readEnv(ENV.port) ?? String(DEFAULT_PORT));
  if (Number.isNaN(port) || port < 1 || port > 65_535) {
    process.stderr.write(`csuite-server: invalid ${ENV.port}: ${readEnv(ENV.port)}\n`);
    process.exit(1);
  }

  const host = readEnv(ENV.host) ?? '127.0.0.1';
  const configPath = args.configPath ?? defaultConfigPath();

  // KEK is process-wide; install before any read/write so encrypted
  // VAPID + TOTP roundtrip cleanly. Deferred when no config file
  // exists yet: `resolveKek` mints `csuite-kek.bin` on first use, and
  // a boot that bails at the wizard gate (non-TTY stdin) must not
  // leave a stray key file in an otherwise-untouched directory. The
  // wizard path installs the KEK right after that gate instead.
  if (existsSync(configPath)) {
    installKekOrExit(configPath);
  }

  const { config: serverConfig, wizard } = await loadOrCreateServerConfig(configPath);

  // dbPath precedence: env override > config file > default.
  // Relative paths in the config file resolve against the config
  // file's directory (not the cwd of whoever spawned us) so a config
  // written by `csuite setup` from one cwd works when consumed by the
  // broker from another. Env-provided dbPath is treated as
  // operator-explicit and used verbatim.
  const dbPath =
    readEnv(ENV.dbPath) ??
    resolveConfigPath(configPath, serverConfig.dbPath) ??
    join(dirname(configPath), 'csuite.db');

  // Open DB + DB-backed team and member stores. The team store
  // creates its tables on construction; the member store reuses them.
  const db = openDatabase(dbPath);
  const stores = openTeamAndMembers(db);
  const tokens = new TokenStore(db);

  // First-boot path: wizard ran, DB is fresh — seed it now and write
  // the slim infra-only config file alongside.
  if (wizard !== null) {
    stores.team.setTeam({
      name: wizard.team.name,
      context: wizard.team.context,
    });
    for (const [name, leaves] of Object.entries(wizard.team.permissionPresets)) {
      stores.team.setPreset(name, leaves);
    }
    seedFromWizard(db, wizard.team, stores.members, tokens, wizard);
    writeServerConfigFile(configPath, serverConfig);
    process.stdout.write(
      `csuite-server: wrote slim config to ${configPath} and seeded team '${wizard.team.name}' ` +
        `with admin '${wizard.admin.name}' in ${dbPath}\n`,
    );
  }

  // Refuse to continue if the DB is empty AND no wizard ran. This
  // happens when an operator points us at a fresh DB but supplies an
  // existing config file — there's no way to know which side is
  // authoritative, so we surface the mismatch.
  if (!stores.team.hasTeam()) {
    process.stderr.write(
      `csuite-server: no team in ${dbPath} but config file already exists at ${configPath}.\n` +
        `  Either delete ${configPath} to re-run the wizard, or point at a DB that\n` +
        `  has been initialized.\n`,
    );
    db.close();
    process.exit(1);
  }

  const team: Team = stores.team.getTeam();

  // Auto-flip HTTPS to self-signed when binding non-loopback. Operator
  // can override by setting https.mode explicitly in the config file.
  let https: HttpsConfig = serverConfig.https ?? defaultHttpsConfig();
  if (https.mode === 'off') {
    const lanIp = detectLanIpForSelfSign(host);
    if (lanIp !== null) {
      https = {
        ...https,
        mode: 'self-signed',
        selfSigned: { ...https.selfSigned, lanIp: lanIp || https.selfSigned.lanIp },
      };
      process.stdout.write(
        `csuite-server: host ${host} is non-loopback, auto-enabling self-signed HTTPS. ` +
          `Set \`https.mode\` in ${configPath} to override.\n`,
      );
    }
  }

  // Close our handle on the DB before runServer opens it; runServer
  // currently opens its own handle. (`node:sqlite` is one-handle-per-
  // file, so we can't share.) The team/member stores hold prepared
  // statements against this handle, but we'll re-open them on the
  // shared handle inside runServer.
  db.close();

  const running = await runServer({
    https,
    webPush: serverConfig.webPush,
    jwt: serverConfig.jwt,
    configPath,
    configDir: dirname(configPath),
    port,
    host,
    dbPath,
    onListen: (info: ListenInfo) => {
      const url = `${info.protocol}://${formatHost(info.address)}:${info.port}`;
      const lines: string[] = [`csuite-server listening on ${url}`];
      if (info.protocol === 'https' && info.cert) {
        lines.push(`  cert:    ${info.cert.source}`);
        if (info.cert.certPath) {
          lines.push(`  cert@:   ${info.cert.certPath}`);
        }
        if (info.cert.expiresAt) {
          lines.push(`  expires: ${new Date(info.cert.expiresAt).toISOString()}`);
        }
        if (info.redirectHttpPort !== undefined) {
          lines.push(`  redirect: http on :${info.redirectHttpPort} → 308 → ${url}`);
        }
      }
      lines.push(
        `  team:      ${team.name}`,
        `  config:    ${configPath}`,
        `  db:        ${dbPath}`,
      );
      process.stdout.write(`${lines.join('\n')}\n`);
    },
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info('shutting down', { signal });
    await running.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // `encryptField` is imported only to keep VAPID auto-gen path usable
  // for downstream consumers; surface as an unused-import suppression.
  void encryptField;
  void getKek;
  void generateMemberToken;
}

main().catch((err) => {
  process.stderr.write(
    `csuite-server: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
