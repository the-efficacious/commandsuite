/**
 * CaptureHost — the runner-owned handle that turns each agent's NATIVE
 * instrumentation into one normalized activity stream.
 *
 * There is NO network interception here — the CaptureHost is the
 * capture SINK the runner wires every adapter into:
 *
 *   - the batched `ActivityUploader` (ships `ActivityEvent`s to the
 *     broker in real time),
 *   - the `busy` signal (driven by Claude Code hooks and the codex
 *     app-server item stream),
 *   - the loopback hook server (Claude Code POSTs PreToolUse /
 *     PostToolUse / UserPromptSubmit / Stop / Notification here — it
 *     drives `busy` and surfaces the `transcript_path`; PRESENCE-ONLY,
 *     no content),
 *   - the `TranscriptReader` (tails the Claude Code session transcript
 *     the hooks point us at and emits the CONTENT — `llm_exchange`
 *     turns with thinking/text/tool_use/usage, `tool_action` results,
 *     `user_prompt` openers).
 *
 * Adapters push captured activity through `enqueue(event)`. For Claude
 * Code the capture mechanism is TRANSCRIPT-PRIMARY for CONTENT: the
 * child writes its full turn transcript to disk; the hook server hands
 * us that file's path; the TranscriptReader tails it and feeds the
 * uploader untruncated content (including thinking). The hooks
 * contribute only presence (the tool/turn windows). OPERATIONAL
 * telemetry (cost, tokens, api_request/api_error, tool decisions,
 * session/productivity metrics, lifecycle events) comes back via a LEAN
 * OTEL export (`envVars()` below) to the broker's `/otlp` sink. The
 * prose content-logging flags (USER_PROMPTS / ASSISTANT_RESPONSES /
 * TOOL_DETAILS / TOOL_CONTENT) stay OFF — that content lives in the
 * transcript. The ONE content flag we DO set is
 * `OTEL_LOG_RAW_API_BODIES=file:<dir>`: FILE mode makes Claude write the
 * COMPLETE untruncated Anthropic request/response bodies to a per-runner
 * directory and emit a `body_ref` file path on each OTEL log record. A
 * runner-local relay resolves those refs and forwards inline bodies to the
 * broker's authoritative full-context gen_ai inference layer.
 * For codex the runner's app-server adapter is the source (no
 * transcript). Either way the sink is identical.
 *
 * Everything is loopback-only (the hook server) and scoped to the
 * runner's lifetime. On `close()` the uploader drains (best-effort),
 * and the transcript reader + hook server tear down. The raw-bodies
 * dir is deliberately LEFT IN PLACE at close: the relay unlinks a body only
 * after broker acknowledgement, so removing the dir here would destroy an
 * unacknowledged tail. Completed empty dirs are swept at the NEXT host start.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { logger as defaultLogger, type Logger } from 'csuite-core';
import type { Client as BrokerClient, CodexGenaiInferenceUpload } from 'csuite-sdk/client';
import type { ActivityEvent } from 'csuite-sdk/types';
import { sweepStaleSessionLogs } from '../session-log.js';
import { ActivityUploader, type ActivityUploaderStats } from './activity-uploader.js';
import { type BusySignal, createBusySignal } from './busy.js';
import { type HookServer, startHookServer } from './hook-server.js';
import { type OtlpRelay, startOtlpRelay, sweepQuarantine } from './otlp-relay.js';
import { attachTranscriptReader, type TranscriptReader } from './transcript-reader.js';

const CAPTURE_COMPLETE_MARKER = '.csuite-capture-complete';

export interface CaptureHostOptions {
  brokerClient: BrokerClient;
  name: string;
  /**
   * Broker base URL. `envVars()` strips any trailing slash and bakes the
   * child's OTLP endpoint from it (`${base}/otlp`) for the operational
   * OTEL export.
   */
  brokerUrl: string;
  /**
   * The member's bearer token. Sent as the child's OTLP
   * `Authorization: Bearer <token>` header for the operational OTEL
   * export.
   */
  token: string;
  /**
   * Relayed from the hook server's SessionStart route with the hook's
   * `source` (`startup` / `resume` / `clear` / `compact`). The runner
   * uses compact/clear as the "context fell off" signal to push a
   * `context_refresh` re-brief. Optional; claude only (codex has
   * no hook server).
   */
  onSessionStart?: (source: string) => void;
  logger?: Logger;
}

