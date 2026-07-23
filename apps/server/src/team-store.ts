/**
 * SQLite-backed team + members + permission-preset store.
 *
 * Replaces the legacy csuite.json team/member surface. Three tables live
 * here:
 *
 *   - `team`               singleton row (id=1) carrying name + context
 *   - `permission_presets` named bundles of leaf permissions
 *   - `members`            roster: name, role, instructions, raw_permissions,
 *                          totp enrollment, insertion order
 *
 * Auth tokens still live in the `tokens` table (see tokens.ts). Member
 * creation here does NOT issue a token — callers compose the two
 * stores: insert a member row, then issue a `tokens` row whose
 * `member_name` references it. Member deletion removes the row here
 * and asks the token store to revoke every token for the name.
 *
 * `raw_permissions` is stored verbatim (preset names or leaf strings);
 * the resolved leaf array is computed on every read against the
 * current presets. That means mutating a preset takes effect for every
 * member that references it on the next `findByName` / `members()`
 * call — no eager re-resolve, no stale cache.
 *
 * TOTP secrets are encrypted at rest when a process-wide KEK is set
 * (see kek.ts). Reads transparently decrypt; writes transparently
 * encrypt. The on-disk shape is `enc-v1:...` when wrapped, plaintext
 * base32 otherwise.
 */

import type { Permission, PermissionPresets, Team } from 'csuite-sdk/types';
import type { DatabaseSyncInstance, StatementInstance } from './db.js';
import { decryptField, encryptField } from './kek.js';
import {
  type AddMemberInput,
  getKek,
  type LoadedMember,
  MemberLoadError,
  type MemberStore,
  resolvePermissions,
  type UpdateMemberPatch,
  validateMemberInstructions,
  validateMemberName,
  validatePermissionPreset,
  validateRawPermissions,
  validateRole,
  validateTeamContext,
  validateTeamName,
  validateTotpSecret,
} from './members.js';

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
function migrateDirectiveIntoContext(db: DatabaseSyncInstance): void {
  const columns = db.prepare('PRAGMA table_info(team)').all() as unknown as Array<{
    name: string;
  }>;
  if (!columns.some((c) => c.name === 'directive')) return;
  db.exec(`
    BEGIN;
    UPDATE team SET context = directive || CASE
      WHEN length(context) > 0 THEN char(10) || char(10) || context
      ELSE ''
    END
    WHERE id = 1 AND length(directive) > 0;
    ALTER TABLE team DROP COLUMN directive;
    COMMIT;
  `);
}

function decryptTotpSecret(stored: string | null): string | null {
  if (stored === null) return null;
  const kek = getKek();
  if (kek === null) return stored;
  return decryptField(stored, kek);
}

function encryptTotpSecret(plaintext: string | null): string | null {
  if (plaintext === null) return null;
  const kek = getKek();
  if (kek === null) return plaintext;
  return encryptField(plaintext, kek);
}

/**
 * Read-side projection for the team config.
 *
 * Both the `Team` (wire) and a fresh `permissionPresets` snapshot are
 * baked in. Callers that mutate presets are expected to invalidate any
 * cached projection they hold; the store always returns a fresh copy.
 */
export class TeamStore {
  private readonly db: DatabaseSyncInstance;
  private readonly getTeamStmt: StatementInstance;
  private readonly upsertTeamStmt: StatementInstance;
  private readonly listPresetsStmt: StatementInstance;
  private readonly upsertPresetStmt: StatementInstance;
  private readonly deletePresetStmt: StatementInstance;
  private readonly now: () => number;

  constructor(db: DatabaseSyncInstance, options: { now?: () => number } = {}) {
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
    this.upsertPresetStmt = this.db.prepare(`
      INSERT INTO permission_presets (name, permissions, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        permissions = excluded.permissions,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `);
    this.deletePresetStmt = this.db.prepare('DELETE FROM permission_presets WHERE name = ?');
  }

  /**
   * Materialize the current team config. Throws if the singleton row
   * has never been seeded — callers must run the wizard or
   * `seedTeam` first.
   */
  getTeam(): Team {
    const row = this.getTeamStmt.get() as RawTeamRow | undefined;
    if (!row) {
      throw new MemberLoadError('team: no team row — run the setup wizard first');
    }
    return {
      name: row.name,
      context: row.context,
      permissionPresets: this.getPresets(),
    };
  }

