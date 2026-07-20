/**
 * GenAI inference record store.
 *
 * The authoritative, full-fidelity layer: one row per Claude
 * `/v1/messages` API call, carrying the COMPLETE input context actually
 * sent on the wire (mutations/compaction included), the system prompt
 * kept SEPARATE from the chat history, and the assistant's response —
 * all shaped after the OpenTelemetry GenAI semantic conventions
 * (Development) and produced by the core `anthropicToGenAi` mapper.
 *
 * This is deliberately independent of both the operational telemetry
 * sink (`telemetry-store.ts`) and the member-activity stream: its own
 * `gen_ai_inference` table, its own append path, no EventEmitter. It can
 * share the dedicated activity `DatabaseSyncInstance` with the telemetry
 * store — both are heavy-write, per-member operational streams we keep
 * off the main broker write lock — without any coupling.
 *
 * The big content columns (`system_instructions`, `input_messages`,
 * `output_messages`, `usage`, `finish_reasons`) are stored as JSON text
 * VERBATIM. Losslessness is the whole point: these records feed a
 * downstream content-addressed store, so we keep the full context, not a
 * summary.
 *
 * Timestamps here are epoch MILLISECONDS (the mapper's `ts`), which sit
 * comfortably inside `Number.MAX_SAFE_INTEGER` — no BigInt read path is
 * needed (unlike the nanosecond telemetry store).
 */

