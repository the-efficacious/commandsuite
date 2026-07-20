import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalBlobStore } from '../../src/files/blob-store.js';
import { FsError } from '../../src/files/errors.js';

describe('LocalBlobStore', () => {
  const dirsToClean: string[] = [];

  afterEach(() => {
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeStore(): LocalBlobStore {
    const dir = mkdtempSync(join(tmpdir(), 'csuite-blob-test-'));
    dirsToClean.push(dir);
    return new LocalBlobStore(dir);
  }

  it('hashes + stores + reads back a buffer', async () => {
    const store = makeStore();
    const payload = Buffer.from('hello blob');
    const { hash, size } = await store.putFromBuffer(payload);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(size).toBe(payload.length);
    expect(await store.exists(hash)).toBe(true);

    const chunks: Buffer[] = [];
    for await (const chunk of store.openReadStream(hash)) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello blob');
  });

  it('dedupes identical uploads to the same hash and keeps the blob', async () => {
    const store = makeStore();
    const a = await store.putFromBuffer(Buffer.from('same bytes'));
    const b = await store.putFromBuffer(Buffer.from('same bytes'));
    expect(a.hash).toBe(b.hash);
    expect(await store.exists(a.hash)).toBe(true);
  });

  it('streams a large buffered payload through without buffering in memory', async () => {
    const store = makeStore();
    const chunk = Buffer.alloc(64 * 1024, 0x41); // "A"*64KB
    const chunks = Array.from({ length: 4 }, () => chunk);
    const src = Readable.from(chunks);
    const { hash, size } = await store.putFromStream(src);
    expect(size).toBe(chunk.length * 4);
    expect(await store.exists(hash)).toBe(true);
  });

  it('rejects uploads over maxSize mid-stream', async () => {
    const store = makeStore();
    await expect(store.putFromBuffer(Buffer.alloc(2048), { maxSize: 1024 })).rejects.toMatchObject({
      code: 'too_large',
    });
  });

  it('delete is idempotent', async () => {
    const store = makeStore();
    const { hash } = await store.putFromBuffer(Buffer.from('gone soon'));
    await store.delete(hash);
    await store.delete(hash); // second call should not throw
    expect(await store.exists(hash)).toBe(false);
  });

  it('rejects bogus hash format on read', () => {
    const store = makeStore();
    expect(() => store.openReadStream('not-a-hash')).toThrow(FsError);
  });
});
