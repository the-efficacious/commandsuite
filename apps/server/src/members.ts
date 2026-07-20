/**
 * Team config loading for the csuite server.
 *
 * A team config defines the directive, the permission presets, and
 * the members that make up the team. Each member carries a name, a
 * role (title + description), per-member permissions (preset name or
 * leaf), personal instructions, and a hashed bearer token. Humans vs
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
 *       "directive": "Ship the payment service.",
 *       "context": "We own the full lifecycle...",
 *       "permissionPresets": {
 *         "admin":    ["team.manage", "members.manage", "objectives.create", "objectives.cancel", "objectives.reassign", "objectives.watch", "activity.read"],
 *         "operator": ["objectives.create", "objectives.cancel", "objectives.reassign"]
 *       }
 *     },
 *     "members": [
 *       { "name": "director-1",  "role": { "title": "director", "description": "Leads the team." },
 *         "instructions": "Approve objectives before they go to the team.",
 *         "permissions": ["admin"],
 *         "tokenHash": "sha256:..." },
 *       { "name": "engineer-1", "role": { "title": "engineer", "description": "Ships code." },
 *         "instructions": "", "permissions": [],
 *         "token": "csuite_plaintext_for_migration" }
 *     ]
 *   }
 *
 * `permissions` entries may be preset names (resolved via the team's
 * `permissionPresets`) or leaf permission strings; the server
 * validates each entry resolves.
 */

import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Member, Permission, Role, Teammate } from 'csuite-sdk/types';
import { PERMISSIONS } from 'csuite-sdk/types';
import { z } from 'zod';

export const TOKEN_HASH_PREFIX = 'sha256:';
const DEFAULT_CONFIG_FILENAME = 'csuite.json';

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

/**
 * A member materialized in memory once hashes are known. Extends the
 * wire `Member` with server-only fields — TOTP enrollment and replay
 * guard state, plus the raw (unresolved) permissions list so we can
 * round-trip preset references to disk without expanding them.
 */
export interface LoadedMember extends Member {
  /** Preset names + leaf permissions as written on disk; preserved for round-tripping. */
  rawPermissions: string[];
  totpSecret?: string | null;
  totpLastCounter?: number;
}

const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
const PRESET_KEY_REGEX = /^[a-zA-Z0-9._-]+$/;

// Base32 alphabet (RFC 4648) — plaintext TOTP secrets from `otpauth` use this.
// When at-rest encryption is enabled, the stored value instead has the
// `enc-v1:<iv>:<tag>:<ct>` shape emitted by `encryptField` — all
// base64url segments. Either form passes zod validation here; the
// loader (after zod) uses the `enc-v1:` prefix to decide whether to
// decrypt or treat as legacy plaintext.
const TOTP_SECRET_REGEX = /^(?:[A-Z2-7]+=*|enc-v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+)$/;

const PermissionLeafSchema = z.enum(PERMISSIONS);

// ─────────────── Per-field schemas (single source of truth) ───────────
//
// Surfaced both to the composite `TeamConfigSchema` (file loader) and
// to the imperative validators below (DB-backed mutators). Keeping
// them as named top-level constants means the caps live in exactly
// one place.

const TeamNameSchema = z.string().min(1).max(128);
const TeamDirectiveSchema = z.string().min(1).max(512);
const TeamContextSchema = z.string().max(4096).default('');
const MemberNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(NAME_REGEX, 'name must be alphanumeric with . _ - allowed');
const InstructionsSchema = z.string().max(8192).default('');
const RawPermissionsSchema = z.array(z.string().min(1).max(64)).max(32).default([]);
const TotpSecretSchema = z
  .string()
  .min(16, 'totpSecret must be at least 16 base32 characters')
  .max(128)
  .regex(TOTP_SECRET_REGEX, 'totpSecret must be a base32-encoded string');
const PresetNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(PRESET_KEY_REGEX, 'preset name must be alphanumeric with . _ - allowed');
const PresetLeavesSchema = z.array(PermissionLeafSchema).max(32);

const RoleSchema = z.object({
  title: z.string().min(1).max(64),
  description: z.string().max(512).default(''),
});

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
// without round-tripping through the whole `TeamConfigSchema`.
// Each helper throws `MemberLoadError` on the first failure.

function failFromZod(prefix: string, err: unknown): never {
  if (err instanceof z.ZodError) {
    throw new MemberLoadError(`${prefix}: ${err.issues.map((i) => i.message).join('; ')}`);
  }
  throw err;
}

export function validateTeamName(name: string): void {
  try {
    TeamNameSchema.parse(name);
  } catch (err) {
    failFromZod('team.name', err);
  }
}
export function validateTeamDirective(directive: string): void {
  try {
    TeamDirectiveSchema.parse(directive);
  } catch (err) {
    failFromZod('team.directive', err);
  }
}
export function validateTeamContext(context: string): void {
  try {
    TeamContextSchema.parse(context);
  } catch (err) {
    failFromZod('team.context', err);
  }
}
export function validateMemberName(name: string): void {
  try {
    MemberNameSchema.parse(name);
  } catch (err) {
    failFromZod('member.name', err);
  }
}
export function validateRole(role: Role): void {
  try {
    RoleSchema.parse(role);
  } catch (err) {
    failFromZod('member.role', err);
  }
}
export function validateMemberInstructions(instructions: string): void {
  try {
    InstructionsSchema.parse(instructions);
  } catch (err) {
    failFromZod('member.instructions', err);
  }
}
export function validateRawPermissions(raw: readonly string[]): void {
  try {
    RawPermissionsSchema.parse(raw);
  } catch (err) {
    failFromZod('member.permissions', err);
  }
}
export function validateTotpSecret(secret: string): void {
  try {
    TotpSecretSchema.parse(secret);
  } catch (err) {
    failFromZod('totpSecret', err);
  }
}
export function validatePermissionPreset(name: string, leaves: readonly Permission[]): void {
  try {
    PresetNameSchema.parse(name);
  } catch (err) {
    failFromZod(`preset '${name}'`, err);
  }
  try {
    PresetLeavesSchema.parse(leaves);
  } catch (err) {
    failFromZod(`preset '${name}'.permissions`, err);
  }
}

