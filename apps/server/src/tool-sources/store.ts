/**
 * Tool-sources store — SQLite-backed registry of platform-defined
 * external tools.
 *
 * A tool source is either:
 *   - `custom` — declaratively defined tools (name, description, JSON
 *     input schema, HTTP binding) the broker executes against a
 *     third-party API with a stored credential, or
 *   - `mcp`    — a remote MCP server the broker connects to as a
 *     client; upstream tools are discovered into `mcp_tools_cache`
 *     and relayed.
 *
 * Shares the main `DatabaseSync` handle with channels/objectives.
 * Credentials are KEK-encrypted at rest (`enc-v1:` envelope) and
 * WRITE-ONLY over the wire — no store method returns the secret
 * except `getCredential`, which only the invoke path calls.
 *
 * Deliberate deviation from team-store's TOTP handling: credential
 * writes FAIL CLOSED when no KEK is active (`no_kek`). TOTP tolerates
 * plaintext for migration reasons; these are fresh third-party
 * secrets with no legacy to migrate.
 *
 * Slugs are IMMUTABLE in v1 — the change-event thread key
 * (`tool:<slug>`) rides on them; `displayName` is the mutable label.
 *
 * FK cascades are NOT enforced by this codebase (PRAGMA foreign_keys
 * is never enabled), so `delete()` cascades child rows explicitly
 * inside one transaction.
 */

import type {
  CustomToolDef,
  ResolvedTool,
  ResolvedToolSource,
  ToolCredentialKind,
  ToolSource,
  ToolSourceConfig,
  ToolSourceKind,
} from 'csuite-sdk/types';
import type { DatabaseSyncInstance, StatementInstance } from '../db.js';
import { decryptField, encryptField } from '../kek.js';
import { getKek } from '../members.js';
import { validateBinding } from './template.js';

export class ToolSourcesError extends Error {
  readonly code: 'not_found' | 'invalid_input' | 'slug_taken' | 'kind_mismatch' | 'no_kek';
  constructor(code: ToolSourcesError['code'], message: string) {
    super(message);
    this.name = 'ToolSourcesError';
    this.code = code;
  }
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/;
const SLUG_MAX = 32;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function validateSourceSlug(slug: string): void {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new ToolSourcesError('invalid_input', 'slug is required');
  }
  if (slug.length > SLUG_MAX) {
    throw new ToolSourcesError('invalid_input', `slug too long (max ${SLUG_MAX})`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new ToolSourcesError(
      'invalid_input',
      'slug must be lowercase letters/digits/dashes, no consecutive dashes, no leading/trailing dash',
    );
  }
}

export interface DecryptedCredential {
  kind: ToolCredentialKind;
  headerName: string | null;
  secret: string;
  updatedAt: number;
}

export interface McpCachedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown> | null;
}

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tool_sources (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('custom','mcp')),
    display_name TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    all_members INTEGER NOT NULL DEFAULT 0 CHECK(all_members IN (0,1)),
    config_json TEXT NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS tool_sources_slug_idx ON tool_sources (slug);

  CREATE TABLE IF NOT EXISTS tool_source_bindings (
    source_id TEXT NOT NULL,
    member_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, member_name),
    FOREIGN KEY (source_id) REFERENCES tool_sources(id)
  );
  CREATE INDEX IF NOT EXISTS tool_source_bindings_member_idx
    ON tool_source_bindings (member_name);

  CREATE TABLE IF NOT EXISTS tool_source_credentials (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    member_name TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('bearer','header')),
    header_name TEXT,
    secret_enc TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (source_id) REFERENCES tool_sources(id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS tool_source_credentials_scope_idx
    ON tool_source_credentials (source_id, IFNULL(member_name, ''));

  CREATE TABLE IF NOT EXISTS custom_tools (
    source_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    input_schema_json TEXT NOT NULL,
    binding_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, name),
    FOREIGN KEY (source_id) REFERENCES tool_sources(id)
  );

  CREATE TABLE IF NOT EXISTS mcp_tools_cache (
    source_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    input_schema_json TEXT NOT NULL,
    annotations_json TEXT,
    discovered_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, name),
    FOREIGN KEY (source_id) REFERENCES tool_sources(id)
  );