  /** True iff the team singleton row exists. Fast existence check. */
  hasTeam(): boolean {
    return (this.getTeamStmt.get() as RawTeamRow | undefined) !== undefined;
  }

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

  /**
   * Insert or replace a permission preset. The `permissions` array is
   * validated against the canonical leaf set; unknown leaves throw
   * `MemberLoadError`. The preset NAME is also validated against the
   * preset-key regex.
   */
  setPreset(name: string, permissions: Permission[], by: string | null = null): void {
    validatePermissionPreset(name, permissions);
    this.upsertPresetStmt.run(name, JSON.stringify(permissions), this.now(), by);
  }

  /**
   * Delete a permission preset. Returns true if a row was removed.
   * Note: members may still reference this preset in `raw_permissions`;
   * after deletion their resolved permissions exclude these leaves
   * silently. The caller is expected to gate destructive removal on
   * an admin permission and surface the dependency to the operator.
   */
  deletePreset(name: string): boolean {
    const result = this.deletePresetStmt.run(name);
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * List members that reference a preset by name in their
   * `raw_permissions`. Cheap scan — the roster is small (tens, not
   * thousands). Used by the destructive-delete confirmation path.
   */
  membersReferencingPreset(presetName: string, members: MemberStore): string[] {
    const out: string[] = [];
    for (const m of members.members()) {
      if (m.rawPermissions.includes(presetName)) out.push(m.name);
    }
    return out;
  }
}

class SqliteMemberStore implements MemberStore {
  private readonly db: DatabaseSyncInstance;
  private readonly teamStore: TeamStore;
  private readonly listAllStmt: StatementInstance;
  private readonly findByNameStmt: StatementInstance;
  private readonly insertStmt: StatementInstance;
  private readonly deleteStmt: StatementInstance;
  private readonly updateStmt: StatementInstance;
  private readonly setTotpStmt: StatementInstance;
  private readonly bumpTotpCounterStmt: StatementInstance;
  private readonly nextOrderStmt: StatementInstance;
  private readonly now: () => number;

  constructor(
    db: DatabaseSyncInstance,
    teamStore: TeamStore,
    options: { now?: () => number } = {},
  ) {
    this.db = db;
    this.teamStore = teamStore;
    this.now = options.now ?? Date.now;
    this.db.exec(CREATE_SCHEMA);
    this.listAllStmt = this.db.prepare(
      `SELECT name, role_title, role_description, instructions, raw_permissions,
              totp_secret, totp_last_counter, insertion_order, created_at, updated_at
         FROM members ORDER BY insertion_order ASC`,
    );
    this.findByNameStmt = this.db.prepare(
      `SELECT name, role_title, role_description, instructions, raw_permissions,
              totp_secret, totp_last_counter, insertion_order, created_at, updated_at
         FROM members WHERE name = ?`,
    );
    this.insertStmt = this.db.prepare(`
      INSERT INTO members
        (name, role_title, role_description, instructions, raw_permissions,
         totp_secret, totp_last_counter, insertion_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
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
      name: row.name,
      role: { title: row.role_title, description: row.role_description },
      instructions: row.instructions,
      permissions,
      rawPermissions,
      totpSecret: decryptTotpSecret(row.totp_secret),
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
        name: row.name,
        role: { title: row.role_title, description: row.role_description },
        instructions: row.instructions,
        permissions: resolvePermissions(rawPermissions, presets, `member '${row.name}'`),
        rawPermissions,
        totpSecret: decryptTotpSecret(row.totp_secret),
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

  hasAdmin(): boolean {
    for (const m of this.members()) {
      if (m.permissions.includes('members.manage')) return true;
    }
    return false;
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
      input.name,
      input.role.title,
      input.role.description,
      input.instructions,
      JSON.stringify(input.rawPermissions),
      encryptTotpSecret(input.totpSecret ?? null),
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
    this.setTotpStmt.run(encryptTotpSecret(secret), this.now(), name);
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
  db: DatabaseSyncInstance,
  options: { now?: () => number } = {},
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
  db: DatabaseSyncInstance,
  teamStore: TeamStore,
  options: { now?: () => number } = {},
): MemberStore {
  return new SqliteMemberStore(db, teamStore, options);
}
