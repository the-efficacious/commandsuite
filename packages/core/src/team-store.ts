/**
 * SQLite-backed team + members + permission-preset store.
 *
 * Replaces the legacy csuite.json team/member surface. Three tables live
 * here:
 *
 *   - `team`               singleton row (id=1) carrying name + context
 *   - `permission_presets` legacy named bundles of leaf permissions.
 *                          READ-ONLY: rows an older broker wrote, kept
 *                          so a pre-consolidation database still loads
 *   - `members`            roster: name, role, instructions, raw_permissions,
 *                          totp enrollment, insertion order
 *
 * Auth tokens still live in the `tokens` table (see tokens.ts). Member
 * creation here does NOT issue a token — callers compose the two
 * stores: insert a member row, then issue a `tokens` row whose
 * `member_name` references it. Member deletion removes the row here
 * and asks the token store to revoke every token for the name.
 *
 * `raw_permissions` is stored verbatim (leaf strings, or a preset name
 * on a row written before the consolidation); the resolved leaf array
 * is computed on every read against the stored presets, so a legacy
 * row keeps resolving without being rewritten. Nothing in the product
 * can write a preset any more — no route, no CLI command, no MCP tool,
 * and the wire refuses a preset name by construction, since
 * `MemberPermissionListSchema`'s element type is `z.enum(PERMISSIONS)`.
 *
 * TOTP secrets are encrypted at rest when a process-wide KEK is set
 * (see kek.ts). Reads transparently decrypt; writes transparently
 * encrypt. The on-disk shape is `enc-v1:...` when wrapped, plaintext
 * base32 otherwise.
 */

import type { Permission, PermissionPresets, Team } from 'csuite-sdk/types';
import type { GetFieldCipher } from './field-crypto.js';
import {
  type AddMemberInput,
  type LoadedMember,
  MemberLoadError,
  type MemberStore,
  resolvePermissions,
  type UpdateMemberPatch,
  validateMemberInstructions,
  validateMemberName,
  validateRawPermissions,
  validateRole,
  validateTeamContext,
  validateTeamName,
  validateTotpSecret,
} from './members-domain.js';
import { runInTransaction, type SqlDriver, type SqlStatement } from './sql-driver.js';

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS team (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    name        TEXT NOT NULL,
    context     TEXT NOT NULL DEFAULT '',
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT
  );

  CREATE TABLE IF NOT EXISTS permission_presets (
    name         TEXT PRIMARY KEY,
    permissions  TEXT NOT NULL,
    updated_at   INTEGER NOT NULL,
    updated_by   TEXT
  );

  CREATE TABLE IF NOT EXISTS members (
    identity_id       TEXT NOT NULL UNIQUE,
    name              TEXT PRIMARY KEY,
    role_title        TEXT NOT NULL,
    role_description  TEXT NOT NULL DEFAULT '',
    instructions      TEXT NOT NULL DEFAULT '',
    raw_permissions   TEXT NOT NULL,
    totp_secret       TEXT,
    totp_last_counter INTEGER NOT NULL DEFAULT 0,
    insertion_order   INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS members_order_idx ON members(insertion_order);
`;

interface RawTeamRow {
  id: number;
  name: string;
  context: string;
  updated_at: number;
  updated_by: string | null;
}

interface RawPresetRow {
  name: string;
  permissions: string;
  updated_at: number;
  updated_by: string | null;
}

interface RawMemberRow {
  identity_id: string;
  name: string;
  role_title: string;
  role_description: string;
  instructions: string;
  raw_permissions: string;
  totp_secret: string | null;
  totp_last_counter: number;
  insertion_order: number;
  created_at: number;
  updated_at: number;
}

function parseJsonArray(s: string, where: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch (err) {
    throw new MemberLoadError(
      `${where}: corrupt JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== 'string')) {
    throw new MemberLoadError(`${where}: expected a JSON array of strings`);
  }
  return parsed as string[];
}

/**
 * One-shot upgrade for databases created before the directive field
 * was retired: fold any non-empty `directive` into the head of
 * `context` (blank-line separated) and drop the column. Runs inside
 * a transaction; a no-op when the column is already gone.
 */