`;

interface SourceRow {
  id: string;
  slug: string;
  kind: string;
  display_name: string;
  enabled: number;
  all_members: number;
  config_json: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface CredentialRow {
  kind: string;
  header_name: string | null;
  secret_enc: string;
  updated_at: number;
}

interface CustomToolRow {
  source_id: string;
  name: string;
  description: string;
  input_schema_json: string;
  binding_json: string;
}

interface McpToolRow {
  source_id: string;
  name: string;
  description: string;
  input_schema_json: string;
  annotations_json: string | null;
}

export interface ToolSourceStore {
  list(): ToolSource[];
  /** Enabled sources visible to a member: allMembers OR explicitly bound. */
  listForMember(memberName: string): ToolSource[];
  /** The briefing projection: visible sources with their tool lists. */
  resolveFor(memberName: string): ResolvedToolSource[];
  get(id: string): ToolSource | null;
  getBySlug(slug: string): ToolSource | null;
  create(input: {
    slug: string;
    kind: ToolSourceKind;
    displayName?: string;
    config?: ToolSourceConfig;
    allMembers?: boolean;
    enabled?: boolean;
    creator: string;
    now?: number;
  }): ToolSource;
  update(
    id: string,
    patch: {
      displayName?: string;
      config?: ToolSourceConfig;
      allMembers?: boolean;
      enabled?: boolean;
    },
    now?: number,
  ): ToolSource;
  /** Delete a source and every child row, in one transaction. */
  delete(id: string): void;

  isBound(sourceId: string, memberName: string): boolean;
  listBindings(sourceId: string): string[];
  bind(sourceId: string, memberName: string, now?: number): void;
  unbind(sourceId: string, memberName: string): void;

  /** Upsert the source-wide credential. Fails closed without a KEK. */
  setCredential(
    sourceId: string,
    input: { kind: ToolCredentialKind; headerName?: string; secret: string },
    now?: number,
  ): void;
  /** Decrypted credential — invoke path only. Null when unset. */
  getCredential(sourceId: string): DecryptedCredential | null;
  deleteCredential(sourceId: string): void;
  hasCredential(sourceId: string): boolean;
  /** Epoch-ms of the last credential write (0 when unset) — MCP fingerprint input. */
  credentialUpdatedAt(sourceId: string): number;

  upsertCustomTool(sourceId: string, tool: CustomToolDef, now?: number): void;
  deleteCustomTool(sourceId: string, name: string): void;
  listCustomTools(sourceId: string): CustomToolDef[];
  getCustomTool(sourceId: string, name: string): CustomToolDef | null;

  /** Replace the MCP discovery cache. Returns whether the set changed. */
  replaceMcpToolsCache(
    sourceId: string,
    tools: McpCachedTool[],
    now?: number,
  ): { changed: boolean };
  listMcpToolsCache(sourceId: string): McpCachedTool[];
  getMcpCachedTool(sourceId: string, name: string): McpCachedTool | null;

  /** Tool count for summaries (defs for custom, cache rows for mcp). */
  toolCount(sourceId: string, kind: ToolSourceKind): number;
}

class SqliteToolSourceStore implements ToolSourceStore {
  private readonly db: DatabaseSyncInstance;

  private readonly beginStmt: StatementInstance;
  private readonly commitStmt: StatementInstance;
  private readonly rollbackStmt: StatementInstance;

  private readonly insertSourceStmt: StatementInstance;
  private readonly updateSourceStmt: StatementInstance;
  private readonly deleteSourceStmt: StatementInstance;
  private readonly selectByIdStmt: StatementInstance;
  private readonly selectBySlugStmt: StatementInstance;
  private readonly selectAllStmt: StatementInstance;
  private readonly selectForMemberStmt: StatementInstance;

  private readonly insertBindingStmt: StatementInstance;
  private readonly deleteBindingStmt: StatementInstance;
  private readonly deleteBindingsStmt: StatementInstance;
  private readonly selectBindingStmt: StatementInstance;
  private readonly selectBindingsStmt: StatementInstance;

  private readonly upsertCredentialStmt: StatementInstance;
  private readonly selectCredentialStmt: StatementInstance;
  private readonly deleteCredentialStmt: StatementInstance;
  private readonly deleteCredentialsStmt: StatementInstance;

  private readonly upsertCustomToolStmt: StatementInstance;
  private readonly deleteCustomToolStmt: StatementInstance;
  private readonly deleteCustomToolsStmt: StatementInstance;
  private readonly selectCustomToolsStmt: StatementInstance;
  private readonly selectCustomToolStmt: StatementInstance;
  private readonly countCustomToolsStmt: StatementInstance;

  private readonly insertMcpToolStmt: StatementInstance;
  private readonly deleteMcpToolsStmt: StatementInstance;
  private readonly selectMcpToolsStmt: StatementInstance;
  private readonly selectMcpToolStmt: StatementInstance;
  private readonly countMcpToolsStmt: StatementInstance;

  constructor(db: DatabaseSyncInstance) {
    this.db = db;
    this.db.exec(CREATE_SCHEMA);

    this.beginStmt = db.prepare('BEGIN');
    this.commitStmt = db.prepare('COMMIT');
    this.rollbackStmt = db.prepare('ROLLBACK');

    this.insertSourceStmt = db.prepare(
      `INSERT INTO tool_sources
        (id, slug, kind, display_name, enabled, all_members, config_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateSourceStmt = db.prepare(
      `UPDATE tool_sources
       SET display_name = ?, enabled = ?, all_members = ?, config_json = ?, updated_at = ?
       WHERE id = ?`,
    );
    this.deleteSourceStmt = db.prepare('DELETE FROM tool_sources WHERE id = ?');
    const SOURCE_COLS =
      'id, slug, kind, display_name, enabled, all_members, config_json, created_by, created_at, updated_at';
    this.selectByIdStmt = db.prepare(`SELECT ${SOURCE_COLS} FROM tool_sources WHERE id = ?`);
    this.selectBySlugStmt = db.prepare(`SELECT ${SOURCE_COLS} FROM tool_sources WHERE slug = ?`);
    this.selectAllStmt = db.prepare(
      `SELECT ${SOURCE_COLS} FROM tool_sources ORDER BY created_at ASC`,
    );
    this.selectForMemberStmt = db.prepare(
      `SELECT ${SOURCE_COLS} FROM tool_sources s
       WHERE s.enabled = 1
         AND (s.all_members = 1 OR EXISTS (
           SELECT 1 FROM tool_source_bindings b
           WHERE b.source_id = s.id AND b.member_name = ?
         ))
       ORDER BY s.created_at ASC`,
    );

    this.insertBindingStmt = db.prepare(
      'INSERT OR IGNORE INTO tool_source_bindings (source_id, member_name, created_at) VALUES (?, ?, ?)',
    );
    this.deleteBindingStmt = db.prepare(
      'DELETE FROM tool_source_bindings WHERE source_id = ? AND member_name = ?',
    );
    this.deleteBindingsStmt = db.prepare('DELETE FROM tool_source_bindings WHERE source_id = ?');
    this.selectBindingStmt = db.prepare(
      'SELECT 1 FROM tool_source_bindings WHERE source_id = ? AND member_name = ?',
    );
    this.selectBindingsStmt = db.prepare(
      'SELECT member_name FROM tool_source_bindings WHERE source_id = ? ORDER BY created_at ASC',
    );

    // Source-wide credential only in v1 (member_name IS NULL). The
    // unique index on (source_id, IFNULL(member_name,'')) makes this
    // an upsert target.
    this.upsertCredentialStmt = db.prepare(
      `INSERT INTO tool_source_credentials
        (id, source_id, member_name, kind, header_name, secret_enc, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, IFNULL(member_name, ''))
       DO UPDATE SET kind = excluded.kind, header_name = excluded.header_name,
                     secret_enc = excluded.secret_enc, updated_at = excluded.updated_at`,
    );
    this.selectCredentialStmt = db.prepare(
      `SELECT kind, header_name, secret_enc, updated_at
       FROM tool_source_credentials WHERE source_id = ? AND member_name IS NULL`,
    );
    this.deleteCredentialStmt = db.prepare(
      'DELETE FROM tool_source_credentials WHERE source_id = ? AND member_name IS NULL',
    );
    this.deleteCredentialsStmt = db.prepare(
      'DELETE FROM tool_source_credentials WHERE source_id = ?',
    );

    this.upsertCustomToolStmt = db.prepare(
      `INSERT INTO custom_tools
        (source_id, name, description, input_schema_json, binding_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, name)
       DO UPDATE SET description = excluded.description,
                     input_schema_json = excluded.input_schema_json,
                     binding_json = excluded.binding_json,
                     updated_at = excluded.updated_at`,
    );
    this.deleteCustomToolStmt = db.prepare(
      'DELETE FROM custom_tools WHERE source_id = ? AND name = ?',
    );
    this.deleteCustomToolsStmt = db.prepare('DELETE FROM custom_tools WHERE source_id = ?');
    this.selectCustomToolsStmt = db.prepare(
      `SELECT source_id, name, description, input_schema_json, binding_json
       FROM custom_tools WHERE source_id = ? ORDER BY name ASC`,
    );
    this.selectCustomToolStmt = db.prepare(
      `SELECT source_id, name, description, input_schema_json, binding_json
       FROM custom_tools WHERE source_id = ? AND name = ?`,
    );
    this.countCustomToolsStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM custom_tools WHERE source_id = ?',
    );

    this.insertMcpToolStmt = db.prepare(
      `INSERT INTO mcp_tools_cache
        (source_id, name, description, input_schema_json, annotations_json, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.deleteMcpToolsStmt = db.prepare('DELETE FROM mcp_tools_cache WHERE source_id = ?');
    this.selectMcpToolsStmt = db.prepare(
      `SELECT source_id, name, description, input_schema_json, annotations_json
       FROM mcp_tools_cache WHERE source_id = ? ORDER BY name ASC`,
    );
    this.selectMcpToolStmt = db.prepare(
      `SELECT source_id, name, description, input_schema_json, annotations_json
       FROM mcp_tools_cache WHERE source_id = ? AND name = ?`,
    );
    this.countMcpToolsStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM mcp_tools_cache WHERE source_id = ?',
    );
  }

  list(): ToolSource[] {
    const rows = this.selectAllStmt.all() as unknown as SourceRow[];
    return rows.map(rowToSource);
  }

  listForMember(memberName: string): ToolSource[] {
    const rows = this.selectForMemberStmt.all(memberName) as unknown as SourceRow[];
    return rows.map(rowToSource);
  }

  resolveFor(memberName: string): ResolvedToolSource[] {
    return this.listForMember(memberName).map((source) => ({
      source: source.slug,
      kind: source.kind,
      tools: this.resolvedToolsOf(source),
    }));
  }

  private resolvedToolsOf(source: ToolSource): ResolvedTool[] {
    if (source.kind === 'custom') {
      return this.listCustomTools(source.id).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    }
    return this.listMcpToolsCache(source.id).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  get(id: string): ToolSource | null {
    const row = this.selectByIdStmt.get(id) as SourceRow | undefined;
    return row ? rowToSource(row) : null;
  }

  getBySlug(slug: string): ToolSource | null {
    const row = this.selectBySlugStmt.get(slug) as SourceRow | undefined;
    return row ? rowToSource(row) : null;
  }

  create(input: {
    slug: string;
    kind: ToolSourceKind;
    displayName?: string;
    config?: ToolSourceConfig;
    allMembers?: boolean;
    enabled?: boolean;
    creator: string;
    now?: number;
  }): ToolSource {
    validateSourceSlug(input.slug);
    if (input.kind !== 'custom' && input.kind !== 'mcp') {
      throw new ToolSourcesError('invalid_input', `unknown kind: ${String(input.kind)}`);
    }
    const config = input.config ?? {};
    validateConfig(input.kind, config);
    if (this.getBySlug(input.slug)) {
      throw new ToolSourcesError(
        'slug_taken',
        `a tool source called "${input.slug}" already exists`,
      );
    }
    const now = input.now ?? Date.now();
    const id = globalThis.crypto.randomUUID();
    this.insertSourceStmt.run(
      id,
      input.slug,
      input.kind,
      input.displayName ?? '',
      input.enabled === false ? 0 : 1,
      input.allMembers === true ? 1 : 0,
      JSON.stringify(config),
      input.creator,
      now,
      now,
    );
    const created = this.get(id);
    if (!created) throw new Error('tool-sources.create: row vanished after insert');
    return created;
  }

  update(
    id: string,
    patch: {
      displayName?: string;
      config?: ToolSourceConfig;
      allMembers?: boolean;
      enabled?: boolean;
    },
    now: number = Date.now(),
  ): ToolSource {
    const existing = this.get(id);
    if (!existing) throw new ToolSourcesError('not_found', `tool source ${id} not found`);
    const config = patch.config ?? existing.config;
    validateConfig(existing.kind, config);
    this.updateSourceStmt.run(
      patch.displayName ?? existing.displayName,
      (patch.enabled ?? existing.enabled) ? 1 : 0,
      (patch.allMembers ?? existing.allMembers) ? 1 : 0,
      JSON.stringify(config),
      now,
      id,
    );
    return this.get(id) as ToolSource;
  }

  delete(id: string): void {
    const existing = this.get(id);
    if (!existing) throw new ToolSourcesError('not_found', `tool source ${id} not found`);
    // FK cascades aren't enforced — delete children explicitly, all
    // or nothing.
    this.beginStmt.run();
    try {
      this.deleteBindingsStmt.run(id);
      this.deleteCredentialsStmt.run(id);
      this.deleteCustomToolsStmt.run(id);
      this.deleteMcpToolsStmt.run(id);
      this.deleteSourceStmt.run(id);
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

  isBound(sourceId: string, memberName: string): boolean {
    return this.selectBindingStmt.get(sourceId, memberName) !== undefined;
  }

  listBindings(sourceId: string): string[] {
    const rows = this.selectBindingsStmt.all(sourceId) as unknown as Array<{
      member_name: string;
    }>;
    return rows.map((r) => r.member_name);
  }

  bind(sourceId: string, memberName: string, now: number = Date.now()): void {
    if (!this.get(sourceId)) {
      throw new ToolSourcesError('not_found', `tool source ${sourceId} not found`);
    }
    this.insertBindingStmt.run(sourceId, memberName, now);
  }

  unbind(sourceId: string, memberName: string): void {
    this.deleteBindingStmt.run(sourceId, memberName);
  }

  setCredential(
    sourceId: string,
    input: { kind: ToolCredentialKind; headerName?: string; secret: string },
    now: number = Date.now(),
  ): void {
    if (!this.get(sourceId)) {
      throw new ToolSourcesError('not_found', `tool source ${sourceId} not found`);
    }
    if (input.kind === 'header' && !input.headerName) {
      throw new ToolSourcesError('invalid_input', 'headerName is required when kind=header');
    }
    const kek = getKek();
    if (kek === null) {
      // Fail closed — never store a third-party secret in plaintext.
      throw new ToolSourcesError(
        'no_kek',
        'no encryption key is active; cannot store a credential',
      );
    }
    const encrypted = encryptField(input.secret, kek);
    if (encrypted === null) {
      throw new ToolSourcesError('invalid_input', 'secret is required');
    }
    this.upsertCredentialStmt.run(
      globalThis.crypto.randomUUID(),
      sourceId,
      input.kind,
      input.kind === 'header' ? (input.headerName as string) : null,
      encrypted,
      now,
      now,
    );
  }

  getCredential(sourceId: string): DecryptedCredential | null {
    const row = this.selectCredentialStmt.get(sourceId) as CredentialRow | undefined;
    if (!row) return null;
    const kek = getKek();
    if (kek === null) {
      throw new ToolSourcesError('no_kek', 'no encryption key is active; cannot read credential');
    }
    // decryptField throws EncryptedFieldError on KEK mismatch — let
    // it propagate; the app layer maps it to a 500 without detail.
    const secret = decryptField(row.secret_enc, kek);
    if (secret === null) return null;
    return {
      kind: row.kind === 'header' ? 'header' : 'bearer',
      headerName: row.header_name,
      secret,
      updatedAt: row.updated_at,
    };
  }

  deleteCredential(sourceId: string): void {
    this.deleteCredentialStmt.run(sourceId);
  }

  hasCredential(sourceId: string): boolean {
    return this.selectCredentialStmt.get(sourceId) !== undefined;
  }

  credentialUpdatedAt(sourceId: string): number {
    const row = this.selectCredentialStmt.get(sourceId) as CredentialRow | undefined;
    return row?.updated_at ?? 0;
  }

  upsertCustomTool(sourceId: string, tool: CustomToolDef, now: number = Date.now()): void {
    const source = this.get(sourceId);
    if (!source) throw new ToolSourcesError('not_found', `tool source ${sourceId} not found`);
    if (source.kind !== 'custom') {
      throw new ToolSourcesError('kind_mismatch', 'tool definitions only apply to custom sources');
    }
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new ToolSourcesError(
        'invalid_input',
        'tool name must be 1-64 chars of letters/digits/_/-',
      );
    }
    // Save-time binding validation is the security gate (SSRF static
    // origin, header injection, credential shadowing) — a binding
    // that passes here is safe to execute later.
    const credential = this.selectCredentialStmt.get(sourceId) as CredentialRow | undefined;
    try {
      validateBinding(tool.binding, {
        credentialHeaderName: credential?.header_name ?? null,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'BindingValidationError') {
        throw new ToolSourcesError('invalid_input', err.message);
      }
      throw err;
    }
    this.upsertCustomToolStmt.run(
      sourceId,
      tool.name,
      tool.description,
      JSON.stringify(tool.inputSchema),
      JSON.stringify(tool.binding),
      now,
      now,
    );
  }

  deleteCustomTool(sourceId: string, name: string): void {
    this.deleteCustomToolStmt.run(sourceId, name);
  }

  listCustomTools(sourceId: string): CustomToolDef[] {
    const rows = this.selectCustomToolsStmt.all(sourceId) as unknown as CustomToolRow[];
    return rows.map(rowToCustomTool);
  }

  getCustomTool(sourceId: string, name: string): CustomToolDef | null {
    const row = this.selectCustomToolStmt.get(sourceId, name) as CustomToolRow | undefined;
    return row ? rowToCustomTool(row) : null;
  }

  replaceMcpToolsCache(
    sourceId: string,
    tools: McpCachedTool[],
    now: number = Date.now(),
  ): { changed: boolean } {
    if (!this.get(sourceId)) {
      throw new ToolSourcesError('not_found', `tool source ${sourceId} not found`);
    }
    const before = this.listMcpToolsCache(sourceId);
    const fingerprint = (list: McpCachedTool[]): string =>
      JSON.stringify(
        [...list]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((t) => [t.name, t.description, JSON.stringify(t.inputSchema)]),
      );
    const changed = fingerprint(before) !== fingerprint(tools);
    this.beginStmt.run();
    try {
      this.deleteMcpToolsStmt.run(sourceId);
      for (const tool of tools) {
        this.insertMcpToolStmt.run(
          sourceId,
          tool.name,
          tool.description,
          JSON.stringify(tool.inputSchema),
          tool.annotations ? JSON.stringify(tool.annotations) : null,
          now,
        );
      }
      this.commitStmt.run();
    } catch (err) {
      try {
        this.rollbackStmt.run();
      } catch {
        /* ignore */
      }
      throw err;
    }
    return { changed };
  }

  listMcpToolsCache(sourceId: string): McpCachedTool[] {
    const rows = this.selectMcpToolsStmt.all(sourceId) as unknown as McpToolRow[];
    return rows.map(rowToMcpTool);
  }

  getMcpCachedTool(sourceId: string, name: string): McpCachedTool | null {
    const row = this.selectMcpToolStmt.get(sourceId, name) as McpToolRow | undefined;
    return row ? rowToMcpTool(row) : null;
  }

  toolCount(sourceId: string, kind: ToolSourceKind): number {
    const stmt = kind === 'custom' ? this.countCustomToolsStmt : this.countMcpToolsStmt;
    const row = stmt.get(sourceId) as { n: number } | undefined;
    return row?.n ?? 0;
  }
}

function validateConfig(kind: ToolSourceKind, config: ToolSourceConfig): void {
  if (kind === 'mcp') {
    if (!config.url) {
      throw new ToolSourcesError('invalid_input', 'mcp sources require config.url');
    }
    let parsed: URL;
    try {
      parsed = new URL(config.url);
    } catch {
      throw new ToolSourcesError('invalid_input', 'config.url is not a valid URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ToolSourcesError('invalid_input', 'config.url must be http(s)');
    }
  }
  if (config.timeoutMs !== undefined && (config.timeoutMs < 1_000 || config.timeoutMs > 120_000)) {
    throw new ToolSourcesError('invalid_input', 'config.timeoutMs must be between 1000 and 120000');
  }
}

function rowToSource(row: SourceRow): ToolSource {
  let config: ToolSourceConfig = {};
  try {
    const parsed = JSON.parse(row.config_json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as ToolSourceConfig;
    }
  } catch {
    /* corrupt config: expose empty rather than crash reads */
  }
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind === 'mcp' ? 'mcp' : 'custom',
    displayName: row.display_name,
    enabled: row.enabled === 1,
    allMembers: row.all_members === 1,
    config,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCustomTool(row: CustomToolRow): CustomToolDef {
  return {
    name: row.name,
    description: row.description,
    inputSchema: parseJsonObject(row.input_schema_json),
    binding: JSON.parse(row.binding_json),
  };
}

function rowToMcpTool(row: McpToolRow): McpCachedTool {
  return {
    name: row.name,
    description: row.description,
    inputSchema: parseJsonObject(row.input_schema_json),
    annotations: row.annotations_json ? parseJsonObject(row.annotations_json) : null,
  };
}

function parseJsonObject(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

export function createSqliteToolSourceStore(db: DatabaseSyncInstance): ToolSourceStore {
  return new SqliteToolSourceStore(db);
}
