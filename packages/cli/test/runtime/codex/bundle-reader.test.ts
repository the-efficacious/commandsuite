/**
 * Tests for the codex rollout-trace bundle reader (gen_ai + raw-body layer).
 *
 * Builds a synthetic bundle dir (manifest + trace.jsonl + payload files) —
 * modeled on a real codex 0.130.0 bundle — under a temp trace root, then
 * asserts the reader pairs inference_started+completed by inference_call_id,
 * reads the referenced payload bytes verbatim, and produces the right upload
 * entries (with thread attribution). The GenAiInference mapping itself is
 * covered by trace-openai-responses.test.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexGenaiInferenceUpload } from 'csuite-sdk/client';
import { afterEach, describe, expect, it } from 'vitest';
import { attachBundleReader } from '../../../src/runtime/agents/codex/bundle-reader.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeBundle(opts: { rootThreadId: string; threadId: string }): string {
  const traceRoot = mkdtempSync(join(tmpdir(), 'csuite-bundle-test-'));
  cleanups.push(() => rmSync(traceRoot, { recursive: true, force: true }));
  const bundle = join(traceRoot, 'trace-abc-def');
  const payloads = join(bundle, 'payloads');
  mkdirSync(payloads, { recursive: true });

  writeFileSync(
    join(bundle, 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      root_thread_id: opts.rootThreadId,
      payloads_dir: 'payloads',
    }),
  );
  writeFileSync(
    join(payloads, '1.json'),
    JSON.stringify({
      type: 'response.create',
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [] }],
    }),
  );
  writeFileSync(
    join(payloads, '2.json'),
    JSON.stringify({ response_id: 'resp_1', token_usage: { input_tokens: 5 }, output_items: [] }),
  );

  const lines = [
    {
      seq: 1,
      wall_time_unix_ms: 1000,
      thread_id: opts.threadId,
      payload: { type: 'rollout_started' },
    },
    {
      seq: 2,
      wall_time_unix_ms: 1100,
      thread_id: opts.threadId,
      codex_turn_id: 'turn1',
      payload: {
        type: 'inference_started',
        inference_call_id: 'inf:1',
        thread_id: opts.threadId,
        codex_turn_id: 'turn1',
        model: 'gpt-5.5',
        request_payload: {
          raw_payload_id: 'rp:1',
          kind: { type: 'inference_request' },
          path: 'payloads/1.json',
        },
      },
    },
    {
      seq: 3,
      wall_time_unix_ms: 1200,
      thread_id: opts.threadId,
      codex_turn_id: 'turn1',
      payload: {
        type: 'inference_completed',
        inference_call_id: 'inf:1',
        response_id: 'resp_1',
        upstream_request_id: 'ur1',
        response_payload: {
          raw_payload_id: 'rp:2',
          kind: { type: 'inference_response' },
          path: 'payloads/2.json',
        },
      },
    },
  ];
  writeFileSync(join(bundle, 'trace.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return traceRoot;
}

async function readAll(traceRoot: string): Promise<CodexGenaiInferenceUpload[]> {
  const uploaded: CodexGenaiInferenceUpload[] = [];
  const reader = attachBundleReader({
    traceRoot,
    upload: async (infs) => {
      uploaded.push(...infs);
    },
    log: () => {},
    pollMs: 20,
  });
  // close() does a guaranteed final drain, so timing isn't load-bearing.
  await reader.close();
  return uploaded;
}

describe('attachBundleReader', () => {
  it('pairs an inference and uploads its verbatim payload bytes (main thread)', async () => {
    const traceRoot = makeBundle({ rootThreadId: 'root-thread', threadId: 'root-thread' });
    const uploaded = await readAll(traceRoot);

    expect(uploaded).toHaveLength(1);
    const e = uploaded[0];
    if (!e) throw new Error('expected one inference');
    expect(e.model).toBe('gpt-5.5');
    expect(e.threadId).toBe('root-thread');
    expect(e.turnId).toBe('turn1');
    expect(e.responseId).toBe('resp_1');
    expect(e.upstreamRequestId).toBe('ur1');
    expect(e.ts).toBe(1100);
    // thread === root → main-thread attribution.
    expect(e.querySource).toBe('codex_main_thread');
    // Verbatim bytes round-trip to the payload files.
    const req = JSON.parse(Buffer.from(e.requestBase64, 'base64').toString('utf8'));
    const res = JSON.parse(Buffer.from(e.responseBase64, 'base64').toString('utf8'));
    expect(req.type).toBe('response.create');
    expect(res.response_id).toBe('resp_1');
  });

  it('attributes a non-root thread as a subagent', async () => {
    const traceRoot = makeBundle({ rootThreadId: 'root-thread', threadId: 'child-thread-xyz' });
    const uploaded = await readAll(traceRoot);
    expect(uploaded[0]?.querySource).toBe('codex_subagent:child-th');
  });

  it('produces nothing when the trace root is empty', async () => {
    const traceRoot = mkdtempSync(join(tmpdir(), 'csuite-bundle-empty-'));
    cleanups.push(() => rmSync(traceRoot, { recursive: true, force: true }));
    expect(await readAll(traceRoot)).toHaveLength(0);
  });
});
