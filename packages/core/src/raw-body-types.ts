/**
 * Contracts for the content-addressed raw API body store — the
 * fidelity layer under the gen_ai view. The reference implementation
 * lives with the host (sha256 + gzip in the same database); bytes at
 * this seam are plain Uint8Array.
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
  /**
   * The bytes the caller hands this store, verbatim — hashed and gzipped
   * here, never rewritten.
   *
   * NOT necessarily the provider's wire bytes, and the caller decides
   * which: codex bundle uploads pass member-scoped redaction in app.ts,
   * while claude OTLP bodies pass attribute redaction in otlp-parse.ts.
   * This field is the subject of the store's byte-exactness claim, so
   * naming it "wire bytes" here would assert something only one of the two
   * callers can supply. See the file header.
   */
  bytes: Uint8Array;
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
  getBlob(hash: string): Uint8Array | null;
  /** Read exchange rows, oldest-first, with optional filters. */
  list(filter?: RawBodyQuery): RawExchangeRow[];
  /** Total exchange-row count. */
  count(): number;
  /** Blob/exchange counts + raw-vs-stored byte totals. */
  stats(): RawBodyStats;
}