export class MemberLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberLoadError';
  }
}

export class ConfigNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`no config file at ${path}`);
    this.name = 'ConfigNotFoundError';
    this.path = path;
  }
}

/**
 * Expand a raw permissions list (preset names + leaves) against the
 * team's permission presets into a flat, deduplicated array of leaf
 * permissions. Unknown names throw `MemberLoadError` with the
 * offending entry called out.
 */
export function resolvePermissions(
  raw: readonly string[],
  presets: Record<string, Permission[]>,
  context: string,
): Permission[] {
  const set = new Set<Permission>();
  for (const entry of raw) {
    if ((PERMISSIONS as readonly string[]).includes(entry)) {
      set.add(entry as Permission);
      continue;
    }
    const presetLeaves = presets[entry];
    if (presetLeaves) {
      for (const leaf of presetLeaves) set.add(leaf);
      continue;
    }
    throw new MemberLoadError(
      `${context}: unknown permission or preset '${entry}'. ` +
        `Valid leaves: ${PERMISSIONS.join(', ')}. ` +
        `Presets: ${Object.keys(presets).join(', ') || '(none)'}.`,
    );
  }
  // Preserve canonical leaf ordering so outputs are stable.
  return PERMISSIONS.filter((p) => set.has(p));
}

/** Input to `MemberStore.addMember`. */
export interface AddMemberInput {
  name: string;
  role: Role;
  instructions: string;
  /** Raw form — preset names or leaf permissions. Resolved by caller. */
  rawPermissions: string[];
  /** Resolved leaf permissions (derived from `rawPermissions` + presets). */
  permissions: Permission[];
  /**
   * Plaintext bearer token for the legacy in-memory store. The
   * DB-backed store does NOT issue tokens — caller composes a separate
   * `TokenStore.insert(...)` after `addMember` returns. Optional so
   * the new path doesn't need to fabricate a placeholder.
   */
  token?: string;
  totpSecret?: string | null;
}

/** Patch for `MemberStore.updateMember` — any subset of fields may be omitted. */
export interface UpdateMemberPatch {
  role?: Role;
  instructions?: string;
  rawPermissions?: string[];
  permissions?: Permission[];
}

export interface MemberStore {
  // Read surface
  findByName(name: string): LoadedMember | null;
  /**
   * Return the on-disk token hash for `name`, or null if the store
   * doesn't track one. Only the in-memory `MapMemberStore` (used by
   * test fixtures) returns a non-null value; the DB-backed store
   * returns null since auth tokens live in the `tokens` table.
   */
  tokenHashOf?(name: string): string | null;
  recordTotpAccept(name: string, counter: number): LoadedMember | null;
  size(): number;
  /** Snapshot of every member in insertion order. */
  members(): LoadedMember[];
  names(): string[];
  /** True iff at least one member has the `members.manage` permission. */
  hasAdmin(): boolean;

  // Mutation surface — each method mutates store state atomically and
  // throws `MemberLoadError` on validation failure without leaving
  // partial state. The DB-backed store persists immediately; the
  // in-memory MapMemberStore (test fixture) holds state in process
  // memory only.
  addMember(input: AddMemberInput): LoadedMember;
  removeMember(name: string): void;
  updateMember(name: string, patch: UpdateMemberPatch): LoadedMember;
  /**
   * Replace a member's TOTP secret. Pass `null` to clear the
   * enrollment. Resets `totpLastCounter` to 0.
   */
  setTotpSecret(name: string, secret: string | null): LoadedMember;
}

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
    return this.byHash.size;
  }

  members(): LoadedMember[] {
    return [...this.order];
  }

  names(): string[] {
    return this.order.map((m) => m.name);
  }

  hasAdmin(): boolean {
    for (const m of this.order) {
      if (m.permissions.includes('members.manage')) return true;
    }
    return false;
  }

  addMember(input: AddMemberInput): LoadedMember {
    if (input.token === undefined) {
      throw new MemberLoadError(
        'MapMemberStore.addMember: legacy file-backed store requires `token` — use the DB-backed SqliteMemberStore for tokenless adds',
      );
    }
    const tokenHash = hashToken(input.token);
    const member: LoadedMember = {
      name: input.name,
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

export function defaultConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const explicit = env.CSUITE_CONFIG_PATH;
  if (explicit && explicit.length > 0) return explicit;
  return join(cwd, DEFAULT_CONFIG_FILENAME);
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

/**
 * Project the loaded members into a teammate list suitable for the
 * roster and briefing responses. Preserves config ordering. Drops
 * the private `instructions` field (teammates don't see each other's
 * personal instructions).
 */
export function teammatesFromMembers(store: MemberStore): Teammate[] {
  return store.members().map((m) => ({
    name: m.name,
    role: m.role,
    permissions: m.permissions,
  }));
}
