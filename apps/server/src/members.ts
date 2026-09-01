/**
 * Team config loading for the csuite server.
 *
 * The member model carries a name, a role (title + description),
 * explicit permission leaves, personal instructions, and a hashed
 * bearer token. Humans vs
 * agents is not a first-class distinction — members are just
 * members, and TOTP enrollment is optional for anyone.
 *
 * On disk the config stores SHA-256 hashes, not plaintext secrets.
 * Humans editing the file by hand can paste a plaintext `token`; the
 * server will hash it on next boot and rewrite the file. A broker
 * compromise via read-only disk access therefore leaks hashes, not
 * the original tokens.
 *
 * Config file format (JSON):
 *
 *   {
 *     "_comment": "...",
 *     "team": {
 *       "name": "demo-team",
 *       "context": "Ship the payment service. We own the full lifecycle..."
 *     },
 *     "members": [
 *       { "name": "member-1",  "role": { "title": "member", "description": "Coordinates the team." },
 *         "instructions": "Approve objectives before they go to the team.",
 *         "permissions": ["team.manage", "members.manage", "objectives.create", "objectives.cancel", "objectives.reassign", "objectives.watch"],
 *         "tokenHash": "sha256:..." },
 *       { "name": "engineer-1", "role": { "title": "engineer", "description": "Ships code." },
 *         "instructions": "", "permissions": [],
 *         "token": "csuite_plaintext_for_migration" }
 *     ]
 *   }
 *
 * Current writes accept leaf permission strings. The database reader
 * still resolves preset-era rows so upgrades do not strand members.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AddMemberInput,
  type LoadedMember,
  MemberLoadError,
  type MemberStore,
  type UpdateMemberPatch,
} from 'csuite-core';
import type { Permission, Role } from 'csuite-sdk/types';
import { z } from 'zod';

export {
  type AddMemberInput,
  type LoadedMember,
  MemberLoadError,
  type MemberStore,
  resolvePermissions,
  teammatesFromMembers,
  type UpdateMemberPatch,
  validateMemberInstructions,
  validateMemberName,
  validatePermissionPreset,
  validateRawPermissions,
  validateRole,
  validateTeamContext,
  validateTeamName,
  validateTotpSecret,
} from 'csuite-core';

export const TOKEN_HASH_PREFIX = 'sha256:';
const DEFAULT_CONFIG_FILENAME = 'csuite.json';
/** Subdirectory fresh bootstraps seed into. See `defaultConfigPath`. */
export const DEFAULT_SERVER_DIR_NAME = 'csuite';

/**
 * Process-wide KEK for TOTP secret + VAPID private key encryption
 * at rest. Set once at server boot via `setKek` (called from
 * `runServer`), read by the member writers/loaders.
 */
let activeKek: Buffer | null = null;

/**
 * Set the process-wide KEK. Call once during server startup from
 * `runServer`. Passing `null` explicitly disables encryption.
 */
export function setKek(kek: Buffer | null): void {
  activeKek = kek;
}

/** Test-only: read the currently-active KEK (for test setup only). */
export function getKek(): Buffer | null {
  return activeKek;
}

