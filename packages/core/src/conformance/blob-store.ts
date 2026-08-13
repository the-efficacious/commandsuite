import { describe, expect, it } from 'vitest';
import type { BlobStore } from '../files/blob-store.js';

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Behavioral contract for a `BlobStore`.
 *
 * `makeStore` must return a store over FRESH, EMPTY storage on every
 * call. The suite asserts content addressing (identical bytes hash
 * identically, via either put path), byte-exact round-trips through
 * web streams, existence checks, idempotent delete, and `maxSize`
 * rejection.
 */
export function blobStoreConformance(makeStore: () => BlobStore | Promise<BlobStore>): void {
  describe('BlobStore conformance', () => {
    const BYTES = new TextEncoder().encode('conformance blob payload');

    it('content-addresses: same bytes → same hash from either put path', async () => {
      const store = await makeStore();
      const a = await store.putFromBuffer(BYTES);
      const b = await store.putFromStream(streamOf(BYTES));
      expect(a.hash).toBe(b.hash);
      expect(a.size).toBe(BYTES.length);
      expect(b.size).toBe(BYTES.length);
      expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('round-trips bytes exactly through openReadStream', async () => {
      const store = await makeStore();
      const { hash } = await store.putFromBuffer(BYTES);
      const back = await readAll(store.openReadStream(hash));
      expect([...back]).toEqual([...BYTES]);
    });

    it('exists reflects put and delete; delete is idempotent', async () => {
      const store = await makeStore();
      const { hash } = await store.putFromBuffer(BYTES);
      expect(await store.exists(hash)).toBe(true);
      await store.delete(hash);
      expect(await store.exists(hash)).toBe(false);
      await store.delete(hash); // second delete must not throw
    });

    it('rejects an over-limit put via maxSize', async () => {
      const store = await makeStore();
      await expect(store.putFromBuffer(BYTES, { maxSize: 4 })).rejects.toThrow();
      await expect(store.putFromStream(streamOf(BYTES), { maxSize: 4 })).rejects.toThrow();
    });
  });
}