function migrateDirectiveIntoContext(db: SqlDriver): void {
  const columns = db.prepare('PRAGMA table_info(team)').all() as unknown as Array<{
    name: string;
  }>;
  if (!columns.some((c) => c.name === 'directive')) return;
  runInTransaction(db, () => {
    db.exec(`
      UPDATE team SET context = directive || CASE
        WHEN length(context) > 0 THEN char(10) || char(10) || context
        ELSE ''
      END
      WHERE id = 1 AND length(directive) > 0;
      ALTER TABLE team DROP COLUMN directive;
    `);
  });
}

/**
 * Add the stable identity key to databases created before typed member
 * offboarding. The backfill is deliberately independent of member names:
 * names may later be explicitly reused, identity ids never are.
 */
function migrateMemberIdentityIds(db: SqlDriver): void {
  const columns = db.prepare('PRAGMA table_info(members)').all() as unknown as Array<{
    name: string;
  }>;
  if (columns.some((c) => c.name === 'identity_id')) return;

  runInTransaction(db, () => {
    db.exec('ALTER TABLE members ADD COLUMN identity_id TEXT');
    const rows = db
      .prepare('SELECT name FROM members ORDER BY insertion_order ASC')
      .all() as unknown as Array<{
      name: string;
    }>;
    const update = db.prepare('UPDATE members SET identity_id = ? WHERE name = ?');
    for (const row of rows) update.run(globalThis.crypto.randomUUID(), row.name);
    db.exec('CREATE UNIQUE INDEX members_identity_id_idx ON members(identity_id)');
  });
}

function decryptTotpSecret(stored: string | null, getCipher: GetFieldCipher): string | null {
  if (stored === null) return null;
  const cipher = getCipher();
  if (cipher === null) return stored;
  return cipher.decrypt(stored);
}

function encryptTotpSecret(plaintext: string | null, getCipher: GetFieldCipher): string | null {
  if (plaintext === null) return null;
  const cipher = getCipher();
  if (cipher === null) return plaintext;
  return cipher.encrypt(plaintext);
}

/**
 * Read-side projection for the team config.
 *
 * Legacy named bundles remain READABLE internally so preset-era member
 * rows can be resolved, but they are not part of the current Team wire
 * projection and there is no way to write one. `setPreset`,
 * `deletePreset` and `membersReferencingPreset` were deleted with the
 * write path: none had a production caller, no wire shape accepts a
 * preset name, and `Team.permissionPresets` has been `@deprecated` in
 * the SDK since the consolidation. `getPresets()` and the preset branch of
 * `resolvePermissions` stay, because together they are the only reason
 * an older database still loads. If operator-editable permission
 * templates are ever wanted, design them fresh rather than resurrect a
 * schema that predates the flat leaf model.
 */
export class TeamStore {
  private readonly db: SqlDriver;
  private readonly getTeamStmt: SqlStatement;
  private readonly upsertTeamStmt: SqlStatement;
  private readonly listPresetsStmt: SqlStatement;
  private readonly now: () => number;

  constructor(db: SqlDriver, options: { now?: () => number; getCipher?: GetFieldCipher } = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.db.exec(CREATE_SCHEMA);
    migrateDirectiveIntoContext(this.db);
    this.getTeamStmt = this.db.prepare(
      'SELECT id, name, context, updated_at, updated_by FROM team WHERE id = 1',
    );
    this.upsertTeamStmt = this.db.prepare(`
      INSERT INTO team (id, name, context, updated_at, updated_by)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        context = excluded.context,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `);
    this.listPresetsStmt = this.db.prepare(
      'SELECT name, permissions, updated_at, updated_by FROM permission_presets ORDER BY name ASC',
    );
  }

  /**
   * Materialize the current team config. Throws if the singleton row
   * has never been seeded — callers must run the wizard or
   * `setTeam` first.
   */
  getTeam(): Team {
    const row = this.getTeamStmt.get() as RawTeamRow | undefined;
    if (!row) {
      throw new MemberLoadError('team: no team row — run the setup wizard first');
    }
    return {
      name: row.name,
      context: row.context,
    };
  }

