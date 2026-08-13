import { describe, expect, it } from 'vitest';
import {
  decryptFieldPortable,
  EncryptedFieldError,
  encryptFieldPortable,
} from '../src/field-crypto.js';
import { fromBase64Url, toBase64Url } from '../src/random-id.js';

const KEK = new Uint8Array(32).fill(7);

// Produced by the server's node:crypto implementation (kek.ts) with the
// same fixed key (32×0x07) and a fixed 12×0x03 IV. Cross-implementation
// compatibility is the entire point of this fixture: if this decrypt
// breaks, the wire format diverged.
const NODE_VECTOR = 'enc-v1:AwMDAwMDAwMDAwMD:mBkm_DfMXPOlvl6GN1uthg:TYvNdz9abG8OLzcsxiSab59ZlA';

describe('field-crypto', () => {
  it('round-trips', async () => {
    const wrapped = await encryptFieldPortable('hunter2-totp-secret', KEK);
    expect(wrapped).toMatch(/^enc-v1:/);
    expect(await decryptFieldPortable(wrapped, KEK)).toBe('hunter2-totp-secret');
  });

  it('decrypts a value produced by the node:crypto implementation', async () => {
    expect(await decryptFieldPortable(NODE_VECTOR, KEK)).toBe('hunter2-totp-secret');
  });

  it('passes null/undefined and plaintext through, is idempotent on encrypted input', async () => {
    expect(await encryptFieldPortable(null, KEK)).toBeNull();
    expect(await decryptFieldPortable(undefined, KEK)).toBeNull();
    expect(await decryptFieldPortable('plain-value', KEK)).toBe('plain-value');
    expect(await encryptFieldPortable(NODE_VECTOR, KEK)).toBe(NODE_VECTOR);
  });

  it('throws EncryptedFieldError on the wrong KEK and on malformed input', async () => {
    const other = new Uint8Array(32).fill(9);
    await expect(decryptFieldPortable(NODE_VECTOR, other)).rejects.toBeInstanceOf(
      EncryptedFieldError,
    );
    await expect(decryptFieldPortable('enc-v1:only:three', KEK)).rejects.toBeInstanceOf(
      EncryptedFieldError,
    );
  });

  it('base64url decode inverts encode, padding tolerated', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(fromBase64Url('AwMDAwMDAwMDAwMD')).toHaveLength(12);
  });
});
