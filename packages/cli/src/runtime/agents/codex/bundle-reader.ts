/**
 * Runner-side codex rollout-trace bundle reader — the gen_ai + raw-body
 * fidelity layer for the codex runner.
 *
 * With `CODEX_ROLLOUT_TRACE_ROOT=<dir>` set on the child, codex writes a
 * per-session bundle `<dir>/trace-<traceId>-<rolloutId>/` containing:
 *   - `manifest.json`  — { root_thread_id, payloads_dir, … }
 *   - `trace.jsonl`    — an ordered spine; the events we consume are
 *       `inference_started`  { inference_call_id, thread_id, codex_turn_id,
 *                              model, request_payload:{ path } }
 *       `inference_completed`{ inference_call_id, response_id,
 *                              upstream_request_id, response_payload:{ path } }
 *   - `payloads/N.json`— the VERBATIM Responses API request / response bodies
 *     referenced by the events' `{ path }`.
 *
 * This reader pairs each started+completed by `inference_call_id`, reads
 * the two referenced payload files' bytes VERBATIM, and uploads them to the
 * broker's gen_ai ingest (`uploadGenaiInference`), which content-addresses
 * the bytes and maps a parsed copy into a `GenAiInference`. This is the
 * codex analogue of Claude's raw-body → gen_ai layer; the bundle already
 * pairs request and response, so there is no correlation to do.
 *
 * Unlike the rollout reader (which feeds the LIVE activity stream), gen_ai
 * is a background audit/analytics layer, so this reader POLLS (no
 * fs.watch): it drains `trace.jsonl` on an interval, uploading completed
 * inferences as they appear, and does a final drain on `close()` before the
 * ephemeral CODEX_HOME (which holds the trace root) is removed.
 *
 * Never throws: a malformed line, a missing payload file, or a failed
 * upload is logged and skipped — capture is best-effort, like the Claude
 * raw-body path.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodexGenaiInferenceUpload } from 'csuite-sdk/client';

export interface BundleReaderOptions {
  /** The `CODEX_ROLLOUT_TRACE_ROOT` dir the child writes bundles under. */
  traceRoot: string;
  /** Upload a batch of completed inferences to the broker. */
  upload: (inferences: CodexGenaiInferenceUpload[]) => Promise<void>;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Drain interval in ms. Default 2000 — gen_ai isn't latency-sensitive. */
  pollMs?: number;
}

export interface BundleReader {
  /** Final drain + flush, then stop. Idempotent; awaited before CODEX_HOME rm. */
  close(): Promise<void>;
}

const DEFAULT_POLL_MS = 2000;
const NEWLINE = 0x0a;
const BUNDLE_RE = /^trace-.*$/;

interface StartedInfo {
  model: string | null;
  threadId: string | null;
  turnId: string | null;
  requestPath: string | null;
  ts: number | null;
}

