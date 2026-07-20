/**
 * GenAI inference correlator — Claude Code OTEL api-body records →
 * `GenAiInference` records.
 *
 * Claude Code, with the raw-body OTEL export enabled
 * (`OTEL_LOG_RAW_API_BODIES=file:<dir>`), emits three log records per
 * `/v1/messages` call plus an error variant:
 *
 *   claude_code.api_request_body  — the full Anthropic Messages REQUEST.
 *       attrs: body_ref (file-mode path) OR body (inline), model,
 *       event.sequence, query_source. **NO request_id.**
 *   claude_code.api_request       — token/cost ACCOUNTING. attrs:
 *       request_id, model, input_tokens/output_tokens/cache_*_tokens,
 *       cost_usd, duration_ms. This is the bridge: it is the FIRST record
 *       carrying the request_id, and it CLAIMS a request body.
 *   claude_code.api_response_body — the assembled Anthropic Messages
 *       RESPONSE. attrs: body_ref OR body, request_id, model.
 *   claude_code.api_error         — a failed call (no response body).
 *
 * ── Correlation model (per-model FIFO, then request_id) ────────────────
 *
 * The request body carries NO request_id, so it can't pair with its
 * response by id. The linkage is positional-by-model:
 *
 *   1. api_request_body pushes onto a per-model FIFO of unclaimed
 *      request bodies (it carries a `model`).
 *   2. api_request CLAIMS the oldest unclaimed body of its model
 *      (fallback: oldest of any model) and, from here on, the exchange
 *      is keyed by `request_id`.
 *   3. api_response_body pairs by `request_id`.
 *
 * Model-awareness is load-bearing: a turn interleaves a background haiku
 * "session title" call with the main opus turn, so a positional-global
 * FIFO would cross the wires. We sort each batch by `event.sequence`
 * (fallback `timeUnixNano`) so FIFO order is the true emission order even
 * when the transport reordered records.
 *
 * ── Cross-batch state ──────────────────────────────────────────────────
 *
 * The runner batches OTEL exports (`OTEL_BLRP_SCHEDULE_DELAY`), so a
 * turn's api_request_body and its api_request/api_response_body routinely
 * land in DIFFERENT POSTs. The correlator is therefore STATEFUL: the
 * route holds one correlator per member. Both the unclaimed-request FIFO
 * and the request_id-keyed pending map persist across `ingest()` calls; a
 * completed call (request body + accounting + response body) is emitted
 * immediately. A TTL sweep (measured against the newest record ts seen)
 * plus a hard per-member cap evict stale, never-completed entries so a
 * dropped turn can't leak memory. Unlike the old activity correlator
 * there is no "request-only" flush — a GenAiInference needs BOTH bodies,
 * so an incomplete call simply evicts, it never emits.
 *
 * ── Capture-before-parse (raw fidelity first) ──────────────────────────
 *
 * Each body_ref is read ONCE, as a Buffer, at the moment its record
 * arrives (broker + runner are co-located; size-guarded `readFileSync`).
 * When a `rawStore` is wired, the VERBATIM bytes are content-addressed
 * into it IMMEDIATELY — before any JSON.parse, unconditionally, so a
 * body whose JSON fails to parse is still preserved raw. Only after a
 * successful raw capture is the on-disk spill file unlinked
 * (best-effort, `unlinkAfterCapture`, default true) — the broker
 * consuming the file is the designed lifecycle; without it the runner's
 * spill dir grows forever. The decoded text is retained in memory for
 * the gen_ai path. Raw-store failures and gen_ai failures are isolated
 * from each other: neither side's error can drop the other's output.
 *
 * ── Resolution ─────────────────────────────────────────────────────────
 *
 * On completion we `JSON.parse` the retained request + response text
 * and hand them to the pure core `anthropicToGenAi` mapper (which
 * redacts + maps every content block, dropping nothing). The emitted
 * record carries the sha256 of both raw bodies, linking the derived
 * view to its source bytes. Inline `body` attributes are tolerated for
 * small requests that didn't spill to a file. Defensive by
 * construction: a missing / oversized / unreadable body_ref, or an
 * unparseable body, skips just that call (logged) and never throws —
 * and never blocks the raw capture that already happened.
 */

