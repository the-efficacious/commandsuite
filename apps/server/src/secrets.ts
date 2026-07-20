/**
 * Secrets store — SQLite-backed registry of broker-held environment
 * secrets.
 *
 * A secret is a named value an admin drops on the broker once; the
 * runner resolves the set bound to its member immediately before
 * spawning the agent and injects each as an environment variable on
 * the agent child. The value never appears in briefing prose,
 * prompts, or MCP traffic — the agent just finds the variable set.
 *
 * Shares the main `DatabaseSync` handle with channels/objectives.
 * Values are KEK-encrypted at rest (`enc-v1:` envelope) and
 * WRITE-ONLY over the wire — no store method returns a value except
 * `resolveFor`, which only the runner-facing resolve endpoint calls.
 * Value writes FAIL CLOSED when no KEK is active (`no_kek`), same
 * doctrine as tool-source credentials: fresh secrets have no
 * plaintext legacy to migrate.
 *
 * `envName` is validated against the shared SDK grammar and reserved
 * list — runner-managed prefixes (CSUITE_/OTEL_/…) and
 * interpreter/loader control variables (PATH, LD_*, NODE_OPTIONS, …)
 * are rejected so a `secrets.manage` holder can't break trace
 * capture or gain code execution on runner machines. It is unique
 * across secrets so a member's resolved env map can never carry two
 * values for one variable.
 *
 * Slugs are IMMUTABLE — the change-event thread key
 * (`secret:<slug>`) rides on them; `envName`/`description` are the
 * mutable fields. FK cascades are NOT enforced by this codebase, so
 * `delete()` cascades child rows explicitly inside one transaction.
 */

import { isReservedEnvName } from 'csuite-sdk/schemas';
import type { Secret } from 'csuite-sdk/types';
import type { DatabaseSyncInstance, StatementInstance } from './db.js';
import { decryptField, encryptField } from './kek.js';
import { getKek } from './members.js';
import { validateSourceSlug } from './tool-sources/index.js';

export class SecretsError extends Error {
  readonly code: 'not_found' | 'invalid_input' | 'slug_taken' | 'env_taken' | 'no_kek';
  constructor(code: SecretsError['code'], message: string) {
    super(message);
    this.name = 'SecretsError';
    this.code = code;
  }
}

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const ENV_NAME_MAX = 128;
const VALUE_MAX = 32_768;

