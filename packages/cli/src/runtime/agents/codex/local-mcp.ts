import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface LocalMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  enabled: boolean;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
}

export interface LocalMcpConfig {
  path: string;
  servers: Record<string, LocalMcpServer>;
}

export class LocalMcpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalMcpConfigError';
  }
}

export function defaultLocalMcpConfigPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'csuite',
    'codex',
    'mcp-servers.json',
  );
}

export function loadLocalMcpConfig(
  options: { path?: string; realCodexHome?: string } = {},
): LocalMcpConfig {
  const path = resolve(options.path ?? defaultLocalMcpConfigPath());
  const realCodexHome = options.realCodexHome ?? join(homedir(), '.codex');
  refuseLegacyMcpConfig(realCodexHome, path);
  if (!existsSync(path)) return { path, servers: {} };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new LocalMcpConfigError(
      `invalid Codex local MCP config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const root = record(raw, path);
  exactKeys(root, ['version', 'servers'], path);
  if (root.version !== 1) {
    throw new LocalMcpConfigError(`${path}: version must be exactly 1`);
  }
  const configured = record(root.servers, `${path}: servers`);
  const servers: Record<string, LocalMcpServer> = {};
  for (const [name, value] of Object.entries(configured)) {
    if (name === 'csuite') {
      throw new LocalMcpConfigError(
        `${path}: server name "csuite" is reserved for the runner-managed bridge`,
      );
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new LocalMcpConfigError(
        `${path}: server name ${JSON.stringify(name)} must contain only letters, digits, _ or -`,
      );
    }
    const entry = record(value, `${path}: servers.${name}`);
    exactKeys(
      entry,
      ['command', 'args', 'env', 'cwd', 'enabled', 'startupTimeoutSec', 'toolTimeoutSec'],
      `${path}: servers.${name}`,
    );
    const command = requiredString(entry.command, `${path}: servers.${name}.command`);
    const args = stringArray(entry.args ?? [], `${path}: servers.${name}.args`);
    const env = stringRecord(entry.env ?? {}, `${path}: servers.${name}.env`);
    const cwd = optionalString(entry.cwd, `${path}: servers.${name}.cwd`);
    if (cwd !== undefined && !isAbsolute(cwd)) {
      throw new LocalMcpConfigError(`${path}: servers.${name}.cwd must be an absolute path`);
    }
    servers[name] = {
      command,
      args,
      env,
      ...(cwd !== undefined ? { cwd } : {}),
      enabled: optionalBoolean(entry.enabled, `${path}: servers.${name}.enabled`) ?? true,
      ...optionalPositiveNumber(
        entry.startupTimeoutSec,
        `${path}: servers.${name}.startupTimeoutSec`,
        'startupTimeoutSec',
      ),
      ...optionalPositiveNumber(
        entry.toolTimeoutSec,
        `${path}: servers.${name}.toolTimeoutSec`,
        'toolTimeoutSec',
      ),
    };
  }
  return { path, servers };
}

export function assertNoReservedMcpOverride(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const candidate = arg === '-c' || arg === '--config' ? args[i + 1] : undefined;
    if (candidate === undefined) continue;
    const key = candidate.split('=', 1)[0]?.trim() ?? '';
    const normalized = key.replace(/["']/g, '').replace(/\s+/g, '').toLowerCase();
    if (
      normalized === 'mcp_servers' ||
      normalized === 'mcp_servers.csuite' ||
      normalized.startsWith('mcp_servers.csuite.')
    ) {
      throw new LocalMcpConfigError(
        'Codex config overrides for mcp_servers.csuite are refused: ' +
          'the csuite MCP bridge is runner-managed and cannot be replaced',
      );
    }
    i++;
  }
}

function refuseLegacyMcpConfig(realCodexHome: string, supportedPath: string): void {
  const legacyPath = join(realCodexHome, 'config.toml');
  if (!existsSync(legacyPath)) return;
  let text: string;
  try {
    text = readFileSync(legacyPath, 'utf8');
  } catch (err) {
    throw new LocalMcpConfigError(
      `could not inspect ${legacyPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (/^\s*\[\s*mcp_servers(?:\s*\.|\s*\])/m.test(text)) {
    throw new LocalMcpConfigError(
      `MCP servers in ${legacyPath} are outside csuite codex's ephemeral CODEX_HOME and will not be loaded. ` +
        `Move them to ${supportedPath}; see docs/runners/codex.`,
    );
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LocalMcpConfigError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new LocalMcpConfigError(`${label} has unknown field ${JSON.stringify(unknown[0])}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LocalMcpConfigError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new LocalMcpConfigError(`${label} must be a boolean`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new LocalMcpConfigError(`${label} must be an array of strings`);
  }
  return [...value];
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const source = record(value, label);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new LocalMcpConfigError(
        `${label} key ${JSON.stringify(key)} must be an environment variable name`,
      );
    }
    if (typeof item !== 'string') {
      throw new LocalMcpConfigError(`${label}.${key} must be a string`);
    }
    result[key] = item;
  }
  return result;
}

function optionalPositiveNumber(
  value: unknown,
  label: string,
  key: 'startupTimeoutSec' | 'toolTimeoutSec',
): Partial<Pick<LocalMcpServer, 'startupTimeoutSec' | 'toolTimeoutSec'>> {
  if (value === undefined) return {};
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new LocalMcpConfigError(`${label} must be a positive number`);
  }
  return { [key]: value };
}