/** Hash a raw bearer token into the on-disk representation. */
export function hashToken(rawToken: string): string {
  return TOKEN_HASH_PREFIX + createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export const SelfSignedConfigSchema = z.object({
  lanIp: z.string().nullable().default(null),
  validityDays: z.number().int().positive().max(3650).default(365),
  regenerateIfExpiringWithin: z.number().int().nonnegative().max(365).default(30),
});

export const CustomHttpsConfigSchema = z.object({
  certPath: z.string().nullable().default(null),
  keyPath: z.string().nullable().default(null),
});

export const WebPushConfigSchema = z.object({
  vapidPublicKey: z.string().min(1),
  vapidPrivateKey: z.string().min(1),
  vapidSubject: z.string().min(1).default('mailto:admin@csuite.local'),
});

export const HttpsConfigSchema = z.object({
  mode: z.enum(['off', 'self-signed', 'custom']).default('off'),
  bindHttp: z.number().int().min(1).max(65535).default(8717),
  bindHttps: z.number().int().min(1).max(65535).default(7443),
  redirectHttpToHttps: z.boolean().default(true),
  hsts: z.enum(['auto', 'on', 'off']).default('auto'),
  selfSigned: SelfSignedConfigSchema.default({
    lanIp: null,
    validityDays: 365,
    regenerateIfExpiringWithin: 30,
  }),
  custom: CustomHttpsConfigSchema.default({ certPath: null, keyPath: null }),
});

export const FilesConfigSchema = z.object({
  root: z.string().min(1).optional(),
  maxFileSize: z.number().int().positive().optional(),
});

class MapMemberStore implements MemberStore {
  private readonly byHash = new Map<string, LoadedMember>();
  private readonly byName = new Map<string, LoadedMember>();
  private readonly order: LoadedMember[] = [];

  addHashed(tokenHash: string, member: LoadedMember): void {
    if (this.byHash.has(tokenHash)) {
      throw new MemberLoadError(`duplicate token detected for member '${member.name}'`);
    }
    if (this.byName.has(member.name)) {
      throw new MemberLoadError(`duplicate name '${member.name}'`);
    }
    this.byHash.set(tokenHash, member);
    this.byName.set(member.name, member);
    this.order.push(member);
  }

  findByName(name: string): LoadedMember | null {
    const member = this.byName.get(name);
    return member?.state === 'departed' ? null : (member ?? null);
  }

  findAnyByName(name: string): LoadedMember | null {
    return this.byName.get(name) ?? null;
  }

  tokenHashOf(name: string): string | null {
    const member = this.byName.get(name);
    if (!member) return null;
    for (const [h, m] of this.byHash) {
      if (m === member) return h;
    }
    return null;
  }

  recordTotpAccept(name: string, counter: number): LoadedMember | null {
    const member = this.byName.get(name);
    if (!member) return null;
    member.totpLastCounter = counter;
    return member;
  }

  size(): number {
    return this.members().length;
  }

  members(): LoadedMember[] {
    return this.order.filter((member) => member.state !== 'departed');
  }

  allMembers(): LoadedMember[] {
    return [...this.order];
  }

  names(): string[] {
    return this.members().map((m) => m.name);
  }

  addMember(input: AddMemberInput): LoadedMember {
    if (input.token === undefined) {
      throw new MemberLoadError(
        'MapMemberStore.addMember: legacy file-backed store requires `token` — use the DB-backed SqliteMemberStore for tokenless adds',
      );
    }
    const tokenHash = hashToken(input.token);
    const member: LoadedMember = {
      identityId: globalThis.crypto.randomUUID(),
      name: input.name,
      state: 'active',
      role: input.role,
      instructions: input.instructions,
      permissions: input.permissions,
      rawPermissions: input.rawPermissions,
      totpSecret: input.totpSecret ?? null,
      totpLastCounter: 0,
    };
    this.addHashed(tokenHash, member);
    return member;
  }

  removeMember(name: string): void {
    const member = this.byName.get(name);
    if (!member) throw new MemberLoadError(`no such member: '${name}'`);
    let hashToDrop: string | null = null;
    for (const [h, m] of this.byHash) {
      if (m === member) {
        hashToDrop = h;
        break;
      }
    }
    if (hashToDrop !== null) this.byHash.delete(hashToDrop);
    this.byName.delete(name);
    const idx = this.order.indexOf(member);
    if (idx !== -1) this.order.splice(idx, 1);
  }

  departMember(name: string, actor: string, at = Date.now()): LoadedMember {
    const member = this.findByName(name);
    if (!member) throw new MemberLoadError(`no such active member: '${name}'`);
    for (const [hash, candidate] of this.byHash) {
      if (candidate === member) this.byHash.delete(hash);
    }
    member.state = 'departed';
    member.departedAt = at;
    member.departedBy = actor;
    return member;
  }

  updateMember(name: string, patch: UpdateMemberPatch): LoadedMember {
    const member = this.byName.get(name);
    if (!member) throw new MemberLoadError(`no such member: '${name}'`);
    if (patch.role !== undefined) member.role = patch.role;
    if (patch.instructions !== undefined) member.instructions = patch.instructions;
    if (patch.permissions !== undefined) member.permissions = patch.permissions;
    if (patch.rawPermissions !== undefined) member.rawPermissions = patch.rawPermissions;
    return member;
  }

  setTotpSecret(name: string, secret: string | null): LoadedMember {
    const member = this.byName.get(name);
    if (!member) throw new MemberLoadError(`no such member: '${name}'`);
    member.totpSecret = secret;
    member.totpLastCounter = 0;
    return member;
  }
}

/**
 * Build a member store programmatically from plaintext entries. Used
 * by tests and alternate runtimes. Tokens are hashed before storage.
 */

/**
 * Federated JWT config. When present, the auth middleware verifies
 * bearer tokens with JWT structure against the issuer's JWKS and
 * resolves the `member` claim to a LoadedMember by name. Absent →
 * the JWT path stays dormant and only opaque tokens + session
 * cookies work. See `src/jwt.ts` for the claim contract.
 */
export const JwtConfigSchema = z.object({
  issuer: z.string().url(),
  jwksUrl: z.string().url(),
  audience: z.string().min(1),
});

export type HttpsConfig = z.infer<typeof HttpsConfigSchema>;
export type WebPushConfig = z.infer<typeof WebPushConfigSchema>;
export type FilesConfig = z.infer<typeof FilesConfigSchema>;
export type JwtConfig = z.infer<typeof JwtConfigSchema>;

// ───────────────────────── Imperative validators ──────────────────────
//
// Narrow, composable validators around the same Zod schemas above.
// Used by the DB-backed mutation path (team-store.ts) so direct
// API/CLI/MCP writes hit the same caps as the legacy file loader,
// without round-tripping through the whole `ServerConfigSchema`.
// Each helper throws `MemberLoadError` on the first failure.

export class ConfigNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`no config file at ${path}`);
    this.name = 'ConfigNotFoundError';
    this.path = path;
  }
}

