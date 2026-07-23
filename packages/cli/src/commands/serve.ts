/**
 * `csuite serve` — start a local csuite broker.
 *
 * Thin launcher. `csuite-server` is an *optional* peer dependency
 * of the CLI so users who only ever push events don't drag in Hono,
 * node:sqlite, and the MCP server SDK. When the user invokes `csuite
 * serve`, we dynamically import the server at runtime. If it isn't
 * installed, we exit with a friendly hint.
 *
 * Boot path:
 *   1. Resolve the slim infra-only config file path.
 *   2. Resolve + install the KEK so encrypted-at-rest fields
 *      (TOTP secrets, VAPID private key) round-trip.
 *   3. Load the slim ServerConfig, or run the wizard if missing
 *      (TTY required) and seed the DB inline.
 *   4. Hand off to `runServer`, which opens the DB-backed team and
 *      member stores from `dbPath` and refuses to boot if the team
 *      singleton is missing.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_PORT, ENV } from 'csuite-sdk/protocol';

// Type-only import: compiles away, never loaded at runtime.
import type { RunningServer, RunServerOptions, ServerConfig } from 'csuite-server';
import { UsageError } from './errors.js';

export { UsageError };

export interface ServeCommandInput {
  configPath?: string;
  port?: number;
  host?: string;
  dbPath?: string;
}

/**
 * Translate `csuite serve` inputs + a loaded ServerConfig into the
 * options bag that `runServer` expects. Pure — no I/O — so the seam
 * between the CLI and the server is unit-testable.
 *
 * `configPath` and `configDir` matter because runServer rewrites the
 * file when it auto-generates VAPID keys on first boot. `dbPath`
 * precedence: CLI arg > env var > config file > default `./csuite.db`.
 */
export function buildServeRunOptions(args: {
  config: ServerConfig;
  configPath: string;
  port: number;
  host: string;
  dbPath: string;
  onListen: RunServerOptions['onListen'];
}): RunServerOptions {
  return {
    ...(args.config.https !== null ? { https: args.config.https } : {}),
    ...(args.config.webPush !== null ? { webPush: args.config.webPush } : {}),
    ...(args.config.jwt !== null ? { jwt: args.config.jwt } : {}),
    configPath: args.configPath,
    configDir: dirname(args.configPath),
    port: args.port,
    host: args.host,
    dbPath: args.dbPath,
    ...(args.config.files?.root !== undefined ? { filesRoot: args.config.files.root } : {}),
    ...(args.config.files?.maxFileSize !== undefined
      ? { maxFileSize: args.config.files.maxFileSize }
      : {}),
    onListen: args.onListen,
  };
}

export async function runServeCommand(
  input: ServeCommandInput,
  stdout: (line: string) => void,
): Promise<RunningServer> {
  const port = input.port ?? Number(process.env[ENV.port] ?? String(DEFAULT_PORT));
  if (Number.isNaN(port) || port < 1 || port > 65_535) {
    throw new UsageError(`serve: invalid port ${port}`);
  }
  const host = input.host ?? process.env[ENV.host] ?? '127.0.0.1';

  const server = await loadServerModule();
  const configPath = input.configPath ?? process.env[ENV.configPath] ?? server.defaultConfigPath();

  // KEK before any read/write so encrypted-at-rest fields round-trip.
  // Deferred when no config file exists yet: `resolveKek` mints
  // `csuite-kek.bin` on first use, and a boot that bails at the wizard
  // gate (non-TTY stdin) must not leave a stray key file in an
  // otherwise-untouched directory. The wizard path installs the KEK
  // right after that gate instead.
  if (existsSync(configPath)) {
    installKek(server, configPath);
  }

  const { config, freshlySeeded } = await loadOrCreateServerConfig(server, configPath, stdout);
  // Relative paths in the config resolve against the config file's
  // directory, not the caller's cwd. CLI/env overrides are treated
  // as operator-explicit and used verbatim.
  const dbPath =
    input.dbPath ??
    process.env[ENV.dbPath] ??
    server.resolveConfigPath(configPath, config.dbPath) ??
    join(dirname(configPath), 'csuite.db');

  if (freshlySeeded) {
    stdout(`csuite serve: bootstrapped ${configPath} with team data in ${dbPath}`);
  }

  const running = await server.runServer(
    buildServeRunOptions({
      config,
      configPath,
      port,
      host,
      dbPath,
      onListen: (info) => {
        stdout(
          `csuite-server listening on ${info.protocol}://${info.address}:${info.port}\n` +
            `  config:    ${configPath}\n` +
            `  db:        ${dbPath}`,
        );
      },
    }),
  );

  return running;
}