  /** True iff the team singleton row exists. Fast existence check. */
  hasTeam(): boolean {
    return (this.getTeamStmt.get() as RawTeamRow | undefined) !== undefined;
  }

  /**
   * The legacy presets on disk. Read-only by design: rows written by a
   * broker older than the flat leaf model, resolved into leaves on
   * every member load by `resolvePermissions`. A current broker returns
   * `{}` here and nothing can add to it.
   */
  getPresets(): PermissionPresets {
    const rows = this.listPresetsStmt.all() as unknown as RawPresetRow[];
    const out: PermissionPresets = {};
    for (const row of rows) {
      const leaves = parseJsonArray(row.permissions, `preset '${row.name}'`);
      out[row.name] = leaves as Permission[];
    }
    return out;
  }

  /**
   * Create or replace the team singleton. Validates name/context
   * lengths via the shared zod-derived helpers.
   */
  setTeam(input: { name: string; context: string }, by: string | null = null): Team {
    validateTeamName(input.name);
    validateTeamContext(input.context);
    this.upsertTeamStmt.run(input.name, input.context, this.now(), by);
    return this.getTeam();
  }

  /** Patch the team singleton; only the supplied fields change. */
  updateTeam(patch: { name?: string; context?: string }, by: string | null = null): Team {
    const current = this.getTeam();
    return this.setTeam(
      {
        name: patch.name ?? current.name,
        context: patch.context ?? current.context,
      },
      by,
    );
  }
}

class SqliteMemberStore implements MemberStore {
  private readonly db: SqlDriver;
  private readonly teamStore: TeamStore;
  private readonly listAllStmt: SqlStatement;
  private readonly findByNameStmt: SqlStatement;
  private readonly insertStmt: SqlStatement;
  private readonly deleteStmt: SqlStatement;
  private readonly updateStmt: SqlStatement;
  private readonly setTotpStmt: SqlStatement;
  private readonly bumpTotpCounterStmt: SqlStatement;
  private readonly nextOrderStmt: SqlStatement;
  private readonly now: () => number;

  private readonly getCipher: GetFieldCipher;

  constructor(
    db: SqlDriver,
    teamStore: TeamStore,
    options: { now?: () => number; getCipher?: GetFieldCipher } = {},
  ) {
    this.db = db;
    this.teamStore = teamStore;
    this.now = options.now ?? Date.now;
    this.getCipher = options.getCipher ?? (() => null);
    this.db.exec(CREATE_SCHEMA);
    migrateMemberIdentityIds(this.db);
    this.listAllStmt = this.db.prepare(
      `SELECT identity_id, name, role_title, role_description, instructions, raw_permissions,
              totp_secret, totp_last_counter, insertion_order, created_at, updated_at
         FROM members ORDER BY insertion_order ASC`,
    );
    this.findByNameStmt = this.db.prepare(
      `SELECT identity_id, name, role_title, role_description, instructions, raw_permissions,
              totp_secret, totp_last_counter, insertion_order, created_at, updated_at
         FROM members WHERE name = ?`,
    );
    this.insertStmt = this.db.prepare(`
      INSERT INTO members
        (identity_id, name, role_title, role_description, instructions, raw_permissions,
         totp_secret, totp_last_counter, insertion_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `);
    this.deleteStmt = this.db.prepare('DELETE FROM members WHERE name = ?');
    this.updateStmt = this.db.prepare(`
      UPDATE members SET
        role_title       = ?,
        role_description = ?,
        instructions     = ?,
        raw_permissions  = ?,
        updated_at       = ?
      WHERE name = ?
    `);
    this.setTotpStmt = this.db.prepare(`
      UPDATE members SET totp_secret = ?, totp_last_counter = 0, updated_at = ?
      WHERE name = ?
    `);
    this.bumpTotpCounterStmt = this.db.prepare(`
      UPDATE members SET totp_last_counter = ?, updated_at = ?
      WHERE name = ? AND totp_last_counter < ?
    `);
    this.nextOrderStmt = this.db.prepare(
      'SELECT COALESCE(MAX(insertion_order), -1) + 1 AS next FROM members',
    );
  }

