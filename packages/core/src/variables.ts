/**
 * Variables store — SQLite-backed registry of broker-held runner
 * environment variables that are NOT secrets.
 *
 * A variable is everything a secret is — a named value an admin drops
 * on the broker once, bound to members, injected as an environment
 * variable on the agent child at spawn — except for the two things
 * that matter:
 *
 *   1. Its value is READABLE by a caller holding `secrets.manage`.
 *      A secret's value leaves the process only via `resolveFor`.
 *   2. It is NEVER registered with the core trace redactor, so it
 *      appears verbatim in captured traces.
 *
 * WHY THIS EXISTS. Until this store, the secrets registry was the only
 * path into a runner's environment, and every value in it was passed
 * to `registerSecretValues` unconditionally. So a git author name —
 * a value published in every commit the member has ever written — had
 * to be stored as a secret, and was then scrubbed from every trace on
 * the team. Which members it happened to was decided by a length
 * threshold: `Turner` and `Seamus` are six characters and vanished;
 * `Cora`, `Rune` and `Lea` are shorter and did not. A corpus redacted
 * per-member by name length, with nothing declaring it.
 *
 * The repair is classification, not thresholds. `MIN_REGISTERED_VALUE_LENGTH`
 * is unchanged and goes back to doing its actual job — keeping very
 * short SECRET values from shredding ordinary trace content.
 *
 * Values are stored in PLAINTEXT and this is deliberate; see the
 * schema comment in `env-namespace.ts`. Encrypting a value we publish
 * would buy nothing and would make identity depend on an active KEK.
 *
 * `envName` validation, the reserved-name list and the per-member
 * uniqueness invariant are shared with secrets — a member's resolved
 * env cannot carry two values for one name, and it makes no difference
 * which store they came from. That check spans both tables and lives
 * in `env-namespace.ts`.
 *
 * Slugs are IMMUTABLE, as in secrets. FK cascades are NOT enforced by
 * this codebase, so `delete()` cascades child rows explicitly inside
 * one transaction.
 */

import type { Variable } from 'csuite-sdk/types';
import {
  ensureEnvNamespaceSchema,
  envRivalMessage,
  findEnvRivalAnyone,
  findEnvRivalForMember,
} from './env-namespace.js';
import type { GetFieldCipher } from './field-crypto.js';
import type { Logger } from './logger.js';
import { SecretsError, validateEnvName } from './secrets.js';
import type { SqlDriver, SqlStatement } from './sql-driver.js';

/**
 * Variables raise the same error type as secrets. Callers map one error
 * shape to HTTP status, and a second identical class would only create
 * a branch where a route could handle one and miss the other.
 */
export { SecretsError as VariablesError } from './secrets.js';

const VALUE_MAX = 32_768;

interface VariableRow {
  id: string;
  slug: string;
  env_name: string;
  description: string;
  enabled: number;
  all_members: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface VariablesStore {
  list(): Variable[];
  /** Enabled variables delivered to a member: allMembers OR explicitly bound. */
  listForMember(memberName: string): Variable[];
  /**
   * The runner projection: env delta for a member, keyed by envName.
   * Variables without a stored value are skipped. Unlike the secrets
   * equivalent this cannot fail on a missing KEK — there is nothing to
   * decrypt.
   */
  resolveFor(memberName: string): Record<string, string>;
  get(id: string): Variable | null;
  getBySlug(slug: string): Variable | null;
  create(input: {
    slug: string;
    envName: string;
    description?: string;
    allMembers?: boolean;
    enabled?: boolean;
    creator: string;
    now?: number;
  }): Variable;
  update(
    id: string,
    patch: {
      envName?: string;
      description?: string;
      allMembers?: boolean;
      enabled?: boolean;
    },
    now?: number,
  ): Variable;
  /** Delete a variable and every child row, in one transaction. */
  delete(id: string): void;

  isBound(variableId: string, memberName: string): boolean;
  listBindings(variableId: string): string[];
  bind(variableId: string, memberName: string, now?: number): void;
  unbind(variableId: string, memberName: string): void;

  setValue(variableId: string, value: string, now?: number): void;
  deleteValue(variableId: string): void;
  hasValue(variableId: string): boolean;
  /**
   * The value, in the clear. This is the method that has no counterpart
   * on `SecretsStore`, and the reason the two are separate types rather
   * than one table with a `kind` column.
   */
  getValue(variableId: string): string | null;
}

const VARIABLE_COLS =
  'id, slug, env_name, description, enabled, all_members, created_by, created_at, updated_at';

class SqliteVariablesStore implements VariablesStore {
  private readonly db: SqlDriver;

