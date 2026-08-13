/**
 * Content-addressed blob storage seam for the team filesystem.
 *
 * The filesystem store owns metadata (paths, ACLs, refcounts) in SQL;
 * bytes live behind this interface, addressed by sha256. Streams are
 * web `ReadableStream<Uint8Array>` — the interchange type every
 * target runtime shares; a Node host adapts to its native streams at
 * its own edge (see csuite-server's `LocalBlobStore`).
 */

export interface PutResult {
  hash: string;
  size: number;
}

export interface PutOptions {
  /** Reject uploads larger than this many bytes. Default unlimited. */
  maxSize?: number;
}

export interface BlobStore {
  putFromStream(stream: ReadableStream<Uint8Array>, opts?: PutOptions): Promise<PutResult>;
  putFromBuffer(bytes: Uint8Array, opts?: PutOptions): Promise<PutResult>;
  openReadStream(hash: string): ReadableStream<Uint8Array>;
  exists(hash: string): Promise<boolean>;
  delete(hash: string): Promise<void>;
}