import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { anthropicToGenAi } from 'csuite-core';
import type { GenAiInferenceInput } from './genai-store.js';
import type { RawBodyStore } from './raw-body-store.js';
import type { TelemetryRecord } from './telemetry-store.js';

const NANOS_PER_MS = 1_000_000;

const EV_API_REQUEST_BODY = 'api_request_body';
const EV_API_REQUEST = 'api_request';
const EV_API_RESPONSE_BODY = 'api_response_body';
const EV_API_ERROR = 'api_error';

const GENAI_EVENT_NAMES: ReadonlySet<string> = new Set([
  EV_API_REQUEST_BODY,
  EV_API_REQUEST,
  EV_API_RESPONSE_BODY,
  EV_API_ERROR,
]);

/** Strip the fully-qualified `claude_code.` prefix the producer may add. */
function shortName(name: string): string {
  return name.startsWith('claude_code.') ? name.slice('claude_code.'.length) : name;
}

/**
 * True for the four api-body log records this correlator owns. The route
 * uses this to split the OTLP log batch: matching records go here,
 * everything else stays on the operational telemetry sink.
 */
export function isGenAiLogRecord(name: string): boolean {
  return GENAI_EVENT_NAMES.has(shortName(name));
}

export interface GenAiCorrelatorOptions {
  /** Structured logger for skip/continue diagnostics. Optional. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Clock, injectable for tests. Last-resort ts when a record has none. */
  now?: () => number;
  /**
   * Reads a `body_ref` file path to its raw bytes. The default is a
   * size-guarded `readFileSync` (throws on a file larger than
   * `maxBodyBytes`, which the caller treats as a skip). Injectable so
   * tests never touch fs.
   */
  readBodyRef?: (path: string) => Buffer;
  /** Max body_ref file size in bytes before it is treated as oversized. */
  maxBodyBytes?: number;
  /**
   * Content-addressed raw-body store. When set, every resolved body is
   * captured VERBATIM (sha256 + gzip) the moment its record arrives —
   * before parse, before redaction, unconditionally — and the emitted
   * inference carries both body hashes. Omit to skip raw capture.
   */
  rawStore?: RawBodyStore;
  /**
   * Member the raw exchanges are recorded under. Only meaningful with
   * `rawStore` (the caller holds one correlator per member).
   */
  memberName?: string;
  /**
   * Unlink the body_ref spill file after a SUCCESSFUL raw capture
   * (default true). The broker consuming the file is the designed
   * lifecycle — Claude Code never deletes them itself. Best-effort:
   * an unlink failure is logged and never thrown. No `rawStore` → no
   * capture → never unlinks.
   */
  unlinkAfterCapture?: boolean;
  /**
   * TTL (ms) after which an incomplete entry (unclaimed request body, or
   * a pending exchange still missing a body) is evicted. Measured against
   * the newest record ts the correlator has seen.
   */
  ttlMs?: number;
  /** Hard cap on retained unclaimed request bodies per correlator. */
  maxPending?: number;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_TTL_MS = 120_000;
const DEFAULT_MAX_PENDING = 256;

export interface GenAiCorrelator {
  /**
   * Feed a batch of gen-ai api-body TelemetryRecords (non-matching
   * records are ignored). Returns the `GenAiInference` records that
   * COMPLETED in this batch, ascending by ts. Never throws.
   */
  ingest(records: TelemetryRecord[]): GenAiInferenceInput[];
  /**
   * Evict every incomplete entry older than the TTL (measured against
   * `nowMs`, default = newest record ts seen). Returns `[]` — an
   * incomplete call can never produce a record. Exposed for a caller
   * holding the map to evict on its own cadence.
   */
  sweep(nowMs?: number): GenAiInferenceInput[];
  /** Count of unclaimed request bodies currently retained. */
  pendingCount(): number;
}

/**
 * A body resolved (and, with a rawStore, captured) at record-arrival
 * time. `text` is the decoded bytes retained in memory — the spill file
 * may already be unlinked, so this is the only copy. `hash`/`exchangeId`
 * are null when no rawStore is wired or the capture failed.
 */
interface CapturedBody {
  text: string | null;
  bodyRef: string | null;
  hash: string | null;
  exchangeId: number | null;
}

/** An api_request_body waiting to be claimed by its api_request. */
interface UnclaimedRequest extends CapturedBody {
  startedAt: number;
  model: string | null;
}

/** A request keyed by request_id after its api_request claimed it. */
interface PendingExchange {
  requestText: string | null;
  requestBodyRef: string | null;
  requestHash: string | null;
  responseText: string | null;
  responseHash: string | null;
  startedAt: number;
  endedAt: number;
  model: string | null;
  hasRequest: boolean;
  hasResponse: boolean;
  /**
   * Thread attribution lifted off the `api_request` (accounting/bridge)
   * event — the FIRST record carrying the request_id. `query_source`
   * names the interleaved thread; `agent.name` names the agent (for
   * named agents only). Both null until the api_request is seen, and
   * null when that event omitted them.
   */
  querySource: string | null;
  agentName: string | null;
}

/** A pre-normalized record ready to correlate. */
interface Normalized {
  event: string;
  attrs: Record<string, unknown>;
  ts: number;
  seq: number;
}

export function createGenAiCorrelator(opts: GenAiCorrelatorOptions = {}): GenAiCorrelator {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const readBodyRef = opts.readBodyRef ?? defaultReadBodyRef(maxBodyBytes);
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
  const rawStore = opts.rawStore;
  const memberName = opts.memberName ?? 'unknown';
  const unlinkAfterCapture = opts.unlinkAfterCapture ?? true;

  // Cross-batch state.
  const fifo: UnclaimedRequest[] = [];
  const pending = new Map<string, PendingExchange>();
  let newestTs = 0;
  let synthSeq = 0;

  /** Claim the oldest unclaimed request body of `model` (fallback any). */
  function claimRequest(model: string | null): UnclaimedRequest | undefined {
    if (fifo.length === 0) return undefined;
    if (model !== null) {
      const idx = fifo.findIndex((r) => r.model === model);
      if (idx !== -1) return fifo.splice(idx, 1)[0];
    }
    return fifo.shift();
  }

  function getPending(key: string): PendingExchange {
    let p = pending.get(key);
    if (!p) {
      p = {
        requestText: null,
        requestBodyRef: null,
        requestHash: null,
        responseText: null,
        responseHash: null,
        startedAt: 0,
        endedAt: 0,
        model: null,
        hasRequest: false,
        hasResponse: false,
        querySource: null,
        agentName: null,
      };
      pending.set(key, p);
    }
    return p;
  }

  /**
   * Resolve a body's record to its raw bytes (read the body_ref ONCE,
   * else the inline `body`), capture them VERBATIM into the raw store
   * BEFORE any parse, then unlink the consumed spill file. Raw-store
   * errors are contained here — the decoded text still flows to the
   * gen_ai path, and vice versa an unreadable body never blocks other
   * records. Never throws.
   */
  function captureBody(
    kind: 'request' | 'response',
    attrs: Record<string, unknown>,
    ts: number,
  ): CapturedBody {
    const bodyRef = asStr(attrs.body_ref);
    const inline = asStr(attrs.body);
    let bytes: Buffer | null = null;
    if (bodyRef) {
      try {
        bytes = readBodyRef(bodyRef);
      } catch (err) {
        log('genai-correlator: body_ref unreadable', {
          body_ref: bodyRef,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (inline) {
      bytes = Buffer.from(inline, 'utf8');
    }
    if (bytes === null) return { text: null, bodyRef, hash: null, exchangeId: null };

    // Sanity: the OTEL event states the body's byte length (as a
    // string). A mismatch means we read something other than what the
    // producer wrote — warn, never reject; the bytes we have are still
    // worth keeping.
    const declared = Number(attrs.body_length);
    if (Number.isFinite(declared) && declared !== bytes.length) {
      log('genai-correlator: body length mismatch', {
        kind,
        body_ref: bodyRef,
        declared,
        actual: bytes.length,
      });
    }

    // Raw capture FIRST — verbatim bytes, content-addressed, before
    // anything parses or redacts them. Unconditional: a body whose JSON
    // later fails to parse is still preserved here.
    let hash: string | null = null;
    let exchangeId: number | null = null;
    if (rawStore) {
      try {
        const res = rawStore.appendBody({
          memberName,
          kind,
          bytes,
          envelope: {
            requestId: asStr(attrs.request_id),
            promptId: asStr(attrs['prompt.id']),
            sessionId: asStr(attrs['session.id']),
            querySource: asStr(attrs.query_source),
            model: asStr(attrs.model),
            eventTs: ts,
          },
        });
        hash = res.hash;
        exchangeId = res.exchangeId;
        // The bytes are durably captured — consume the spill file (the
        // broker deleting it IS the designed lifecycle; Claude Code
        // never cleans up after itself). Best-effort: an unlink failure
        // only means a leftover file, never a lost body.
        if (unlinkAfterCapture && bodyRef) {
          try {
            unlinkSync(bodyRef);
          } catch (err) {
            log('genai-correlator: unlink after capture failed', {
              body_ref: bodyRef,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        // Isolation: a raw-store failure must never break the gen_ai
        // path — the text below still flows to the correlation state.
        log('genai-correlator: raw capture failed', {
          kind,
          body_ref: bodyRef,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { text: bytes.toString('utf8'), bodyRef, hash, exchangeId };
  }

  /** Build + push a completed exchange. Skips (logs) on any parse failure. */
  function tryEmit(key: string, out: GenAiInferenceInput[]): void {
    const p = pending.get(key);
    if (!p?.hasRequest || !p.hasResponse) return;
    pending.delete(key);
    try {
      if (p.requestText === null || p.responseText === null) return;

      let requestBody: unknown;
      let responseBody: unknown;
      try {
        requestBody = JSON.parse(p.requestText);
        responseBody = JSON.parse(p.responseText);
      } catch (err) {
        log('genai-correlator: body JSON parse failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      const inference = anthropicToGenAi({
        requestBody,
        responseBody,
        querySource: p.querySource,
        agentName: p.agentName,
        ts: p.startedAt || p.endedAt || now(),
      });
      out.push({
        ...inference,
        requestBodyRef: p.requestBodyRef,
        requestSha256: p.requestHash,
        responseSha256: p.responseHash,
      });
    } catch (err) {
      log('genai-correlator: failed to build inference', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function evictStale(nowMs: number): void {
    const cutoff = nowMs - ttlMs;
    // Drain the stale prefix of the FIFO (oldest-first).
    while (fifo.length > 0 && (fifo[0]?.startedAt ?? 0) < cutoff) {
      fifo.shift();
    }
    // Hard cap — drop the oldest overflow.
    while (fifo.length > maxPending) {
      fifo.shift();
    }
    // Evict stale pending exchanges that never completed.
    for (const [key, p] of pending) {
      const stamp = Math.max(p.startedAt, p.endedAt);
      if (stamp < cutoff) pending.delete(key);
    }
  }

  function ingest(records: TelemetryRecord[]): GenAiInferenceInput[] {
    const out: GenAiInferenceInput[] = [];
    const normalized = collectNormalized(records, now);
    // Sort by event.sequence (fallback ts) so FIFO order == emission order.
    normalized.sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.ts - b.ts));

    for (const rec of normalized) {
      try {
        if (rec.ts > newestTs) newestTs = rec.ts;
        const { event, attrs, ts } = rec;

        switch (event) {
          case EV_API_REQUEST_BODY: {
            // Read once + raw-capture BEFORE anything can parse it.
            const cap = captureBody('request', attrs, ts);
            fifo.push({
              ...cap,
              startedAt: ts,
              model: asStr(attrs.model),
            });
            while (fifo.length > maxPending) fifo.shift();
            break;
          }
          case EV_API_REQUEST: {
            const model = asStr(attrs.model);
            const realRequestId = asStr(attrs.request_id);
            const requestId = realRequestId ?? `__acct_${ts}_${synthSeq++}`;
            const claimed = claimRequest(model);
            const p = getPending(requestId);
            if (claimed) {
              p.requestText = claimed.text;
              p.requestBodyRef = claimed.bodyRef;
              p.requestHash = claimed.hash;
              p.startedAt = claimed.startedAt;
              p.hasRequest = true;
              p.model = p.model ?? claimed.model ?? model;
              // Bridge the request_id (plus thread attribution) onto the
              // captured raw exchange row — this accounting event is the
              // FIRST record that carries it. Isolated: a raw-store
              // failure must not break the gen_ai path.
              if (rawStore && claimed.exchangeId !== null && realRequestId !== null) {
                try {
                  rawStore.assignRequestId(claimed.exchangeId, {
                    requestId: realRequestId,
                    querySource: asStr(attrs.query_source),
                    agentName: asStr(attrs['agent.name']),
                  });
                } catch (err) {
                  log('genai-correlator: raw request_id assign failed', {
                    request_id: realRequestId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            } else {
              p.model = p.model ?? model;
            }
            // Thread attribution rides on this accounting/bridge event —
            // the only record carrying both the request_id and the
            // query_source / agent.name. Attrs are already-flattened, so
            // the agent name lives under the DOTTED key `agent.name`.
            // Defensive: missing attrs → null.
            p.querySource = p.querySource ?? asStr(attrs.query_source);
            p.agentName = p.agentName ?? asStr(attrs['agent.name']);
            p.endedAt = ts;
            tryEmit(requestId, out);
            break;
          }
          case EV_API_RESPONSE_BODY: {
            const requestId = asStr(attrs.request_id) ?? `__resp_${ts}_${synthSeq++}`;
            // Read once + raw-capture (request_id already on the attrs).
            const cap = captureBody('response', attrs, ts);
            const p = getPending(requestId);
            p.responseText = cap.text;
            p.responseHash = cap.hash;
            p.hasResponse = true;
            p.endedAt = ts;
            tryEmit(requestId, out);
            break;
          }
          case EV_API_ERROR: {
            // Errored call: no response body will ever arrive. Discard a
            // matching unclaimed request body so it can't linger in the
            // FIFO, and drop any pending keyed by this request_id.
            claimRequest(asStr(attrs.model));
            const requestId = asStr(attrs.request_id);
            if (requestId) pending.delete(requestId);
            break;
          }
        }
      } catch (err) {
        log('genai-correlator: skipped malformed record', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    evictStale(newestTs);
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  function sweep(nowMs?: number): GenAiInferenceInput[] {
    evictStale(nowMs ?? newestTs);
    return [];
  }

  return { ingest, sweep, pendingCount: () => fifo.length };
}

/** Default size-guarded body_ref reader. Throws on missing/oversized. */
function defaultReadBodyRef(maxBytes: number): (path: string) => Buffer {
  return (path: string): Buffer => {
    const st = statSync(path);
    if (st.size > maxBytes) {
      throw new Error(`body_ref too large: ${st.size} > ${maxBytes} bytes`);
    }
    return readFileSync(path);
  };
}

/** Normalize the matching gen-ai records: short event name, ts, seq. */
function collectNormalized(records: TelemetryRecord[], now: () => number): Normalized[] {
  const out: Normalized[] = [];
  for (const rec of records) {
    if (rec.signal !== 'log') continue;
    const event = shortName(rec.name);
    if (!GENAI_EVENT_NAMES.has(event)) continue;
    const attrs = rec.attributes ?? {};
    out.push({
      event,
      attrs,
      ts: recordTsMs(rec.tsUnixNano, now),
      seq: recordSeq(attrs),
    });
  }
  return out;
}

/** Nanoseconds → integer ms; falls back to `now()`. */
function recordTsMs(tsUnixNano: unknown, now: () => number): number {
  const n = typeof tsUnixNano === 'number' ? tsUnixNano : Number(tsUnixNano);
  if (Number.isFinite(n) && n > 0) return Math.round(n / NANOS_PER_MS);
  return now();
}

/** event.sequence (monotonic int) for ordering; +Inf when absent. */
function recordSeq(attrs: Record<string, unknown>): number {
  const s = attrs['event.sequence'];
  const n = typeof s === 'number' ? s : typeof s === 'string' ? Number(s) : NaN;
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