  private readonly beginStmt: SqlStatement;
  private readonly commitStmt: SqlStatement;
  private readonly rollbackStmt: SqlStatement;

  private readonly insertStmt: SqlStatement;
  private readonly updateStmt: SqlStatement;
  private readonly deleteStmt: SqlStatement;
  private readonly selectByIdStmt: SqlStatement;
  private readonly selectBySlugStmt: SqlStatement;
  private readonly selectAllStmt: SqlStatement;
  private readonly selectForMemberStmt: SqlStatement;

  private readonly insertBindingStmt: SqlStatement;
  private readonly deleteBindingStmt: SqlStatement;
  private readonly deleteBindingsStmt: SqlStatement;
  private readonly selectBindingStmt: SqlStatement;
  private readonly selectBindingsStmt: SqlStatement;

  private readonly upsertValueStmt: SqlStatement;
  private readonly selectValueStmt: SqlStatement;
  private readonly deleteValueStmt: SqlStatement;

  constructor(db: SqlDriver) {
    this.db = db;
    ensureEnvNamespaceSchema(db);

    this.beginStmt = db.prepare('BEGIN');
    this.commitStmt = db.prepare('COMMIT');
    this.rollbackStmt = db.prepare('ROLLBACK');

    this.insertStmt = db.prepare(
      `INSERT INTO variables
        (id, slug, env_name, description, enabled, all_members, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateStmt = db.prepare(
      `UPDATE variables
       SET env_name = ?, description = ?, enabled = ?, all_members = ?, updated_at = ?
       WHERE id = ?`,
    );
    this.deleteStmt = db.prepare('DELETE FROM variables WHERE id = ?');
    this.selectByIdStmt = db.prepare(`SELECT ${VARIABLE_COLS} FROM variables WHERE id = ?`);
    this.selectBySlugStmt = db.prepare(`SELECT ${VARIABLE_COLS} FROM variables WHERE slug = ?`);
    this.selectAllStmt = db.prepare(
      `SELECT ${VARIABLE_COLS} FROM variables ORDER BY created_at ASC`,
    );
    this.selectForMemberStmt = db.prepare(
      `SELECT ${VARIABLE_COLS} FROM variables v
       WHERE v.enabled = 1
         AND (v.all_members = 1 OR EXISTS (
           SELECT 1 FROM variable_bindings b
           WHERE b.variable_id = v.id AND b.member_name = ?
         ))
       ORDER BY v.created_at ASC`,
    );

    this.insertBindingStmt = db.prepare(
      'INSERT OR IGNORE INTO variable_bindings (variable_id, member_name, created_at) VALUES (?, ?, ?)',
    );
    this.deleteBindingStmt = db.prepare(
      'DELETE FROM variable_bindings WHERE variable_id = ? AND member_name = ?',
    );
    this.deleteBindingsStmt = db.prepare('DELETE FROM variable_bindings WHERE variable_id = ?');
    this.selectBindingStmt = db.prepare(
      'SELECT 1 FROM variable_bindings WHERE variable_id = ? AND member_name = ?',
    );
    this.selectBindingsStmt = db.prepare(
      'SELECT member_name FROM variable_bindings WHERE variable_id = ? ORDER BY created_at ASC',
    );

    this.upsertValueStmt = db.prepare(
      `INSERT INTO variable_values (variable_id, value, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(variable_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.selectValueStmt = db.prepare('SELECT value FROM variable_values WHERE variable_id = ?');
    this.deleteValueStmt = db.prepare('DELETE FROM variable_values WHERE variable_id = ?');
  }

  list(): Variable[] {
    return (this.selectAllStmt.all() as unknown as VariableRow[]).map(rowToVariable);
  }

  listForMember(memberName: string): Variable[] {
    return (this.selectForMemberStmt.all(memberName) as unknown as VariableRow[]).map(
      rowToVariable,
    );
  }

  resolveFor(memberName: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const variable of this.listForMember(memberName)) {
      const row = this.selectValueStmt.get(variable.id) as { value: string } | undefined;
      if (!row) continue;
      env[variable.envName] = row.value;
    }
    return env;
  }

  get(id: string): Variable | null {
    const row = this.selectByIdStmt.get(id) as VariableRow | undefined;
    return row ? rowToVariable(row) : null;
  }

  getBySlug(slug: string): Variable | null {
    const row = this.selectBySlugStmt.get(slug) as VariableRow | undefined;
    return row ? rowToVariable(row) : null;
  }

  create(input: {
    slug: string;
    envName: string;
    description?: string;
    allMembers?: boolean;
    enabled?: boolean;
    creator: string;
    now?: number;
  }): Variable {
    const now = input.now ?? Date.now();
    validateVariableSlug(input.slug);
    validateEnvName(input.envName);
    if (this.getBySlug(input.slug)) {
      throw new SecretsError('slug_taken', `slug "${input.slug}" is already in use`);
    }
    const allMembers = input.allMembers ?? false;
    const id = `var_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    // An all-members variable reaches everyone the moment it exists, so
    // its collision check runs at create. A targeted one reaches nobody
    // until it is bound, and is checked there.
    if (allMembers) {
      const rival = findEnvRivalAnyone(this.db, input.envName, 'variable', id);
      if (rival) {
        throw new SecretsError(
          'env_taken',
          `${rival.kind} "${rival.slug}" already targets ${input.envName} and this variable applies to all members`,
        );
      }
    }
    this.insertStmt.run(
      id,
      input.slug,
      input.envName,
      input.description ?? '',
      (input.enabled ?? true) ? 1 : 0,
      allMembers ? 1 : 0,
      input.creator,
      now,
      now,
    );
    return this.get(id) as Variable;
  }

  update(
    id: string,
    patch: {
      envName?: string;
      description?: string;
      allMembers?: boolean;
      enabled?: boolean;
    },
    now: number = Date.now(),
  ): Variable {
    const existing = this.get(id);
    if (!existing) throw new SecretsError('not_found', `variable ${id} not found`);
    const envName = patch.envName ?? existing.envName;
    const willApplyToAll = patch.allMembers ?? existing.allMembers;
    if (envName !== existing.envName || (willApplyToAll && !existing.allMembers)) {
      if (envName !== existing.envName) validateEnvName(envName);
      // Re-check against the audience this variable will have AFTER the
      // patch, not the one it has now.
      if (willApplyToAll) {
        const rival = findEnvRivalAnyone(this.db, envName, 'variable', id);
        if (rival) {
          throw new SecretsError(
            'env_taken',
            `${rival.kind} "${rival.slug}" already targets ${envName} and this variable applies to all members`,
          );
        }
      } else {
        for (const memberName of this.listBindings(id)) {
          const rival = findEnvRivalForMember(this.db, envName, 'variable', id, memberName);
          if (rival) {
            throw new SecretsError('env_taken', envRivalMessage(memberName, envName, rival));
          }
        }
      }
    }
    this.updateStmt.run(
      envName,
      patch.description ?? existing.description,
      (patch.enabled ?? existing.enabled) ? 1 : 0,
      (patch.allMembers ?? existing.allMembers) ? 1 : 0,
      now,
      id,
    );
    return this.get(id) as Variable;
  }

  delete(id: string): void {
    const existing = this.get(id);
    if (!existing) throw new SecretsError('not_found', `variable ${id} not found`);
    this.beginStmt.run();
    try {
      this.deleteBindingsStmt.run(id);
      this.deleteValueStmt.run(id);
      this.deleteStmt.run(id);
      this.commitStmt.run();
    } catch (err) {
      try {
        this.rollbackStmt.run();
      } catch {
        /* rollback of a failed tx can itself fail — nothing to do */
      }
      throw err;
    }
  }

  isBound(variableId: string, memberName: string): boolean {
    return this.selectBindingStmt.get(variableId, memberName) !== undefined;
  }

  listBindings(variableId: string): string[] {
    const rows = this.selectBindingsStmt.all(variableId) as unknown as Array<{
      member_name: string;
    }>;
    return rows.map((r) => r.member_name);
  }

  /**
   * Bind a member to a variable. Binding is the first moment a targeted
   * variable actually reaches someone, so it is the first moment a
   * collision can exist — including a collision with a SECRET that
   * targets the same env name for the same member.
   */
  bind(variableId: string, memberName: string, now: number = Date.now()): void {
    const variable = this.get(variableId);
    if (!variable) throw new SecretsError('not_found', `variable ${variableId} not found`);
    const rival = findEnvRivalForMember(
      this.db,
      variable.envName,
      'variable',
      variableId,
      memberName,
    );
    if (rival) {
      throw new SecretsError('env_taken', envRivalMessage(memberName, variable.envName, rival));
    }
    this.insertBindingStmt.run(variableId, memberName, now);
  }

  unbind(variableId: string, memberName: string): void {
    this.deleteBindingStmt.run(variableId, memberName);
  }

  setValue(variableId: string, value: string, now: number = Date.now()): void {
    if (!this.get(variableId)) {
      throw new SecretsError('not_found', `variable ${variableId} not found`);
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new SecretsError('invalid_input', 'value is required');
    }
    if (value.length > VALUE_MAX) {
      throw new SecretsError('invalid_input', `value too long (max ${VALUE_MAX})`);
    }
    // No KEK gate. A variable is not encrypted, so unlike `secrets`
    // there is no fail-closed case here — and that is a feature: a
    // broker booted without a KEK still delivers identity.
    this.upsertValueStmt.run(variableId, value, now, now);
  }

  deleteValue(variableId: string): void {
    this.deleteValueStmt.run(variableId);
  }

  hasValue(variableId: string): boolean {
    return this.selectValueStmt.get(variableId) !== undefined;
  }

  getValue(variableId: string): string | null {
    const row = this.selectValueStmt.get(variableId) as { value: string } | undefined;
    return row ? row.value : null;
  }
}

/**
 * Slug grammar, matching the secrets store's: lowercase alphanumeric
 * and hyphens, bounded. Slugs are immutable and address the change-event
 * thread, so they may not collide with a secret's.
 */
export function validateVariableSlug(slug: string): void {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new SecretsError('invalid_input', 'slug is required');
  }
  if (slug.length > 64) {
    throw new SecretsError('invalid_input', 'slug too long (max 64)');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new SecretsError(
      'invalid_input',
      'slug must be lowercase alphanumeric with hyphens ([a-z0-9][a-z0-9-]*)',
    );
  }
}

function rowToVariable(row: VariableRow): Variable {
  return {
    id: row.id,
    slug: row.slug,
    envName: row.env_name,
    description: row.description,
    enabled: row.enabled === 1,
    allMembers: row.all_members === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSqliteVariablesStore(db: SqlDriver): VariablesStore {
  return new SqliteVariablesStore(db);
}

/**
 * Environment names that are identity, not secrets. A git author name
 * appears in every commit its member has ever written; redacting it
 * from traces is pure loss.
 *
 * Deliberately a fixed list rather than a heuristic. "Looks like
 * identity" would be a guess applied to values an operator chose, and
 * a wrong guess in the permissive direction publishes a secret.
 */
export const IDENTITY_ENV_NAMES = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

export interface IdentityMigrationResult {
  /** Slugs moved from `secrets` to `variables`, with their values. */
  migrated: string[];
  /**
   * Slugs that are identity but could NOT be moved, with the reason.
   * The common one is a secret whose value cannot be decrypted because
   * no KEK is active — the row is left exactly where it is.
   */
  skipped: Array<{ slug: string; reason: string }>;
  /** True when nothing needed doing (already migrated, or none present). */
  noop: boolean;
}

/**
 * Move identity rows out of the secrets store and into variables,
 * once, at boot.
 *
 * AUTOMATIC AND NOT OPERATOR-DRIVEN, deliberately. An operator step
 * that has not been run leaves identity registered for redaction —
 * the exact state this change exists to end — and it fails silently:
 * everything works, names just keep vanishing from traces. The
 * migration is cheap, idempotent, and safe to run on every boot.
 *
 * ALL OR NOTHING PER ROW, inside one transaction for the whole batch.
 * A half-migrated state is the one outcome worth refusing: a secret
 * deleted before its variable exists loses a value we cannot
 * regenerate, and a variable created without deleting the secret
 * leaves the member resolving one env name from both stores — which
 * `resolveFor` then refuses, breaking every runner start.
 *
 * Ordering matters and is enforced by the caller: this must run BEFORE
 * `registerSecretValues(secretsStore.allDecryptedValues())`, or the
 * identity values are registered for the life of the process and the
 * migration only takes effect after the NEXT restart.
 */
export function migrateIdentityToVariables(
  db: SqlDriver,
  getCipher: GetFieldCipher,
  secrets: {
    list(): Array<{
      id: string;
      slug: string;
      envName: string;
      description: string;
      enabled: boolean;
      allMembers: boolean;
      createdBy: string;
    }>;
    listBindings(id: string): string[];
    delete(id: string): void;
  },
  variables: VariablesStore,
  log: Pick<Logger, 'info' | 'warn'>,
): IdentityMigrationResult {
  const identityNames = new Set<string>(IDENTITY_ENV_NAMES);
  const candidates = secrets.list().filter((s) => identityNames.has(s.envName));
  const result: IdentityMigrationResult = { migrated: [], skipped: [], noop: false };

  if (candidates.length === 0) {
    result.noop = true;
    return result;
  }

  // Read every value BEFORE mutating anything, by decrypting the stored
  // row directly rather than through `resolveFor`.
  //
  // `resolveFor` is per-member, so it can only recover a value through
  // a member the secret reaches — and an identity secret bound to
  // NOBODY would be unreadable and therefore unmigratable. That looks
  // harmless (it reaches no runner) and is not: `allDecryptedValues()`
  // registers every stored value regardless of binding, so an unbound
  // identity row goes on scrubbing that name from EVERY member's
  // captured bodies. Measured on the live team database, exactly one
  // row was in this state and it was the reason one member's name
  // survived the migration still redacted.
  //
  // Reading the row directly is also consistent with how the move
  // itself is done below: this is a storage-level operation on rows
  // whose values were already validated when they were written.
  const cipher = getCipher();
  const selectValue = db.prepare('SELECT value_enc FROM secret_values WHERE secret_id = ?');
  const pending: Array<{
    secret: (typeof candidates)[number];
    value: string;
    bindings: string[];
  }> = [];
  for (const secret of candidates) {
    if (variables.getBySlug(secret.slug) !== null) continue; // already migrated
    const bindings = secrets.listBindings(secret.id);
    const row = selectValue.get(secret.id) as { value_enc: string } | undefined;
    let value: string | undefined;
    let reason: string | undefined;
    if (!row) {
      reason = 'no stored value';
    } else if (cipher === null) {
      reason = 'no encryption key is active; the value cannot be decrypted';
    } else {
      try {
        value = cipher.decrypt(row.value_enc) ?? undefined;
        if (value === undefined) reason = 'value decrypted to nothing';
      } catch (err) {
        reason = `value unreadable (${err instanceof Error ? err.message : String(err)})`;
      }
    }
    if (value === undefined) {
      result.skipped.push({ slug: secret.slug, reason: reason ?? 'value unreadable' });
      continue;
    }
    pending.push({ secret, value, bindings });
  }

  if (pending.length === 0) {
    result.noop = result.skipped.length === 0;
    if (result.skipped.length > 0) {
      log.warn('identity migration: nothing moved', { skipped: result.skipped });
    }
    return result;
  }

  // Storage-level, deliberately. The store methods each open their own
  // transaction (`delete` in particular), and SQLite has no nested
  // BEGIN — calling them inside one would fail with "cannot start a
  // transaction within a transaction" and roll the whole migration
  // back. Batch atomicity is worth more here than going through the
  // store API, because the rows being moved are already validated and
  // the cross-store collision check is satisfied by construction: each
  // secret is deleted in the same transaction that inserts its variable.
  db.prepare('BEGIN').run();
  try {
    const now = Date.now();
    const insertVariable = db.prepare(
      `INSERT INTO variables
        (id, slug, env_name, description, enabled, all_members, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertValue = db.prepare(
      'INSERT INTO variable_values (variable_id, value, created_at, updated_at) VALUES (?, ?, ?, ?)',
    );
    const insertBinding = db.prepare(
      'INSERT OR IGNORE INTO variable_bindings (variable_id, member_name, created_at) VALUES (?, ?, ?)',
    );
    const deleteSecretBindings = db.prepare('DELETE FROM secret_bindings WHERE secret_id = ?');
    const deleteSecretValue = db.prepare('DELETE FROM secret_values WHERE secret_id = ?');
    const deleteSecret = db.prepare('DELETE FROM secrets WHERE id = ?');

    for (const { secret, value, bindings } of pending) {
      const id = `var_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      insertVariable.run(
        id,
        secret.slug,
        secret.envName,
        secret.description,
        secret.enabled ? 1 : 0,
        secret.allMembers ? 1 : 0,
        secret.createdBy,
        now,
        now,
      );
      insertValue.run(id, value, now, now);
      for (const member of bindings) insertBinding.run(id, member, now);
      deleteSecretBindings.run(secret.id);
      deleteSecretValue.run(secret.id);
      deleteSecret.run(secret.id);
      result.migrated.push(secret.slug);
    }
    db.prepare('COMMIT').run();
  } catch (err) {
    try {
      db.prepare('ROLLBACK').run();
    } catch {
      /* rollback of a failed tx can itself fail — nothing to do */
    }
    // Rolled back: every identity row is exactly where it was. The
    // broker keeps booting, identity keeps being redacted, and this
    // line is the only thing that says so — so it is a warning, not
    // an info.
    log.warn('identity migration rolled back; identity remains registered for redaction', {
      error: err instanceof Error ? err.message : String(err),
      attempted: pending.map((p) => p.secret.slug),
    });
    return { migrated: [], skipped: result.skipped, noop: false };
  }

  log.info('identity migrated from secrets to variables', {
    migrated: result.migrated,
    skipped: result.skipped,
  });
  return result;
}
