/**
 * Content-addressed blob storage.
 *
 * Files are hashed with SHA-256 and stored under
 * `<baseDir>/<first-2-of-hash>/<rest-of-hash>`. Identical bytes
 * from different uploads land at the same path — the `FilesystemStore`
 * layer tracks a per-hash refcount and only physically deletes when
 * the last referencing entry goes away.
 *
 * Writes stream through a `Transform` that hashes as it goes, so we
 * never buffer the full file in memory. A temp file is written under
 * `<baseDir>/.tmp/` and atomically renamed into place on completion.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BlobStore, PutOptions, PutResult } from 'csuite-core';
import { FsError } from 'csuite-core';

export type { BlobStore, PutOptions, PutResult };

const HASH_RE = /^[a-f0-9]{64}$/;

export class LocalBlobStore implements BlobStore {
  private readonly baseDir: string;
  private readonly tmpDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    this.tmpDir = path.join(this.baseDir, '.tmp');
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  private pathFor(hash: string): string {
    if (!HASH_RE.test(hash)) {
      throw new FsError('invalid_input', `invalid blob hash: ${hash}`);
    }
    return path.join(this.baseDir, hash.slice(0, 2), hash.slice(2));
  }

  async putFromStream(
    stream: ReadableStream<Uint8Array>,
    opts: PutOptions = {},
  ): Promise<PutResult> {
    return this.putFromNodeStream(
      Readable.fromWeb(stream as unknown as import('node:stream/web').ReadableStream<Uint8Array>),
      opts,
    );
  }

  private async putFromNodeStream(stream: Readable, opts: PutOptions = {}): Promise<PutResult> {
    const tmpName = `${Date.now()}-${randomBytes(8).toString('hex')}`;
    const tmpPath = path.join(this.tmpDir, tmpName);
    const hasher = createHash('sha256');
    const maxSize = opts.maxSize ?? Number.POSITIVE_INFINITY;
    let size = 0;

    const measure = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxSize) {
          cb(new FsError('too_large', `file exceeds max size ${maxSize}`));
          return;
        }
        hasher.update(chunk);
        cb(null, chunk);
      },
    });

    try {
      await pipeline(stream, measure, fs.createWriteStream(tmpPath));
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }

    const hash = hasher.digest('hex');
    const finalPath = this.pathFor(hash);
    await mkdir(path.dirname(finalPath), { recursive: true });

    // Dedup: if a prior upload hashed to the same bytes, the final
    // path already exists — drop the temp rather than overwriting.
    try {
      await stat(finalPath);
      await rm(tmpPath, { force: true });
    } catch {
      await rename(tmpPath, finalPath);
    }
    return { hash, size };
  }

  async putFromBuffer(bytes: Uint8Array, opts: PutOptions = {}): Promise<PutResult> {
    const maxSize = opts.maxSize ?? Number.POSITIVE_INFINITY;
    if (bytes.length > maxSize) {
      throw new FsError('too_large', `file exceeds max size ${maxSize}`);
    }
    return this.putFromNodeStream(Readable.from(Buffer.from(bytes)), opts);
  }

  openReadStream(hash: string): ReadableStream<Uint8Array> {
    return Readable.toWeb(
      fs.createReadStream(this.pathFor(hash)),
    ) as unknown as ReadableStream<Uint8Array>;
  }

  async exists(hash: string): Promise<boolean> {
    try {
      await stat(this.pathFor(hash));
      return true;
    } catch {
      return false;
    }
  }

  async delete(hash: string): Promise<void> {
    // Idempotent — missing files are fine.
    await rm(this.pathFor(hash), { force: true }).catch(() => {});
  }
}
