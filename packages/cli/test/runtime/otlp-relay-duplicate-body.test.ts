/**
 * Duplicate `body` attributes — the relay must resolve a `body_ref` to
 * exactly ONE body attribute, deterministically, whatever order the
 * producer listed its attributes in.
 *
 * `bodyRefsToInline` rewrites the `body_ref` attribute IN PLACE to
 * `body` (otlp-relay.ts). If the producer already emitted an inline
 * `body` on the same record, that leaves TWO attributes keyed `body` on
 * the wire — and the broker's `flattenAttributes` is `out[key] = …` in
 * array order, so **last one wins**. Which serialisation the broker
 * stores is then decided by the producer's array order rather than by
 * any decision this code makes.
 *
 * Two things make that a capture-contract violation rather than a
 * cosmetic duplicate:
 *
 *   1. The relay counts the substitution in `refs`, reports it in
 *      `X-CSuite-Raw-Bodies`, and **unlinks the spool file on ack** — so
 *      in the shadowed case it destroys the only copy of the bytes it
 *      claimed to capture, while the broker stored different bytes.
 *   2. Nothing reports it. `refs.length` counts substitutions performed,
 *      not substitutions that survived to storage.
 *
 * These assert the value the CONSUMER reads — the flattened attribute
 * map, using the broker's own flattening rule — not the attribute array.
 * Asserting on the array alone cannot see a last-wins collapse at all,
 * which is the whole defect.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type OtlpRelay, startOtlpRelay } from '../../src/runtime/trace/otlp-relay.js';

/**
 * The broker's attribute flattener, mirroring `otlp-parse.ts`
 * `flattenAttributes`: later entries overwrite earlier ones. Duplicated
 * here rather than imported because the point is what the SERVER does
 * with what the RUNNER sent, across a package boundary.
 */
function flattenAttributes(list: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(list)) return out;
  for (const kv of list as Array<{ key?: unknown; value?: { stringValue?: unknown } }>) {
    const key = kv.key;
    if (typeof key !== 'string') continue;
    out[key] = kv.value?.stringValue;
  }
  return out;
}

type Attr = { key: string; value: { stringValue: string } };

function recordWith(attributes: Attr[]): Record<string, unknown> {
  return { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes }] }] }] };
}

async function startBroker(): Promise<{ url: string; server: Server; received: unknown[] }> {
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ partialSuccess: {}, csuite: { rawBodiesCaptured: 1 } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('relay broker did not bind');
  return { url: `http://127.0.0.1:${address.port}`, server, received };
}

// Distinct on purpose: different lengths and different content, so a
// test that accidentally compares a value to itself cannot pass.
const SPOOL_BYTES = '{"messages":"from-the-spool-file"}';
const PRODUCER_INLINE = '{"messages":"a-different-serialisation-of-the-same-turn"}';

describe('otlp relay — a resolved body_ref must not be shadowed by an inline body', () => {
  const dirs: string[] = [];
  const relays: OtlpRelay[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(relays.splice(0).map((relay) => relay.close()));
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function relayRecord(order: 'inline-first' | 'ref-first') {
    const dir = mkdtempSync(join(tmpdir(), 'csuite-relay-dup-'));
    dirs.push(dir);
    const bodyPath = join(dir, 'request.json');
    writeFileSync(bodyPath, SPOOL_BYTES);

    const broker = await startBroker();
    servers.push(broker.server);
    const relay = await startOtlpRelay({
      brokerUrl: broker.url,
      token: 'tok_test',
      rawBodiesDir: dir,
    });
    relays.push(relay);

    const inline: Attr = { key: 'body', value: { stringValue: PRODUCER_INLINE } };
    const ref: Attr = { key: 'body_ref', value: { stringValue: bodyPath } };

    const response = await fetch(`${relay.endpoint}/v1/logs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok_test', 'Content-Type': 'application/json' },
      body: JSON.stringify(recordWith(order === 'inline-first' ? [inline, ref] : [ref, inline])),
    });

    const forwarded = broker.received[0] as {
      resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ attributes: Attr[] }> }> }>;
    };
    const attributes = forwarded.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes ?? [];
    return { response, attributes, flat: flattenAttributes(attributes), bodyPath };
  }

  // Both orderings, because the defect IS the order dependence: a repair
  // that fixes one ordering and not the other leaves the stored bytes
  // decided by the producer, which is the thing being removed.
  for (const order of ['inline-first', 'ref-first'] as const) {
    it(`emits exactly one body attribute carrying the spool bytes (${order})`, async () => {
      const { attributes, flat } = await relayRecord(order);

      const bodyAttrs = attributes.filter((attr) => attr.key === 'body');
      // Two attributes with the same key is the hazard itself — the
      // broker cannot see that a choice was made, let alone which.
      expect(bodyAttrs).toHaveLength(1);
      expect(attributes.some((attr) => attr.key === 'body_ref')).toBe(false);

      // The value the consumer actually reads, under the broker's own
      // last-wins flattening. This is the assertion that fails today.
      expect(flat.body).toBe(SPOOL_BYTES);
      expect(flat.body).not.toBe(PRODUCER_INLINE);
    });
  }

  it('does not unlink the spool copy while a shadowing body is still on the wire', async () => {
    // The unlink is earned by `refs.length` matching the broker's
    // captured count — a count of substitutions PERFORMED, not of
    // substitutions that survived. A shadowed ref therefore deletes the
    // only copy of bytes the broker never stored.
    const { attributes, flat, bodyPath } = await relayRecord('ref-first');
    const shadowed =
      attributes.filter((attr) => attr.key === 'body').length > 1 || flat.body !== SPOOL_BYTES;
    if (shadowed) {
      expect(existsSync(bodyPath)).toBe(true);
    }
  });
});