export interface CaptureHost {
  /**
   * "Agent is working" signal. Driven by native instrumentation —
   * Claude Code hook events (via the hook server) and the codex
   * app-server item stream — NOT by intercepted network traffic. The
   * runner subscribes and reports the boolean state to the broker so
   * the web UI can render a spinner next to the agent's name.
   */
  readonly busy: BusySignal;
  /**
   * Loopback HTTP endpoint URL that Claude Code hooks POST to. The
   * `claude` adapter writes it into `.claude/settings.json` as a
   * `type: "http"` hook target so lifecycle events drive `busy` and
   * surface the `transcript_path` that arms the transcript reader.
   * Presence-only — the hooks emit no content.
   */
  readonly hookEndpointUrl: string;
  /**
   * Enqueue a captured activity event. Adapters call this; it delegates
   * to the batched uploader. Returns immediately.
   */
  enqueue(event: ActivityEvent): void;
  /**
   * Env vars to merge into the agent child's environment. Enables Claude
   * Code's operational OTEL export (metrics + structured events) to the
   * broker's `/otlp` sink, plus FILE-mode raw API body capture
   * (`OTEL_LOG_RAW_API_BODIES=file:<dir>`) that feeds the full-context
   * gen_ai inference layer. The prose content-logging flags stay OFF —
   * that content is captured separately via the transcript. Returns a
   * delta, not a full replacement.
   */
  envVars(): Record<string, string>;
  /**
   * OTLP logs target for the codex runner's native OTEL export. Codex is
   * configured (via its ephemeral config.toml `[otel]` block) to POST its
   * log records here with this bearer token. Unlike Claude Code (env
   * vars, base endpoint), codex POSTs to the configured URL VERBATIM — it
   * does NOT append `/v1/logs` — so we hand it the full logs path.
   */
  otelLogsTarget(): { endpoint: string; token: string };
  /**
   * Upload codex gen_ai inferences (the full-context layer — verbatim
   * Responses request/response bytes from a rollout-trace bundle) to the
   * broker. Self-authenticated over the runner's existing broker channel.
   * A no-op for an empty batch.
   */
  uploadGenai(inferences: CodexGenaiInferenceUpload[]): Promise<void>;
  /** Record an objective_open event in the agent's activity stream. */
  noteObjectiveOpen(objectiveId: string): void;
  /** Record an objective_close event. */
  noteObjectiveClose(
    objectiveId: string,
    result: 'done' | 'cancelled' | 'reassigned' | 'runner_shutdown',
  ): void;
  /**
   * Lifetime accounting of the activity uploader (enqueued / uploaded /
   * dropped). The agent-session driver stamps this into the run
   * summary + `session_end` event so an incomplete trace is visible
   * at the end of the run instead of silently short on the broker.
   */
  stats(): ActivityUploaderStats;
  /** Flush the activity uploader + tear down the hook server. */
  close(): Promise<void>;
}

