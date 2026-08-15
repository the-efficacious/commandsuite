/**
 * Contract for the per-member gen-ai correlator — the capture layer
 * that stitches OTLP api-body records into complete `GenAiInference`
 * rows. The implementation ships with the host (it reads body_ref
 * spill files); the broker application depends only on this contract
 * and an injected factory.
 */

import type { DiagnosticEmitter } from './diagnostics.js';
import type { GenAiInferenceInput } from './genai-store.js';
import type { Logger } from './logger.js';
import type { RawBodyStore } from './raw-body-types.js';
import type { TelemetryRecord } from './telemetry-store.js';

export const EV_API_REQUEST_BODY = 'api_request_body';
export const EV_API_REQUEST = 'api_request';
export const EV_API_RESPONSE_BODY = 'api_response_body';
export const EV_API_ERROR = 'api_error';

export const GENAI_EVENT_NAMES: ReadonlySet<string> = new Set([
  EV_API_REQUEST_BODY,
  EV_API_REQUEST,
  EV_API_RESPONSE_BODY,
  EV_API_ERROR,
]);

/** Strip the fully-qualified `claude_code.` prefix the producer may add. */
export function shortName(name: string): string {
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
  /** Exact instruction packet blocks issued to this member, read at emission time. */
  getRedactionExemptions?: () => readonly string[];
  /**
   * Structured logger for skip/continue diagnostics. Severity is the
   * implementation's per-site call, not fixed here. Optional; the
   * implementation defaults to the shared logger, never to a no-op.
   */
  logger?: Logger;
  /**
   * Retained completeness diagnostics. Optional so a correlator can be
   * constructed without one (tests, and a broker with retention
   * unwired), but every completeness failure below reports to it when
   * present — the stderr line stays for live tailing and is no longer
   * the only record.
   */
  diagnostics?: DiagnosticEmitter;
  /** Clock, injectable for tests. Last-resort ts when a record has none. */
  now?: () => number;
  /**
   * Reads a `body_ref` file path to its raw bytes. The default is a
   * size-guarded `readFileSync` (throws on a file larger than
   * `maxBodyBytes`, which the caller treats as a skip). Injectable so
   * tests never touch fs.
   */
  readBodyRef?: (path: string) => Uint8Array;
  /** Max body_ref file size in bytes before it is treated as oversized. */
  maxBodyBytes?: number;
  /**
   * Content-addressed raw-body store. When set, every resolved body is
   * captured (sha256 + gzip) the moment its record arrives — before THIS
   * layer parses it, unconditionally — and the emitted inference carries
   * both body hashes. Omit to skip raw capture.
   *
   * "Before redaction" is NOT among the guarantees: the OTLP records this
   * correlator consumes have already passed `parseOtlpLogs` attribute
   * redaction. Verbatim here means with respect to the record's `body`
   * attribute as received, not to what the provider sent.
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

export type GenAiCorrelatorFactory = (opts: GenAiCorrelatorOptions) => GenAiCorrelator;
