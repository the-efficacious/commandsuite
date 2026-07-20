/**
 * Content-addressed raw API body store.
 *
 * The fidelity layer UNDER the gen_ai view: the complete request and
 * response BYTES of every Claude `/v1/messages` call, exactly as sent
 * and received on the wire, captured BEFORE anything parses, reshapes,
 * or redacts them. The `gen_ai_inference` table is the queryable
 * derived view; each of its rows points back at its source bytes here
 * by sha256 (`request_sha256` / `response_sha256`).
 *
 * ── INVARIANT (the point of this store) ────────────────────────────────
 * Raw bytes are stored VERBATIM: un-redacted, un-parsed, un-reshaped.
 * `sha256(gunzip(raw_blob.bytes))` MUST equal the `hash` primary key.
 * Nothing in this path may call redactJson or otherwise rewrite the
 * body — thinking blocks that arrive redacted-at-source
 * (`"<REDACTED>"`) are stored with those exact bytes, like everything
 * else. `getBlob` re-verifies the hash on every read and returns null
 * (logged) on a mismatch rather than serving corrupted bytes.
 *
 * ── Layout ─────────────────────────────────────────────────────────────
 * Two tables on the dedicated activity DB (same heavy-write,
 * off-the-main-lock rationale as the telemetry + gen_ai stores, same
 * wiring pattern as genai-store.ts):
 *
 *   raw_blob      — one row per DISTINCT body, keyed by sha256 of the
 *                   original bytes. Bytes are gzipped at rest
 *                   (`stored_length` = compressed, `byte_length` =
 *                   original). INSERT OR IGNORE on the hash gives
 *                   whole-body dedup for free — a request body re-sent
 *                   byte-identical across turns stores once.
 *   raw_exchange  — one row per CAPTURE EVENT (a request or response
 *                   observed on the wire), carrying the telemetry
 *                   envelope: member, kind, request_id (bridged later
 *                   for requests — see genai-correlator.ts), prompt /
 *                   session ids, query_source, agent name, model,
 *                   event timestamp. Many exchanges may share one blob.
 */

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DatabaseSyncInstance, StatementInstance } from './db.js';
import { logger as defaultLogger, type Logger } from './logger.js';

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS raw_blob (
    hash TEXT PRIMARY KEY,
    bytes BLOB NOT NULL,
    byte_length INTEGER NOT NULL,
    stored_length INTEGER NOT NULL,
    first_seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS raw_exchange (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('request','response')),
    hash TEXT NOT NULL,
    body_length INTEGER NOT NULL,
    request_id TEXT,
    prompt_id TEXT,
    session_id TEXT,
    query_source TEXT,
    agent_name TEXT,
    model TEXT,
    event_ts INTEGER,
    received_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS raw_exchange_member_ts ON raw_exchange (member_name, event_ts);
  CREATE INDEX IF NOT EXISTS raw_exchange_request_id ON raw_exchange (request_id);
  CREATE INDEX IF NOT EXISTS raw_exchange_hash ON raw_exchange (hash);
`;

/**
 * Telemetry envelope captured alongside the bytes. All fields optional:
 * a request body's OTEL record carries NO request_id (it is bridged in
 * later via `assignRequestId` when the api_request event claims it).
 */
export interface RawBodyEnvelope {
  requestId?: string | null;
  promptId?: string | null;
  sessionId?: string | null;
  querySource?: string | null;
  agentName?: string | null;
  model?: string | null;
  /** Epoch ms of the producing OTEL record. */
  eventTs?: number | null;
}

export interface AppendBodyInput {
  memberName: string;
  kind: 'request' | 'response';
  /** The ORIGINAL wire bytes, verbatim. Hashed and gzipped here. */
  bytes: Buffer;
  envelope?: RawBodyEnvelope;
}

export interface AppendBodyResult {
  /** sha256 hex of the original (pre-gzip) bytes. */
  hash: string;
  /** Rowid of the raw_exchange row recording this capture event. */
  exchangeId: number;
}

/** A raw_exchange row decoded for reads (tests, downstream queries). */
export interface RawExchangeRow {
  id: number;
  memberName: string;
  kind: 'request' | 'response';
  hash: string;
  bodyLength: number;
  requestId: string | null;
  promptId: string | null;
  sessionId: string | null;
  querySource: string | null;
  agentName: string | null;
  model: string | null;
  eventTs: number | null;
  receivedAt: number;
}

/** Optional filters for `list`. `from`/`to` bound on `event_ts`. */
export interface RawBodyQuery {
  memberName?: string;
  kind?: 'request' | 'response';
  requestId?: string;
  hash?: string;
  from?: number;
  to?: number;
  limit?: number;
}

/** Dedup + compression visibility: raw vs stored byte totals. */
export interface RawBodyStats {
  blobs: number;
  exchanges: number;
  /** Sum of original byte lengths across distinct blobs. */
  rawBytes: number;
  /** Sum of gzipped lengths across distinct blobs. */
  storedBytes: number;
}

export interface RawBodyStore {
  /**
   * Store one captured body: content-addressed blob (dedup on hash)
   * plus one exchange row carrying the envelope. Returns the hash and
   * the exchange rowid so the caller can bridge the request_id later.
   */
  appendBody(input: AppendBodyInput): AppendBodyResult;
  /**
   * Bridge the request_id (and thread attribution) onto an exchange
   * row after the fact — the api_request accounting event is the first
   * record carrying it. Fills only NULL fields; never overwrites.
   */
  assignRequestId(
    exchangeId: number,
    patch: { requestId: string; querySource?: string | null; agentName?: string | null },
  ): void;
  /**
   * Read a blob's ORIGINAL bytes back (gunzip + sha256 re-verify).
   * Returns null — logged — when the hash is unknown or the stored
   * bytes fail verification.
   */
  getBlob(hash: string): Buffer | null;
  /** Read exchange rows, oldest-first, with optional filters. */
  list(filter?: RawBodyQuery): RawExchangeRow[];
  /** Total exchange-row count. */
  count(): number;
  /** Blob/exchange counts + raw-vs-stored byte totals. */
  stats(): RawBodyStats;
}

export interface RawBodyStoreOptions {
  logger?: Logger;
}

interface RawExchangeRowRaw {
  id: number | bigint;
  member_name: string;
  kind: 'request' | 'response';
  hash: string;
  body_length: number | bigint;
  request_id: string | null;
  prompt_id: string | null;
  session_id: string | null;
  query_source: string | null;
  agent_name: string | null;
  model: string | null;
  event_ts: number | bigint | null;
  received_at: number | bigint;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

class SqliteRawBodyStore implements RawBodyStore {
  private readonly db: DatabaseSyncInstance;
  private readonly insertBlobStmt: StatementInstance;
  private readonly insertExchangeStmt: StatementInstance;
  private readonly assignStmt: StatementInstance;
  private readonly getBlobStmt: StatementInstance;
  private readonly log: Logger;

  constructor(db: DatabaseSyncInstance, log: Logger) {
    this.db = db;
    this.log = log;
    this.db.exec(CREATE_SCHEMA);
    this.insertBlobStmt = db.prepare(
      `INSERT OR IGNORE INTO raw_blob (hash, bytes, byte_length, stored_length, first_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.insertExchangeStmt = db.prepare(
      `INSERT INTO raw_exchange
         (member_name, kind, hash, body_length, request_id, prompt_id, session_id,
          query_source, agent_name, model, event_ts, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // COALESCE(existing, patch): fill only NULL fields, never overwrite.
    this.assignStmt = db.prepare(
      `UPDATE raw_exchange
       SET request_id = COALESCE(request_id, ?),
           query_source = COALESCE(query_source, ?),
           agent_name = COALESCE(agent_name, ?)
       WHERE id = ?`,
    );
    this.getBlobStmt = db.prepare('SELECT bytes FROM raw_blob WHERE hash = ?');
  }

  appendBody(input: AppendBodyInput): AppendBodyResult {
    const { memberName, kind, bytes } = input;
    const env = input.envelope ?? {};
    const hash = sha256Hex(bytes);
    const gz = gzipSync(bytes);
    // INSERT OR IGNORE on the content hash: a byte-identical body seen
    // again (e.g. an unchanged request re-sent next turn) dedups here.
    this.insertBlobStmt.run(hash, gz, bytes.length, gz.length, Date.now());
    const res = this.insertExchangeStmt.run(
      memberName,
      kind,
      hash,
      bytes.length,
      env.requestId ?? null,
      env.promptId ?? null,
      env.sessionId ?? null,
      env.querySource ?? null,
      env.agentName ?? null,
      env.model ?? null,
      env.eventTs ?? null,
      Date.now(),
    );
    return { hash, exchangeId: Number(res.lastInsertRowid) };
  }

  assignRequestId(
    exchangeId: number,
    patch: { requestId: string; querySource?: string | null; agentName?: string | null },
  ): void {
    this.assignStmt.run(
      patch.requestId,
      patch.querySource ?? null,
      patch.agentName ?? null,
      exchangeId,
    );
  }

  getBlob(hash: string): Buffer | null {
    const row = this.getBlobStmt.get(hash) as { bytes: Uint8Array } | undefined;
    if (row === undefined) return null;
    let bytes: Buffer;
    try {
      bytes = gunzipSync(Buffer.from(row.bytes));
    } catch (err) {
      this.log.warn('raw-body-store: blob gunzip failed', {
        hash,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    // Re-verify the content address on every read — never serve bytes
    // that no longer hash to their key.
    const actual = sha256Hex(bytes);
    if (actual !== hash) {
      this.log.warn('raw-body-store: blob hash mismatch', { hash, actual });
      return null;
    }
    return bytes;
  }

  list(filter: RawBodyQuery = {}): RawExchangeRow[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (filter.memberName !== undefined) {
      conditions.push('member_name = ?');
      params.push(filter.memberName);
    }
    if (filter.kind !== undefined) {
      conditions.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.requestId !== undefined) {
      conditions.push('request_id = ?');
      params.push(filter.requestId);
    }
    if (filter.hash !== undefined) {
      conditions.push('hash = ?');
      params.push(filter.hash);
    }
    if (filter.from !== undefined) {
      conditions.push('event_ts >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      conditions.push('event_ts <= ?');
      params.push(filter.to);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const sql = `SELECT * FROM raw_exchange ${where} ORDER BY event_ts ASC, id ASC LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as unknown as RawExchangeRowRaw[];
    return rows.map((raw) => ({
      id: Number(raw.id),
      memberName: raw.member_name,
      kind: raw.kind,
      hash: raw.hash,
      bodyLength: Number(raw.body_length),
      requestId: raw.request_id,
      promptId: raw.prompt_id,
      sessionId: raw.session_id,
      querySource: raw.query_source,
      agentName: raw.agent_name,
      model: raw.model,
      eventTs: raw.event_ts == null ? null : Number(raw.event_ts),
      receivedAt: Number(raw.received_at),
    }));
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM raw_exchange').get() as
      | { n: number | bigint }
      | undefined;
    return row ? Number(row.n) : 0;
  }

  stats(): RawBodyStats {
    const blobRow = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(byte_length), 0) AS raw,
                COALESCE(SUM(stored_length), 0) AS stored
         FROM raw_blob`,
      )
      .get() as { n: number | bigint; raw: number | bigint; stored: number | bigint } | undefined;
    return {
      blobs: blobRow ? Number(blobRow.n) : 0,
      exchanges: this.count(),
      rawBytes: blobRow ? Number(blobRow.raw) : 0,
      storedBytes: blobRow ? Number(blobRow.stored) : 0,
    };
  }
}

export function createRawBodyStore(
  db: DatabaseSyncInstance,
  opts: RawBodyStoreOptions = {},
): RawBodyStore {
  return new SqliteRawBodyStore(db, opts.logger ?? defaultLogger);
}