export function createMemberStore(
  entries: Array<{
    name: string;
    role: Role;
    instructions?: string;
    rawPermissions?: string[];
    permissions: Permission[];
    token: string;
    totpSecret?: string | null;
    totpLastCounter?: number;
  }>,
): MemberStore {
  if (entries.length === 0) {
    throw new MemberLoadError('createMemberStore: at least one entry is required');
  }
  const store = new MapMemberStore();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new MemberLoadError(`duplicate name '${entry.name}'`);
    }
    seen.add(entry.name);
    store.addHashed(hashToken(entry.token), {
      name: entry.name,
      role: entry.role,
      instructions: entry.instructions ?? '',
      permissions: entry.permissions,
      rawPermissions: entry.rawPermissions ?? entry.permissions,
      totpSecret: entry.totpSecret ?? null,
      totpLastCounter: entry.totpLastCounter ?? 0,
    });
  }
  return store;
}

/**
 * Resolve where the config file lives (or should be created).
 *
 * Order:
 *   1. `$CSUITE_CONFIG_PATH` — operator-explicit, used verbatim.
 *   2. `./csuite.json` — the cwd IS the server directory. Covers
 *      flat legacy deployments and running from inside the server
 *      dir; because this wins over rule 3, bootstrapping from inside
 *      an existing server dir can never nest another one.
 *   3. `./csuite/csuite.json` — otherwise. When it doesn't exist yet
 *      this is the bootstrap target: the wizard paths create the
 *      `csuite/` subdirectory (0o700) and seed config + DB + KEK
 *      inside it, keeping the caller's cwd pristine.
 */
export function defaultConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const explicit = env.CSUITE_CONFIG_PATH;
  if (explicit && explicit.length > 0) return explicit;
  const flat = join(cwd, DEFAULT_CONFIG_FILENAME);
  if (existsSync(flat)) return flat;
  return join(cwd, DEFAULT_SERVER_DIR_NAME, DEFAULT_CONFIG_FILENAME);
}

export function defaultHttpsConfig(): HttpsConfig {
  return {
    mode: 'off',
    bindHttp: 8717,
    bindHttps: 7443,
    redirectHttpToHttps: true,
    hsts: 'auto',
    selfSigned: {
      lanIp: null,
      validityDays: 365,
      regenerateIfExpiringWithin: 30,
    },
    custom: {
      certPath: null,
      keyPath: null,
    },
  };
}

/**
 * Resolve the platform-overlay path sibling to the primary config.
 *
 *   /etc/csuite/config.json   → /etc/csuite/config.platform.json
 *   /etc/csuite/team.json     → /etc/csuite/team.platform.json
 *   /etc/csuite/csuite           → /etc/csuite/csuite.platform.json
 */
export function platformOverlayPathFor(configPath: string): string {
  const dotJson = /\.json$/i;
  if (dotJson.test(configPath)) {
    return configPath.replace(dotJson, '.platform.json');
  }
  return `${configPath}.platform.json`;
}

/**
 * Generate a fresh cryptorandom bearer token in the standard
 * `csuite_<base64url>` format. 32 raw bytes → 43-char payload (~256 bits).
 */
export function generateMemberToken(): string {
  return `csuite_${randomBytes(32).toString('base64url')}`;
}