export function attachBundleReader(options: BundleReaderOptions): BundleReader {
  const log =
    options.log ??
    ((msg: string, ctx: Record<string, unknown> = {}): void => {
      const record = { ts: new Date().toISOString(), component: 'bundle-reader', msg, ...ctx };
      process.stderr.write(`${JSON.stringify(record)}\n`);
    });
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  let bundleDir: string | null = null;
  let rootThreadId: string | null = null;
  let offset = 0;
  const pendingStarts = new Map<string, StartedInfo>();
  let pollTimer: NodeJS.Timeout | null = null;
  let draining = false;
  let closed = false;

  /** Pick the newest `trace-…` bundle dir under the trace root, or null. */
  const resolveBundle = (): string | null => {
    let entries: string[];
    try {
      entries = readdirSync(options.traceRoot);
    } catch {
      return null; // codex hasn't created it yet
    }
    let newest: { dir: string; mtime: number } | null = null;
    for (const name of entries) {
      if (!BUNDLE_RE.test(name)) continue;
      const full = join(options.traceRoot, name);
      let mtime = 0;
      try {
        if (!statSync(full).isDirectory()) continue;
        mtime = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (newest === null || mtime > newest.mtime) newest = { dir: full, mtime };
    }
    return newest?.dir ?? null;
  };

  const loadManifest = (): void => {
    if (bundleDir === null || rootThreadId !== null) return;
    try {
      const m = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'));
      if (m && typeof m.root_thread_id === 'string') rootThreadId = m.root_thread_id;
    } catch {
      /* manifest not written yet or unreadable — attribution just stays null */
    }
  };

  /** Build one upload entry from a paired started+completed, or null. */
  const buildEntry = (
    started: StartedInfo,
    completed: {
      responseId: string | null;
      upstreamRequestId: string | null;
      responsePath: string | null;
    },
  ): CodexGenaiInferenceUpload | null => {
    if (bundleDir === null || started.requestPath === null || completed.responsePath === null) {
      return null;
    }
    let requestBase64: string;
    let responseBase64: string;
    try {
      requestBase64 = readFileSync(join(bundleDir, started.requestPath)).toString('base64');
      responseBase64 = readFileSync(join(bundleDir, completed.responsePath)).toString('base64');
    } catch (err) {
      log('bundle-reader: payload read failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    // Basic thread attribution: root thread vs. a spawned subagent thread.
    const querySource =
      started.threadId === null
        ? null
        : rootThreadId !== null && started.threadId === rootThreadId
          ? 'codex_main_thread'
          : `codex_subagent:${started.threadId.slice(0, 8)}`;
    return {
      requestBase64,
      responseBase64,
      model: started.model,
      responseId: completed.responseId,
      upstreamRequestId: completed.upstreamRequestId,
      threadId: started.threadId,
      turnId: started.turnId,
      querySource,
      ts: started.ts,
    };
  };

  const handleLine = (line: string, batch: CodexGenaiInferenceUpload[]): void => {
    let rec: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') return;
      rec = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const payload = asObj(rec.payload);
    if (payload === null) return;
    const type = str(payload.type);
    if (type === 'inference_started') {
      const id = str(payload.inference_call_id);
      if (id === null) return;
      pendingStarts.set(id, {
        model: str(payload.model),
        threadId: str(payload.thread_id),
        turnId: str(payload.codex_turn_id),
        requestPath: str(asObj(payload.request_payload)?.path),
        ts: num(rec.wall_time_unix_ms),
      });
    } else if (type === 'inference_completed') {
      const id = str(payload.inference_call_id);
      if (id === null) return;
      const started = pendingStarts.get(id);
      pendingStarts.delete(id);
      if (!started) return;
      const entry = buildEntry(started, {
        responseId: str(payload.response_id),
        upstreamRequestId: str(payload.upstream_request_id),
        responsePath: str(asObj(payload.response_payload)?.path),
      });
      if (entry) batch.push(entry);
    }
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      if (bundleDir === null) {
        bundleDir = resolveBundle();
        if (bundleDir === null) return;
        log('bundle-reader: reading bundle', { bundleDir });
      }
      loadManifest();
      const traceFile = join(bundleDir, 'trace.jsonl');
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(traceFile, 'r');
      } catch {
        return; // trace.jsonl not there yet
      }
      const batch: CodexGenaiInferenceUpload[] = [];
      try {
        const stat = await handle.stat();
        if (stat.size > offset) {
          const len = stat.size - offset;
          const buf = Buffer.alloc(len);
          const { bytesRead } = await handle.read(buf, 0, len, offset);
          const lastNl = buf.lastIndexOf(NEWLINE, bytesRead - 1);
          if (lastNl >= 0) {
            const text = buf.subarray(0, lastNl).toString('utf8');
            offset += lastNl + 1;
            for (const line of text.split('\n')) {
              if (line.trim().length > 0) handleLine(line, batch);
            }
          }
        }
      } finally {
        await handle.close();
      }
      if (batch.length > 0) {
        try {
          await options.upload(batch);
          log('bundle-reader: uploaded inferences', { count: batch.length });
        } catch (err) {
          log('bundle-reader: upload failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log('bundle-reader: drain error', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      draining = false;
    }
  };

  pollTimer = setInterval(() => void drain(), pollMs);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();

  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      // Wait out any in-flight drain, then one final pass to catch the
      // tail written since the last poll (before CODEX_HOME is removed).
      while (draining) await new Promise((r) => setTimeout(r, 10));
      await drain();
    },
  };
}

// ── defensive helpers ───────────────────────────────────────────────

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
