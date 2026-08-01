/**
 * The runner environment namespace, shared by secrets and variables.
 *
 * Two stores write into one environment map. A member's resolved env
 * can never carry two values for one variable name, and that invariant
 * does not care which store a row lives in — so the schema for both,
 * and the collision check across both, live here rather than in either
 * one.
 *
 * WHY TWO TABLES INSTEAD OF A `kind` COLUMN. A variable's value is
 * readable by authorised callers; a secret's is write-only and leaves
 * the process only via `resolveFor`. On one table that difference is
 * held by a conditional — every read path must remember to filter
 * `kind = 'variable'`, and the first one that forgets publishes every
 * secret on the broker. On two tables it is held by the type: no
 * method on `SecretsStore` returns a value except `resolveFor`, so a
 * variables read path cannot expose a secret because secrets are not
 * in it.
 *
 * The cost is this module. The collision check that `secrets.ts` used
 * to run against one table now runs against two, and it must be
 * called from create, update and bind on BOTH stores. That is a wider
 * check, deliberately taken in exchange for a narrower blast radius:
 * a missed check here collides one environment variable and says so;
 * a missed `kind` filter would have leaked the secrets table.
 *
 * A collision is an ERROR, never a precedence rule. If a member would
 * resolve one name from both stores, resolution fails loudly rather
 * than picking a winner — a silent precedence rule is one more thing
 * to remember, and it would be remembered wrong.
 */

import type { DatabaseSyncInstance } from './db.js';

/**
 * Schema for both halves of the namespace. Idempotent, and created by
 * whichever store is constructed first — each store calls this, so
 * cross-table queries can never run against a table that does not
 * exist yet.
 */
const ENV_NAMESPACE_SCHEMA = `
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
  -- env_name is deliberately NOT globally unique. The invariant that
  -- matters is per-member: no single member may resolve two values for
  -- one variable. A global unique index enforces that, but also forbids
  -- the per-agent pattern this team runs on: cora-github-token and
  -- rune-github-token both targeting GITHUB_TOKEN, bound to different
  -- members and never colliding for anyone.
  --
  -- DROP rather than "stop creating": existing databases already carry
  -- the index, and leaving it would keep rejecting the second binding
  -- with a SQLite constraint error instead of our own message.
  DROP INDEX IF EXISTS secrets_env_idx;
  CREATE INDEX IF NOT EXISTS secrets_env_lookup_idx ON secrets (env_name);

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

  -- Variables mirror secrets structurally and differ in exactly two
  -- ways: the value column is plaintext, and nothing registers it with
  -- the trace redactor.
  --
  -- PLAINTEXT IS THE POINT, not an omission. A variable is a value we
  -- publish — a git author name appears in every commit the member has
  -- ever written. Encrypting it would buy nothing and would make
  -- identity depend on an active KEK, so a broker booted without one
  -- would silently fall back to no identity at all. Values are capped
  -- and validated the same way; they are simply not secret.
  CREATE TABLE IF NOT EXISTS variables (
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
  CREATE UNIQUE INDEX IF NOT EXISTS variables_slug_idx ON variables (slug);
  CREATE INDEX IF NOT EXISTS variables_env_lookup_idx ON variables (env_name);

  CREATE TABLE IF NOT EXISTS variable_bindings (
    variable_id TEXT NOT NULL,
    member_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (variable_id, member_name),
    FOREIGN KEY (variable_id) REFERENCES variables(id)
  );
  CREATE INDEX IF NOT EXISTS variable_bindings_member_idx
    ON variable_bindings (member_name);

  CREATE TABLE IF NOT EXISTS variable_values (
    variable_id TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (variable_id) REFERENCES variables(id)
  );
`;

let ensured: WeakSet<DatabaseSyncInstance> | null = null;

/**
 * Create both halves of the namespace if absent. Safe to call from
 * every store constructor; the statements are all `IF NOT EXISTS` and
 * the per-handle guard keeps repeat construction cheap.
 */
export function ensureEnvNamespaceSchema(db: DatabaseSyncInstance): void {
  if (ensured === null) ensured = new WeakSet();
  if (ensured.has(db)) return;
  db.exec(ENV_NAMESPACE_SCHEMA);
  ensured.add(db);
}

/** Which store a colliding row came from, for the error message. */
export type EnvRivalKind = 'secret' | 'variable';

export interface EnvRival {
  kind: EnvRivalKind;
  slug: string;
}

/**
 * A row in EITHER store, other than `excludeId` in `excludeKind`, that
 * targets `envName` and would actually reach `memberName` — because it
 * applies to all members, or because that member is bound to it.
 *
 * The exclusion is (kind, id) rather than id alone: ids are unique
 * within a store, and a variable must not exclude a secret that
 * happens to share its id.
 */
export function findEnvRivalForMember(
  db: DatabaseSyncInstance,
  envName: string,
  excludeKind: EnvRivalKind,
  excludeId: string,
  memberName: string,
): EnvRival | null {
  const row = db
    .prepare(
      `SELECT 'secret' AS kind, s.slug AS slug FROM secrets s
        WHERE s.env_name = ?1
          AND NOT (?2 = 'secret' AND s.id = ?3)
          AND (s.all_members = 1 OR EXISTS (
                SELECT 1 FROM secret_bindings b
                 WHERE b.secret_id = s.id AND b.member_name = ?4))
       UNION ALL
       SELECT 'variable' AS kind, v.slug AS slug FROM variables v
        WHERE v.env_name = ?1
          AND NOT (?2 = 'variable' AND v.id = ?3)
          AND (v.all_members = 1 OR EXISTS (
                SELECT 1 FROM variable_bindings b
                 WHERE b.variable_id = v.id AND b.member_name = ?4))
       LIMIT 1`,
    )
    .get(envName, excludeKind, excludeId, memberName) as
    | { kind: EnvRivalKind; slug: string }
    | undefined;
  return row ?? null;
}

/**
 * A row in EITHER store targeting `envName` that reaches ANYONE. Used
 * when the row under test applies to all members, where any reachable
 * rival collides by definition.
 */
export function findEnvRivalAnyone(
  db: DatabaseSyncInstance,
  envName: string,
  excludeKind: EnvRivalKind,
  excludeId: string,
): EnvRival | null {
  const row = db
    .prepare(
      `SELECT 'secret' AS kind, s.slug AS slug FROM secrets s
        WHERE s.env_name = ?1
          AND NOT (?2 = 'secret' AND s.id = ?3)
          AND (s.all_members = 1
               OR EXISTS (SELECT 1 FROM secret_bindings b WHERE b.secret_id = s.id))
       UNION ALL
       SELECT 'variable' AS kind, v.slug AS slug FROM variables v
        WHERE v.env_name = ?1
          AND NOT (?2 = 'variable' AND v.id = ?3)
          AND (v.all_members = 1
               OR EXISTS (SELECT 1 FROM variable_bindings b WHERE b.variable_id = v.id))
       LIMIT 1`,
    )
    .get(envName, excludeKind, excludeId) as { kind: EnvRivalKind; slug: string } | undefined;
  return row ?? null;
}

/** Human-readable collision message, identical in shape from either store. */
export function envRivalMessage(memberName: string, envName: string, rival: EnvRival): string {
  return `${memberName} already resolves ${envName} from ${rival.kind} "${rival.slug}"`;
}
