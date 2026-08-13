/**
 * Member domain logic — types, field validation, and permission
 * resolution for teams, members, and presets. Pure: no IO, no config
 * files; the stores and the config loader both build on it.
 */

import type { Member, Permission, Role, Teammate } from 'csuite-sdk/types';
import { LEGACY_PERMISSION_ALIASES, PERMISSIONS } from 'csuite-sdk/types';
import { z } from 'zod';

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
// Surfaced both to the composite `ServerConfigSchema` (file loader) and
// to the imperative validators below (DB-backed mutators). Keeping
// them as named top-level constants means the caps live in exactly
// one place.

const TeamNameSchema = z.string().min(1).max(128);
const TeamContextSchema = z.string().default('');
const MemberNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(NAME_REGEX, 'name must be alphanumeric with . _ - allowed');
const InstructionsSchema = z.string().default('');
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
  description: z.string().default(''),
});

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
    // Configs written under the old vocabulary keep loading: a
    // retired leaf resolves to its modern replacement before the
    // unknown-name check can reject it.
    const canonical = LEGACY_PERMISSION_ALIASES[entry] ?? entry;
    if ((PERMISSIONS as readonly string[]).includes(canonical)) {
      set.add(canonical as Permission);
      continue;
    }
    const presetLeaves = presets[entry];
    if (presetLeaves) {
      // Stored presets can predate the consolidation too — map each
      // leaf, not only direct entries.
      for (const leaf of presetLeaves) {
        set.add((LEGACY_PERMISSION_ALIASES[leaf] ?? leaf) as Permission);
      }
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

/**
 * Project the loaded members into a teammate list suitable for the
 * roster and instructions responses. Preserves config ordering. Drops
 * the private `instructions` field (teammates don't see each other's
 * personal instructions).
 */
export function teammatesFromMembers(store: MemberStore): Teammate[] {
  return store.members().map((m) => ({
    name: m.name,
    role: m.role,
    permissions: m.permissions,
    // The auth plane is the only person/agent signal we have: humans
    // enroll TOTP for the web UI, agents authenticate by bearer token
    // alone. No TOTP ⇒ unknown, and the field is omitted so the UI
    // renders the neutral treatment instead of guessing.
    ...(m.totpSecret ? { kind: 'person' as const } : {}),
  }));
}
