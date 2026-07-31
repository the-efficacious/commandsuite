/**
 * Per-record resolution policy for the runner-local OTLP relay.
 *
 * THESE TESTS FAIL ON 5ed64c6 AND ARE MEANT TO. They specify a contract
 * the relay does not yet meet; they are the verifier's statement of what
 * "done" is, not a description of current behaviour.
 *
 * WHAT THEY PIN
 * -------------
 * `bodyRefsToInline` THROWS on a body_ref that is missing, not a file,
 * oversized, or not byte-exact UTF-8. The throw is caught by the route's
 * outer handler, so the ENTIRE batch is dropped and answered 503.
 *
 * The broker already covers this exact condition per-body and has since
 * before the relay existed — `genai-correlator.test.ts:266`, "skips an
 * unreadable body_ref without throwing or emitting". One bad body cost
 * one body. Under the relay it costs the batch.
 *
 * And `app.ts:1354` records why non-2xx is the wrong answer here:
 *
 *     an OTEL exporter that gets a non-2xx will retry the batch
 *     indefinitely; we'd rather drop a malformed batch than wedge
 *     the exporter
 *
 * The relay returns non-2xx on conditions that never clear. NOTE the
 * limit of that citation: it is the codebase's claim about exporter
 * behaviour, not a measurement of Claude's exporter. If it is wrong,
 * these cases are batch LOSS rather than a wedge — a blast-radius
 * regression from per-body to per-batch either way.
 *
 * THE CONTRACT THEY SPECIFY
 * -------------------------
 * An unresolvable record is SKIPPED, not fatal: forward it unchanged
 * with its `body_ref` intact, and exclude it from the resolved `refs`
 * count. The broker's existing unreadable-ref path then skips that one
 * record, the delta excludes it, and `captured === refs.length` still
 * holds on both sides. Healthy bodies in the same batch land and unlink.
 *
 * This preserves the ack invariant exactly rather than weakening it.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type OtlpRelay, startOtlpRelay } from '../../src/runtime/trace/otlp-relay.js';

type Attr = { key: string; value: { stringValue: string } };

/** A batch of body records, one per ref. */
function batch(refs: string[]): Record<string, unknown> {
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: refs.map((r) => ({
              attributes: [
                { key: 'event.name', value: { stringValue: 'api_request_body' } },
                { key: 'body_ref', value: { stringValue: r } },
              ],
            })),
          },
        ],
      },
    ],
  };
}

function attrsOf(payload: unknown, index: number): Attr[] {
  const p = payload as {
    resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: Array<{ attributes?: Attr[] }> }> }>;
  };
  return p.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[index]?.attributes ?? [];
}

/**
 * A broker that acknowledges exactly what the relay declares. Honest by
 * construction: it never claims to have captured more than it was told
 * to expect, so a mismatch in these tests is the relay's accounting.
 */
async function startBroker(): Promise<{
  url: string;
  server: Server;
  received: unknown[];
  /** `X-CSuite-Raw-Bodies` as declared by the relay, per request. */
  declared: string[];
}> {
  const received: unknown[] = [];
  const declared: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      const header = String(req.headers['x-csuite-raw-bodies'] ?? '0');
      declared.push(header);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ partialSuccess: {}, csuite: { rawBodiesCaptured: Number(header) } }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const a = server.address();
  if (a === null || typeof a === 'string') throw new Error('broker did not bind');
  return { url: `http://127.0.0.1:${a.port}`, server, received, declared };
}

describe('relay per-record resolution', () => {
  const dirs: string[] = [];
  const relays: OtlpRelay[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(relays.splice(0).map((r) => r.close()));
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function harness() {
    const dir = mkdtempSync(join(tmpdir(), 'csuite-relay-res-'));
    dirs.push(dir);
    const broker = await startBroker();
    servers.push(broker.server);
    const relay = await startOtlpRelay({ brokerUrl: broker.url, token: 't', rawBodiesDir: dir });
    relays.push(relay);
    const send = (refs: string[]) =>
      fetch(`${relay.endpoint}/v1/logs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify(batch(refs)),
      });
    return { dir, broker, send };
  }

  it('an unresolvable body_ref does not strand the healthy bodies beside it', async () => {
    // The blast-radius case. One missing file must cost one body, which
    // is what the broker's own correlator has always done.
    const { dir, broker, send } = await harness();
    const good = join(dir, 'good.json');
    writeFileSync(good, '{"ok":true}');
    const missing = join(dir, 'gone.json'); // never created

    const res = await send([good, missing]);

    expect(res.status).toBe(200);
    expect(broker.received.length).toBe(1);
    // The healthy body was substituted and its spool file released.
    const first = attrsOf(broker.received[0], 0);
    expect(first.find((a) => a.key === 'body')?.value.stringValue).toBe('{"ok":true}');
    expect(existsSync(good)).toBe(false);
    // The unresolvable one was forwarded UNCHANGED for the broker to skip.
    const second = attrsOf(broker.received[0], 1);
    expect(second.find((a) => a.key === 'body_ref')?.value.stringValue).toBe(missing);
    expect(second.some((a) => a.key === 'body')).toBe(false);
  });

  it('declares only the bodies it actually resolved', async () => {
    // The ack invariant must survive the degradation. A batch of two
    // where one is unresolvable must declare ONE, so the broker's delta
    // of one is an exact match rather than a short count that would
    // fail the ack and strand the body that DID land.
    const { dir, broker, send } = await harness();
    const good = join(dir, 'good.json');
    writeFileSync(good, '{"ok":true}');

    const res = await send([good, join(dir, 'absent.json')]);

    expect(res.status).toBe(200);
    expect(broker.declared).toEqual(['1']); // one resolved, not two
  });

  it('a redelivery after a successful ack succeeds instead of failing forever', async () => {
    // Measured on 5ed64c6: first 200 (file unlinked), every retry 503,
    // never clearing. Any lost or timed-out response after the unlink
    // poisons that batch permanently — the bytes landed and the file is
    // gone, so there is nothing left to resolve and nothing to retry.
    // With zero resolvable refs the batch is a no-op the relay can
    // safely acknowledge.
    const { dir, send } = await harness();
    const p = join(dir, 'req.json');
    writeFileSync(p, '{"a":1}');

    const first = await send([p]);
    expect(first.status).toBe(200);
    expect(existsSync(p)).toBe(false);

    // The exporter never observed that 200 and redelivers the batch.
    expect((await send([p])).status).toBe(200);
    expect((await send([p])).status).toBe(200);
  });
});