  private rowToLoaded(row: RawMemberRow): LoadedMember {
    const rawPermissions = parseJsonArray(row.raw_permissions, `member '${row.name}'`);
    const presets = this.teamStore.getPresets();
    const permissions = resolvePermissions(rawPermissions, presets, `member '${row.name}'`);
    return {
      identityId: row.identity_id,
      name: row.name,
      role: { title: row.role_title, description: row.role_description },
      instructions: row.instructions,
      permissions,
      rawPermissions,
      totpSecret: decryptTotpSecret(row.totp_secret, this.getCipher),
      totpLastCounter: row.totp_last_counter,
    };
  }

  findByName(name: string): LoadedMember | null {
    const row = this.findByNameStmt.get(name) as RawMemberRow | undefined;
    return row ? this.rowToLoaded(row) : null;
  }

  size(): number {
    return (
      (this.db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number } | undefined)
        ?.c ?? 0
    );
  }

  members(): LoadedMember[] {
    const rows = this.listAllStmt.all() as unknown as RawMemberRow[];
    // Fetch presets once for the whole list to avoid N+1 lookups.
    const presets = this.teamStore.getPresets();
    return rows.map((row) => {
      const rawPermissions = parseJsonArray(row.raw_permissions, `member '${row.name}'`);
      return {
        identityId: row.identity_id,
        name: row.name,
        role: { title: row.role_title, description: row.role_description },
        instructions: row.instructions,
        permissions: resolvePermissions(rawPermissions, presets, `member '${row.name}'`),
        rawPermissions,
        totpSecret: decryptTotpSecret(row.totp_secret, this.getCipher),
        totpLastCounter: row.totp_last_counter,
      };
    });
  }

  names(): string[] {
    const rows = this.db
      .prepare('SELECT name FROM members ORDER BY insertion_order ASC')
      .all() as unknown as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  addMember(input: AddMemberInput): LoadedMember {
    validateMemberName(input.name);
    validateRole(input.role);
    validateMemberInstructions(input.instructions);
    validateRawPermissions(input.rawPermissions);
    if (input.totpSecret !== null && input.totpSecret !== undefined) {
      validateTotpSecret(input.totpSecret);
    }
    if (this.findByNameStmt.get(input.name) !== undefined) {
      throw new MemberLoadError(`duplicate name '${input.name}'`);
    }
    const presets = this.teamStore.getPresets();
    // Resolve up-front so we surface unknown preset/leaf names before
    // we touch the row. The resolved value isn't persisted (we
    // re-resolve on read), but failing fast here means the caller
    // never sees a partial commit.
    resolvePermissions(input.rawPermissions, presets, `member '${input.name}'`);

    const next = (this.nextOrderStmt.get() as { next: number } | undefined)?.next ?? 0;
    const t = this.now();
    this.insertStmt.run(
      globalThis.crypto.randomUUID(),
      input.name,
      input.role.title,
      input.role.description,
      input.instructions,
      JSON.stringify(input.rawPermissions),
      encryptTotpSecret(input.totpSecret ?? null, this.getCipher),
      next,
      t,
      t,
    );
    const loaded = this.findByName(input.name);
    if (!loaded) {
      throw new MemberLoadError(`addMember: row not visible after insert (name='${input.name}')`);
    }
    return loaded;
  }

  removeMember(name: string): void {
    const row = this.findByNameStmt.get(name) as RawMemberRow | undefined;
    if (!row) throw new MemberLoadError(`no such member: '${name}'`);
    this.deleteStmt.run(name);
  }

  updateMember(name: string, patch: UpdateMemberPatch): LoadedMember {
    const row = this.findByNameStmt.get(name) as RawMemberRow | undefined;
    if (!row) throw new MemberLoadError(`no such member: '${name}'`);
    const role = patch.role ?? { title: row.role_title, description: row.role_description };
    if (patch.role !== undefined) validateRole(patch.role);
    const instructions = patch.instructions ?? row.instructions;
    if (patch.instructions !== undefined) validateMemberInstructions(patch.instructions);
    const rawPermissions =
      patch.rawPermissions ?? parseJsonArray(row.raw_permissions, `member '${name}'`);
    if (patch.rawPermissions !== undefined) {
      validateRawPermissions(patch.rawPermissions);
      resolvePermissions(patch.rawPermissions, this.teamStore.getPresets(), `member '${name}'`);
    }
    this.updateStmt.run(
      role.title,
      role.description,
      instructions,
      JSON.stringify(rawPermissions),
      this.now(),
      name,
    );
    const loaded = this.findByName(name);
    if (!loaded) {
      throw new MemberLoadError(`updateMember: row vanished mid-update (name='${name}')`);
    }
    return loaded;
  }

  setTotpSecret(name: string, secret: string | null): LoadedMember {
    const row = this.findByNameStmt.get(name) as RawMemberRow | undefined;
    if (!row) throw new MemberLoadError(`no such member: '${name}'`);
    if (secret !== null) validateTotpSecret(secret);
    this.setTotpStmt.run(encryptTotpSecret(secret, this.getCipher), this.now(), name);
    const loaded = this.findByName(name);
    if (!loaded) {
      throw new MemberLoadError(`setTotpSecret: row vanished mid-update (name='${name}')`);
    }
    return loaded;
  }

  recordTotpAccept(name: string, counter: number): LoadedMember | null {
    const result = this.bumpTotpCounterStmt.run(counter, this.now(), name, counter);
    if (Number(result.changes ?? 0) === 0) {
      // Either no such member, or counter was not strictly greater
      // than the stored one (replay guard). Distinguish by looking up
      // the row.
      const row = this.findByNameStmt.get(name) as RawMemberRow | undefined;
      if (!row) return null;
      return this.rowToLoaded(row);
    }
    return this.findByName(name);
  }

  // ─────────────────── Legacy MemberStore methods ────────────────────
  //
  // These exist on the MemberStore interface for the legacy file-backed
  // path. The DB-backed store does not own auth tokens — those live in
  // the `tokens` table (tokens.ts). They throw here so any caller
  // wired to the new store fails loudly; the next refactor pass drops
  // them from the interface entirely.

  // `resolve(rawToken)` and `tokenHashOf(name)` return null because the
  // DB-backed store is not the auth source — the `tokens` table is.
  // Legacy callers (createTokenStoreFromMembers, anything that walks
  // the file's tokenHash) cleanly degrade to a no-op.
  resolve(_rawToken: string): LoadedMember | null {
    return null;
  }

  tokenHashOf(_name: string): string | null {
    return null;
  }

  // `rotateToken` THROWS because it is a write op a legacy caller may
  // still hit. Rotation belongs to the tokens store now; surfacing the
  // error tells the caller they need to migrate, rather than silently
  // letting the rotation appear to succeed.
  rotateToken(_name: string, _newRawToken: string): LoadedMember {
    throw new MemberLoadError(
      'SqliteMemberStore.rotateToken() is not supported — rotate via the tokens store',
    );
  }
}

/**
 * Open both stores on a shared database handle. Boot-time helper.
 */
export function openTeamAndMembers(
  db: SqlDriver,
  options: { now?: () => number; getCipher?: GetFieldCipher } = {},
): { team: TeamStore; members: MemberStore } {
  const team = new TeamStore(db, options);
  const members = new SqliteMemberStore(db, team, options);
  return { team, members };
}

/**
 * Test/wizard helper: build a SqliteMemberStore directly. Production
 * code paths should use `openTeamAndMembers` so the team store is
 * shared.
 */
export function createSqliteMemberStore(
  db: SqlDriver,
  teamStore: TeamStore,
  options: { now?: () => number; getCipher?: GetFieldCipher } = {},
): MemberStore {
  return new SqliteMemberStore(db, teamStore, options);
}
