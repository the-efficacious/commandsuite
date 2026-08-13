/**
 * Field-level AES-256-GCM over Web Crypto — the portable counterpart
 * of the server's `kek.ts` primitives, byte-compatible in both
 * directions with the `enc-v1:<iv>:<tag>:<ct>` wire format (all parts
 * base64url). A value encrypted by either implementation decrypts in
 * the other.
 *
 * KEK *resolution* (env var, key file) stays with the host binding —
 * these functions take the 32 raw key bytes.
 *
 * Web Crypto's AES-GCM emits ciphertext with the auth tag appended;
 * the wire format stores the tag separately, so encrypt splits the
 * last 16 bytes out and decrypt joins them back.
 */

import { fromBase64Url, toBase64Url } from './random-id.js';

export const ENCRYPTED_FIELD_PREFIX = 'enc-v1:';

const KEK_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export class EncryptedFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedFieldError';
  }
}

async function importKek(kek: Uint8Array): Promise<CryptoKey> {
  if (kek.length !== KEK_BYTES) {
    throw new EncryptedFieldError(`KEK must be exactly ${KEK_BYTES} bytes; got ${kek.length}`);
  }
  return crypto.subtle.importKey('raw', kek as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt a plaintext string and return the opaque `enc-v1:...`
 * wrapper. Null/undefined pass through as-is; an already-encrypted
 * value is returned unchanged (idempotent).
 */
export async function encryptFieldPortable(
  plaintext: string | null | undefined,
  kek: Uint8Array,
): Promise<string | null> {
  if (plaintext === null || plaintext === undefined) return null;
  if (plaintext.startsWith(ENCRYPTED_FIELD_PREFIX)) return plaintext;
  const key = await importKek(kek);
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  const ciphertext = sealed.subarray(0, sealed.length - AUTH_TAG_BYTES);
  const authTag = sealed.subarray(sealed.length - AUTH_TAG_BYTES);
  return [
    ENCRYPTED_FIELD_PREFIX.slice(0, -1), // "enc-v1"
    toBase64Url(iv),
    toBase64Url(authTag),
    toBase64Url(ciphertext),
  ].join(':');
}

/**
 * Decrypt an `enc-v1:...` wrapper back to plaintext. Null/undefined
 * return null; a value without the prefix is returned unchanged
 * (plaintext passthrough for the migration path). Throws
 * `EncryptedFieldError` only when the input looks encrypted but fails
 * to parse or authenticate.
 */
export async function decryptFieldPortable(
  value: string | null | undefined,
  kek: Uint8Array,
): Promise<string | null> {
  if (value === null || value === undefined) return null;
  if (!value.startsWith(ENCRYPTED_FIELD_PREFIX)) return value;
  const parts = value.split(':');
  if (parts.length !== 4) {
    throw new EncryptedFieldError(
      `encrypted field is malformed: expected 4 colon-separated parts, got ${parts.length}`,
    );
  }
  const [, ivB64, tagB64, ctB64] = parts;
  let iv: Uint8Array;
  let authTag: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    iv = fromBase64Url(ivB64 ?? '');
    authTag = fromBase64Url(tagB64 ?? '');
    ciphertext = fromBase64Url(ctB64 ?? '');
  } catch (err) {
    throw new EncryptedFieldError(
      `encrypted field base64url decode failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (iv.length !== IV_BYTES) {
    throw new EncryptedFieldError(`encrypted field IV must be ${IV_BYTES} bytes; got ${iv.length}`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new EncryptedFieldError(
      `encrypted field auth tag must be ${AUTH_TAG_BYTES} bytes; got ${authTag.length}`,
    );
  }
  const key = await importKek(kek);
  const sealed = new Uint8Array(ciphertext.length + authTag.length);
  sealed.set(ciphertext, 0);
  sealed.set(authTag, ciphertext.length);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv } as AesGcmParams, key, sealed);
    return new TextDecoder().decode(plain);
  } catch (err) {
    throw new EncryptedFieldError(
      `encrypted field failed authentication (wrong KEK or tampered data): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Synchronous field cipher a store receives from its host. The stores
 * read/write the `enc-v1:` wrapper through this seam so the choice of
 * key management — and of sync primitive — stays with the binding.
 * A host returns null from its getter when no key is active; stores
 * surface that per their own error vocabulary (or pass values through
 * unchanged where plaintext-at-rest is the documented degraded mode).
 */
export interface FieldCipher {
  encrypt(plaintext: string | null | undefined): string | null;
  decrypt(value: string | null | undefined): string | null;
}

/** A cipher getter — read per operation so late key installation is seen. */
export type GetFieldCipher = () => FieldCipher | null;