async function loadOrCreateServerConfig(
  server: typeof import('csuite-server'),
  configPath: string,
  _stdout: (line: string) => void,
): Promise<{ config: ServerConfig; freshlySeeded: boolean }> {
  try {
    return { config: server.loadServerConfigFromFile(configPath), freshlySeeded: false };
  } catch (err) {
    if (err instanceof server.ConfigNotFoundError) {
      const config = await runWizardOrFail(server, configPath);
      return { config, freshlySeeded: true };
    }
    if (err instanceof server.MemberLoadError) {
      throw new UsageError(`serve: ${err.message}`);
    }
    throw err;
  }
}

/**
 * No config file — run the wizard, seed the freshly-opened DB with
 * the captured team + admin, write the slim ServerConfig file, and
 * return the in-memory config so the caller can hand it to runServer.
 */
async function runWizardOrFail(
  server: typeof import('csuite-server'),
  configPath: string,
): Promise<ServerConfig> {
  const { io, close } = server.createTtyWizardIO();
  if (!io.isInteractive) {
    close();
    throw new UsageError(
      `serve: no config file at ${configPath}\n` +
        '  stdin is not a TTY, so the first-run wizard cannot prompt.\n' +
        '  Run `csuite setup` interactively to create one, or seed the DB\n' +
        '  via the API once you have one running.',
    );
  }
  try {
    // The wizard is definitely running now. Make sure the server
    // directory exists (fresh bootstraps default to `./csuite/`;
    // no-op with unchanged permissions when it already does), then
    // mint/read the KEK for the encrypted-at-rest seed writes below.
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
    installKek(server, configPath);

    const wizard = await server.runFirstRunWizard({ configPath, io });
    // Seed the DB next to the config file so the path round-trips
    // through `resolveConfigPath` regardless of caller cwd.
    const dbPath = join(dirname(configPath), 'csuite.db');
    const db = server.openDatabase(dbPath);
    try {
      const stores = server.openTeamAndMembers(db);
      stores.team.setTeam({
        name: wizard.team.name,
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
    // Store the dbPath relative to the config file so the file stays
    // portable; consumers anchor it via `resolveConfigPath` on read.
    const config: ServerConfig = {
      dbPath: './csuite.db',
      activityDbPath: null,
      filesRoot: null,
      https: server.defaultHttpsConfig(),
      webPush: null,
      jwt: null,
      files: null,
    };
    server.writeServerConfigFile(configPath, config);
    return config;
  } catch (err) {
    if (err instanceof server.MemberLoadError) {
      throw new UsageError(`serve: ${err.message}`);
    }
    throw err;
  } finally {
    close();
  }
}

function installKek(server: typeof import('csuite-server'), configPath: string): void {
  try {
    server.setKek(server.resolveKek(configPath));
  } catch (err) {
    if (err instanceof server.KekResolutionError) {
      throw new UsageError(`serve: ${err.message}`);
    }
    throw err;
  }
}

async function loadServerModule(): Promise<typeof import('csuite-server')> {
  try {
    return await import('csuite-server');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new UsageError(
        'serve: csuite-server is not installed.\n' +
          '  This command needs the broker package. Install it alongside the CLI:\n' +
          '    npm install -g csuite-server\n' +
          '  Or install the full ecosystem in one step:\n' +
          '    npm install -g csuite',
      );
    }
    throw err;
  }
}
