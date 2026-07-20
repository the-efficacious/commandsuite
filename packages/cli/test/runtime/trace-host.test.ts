/**
 * CaptureHost integration tests.
 *
 * Starts the capture host end-to-end (activity uploader + busy signal
 * + loopback hook server + transcript reader), verifies it produces the
 * LEAN OTEL env delta for the Claude Code child (operational telemetry
 * only — the content-logging flags stay off; content is transcript-
 * primary), exposes a working hook endpoint that drives PRESENCE ONLY
 * (no content emission), enqueues activity, and tears down on close.
 * The raw-bodies dir lifecycle is covered too: close() must LEAVE the
 * dir in place (the broker owns file deletion), and host start sweeps
 * dirs orphaned by dead pids while keeping live-pid dirs.
 * There is no MITM proxy / CA anymore — those checks are gone.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client as BrokerClient } from 'csuite-sdk/client';
import type { ActivityEvent } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCaptureHost } from '../../src/runtime/trace/host.js';

/** Poll until `pred()` is true or the deadline elapses. */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Stub broker client — the capture host needs one to hand to its
 * activity uploader. We capture every uploaded event so tests can
 * assert on what got enqueued, and resolve as if the server accepted
 * them all.
 */
function stubBrokerClient(): { client: BrokerClient; uploaded: ActivityEvent[] } {
  const uploaded: ActivityEvent[] = [];
  const client = {
    uploadActivity: vi.fn(async (_memberName: string, req: { events: ActivityEvent[] }) => {
      uploaded.push(...req.events);
      return { accepted: req.events.length };
    }),
  } as unknown as BrokerClient;
  return { client, uploaded };
}

const BASE = {
  brokerUrl: 'http://127.0.0.1:8787',
  token: 'tok-abc123',
  name: 'TEST',
  log: () => {},
};

