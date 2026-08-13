/**
 * Synchronous counterpart of csuite-core's async `digestPath`, for the
 * server's sync capture paths (the correlator hashes inside a sync
 * try/catch). Must stay byte-identical in output to `digestPath` —
 * both are sha256-hex truncated to 16 chars plus a UTF-8 byte length.
 */

import { createHash } from 'node:crypto';
import type { SafeFields } from 'csuite-core';

export function digestPathSync(path: string): SafeFields {
  return {
    pathDigest: createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 16),
    pathLength: Buffer.byteLength(path, 'utf8'),
  } as SafeFields;
}