export async function startCaptureHost(options: CaptureHostOptions): Promise<CaptureHost> {
  const log = options.logger ?? defaultLogger.child('capture-host');

  // Sweep only dirs carrying an explicit completed-capture marker.
  // PID death is NOT evidence that the spool was shipped: a crash or
  // network outage can leave the only copy here. Unmarked dirs survive
  // indefinitely for recovery rather than being silently discarded.
  // Entirely
  // best-effort — the sweep can never prevent host start.
  try {
    let swept = 0;
    for (const entry of readdirSync(tmpdir())) {
      const match = /^csuite-otel-bodies-.+-(\d+)$/.exec(entry);
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid === process.pid) continue; // our own (or a same-pid sibling) — alive by definition
      const dir = join(tmpdir(), entry);
      if (!existsSync(join(dir, CAPTURE_COMPLETE_MARKER))) continue;
      // A marker records that the spool was empty when close() ran. Re-check
      // at deletion time so a late writer can never turn that old fact into
      // authority to delete newly unshipped bytes.
      if (readdirSync(dir).some((child) => child !== CAPTURE_COMPLETE_MARKER)) continue;
      let alive = true;
      try {
        process.kill(pid, 0); // signal 0 = liveness probe, sends nothing
      } catch (err) {
        // ESRCH → no such process → dead. EPERM → the pid exists but
        // belongs to another user → treat as ALIVE and leave it.
        alive = (err as NodeJS.ErrnoException).code !== 'ESRCH';
      }
      if (alive) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
        swept++;
      } catch {
        // Best-effort per dir — a racing sweep or permissions issue is fine.
      }
    }
    if (swept > 0) log.info('swept stale raw-bodies dirs', { swept });
  } catch (err) {
    log.warn('stale raw-bodies sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Quarantined payloads and per-pid session logs are the two runner
  // artefacts that previously grew without any bound at all. Both are
  // swept here, on the same best-effort footing as the spool sweep
  // above: start is the one moment we know no live run owns them.
  try {
    let removed = 0;
    let bytes = 0;
    for (const entry of readdirSync(tmpdir())) {
      if (!/^csuite-otel-bodies-.+-\d+$/.test(entry)) continue;
      const result = sweepQuarantine(join(tmpdir(), entry));
      removed += result.removed;
      bytes += result.bytesReclaimed;
    }
    // Reported, not silent: the payloads are gone but the manifest
    // entries recording each gap remain, and this says how many.
    if (removed > 0) log.info('swept aged quarantined bodies', { removed, bytesReclaimed: bytes });
  } catch (err) {
    log.warn('quarantine sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { removed, failed } = sweepStaleSessionLogs();
    if (removed > 0 || failed > 0) log.info('swept stale session logs', { removed, failed });
  } catch (err) {
    log.warn('session log sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Per-runner directory for FILE-mode raw API bodies. Claude Code, with
  // `OTEL_LOG_RAW_API_BODIES=file:<dir>`, writes the COMPLETE untruncated
  // Anthropic request/response bodies here and emits a `body_ref` file
  // path on each OTEL log record (instead of a 60KB-truncated inline
  // body). The broker (co-located on the dev host) resolves those refs
  // into the full-context gen_ai inference records, and OWNS deletion:
  // it unlinks each file after capturing its bytes. We never rm this
  // dir at close — see the stale-dir sweep above for orphan cleanup.
  //
  // The suffix is derived from the member name + pid (NOT a random or
  // timestamp) so it's deterministic even where Date.now()/Math.random()
  // are unavailable. The name is sanitized to a filesystem-safe token.
  const safeName = options.name.replace(/[^A-Za-z0-9_-]+/g, '_') || 'runner';
  const rawBodiesDir = join(tmpdir(), `csuite-otel-bodies-${safeName}-${process.pid}`);
  mkdirSync(rawBodiesDir, { recursive: true });

  // Claude posts OTLP to loopback. The relay resolves FILE-mode body_ref
  // paths on the runner, then forwards inline byte-exact bodies to the
  // broker. Codex does not use this endpoint; it keeps its bundle upload.
  const otlpRelay: OtlpRelay = await startOtlpRelay({
    brokerUrl: options.brokerUrl,
    token: options.token,
    rawBodiesDir,
    logger: log.child('otlp-relay'),
  });

  // Streaming activity uploader — batches events, ships to broker.
  const uploader = new ActivityUploader({
    brokerClient: options.brokerClient,
    name: options.name,
    logger: log.child('activity-uploader'),
  });

  // Agent ACTIVITY signal — driven by native instrumentation. Claude
  // Code hooks bump `tool_inflight` (Pre/PostToolUse) and `turn_active`
  // (UserPromptSubmit/Stop) plus set `blocked` (Notification); the codex
  // adapter bumps `turn_active` (turn/started·completed) and
  // `tool_inflight` (item stream). The runner reports the derived
  // idle/working/blocked state to the broker.
  const busy = createBusySignal({ logger: log.child('activity') });

  // Latest transcript path learned from a Claude Code hook body. Null
  // until the first hook fires; the transcript reader polls `getPath`
  // and begins tailing once it's known. The hook server dedups the
  // callback, and the reader pins the path, so an idempotent re-set is
  // harmless.
  let transcriptPath: string | null = null;

  // Loopback HTTP endpoint for Claude Code hook events. PRESENCE-ONLY:
  // it drives the busy signal (tool/turn windows, blocked) and surfaces
  // the `transcript_path`. It emits NO content — the transcript reader
  // is the single source of `llm_exchange` / `tool_action` /
  // `user_prompt` now. For codex this is unused — codex feeds busy +
  // content via the app-server stream.
  const hookServer: HookServer = await startHookServer({
    busy,
    logger: log.child('hook-server'),
    onTranscriptPath: (path) => {
      transcriptPath = path;
    },
    onSessionStart: options.onSessionStart,
  });

  // Transcript reader — the transcript-primary capture source for Claude
  // runners. Tails the session transcript the hooks point us at and
  // enqueues the CONTENT events (thinking/text/tool_use turns, tool
  // results, openers), redacted by the core parser. It idles until the
  // first hook surfaces a path (getPath returns null before then).
  const transcriptReader: TranscriptReader = attachTranscriptReader({
    getPath: () => transcriptPath,
    enqueue: (event) => uploader.enqueue(event),
    logger: log.child('transcript-reader'),
  });

  log.info('started', {
    hookUrl: hookServer.url,
    name: options.name,
    rawBodiesDir,
  });

  let closed = false;

  return {
    busy,
    hookEndpointUrl: hookServer.url,
    enqueue(event) {
      uploader.enqueue(event);
    },
    /**
     * Env delta for the Claude Code child. Enables Claude Code's LEAN
     * OTEL export so the child ships OPERATIONAL telemetry — metrics
     * (cost, tokens, session/productivity) and structured events
     * (api_request/api_error, tool_decision, lifecycle) — to the broker's
     * `/otlp` sink. It ALSO sets `OTEL_LOG_RAW_API_BODIES=file:<dir>`:
     * FILE mode makes Claude write the COMPLETE untruncated Anthropic
     * request/response bodies to the per-runner `rawBodiesDir` and emit a
     * `body_ref` file path on each log record (no 60KB inline truncation).
     * The broker resolves those refs into the authoritative full-context
     * gen_ai inference records.
     *
     * The prose content flags (OTEL_LOG_USER_PROMPTS /
     * _ASSISTANT_RESPONSES / _TOOL_DETAILS / _TOOL_CONTENT) are
     * deliberately OMITTED — that content is captured separately via the
     * transcript (the TranscriptReader tails the session JSONL the hooks
     * surface), so duplicating it in the operational signals would be
     * redundant. Returns a delta, not a full replacement.
     */
    envVars(): Record<string, string> {
      return {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: otlpRelay.endpoint,
        // LITERAL space after "Bearer" — the OTEL JS exporter does NOT
        // url-decode header values, so an encoded `%20` would fail the
        // broker's `Bearer ` check. csuite_ tokens are base64url, so
        // nothing in the value needs escaping.
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${options.token}`,
        // FILE mode — write complete untruncated request/response bodies
        // to the per-runner dir; each log record carries a `body_ref`
        // path the co-located broker reads to build the gen_ai layer.
        OTEL_LOG_RAW_API_BODIES: `file:${rawBodiesDir}`,
      };
    },
    otelLogsTarget() {
      // Codex posts to the configured URL verbatim (no /v1/logs suffix),
      // so hand it the full logs path. Bearer resolves to the member.
      const base = options.brokerUrl.replace(/\/+$/, '');
      return { endpoint: `${base}/otlp/v1/logs`, token: options.token };
    },
    async uploadGenai(inferences) {
      if (inferences.length === 0) return;
      await options.brokerClient.uploadGenaiInference(options.name, { inferences });
    },
    noteObjectiveOpen(objectiveId) {
      uploader.enqueue({
        kind: 'objective_open',
        ts: Date.now(),
        objectiveId,
      });
    },
    noteObjectiveClose(objectiveId, result) {
      uploader.enqueue({
        kind: 'objective_close',
        ts: Date.now(),
        objectiveId,
        result,
      });
    },
    stats() {
      return uploader.stats();
    },
    async close() {
      if (closed) return;
      closed = true;
      // Stop the transcript reader FIRST so no new content is enqueued
      // while the uploader drains. Synchronous + idempotent.
      try {
        transcriptReader.close();
      } catch (err) {
        log.warn('transcript reader close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await uploader.close().catch((err: unknown) => {
        log.error('uploader close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      await hookServer.close().catch((err: unknown) => {
        log.warn('hook server close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      await otlpRelay.close().catch((err: unknown) => {
        log.warn('OTLP relay close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // A completed marker is earned only when no body file remains after
      // the relay stopped accepting work. The next host start may remove
      // this directory. Any unacknowledged file prevents the marker and is
      // retained across crashes/restarts for explicit recovery.
      try {
        const remaining = readdirSync(rawBodiesDir).filter(
          (entry) => entry !== CAPTURE_COMPLETE_MARKER,
        );
        if (remaining.length === 0) {
          writeFileSync(join(rawBodiesDir, CAPTURE_COMPLETE_MARKER), '', { mode: 0o600 });
        } else {
          log.warn('retaining unshipped raw-body spool', {
            rawBodiesDir,
            remaining: remaining.length,
          });
        }
      } catch (err) {
        log.warn('could not mark raw-body spool complete', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // The FILE-mode raw bodies dir is deliberately NOT removed here.
      // Removing it would destroy an unacknowledged tail; a future host
      // start sweeps only explicitly completed empty spools.
      //
      // Final safety net for the busy signal. Sub-systems above (hook
      // server drain, codex sniff drain at its own teardown) should
      // have drained every handle they own. If anything slipped
      // through — a dropped item/completed notification, a hook event
      // that never fired — this guarantees the indicator goes idle
      // before the runner exits rather than waiting on the 30s
      // server-side TTL.
      //
      // Snapshot per-source counts BEFORE the drain so the diagnostic
      // log tells us which source leaked (the counts are all zero
      // after forceFinishAll, which would be useless on its own).
      const leakedCounts = busy.getSourceCounts();
      const drained = busy.forceFinishAll();
      if (drained > 0) {
        log.warn('force-drained leaked busy handles at teardown', {
          drained,
          sourceCounts: leakedCounts,
        });
      }
      log.info('closed');
    },
  };
}