export function validateEnvName(envName: string): void {
  if (typeof envName !== 'string' || envName.length === 0) {
    throw new SecretsError('invalid_input', 'envName is required');
  }
  if (envName.length > ENV_NAME_MAX) {
    throw new SecretsError('invalid_input', `envName too long (max ${ENV_NAME_MAX})`);
  }
  if (!ENV_NAME_PATTERN.test(envName)) {
    throw new SecretsError(
      'invalid_input',
      'envName must be an uppercase POSIX environment variable name ([A-Z][A-Z0-9_]*)',
    );
  }
  if (isReservedEnvName(envName)) {
    throw new SecretsError(
      'invalid_input',
      `envName '${envName}' is reserved (runner-managed or an interpreter/loader control variable)`,
    );
  }
}

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS secrets (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    env_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    all_members INTEGER NOT NULL DEFAULT 0 CHECK(all_members IN (0,1)),
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS secrets_slug_idx ON secrets (slug);
  CREATE UNIQUE INDEX IF NOT EXISTS secrets_env_idx ON secrets (env_name);

  CREATE TABLE IF NOT EXISTS secret_bindings (
    secret_id TEXT NOT NULL,
    member_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (secret_id, member_name),
    FOREIGN KEY (secret_id) REFERENCES secrets(id)
  );
  CREATE INDEX IF NOT EXISTS secret_bindings_member_idx
    ON secret_bindings (member_name);

  CREATE TABLE IF NOT EXISTS secret_values (
    secret_id TEXT PRIMARY KEY,
    value_enc TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (secret_id) REFERENCES secrets(id)
  );
`;

interface SecretRow {
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

export interface SecretsStore {
  list(): Secret[];
  /** Enabled secrets delivered to a member: allMembers OR explicitly bound. */
  listForMember(memberName: string): Secret[];
  /**
   * The runner projection: decrypted env delta for a member, keyed by
   * envName. Secrets without a stored value are skipped. Throws
   * `no_kek` when encrypted values exist but no KEK is active.
   */
  resolveFor(memberName: string): Record<string, string>;
  get(id: string): Secret | null;
  getBySlug(slug: string): Secret | null;
  create(input: {
    slug: string;
    envName: string;
    description?: string;
    allMembers?: boolean;
    enabled?: boolean;
    creator: string;
    now?: number;
  }): Secret;
  update(
    id: string,
    patch: {
      envName?: string;
      description?: string;
      allMembers?: boolean;
      enabled?: boolean;
    },
    now?: number,
  ): Secret;
  /** Delete a secret and every child row, in one transaction. */
  delete(id: string): void;

  isBound(secretId: string, memberName: string): boolean;
  listBindings(secretId: string): string[];
  bind(secretId: string, memberName: string, now?: number): void;
  unbind(secretId: string, memberName: string): void;

  /** Upsert the value. Fails closed without a KEK. */
  setValue(secretId: string, value: string, now?: number): void;
  deleteValue(secretId: string): void;
  hasValue(secretId: string): boolean;
  /**
   * Every decryptable stored value, for registering with the core
   * trace redactor at boot (broker-side OTLP/genai ingest redacts
   * captured bodies there). Best-effort: rows that fail to decrypt
   * (KEK mismatch) or no active KEK yield an empty/partial list
   * rather than throwing — redaction registration must never block
   * boot. NOT an API surface; values never leave the process.
   */
  allDecryptedValues(): string[];
}

class SqliteSecretsStore implements SecretsStore {
  private readonly db: DatabaseSyncInstance;

  private readonly beginStmt: StatementInstance;
  private readonly commitStmt: StatementInstance;
  private readonly rollbackStmt: StatementInstance;

  private readonly insertSecretStmt: StatementInstance;
  private readonly updateSecretStmt: StatementInstance;
  private readonly deleteSecretStmt: StatementInstance;
  private readonly selectByIdStmt: StatementInstance;
  private readonly selectBySlugStmt: StatementInstance;
  private readonly selectByEnvNameStmt: StatementInstance;
  private readonly selectAllStmt: StatementInstance;
  private readonly selectForMemberStmt: StatementInstance;

  private readonly insertBindingStmt: StatementInstance;
  private readonly deleteBindingStmt: StatementInstance;
  private readonly deleteBindingsStmt: StatementInstance;
  private readonly selectBindingStmt: StatementInstance;
  private readonly selectBindingsStmt: StatementInstance;

  private readonly upsertValueStmt: StatementInstance;
  private readonly selectValueStmt: StatementInstance;
  private readonly deleteValueStmt: StatementInstance;

  constructor(db: DatabaseSyncInstance) {
    this.db = db;
    this.db.exec(CREATE_SCHEMA);

    this.beginStmt = db.prepare('BEGIN');
    this.commitStmt = db.prepare('COMMIT');
    this.rollbackStmt = db.prepare('ROLLBACK');

    const SECRET_COLS =
      'id, slug, env_name, description, enabled, all_members, created_by, created_at, updated_at';
    this.insertSecretStmt = db.prepare(
      `INSERT INTO secrets
        (id, slug, env_name, description, enabled, all_members, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateSecretStmt = db.prepare(
      `UPDATE secrets
       SET env_name = ?, description = ?, enabled = ?, all_members = ?, updated_at = ?
       WHERE id = ?`,
    );
    this.deleteSecretStmt = db.prepare('DELETE FROM secrets WHERE id = ?');
    this.selectByIdStmt = db.prepare(`SELECT ${SECRET_COLS} FROM secrets WHERE id = ?`);
    this.selectBySlugStmt = db.prepare(`SELECT ${SECRET_COLS} FROM secrets WHERE slug = ?`);
    this.selectByEnvNameStmt = db.prepare(`SELECT ${SECRET_COLS} FROM secrets WHERE env_name = ?`);
    this.selectAllStmt = db.prepare(`SELECT ${SECRET_COLS} FROM secrets ORDER BY created_at ASC`);
    this.selectForMemberStmt = db.prepare(
      `SELECT ${SECRET_COLS} FROM secrets s
       WHERE s.enabled = 1
         AND (s.all_members = 1 OR EXISTS (
           SELECT 1 FROM secret_bindings b
           WHERE b.secret_id = s.id AND b.member_name = ?
         ))
       ORDER BY s.created_at ASC`,
    );

    this.insertBindingStmt = db.prepare(
      'INSERT OR IGNORE INTO secret_bindings (secret_id, member_name, created_at) VALUES (?, ?, ?)',
    );
    this.deleteBindingStmt = db.prepare(
      'DELETE FROM secret_bindings WHERE secret_id = ? AND member_name = ?',
    );
    this.deleteBindingsStmt = db.prepare('DELETE FROM secret_bindings WHERE secret_id = ?');
    this.selectBindingStmt = db.prepare(
      'SELECT 1 FROM secret_bindings WHERE secret_id = ? AND member_name = ?',
    );
    this.selectBindingsStmt = db.prepare(
      'SELECT member_name FROM secret_bindings WHERE secret_id = ? ORDER BY created_at ASC',
    );

    this.upsertValueStmt = db.prepare(
      `INSERT INTO secret_values (secret_id, value_enc, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (secret_id)
       DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
    );
    this.selectValueStmt = db.prepare('SELECT value_enc FROM secret_values WHERE secret_id = ?');
    this.deleteValueStmt = db.prepare('DELETE FROM secret_values WHERE secret_id = ?');
  }

  list(): Secret[] {
    const rows = this.selectAllStmt.all() as unknown as SecretRow[];
    return rows.map(rowToSecret);
  }

  listForMember(memberName: string): Secret[] {
    const rows = this.selectForMemberStmt.all(memberName) as unknown as SecretRow[];
    return rows.map(rowToSecret);
  }

  resolveFor(memberName: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const secret of this.listForMember(memberName)) {
      const row = this.selectValueStmt.get(secret.id) as { value_enc: string } | undefined;
      if (!row) continue;
      const kek = getKek();
      if (kek === null) {
        throw new SecretsError('no_kek', 'no encryption key is active; cannot resolve secrets');
      }
      // decryptField throws EncryptedFieldError on KEK mismatch — let
      // it propagate; the app layer maps it to a 500 without detail.
      const value = decryptField(row.value_enc, kek);
      if (value === null) continue;
      env[secret.envName] = value;
    }
    return env;
  }

  get(id: string): Secret | null {
    const row = this.selectByIdStmt.get(id) as SecretRow | undefined;
    return row ? rowToSecret(row) : null;
  }

  getBySlug(slug: string): Secret | null {
    const row = this.selectBySlugStmt.get(slug) as SecretRow | undefined;
    return row ? rowToSecret(row) : null;
  }

  create(input: {
    slug: string;
    envName: string;
    description?: string;
    allMembers?: boolean;
    enabled?: boolean;
    creator: string;
    now?: number;
  }): Secret {
    try {
      validateSourceSlug(input.slug);
    } catch (err) {
      throw new SecretsError('invalid_input', err instanceof Error ? err.message : String(err));
    }
    validateEnvName(input.envName);
    if (this.getBySlug(input.slug)) {
      throw new SecretsError('slug_taken', `a secret called "${input.slug}" already exists`);
    }
    const envHolder = this.selectByEnvNameStmt.get(input.envName) as SecretRow | undefined;
    if (envHolder) {
      throw new SecretsError(
        'env_taken',
        `secret "${envHolder.slug}" already targets ${input.envName}`,
      );
    }
    const now = input.now ?? Date.now();
    const id = globalThis.crypto.randomUUID();
    this.insertSecretStmt.run(
      id,
      input.slug,
      input.envName,
      input.description ?? '',
      input.enabled === false ? 0 : 1,
      input.allMembers === true ? 1 : 0,
      input.creator,
      now,
      now,
    );
    const created = this.get(id);
    if (!created) throw new Error('secrets.create: row vanished after insert');
    return created;
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
  ): Secret {
    const existing = this.get(id);
    if (!existing) throw new SecretsError('not_found', `secret ${id} not found`);
    const envName = patch.envName ?? existing.envName;
    if (envName !== existing.envName) {
      validateEnvName(envName);
      const envHolder = this.selectByEnvNameStmt.get(envName) as SecretRow | undefined;
      if (envHolder && envHolder.id !== id) {
        throw new SecretsError(
          'env_taken',
          `secret "${envHolder.slug}" already targets ${envName}`,
        );
      }
    }
    this.updateSecretStmt.run(
      envName,
      patch.description ?? existing.description,
      (patch.enabled ?? existing.enabled) ? 1 : 0,
      (patch.allMembers ?? existing.allMembers) ? 1 : 0,
      now,
      id,
    );
    return this.get(id) as Secret;
  }

  delete(id: string): void {
    const existing = this.get(id);
    if (!existing) throw new SecretsError('not_found', `secret ${id} not found`);
    // FK cascades aren't enforced — delete children explicitly, all
    // or nothing.
    this.beginStmt.run();
    try {
      this.deleteBindingsStmt.run(id);
      this.deleteValueStmt.run(id);
      this.deleteSecretStmt.run(id);
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

  isBound(secretId: string, memberName: string): boolean {
    return this.selectBindingStmt.get(secretId, memberName) !== undefined;
  }

  listBindings(secretId: string): string[] {
    const rows = this.selectBindingsStmt.all(secretId) as unknown as Array<{
      member_name: string;
    }>;
    return rows.map((r) => r.member_name);
  }

  bind(secretId: string, memberName: string, now: number = Date.now()): void {
    if (!this.get(secretId)) {
      throw new SecretsError('not_found', `secret ${secretId} not found`);
    }
    this.insertBindingStmt.run(secretId, memberName, now);
  }

  unbind(secretId: string, memberName: string): void {
    this.deleteBindingStmt.run(secretId, memberName);
  }

  setValue(secretId: string, value: string, now: number = Date.now()): void {
    if (!this.get(secretId)) {
      throw new SecretsError('not_found', `secret ${secretId} not found`);
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new SecretsError('invalid_input', 'value is required');
    }
    if (value.length > VALUE_MAX) {
      throw new SecretsError('invalid_input', `value too long (max ${VALUE_MAX})`);
    }
    const kek = getKek();
    if (kek === null) {
      // Fail closed — never store a secret in plaintext.
      throw new SecretsError('no_kek', 'no encryption key is active; cannot store a secret value');
    }
    const encrypted = encryptField(value, kek);
    if (encrypted === null) {
      throw new SecretsError('invalid_input', 'value is required');
    }
    this.upsertValueStmt.run(secretId, encrypted, now, now);
  }

  deleteValue(secretId: string): void {
    this.deleteValueStmt.run(secretId);
  }

  hasValue(secretId: string): boolean {
    return this.selectValueStmt.get(secretId) !== undefined;
  }

  allDecryptedValues(): string[] {
    const kek = getKek();
    if (kek === null) return [];
    const values: string[] = [];
    for (const secret of this.list()) {
      const row = this.selectValueStmt.get(secret.id) as { value_enc: string } | undefined;
      if (!row) continue;
      try {
        const value = decryptField(row.value_enc, kek);
        if (value !== null) values.push(value);
      } catch {
        /* KEK mismatch on one row must not block the rest */
      }
    }
    return values;
  }
}

function rowToSecret(row: SecretRow): Secret {
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

export function createSqliteSecretsStore(db: DatabaseSyncInstance): SecretsStore {
  return new SqliteSecretsStore(db);
}