import type { GenAiInference } from 'csuite-sdk/types';
import type { DatabaseSyncInstance, StatementInstance } from './db.js';
import { logger as defaultLogger, type Logger } from './logger.js';

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS gen_ai_inference (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_name TEXT NOT NULL,
    ts INTEGER NOT NULL,
    operation_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    response_id TEXT,
    finish_reasons TEXT NOT NULL,
    usage TEXT,
    system_instructions TEXT NOT NULL,
    input_messages TEXT NOT NULL,
    output_messages TEXT NOT NULL,
    query_source TEXT,
    agent_name TEXT,
    request_body_ref TEXT,
    request_sha256 TEXT,
    response_sha256 TEXT,
    received_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS gen_ai_inference_member_ts ON gen_ai_inference (member_name, ts);
`;

/**
 * The append input: a `GenAiInference` from the core mapper, plus the
 * optional source `body_ref` path of the request body (retained for
 * provenance — the raw material that produced this record still lives on
 * disk, co-located with the broker) and the sha256 content addresses of
 * the raw request/response bytes in the raw-body store (see
 * raw-body-store.ts) — the link from this derived view back to its
 * verbatim source bytes.
 */
export interface GenAiInferenceInput extends GenAiInference {
  /** Source file path of the request body, or null when inlined. */
  requestBodyRef?: string | null;
  /** sha256 (hex) of the raw request bytes, or null when not captured. */
  requestSha256?: string | null;
  /** sha256 (hex) of the raw response bytes, or null when not captured. */
  responseSha256?: string | null;
}

/** A stored row decoded back out for reads (tests, downstream queries). */
export interface GenAiInferenceRow extends GenAiInference {
  id: number;
  memberName: string;
  requestBodyRef: string | null;
  requestSha256: string | null;
  responseSha256: string | null;
  receivedAt: number;
}

/** Optional filters for `list`. `from`/`to` bound on the mapper `ts`. */
export interface GenAiQuery {
  memberName?: string;
  model?: string;
  from?: number;
  to?: number;
  limit?: number;
}

export interface GenAiStore {
  /** Insert one inference record for a member. */
  append(memberName: string, rec: GenAiInferenceInput): void;
  /** Total row count across all members. */
  count(): number;
  /** Read rows back, oldest-first, with optional filters. */
  list(filter?: GenAiQuery): GenAiInferenceRow[];
  /** Read one row by server-assigned id; null when absent/malformed. */
  getById(id: number): GenAiInferenceRow | null;
}

export interface GenAiStoreOptions {
  logger?: Logger;
}

interface GenAiRowRaw {
  id: number;
  member_name: string;
  ts: number;
  operation_name: string;
  provider: string;
  model: string | null;
  response_id: string | null;
  finish_reasons: string;
  usage: string | null;
  system_instructions: string;
  input_messages: string;
  output_messages: string;
  query_source: string | null;
  agent_name: string | null;
  request_body_ref: string | null;
  request_sha256: string | null;
  response_sha256: string | null;
  received_at: number;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

class SqliteGenAiStore implements GenAiStore {
  private readonly db: DatabaseSyncInstance;
  private readonly insertStmt: StatementInstance;
  private readonly log: Logger;

  constructor(db: DatabaseSyncInstance, log: Logger) {
    this.db = db;
    this.log = log;
    this.db.exec(CREATE_SCHEMA);
    // Best-effort schema migrations for databases that predate the
    // sha256 provenance columns. Each ALTER is wrapped individually; we
    // swallow only the "duplicate column name" error fresh DBs throw
    // because CREATE_SCHEMA already created the column.
    for (const alter of [
      'ALTER TABLE gen_ai_inference ADD COLUMN request_sha256 TEXT',
      'ALTER TABLE gen_ai_inference ADD COLUMN response_sha256 TEXT',
    ]) {
      try {
        this.db.exec(alter);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (!msg.includes('duplicate column name')) throw err;
      }
    }
    this.insertStmt = db.prepare(
      `INSERT INTO gen_ai_inference
         (member_name, ts, operation_name, provider, model, response_id,
          finish_reasons, usage, system_instructions, input_messages,
          output_messages, query_source, agent_name, request_body_ref,
          request_sha256, response_sha256, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  append(memberName: string, rec: GenAiInferenceInput): void {
    let finishReasons: string;
    let usage: string | null;
    let systemInstructions: string;
    let inputMessages: string;
    let outputMessages: string;
    try {
      finishReasons = JSON.stringify(rec.finishReasons ?? []);
      usage = rec.usage == null ? null : JSON.stringify(rec.usage);
      systemInstructions = JSON.stringify(rec.systemInstructions ?? []);
      inputMessages = JSON.stringify(rec.inputMessages ?? []);
      outputMessages = JSON.stringify(rec.outputMessages ?? []);
    } catch (err) {
      this.log.warn('genai-store: skipped unserializable record', {
        memberName,
        responseId: rec.responseId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const ts =
      typeof rec.ts === 'number' && Number.isFinite(rec.ts) ? Math.trunc(rec.ts) : Date.now();
    this.insertStmt.run(
      memberName,
      ts,
      rec.operationName,
      rec.provider,
      rec.model ?? null,
      rec.responseId ?? null,
      finishReasons,
      usage,
      systemInstructions,
      inputMessages,
      outputMessages,
      rec.querySource ?? null,
      rec.agentName ?? null,
      rec.requestBodyRef ?? null,
      rec.requestSha256 ?? null,
      rec.responseSha256 ?? null,
      Date.now(),
    );
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM gen_ai_inference').get() as
      | { n: number | bigint }
      | undefined;
    return row ? Number(row.n) : 0;
  }

  list(filter: GenAiQuery = {}): GenAiInferenceRow[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (filter.memberName !== undefined) {
      conditions.push('member_name = ?');
      params.push(filter.memberName);
    }
    if (filter.model !== undefined) {
      conditions.push('model = ?');
      params.push(filter.model);
    }
    if (filter.from !== undefined) {
      conditions.push('ts >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      conditions.push('ts <= ?');
      params.push(filter.to);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const sql = `SELECT * FROM gen_ai_inference ${where} ORDER BY ts ASC, id ASC LIMIT ?`;
    const stmt = this.db.prepare(sql);
    params.push(limit);
    const rows = stmt.all(...params) as unknown as GenAiRowRaw[];
    const out: GenAiInferenceRow[] = [];
    for (const raw of rows) {
      const decoded = this.decode(raw);
      if (decoded !== null) out.push(decoded);
    }
    return out;
  }

  getById(id: number): GenAiInferenceRow | null {
    if (!Number.isInteger(id) || id < 0) return null;
    const raw = this.db.prepare('SELECT * FROM gen_ai_inference WHERE id = ?').get(id) as
      | GenAiRowRaw
      | undefined;
    return raw === undefined ? null : this.decode(raw);
  }

  private decode(raw: GenAiRowRaw): GenAiInferenceRow | null {
    try {
      return {
        id: Number(raw.id),
        memberName: raw.member_name,
        operationName: 'chat',
        // Read the stored provider ('anthropic' Claude / 'openai' codex);
        // default legacy rows to anthropic.
        provider: raw.provider === 'openai' ? 'openai' : 'anthropic',
        model: raw.model,
        responseId: raw.response_id,
        finishReasons: JSON.parse(raw.finish_reasons),
        usage: raw.usage == null ? null : JSON.parse(raw.usage),
        systemInstructions: JSON.parse(raw.system_instructions),
        inputMessages: JSON.parse(raw.input_messages),
        outputMessages: JSON.parse(raw.output_messages),
        querySource: raw.query_source,
        agentName: raw.agent_name,
        requestBodyRef: raw.request_body_ref,
        requestSha256: raw.request_sha256,
        responseSha256: raw.response_sha256,
        ts: Number(raw.ts),
        receivedAt: Number(raw.received_at),
      };
    } catch (err) {
      this.log.warn('genai-store: skipped malformed row', {
        id: Number(raw.id),
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

export function createGenAiStore(
  db: DatabaseSyncInstance,
  opts: GenAiStoreOptions = {},
): GenAiStore {
  return new SqliteGenAiStore(db, opts.logger ?? defaultLogger);
}