describe('CaptureHost', () => {
  let host: Awaited<ReturnType<typeof startCaptureHost>> | null = null;

  beforeEach(() => {
    host = null;
  });

  afterEach(async () => {
    if (host) {
      await host.close().catch(() => {});
      host = null;
    }
    // close() intentionally leaves the raw-bodies dir behind (the broker
    // owns file deletion) — remove this process's dir so tests don't
    // litter the real tmpdir.
    rmSync(join(tmpdir(), `csuite-otel-bodies-${BASE.name}-${process.pid}`), {
      recursive: true,
      force: true,
    });
  });

  it('exposes a loopback hook endpoint URL', async () => {
    host = await startCaptureHost({ ...BASE, brokerClient: stubBrokerClient().client });
    expect(host.hookEndpointUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook\/tool-event$/);
  });

  it('envVars returns the LEAN operational OTEL delta plus FILE-mode raw bodies — no prose content flags, no proxy/CA', async () => {
    host = await startCaptureHost({ ...BASE, brokerClient: stubBrokerClient().client });
    const env = host.envVars();
    // The lean operational OTEL export is present.
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(env.OTEL_METRICS_EXPORTER).toBe('otlp');
    expect(env.OTEL_LOGS_EXPORTER).toBe('otlp');
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/json');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toMatch(/\/otlp$/);
    // Literal space after "Bearer" — the exporter does not url-decode.
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer ${BASE.token}`);
    // FILE-mode raw API bodies IS enabled — it carries the full context
    // for the gen_ai inference layer. It must be `file:<dir>` and the dir
    // must have been created on disk.
    expect(env.OTEL_LOG_RAW_API_BODIES).toBeDefined();
    expect(env.OTEL_LOG_RAW_API_BODIES?.startsWith('file:')).toBe(true);
    const bodiesDir = env.OTEL_LOG_RAW_API_BODIES?.slice('file:'.length) ?? '';
    expect(bodiesDir.length).toBeGreaterThan(0);
    expect(existsSync(bodiesDir)).toBe(true);
    expect(statSync(bodiesDir).isDirectory()).toBe(true);
    // The prose content-logging flags stay OFF — that content is
    // transcript-primary.
    expect(env.OTEL_LOG_USER_PROMPTS).toBeUndefined();
    expect(env.OTEL_LOG_ASSISTANT_RESPONSES).toBeUndefined();
    expect(env.OTEL_LOG_TOOL_DETAILS).toBeUndefined();
    expect(env.OTEL_LOG_TOOL_CONTENT).toBeUndefined();
    // No proxy / CA vars — the MITM is gone.
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it('the FILE-mode raw bodies dir SURVIVES close() — the broker owns file deletion', async () => {
    host = await startCaptureHost({ ...BASE, brokerClient: stubBrokerClient().client });
    const bodiesDir = host.envVars().OTEL_LOG_RAW_API_BODIES?.slice('file:'.length) ?? '';
    expect(existsSync(bodiesDir)).toBe(true);
    // Simulate a body Claude wrote that the broker has NOT captured yet.
    writeFileSync(join(bodiesDir, 'req_test.response.json'), '{"id":"msg_test"}');
    await host.close();
    host = null;
    // close() must NOT rm the dir — the broker unlinks each file after
    // capture, and rm'ing here would destroy the uncaptured tail.
    expect(existsSync(bodiesDir)).toBe(true);
    expect(existsSync(join(bodiesDir, 'req_test.response.json'))).toBe(true);
  });

  it('start sweeps stale raw-bodies dirs of dead pids, keeps live-pid dirs and its own', async () => {
    // A dir whose trailing pid can't exist (way above any real pid) → dead.
    const deadDir = join(tmpdir(), 'csuite-otel-bodies-x-999999999');
    // A dir carrying THIS process's pid → alive, must be kept.
    const aliveDir = join(tmpdir(), `csuite-otel-bodies-y-${process.pid}`);
    mkdirSync(deadDir, { recursive: true });
    mkdirSync(aliveDir, { recursive: true });
    const logged: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    try {
      host = await startCaptureHost({
        ...BASE,
        log: (msg, ctx) => logged.push({ msg, ctx }),
        brokerClient: stubBrokerClient().client,
      });
      const ownDir = host.envVars().OTEL_LOG_RAW_API_BODIES?.slice('file:'.length) ?? '';
      // Dead-pid dir swept; alive-pid dir kept; our own dir created + kept.
      expect(existsSync(deadDir)).toBe(false);
      expect(existsSync(aliveDir)).toBe(true);
      expect(existsSync(ownDir)).toBe(true);
      const sweepLog = logged.find((l) => l.msg === 'capture-host: swept stale raw-bodies dirs');
      expect(sweepLog).toBeTruthy();
      expect(sweepLog?.ctx?.swept).toBeGreaterThanOrEqual(1);
      await host.close();
      host = null;
      // Still there after close — only a future sweep (dead pid) removes it.
      expect(existsSync(aliveDir)).toBe(true);
      expect(existsSync(ownDir)).toBe(true);
    } finally {
      rmSync(deadDir, { recursive: true, force: true });
      rmSync(aliveDir, { recursive: true, force: true });
    }
  });

  it('envVars strips a trailing slash from brokerUrl before appending /otlp', async () => {
    host = await startCaptureHost({
      ...BASE,
      brokerUrl: 'http://127.0.0.1:8787/',
      brokerClient: stubBrokerClient().client,
    });
    const env = host.envVars();
    // No double slash — trailing slash stripped before `${base}/otlp`.
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:8787/otlp');
  });

  it('enqueue forwards events to the activity uploader', async () => {
    const stub = stubBrokerClient();
    host = await startCaptureHost({ ...BASE, brokerClient: stub.client });
    host.enqueue({ kind: 'objective_open', ts: 1_700_000_000_000, objectiveId: 'obj-1' });
    await host.close();
    host = null;
    expect(stub.uploaded.some((e) => e.kind === 'objective_open')).toBe(true);
  });

  it('noteObjectiveOpen / noteObjectiveClose enqueue lifecycle markers', async () => {
    const stub = stubBrokerClient();
    host = await startCaptureHost({ ...BASE, brokerClient: stub.client });
    host.noteObjectiveOpen('obj-42');
    host.noteObjectiveClose('obj-42', 'done');
    await host.close();
    host = null;
    const kinds = stub.uploaded.map((e) => e.kind);
    expect(kinds).toContain('objective_open');
    expect(kinds).toContain('objective_close');
  });

  it('Claude Code tool hooks drive PRESENCE only — no tool_action content', async () => {
    const stub = stubBrokerClient();
    host = await startCaptureHost({ ...BASE, brokerClient: stub.client });

    // Drive the busy signal up (PreToolUse) then complete it (PostToolUse)
    // through the real loopback hook endpoint — the same path Claude Code
    // uses. The hooks must move presence but emit NO content (the
    // transcript reader is the single source of tool_action now).
    await fetch(host.hookEndpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_use_id: 't1', tool_name: 'Bash' }),
    });
    expect(host.busy.busy).toBe(true);

    await fetch(host.hookEndpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_use_id: 't1',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
        tool_response: 'ok',
      }),
    });
    expect(host.busy.busy).toBe(false);

    await host.close();
    host = null;

    // No tool_action was emitted from the hook path.
    expect(stub.uploaded.some((e) => e.kind === 'tool_action')).toBe(false);
  });

  it('Claude Code UserPromptSubmit drives PRESENCE only — no user_prompt content', async () => {
    const stub = stubBrokerClient();
    host = await startCaptureHost({ ...BASE, brokerClient: stub.client });

    await fetch(host.hookEndpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt_id: 'p-1',
        session_id: 's-1',
        prompt: 'do the thing',
      }),
    });
    // Turn presence opens (working)…
    expect(host.busy.state()).toBe('working');

    await host.close();
    host = null;

    // …but no user_prompt content is emitted from the hook path.
    expect(stub.uploaded.some((e) => e.kind === 'user_prompt')).toBe(false);
  });

  it('a hook transcript_path arms the transcript reader, whose content flows to the uploader', async () => {
    const stub = stubBrokerClient();
    host = await startCaptureHost({ ...BASE, brokerClient: stub.client });

    // Hand-author a tiny transcript with one assistant turn.
    const dir = mkdtempSync(join(tmpdir(), 'csuite-transcript-'));
    const transcriptPath = join(dir, 'session.jsonl');
    const assistantLine = JSON.stringify({
      type: 'assistant',
      uuid: 'a-1',
      timestamp: '2026-07-05T00:00:01.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'hello from the transcript' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    writeFileSync(transcriptPath, `${assistantLine}\n`);

    try {
      // A hook fires carrying the transcript path — the same signal Claude
      // Code sends. The host relays it to the reader, which tails the file.
      await fetch(host.hookEndpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          prompt_id: 'p-1',
          transcript_path: transcriptPath,
        }),
      });

      await waitFor(() => stub.uploaded.some((e) => e.kind === 'llm_exchange'));
      await host.close();
      host = null;

      const exchange = stub.uploaded.find((e) => e.kind === 'llm_exchange');
      expect(exchange).toBeTruthy();
      if (exchange && exchange.kind === 'llm_exchange') {
        expect(exchange.entry.response?.messages[0]?.content[0]).toMatchObject({
          type: 'text',
          text: 'hello from the transcript',
        });
        expect(exchange.entry.request.model).toBe('claude-opus-4-8');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('close() is idempotent', async () => {
    host = await startCaptureHost({ ...BASE, brokerClient: stubBrokerClient().client });
    await host.close();
    await host.close(); // second call must not throw
    host = null;
  });

  it('close() force-drains leaked busy handles as the final teardown safety net', async () => {
    const logged: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    host = await startCaptureHost({
      ...BASE,
      log: (msg, ctx) => logged.push({ msg, ctx }),
      brokerClient: stubBrokerClient().client,
    });

    // Leak handles as if an adapter forgot to call finish(). Disable the
    // max-age timer so this test isn't racing the default net.
    host.busy.start('turn_active', { maxAgeMs: Number.POSITIVE_INFINITY });
    host.busy.start('tool_inflight', { maxAgeMs: Number.POSITIVE_INFINITY });
    expect(host.busy.busy).toBe(true);
    expect(host.busy.getSourceCounts()).toEqual({ turn_active: 1, tool_inflight: 1 });

    await host.close();

    expect(host.busy.busy).toBe(false);
    expect(host.busy.getSourceCounts()).toEqual({ turn_active: 0, tool_inflight: 0 });
    const drainLog = logged.find(
      (l) => l.msg === 'capture-host: force-drained leaked busy handles at teardown',
    );
    expect(drainLog).toBeTruthy();
    expect(drainLog?.ctx?.drained).toBe(2);
    expect(drainLog?.ctx?.sourceCounts).toEqual({ turn_active: 1, tool_inflight: 1 });
    host = null;
  });

  it('close() does not log the drain message when no handles leaked', async () => {
    const logged: Array<{ msg: string }> = [];
    host = await startCaptureHost({
      ...BASE,
      log: (msg) => logged.push({ msg }),
      brokerClient: stubBrokerClient().client,
    });
    await host.close();
    host = null;
    const drainLog = logged.find(
      (l) => l.msg === 'capture-host: force-drained leaked busy handles at teardown',
    );
    expect(drainLog).toBeUndefined();
  });
});
