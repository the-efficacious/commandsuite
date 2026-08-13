import { describe, expect, it } from 'vitest';
import type { FieldCipher } from '../field-crypto.js';
import { ENCRYPTED_FIELD_PREFIX } from '../field-crypto.js';

/**
 * Behavioral contract for a `FieldCipher`.
 *
 * `makeCipher` must return a cipher with a stable key across the
 * suite. Asserts the `enc-v1:` wrapper shape, round-trips, encrypt
 * idempotence on already-wrapped values, null passthrough, and
 * plaintext passthrough on decrypt (the migration path).
 */
export function fieldCipherConformance(makeCipher: () => FieldCipher): void {
  describe('FieldCipher conformance', () => {
    it('wraps in enc-v1 and round-trips', () => {
      const cipher = makeCipher();
      const wrapped = cipher.encrypt('totp-secret-base32');
      expect(wrapped).toMatch(/^enc-v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
      expect(cipher.decrypt(wrapped)).toBe('totp-secret-base32');
    });

    it('encrypt is idempotent on an already-encrypted value', () => {
      const cipher = makeCipher();
      const wrapped = cipher.encrypt('value');
      expect(wrapped).not.toBeNull();
      expect(cipher.encrypt(wrapped)).toBe(wrapped);
    });

    it('null and undefined pass through as null', () => {
      const cipher = makeCipher();
      expect(cipher.encrypt(null)).toBeNull();
      expect(cipher.encrypt(undefined)).toBeNull();
      expect(cipher.decrypt(null)).toBeNull();
      expect(cipher.decrypt(undefined)).toBeNull();
    });

    it('decrypt passes non-wrapped plaintext through unchanged', () => {
      const cipher = makeCipher();
      expect(cipher.decrypt('legacy-plaintext')).toBe('legacy-plaintext');
    });

    it('emits fresh IVs — two encryptions of one value differ', () => {
      const cipher = makeCipher();
      const a = cipher.encrypt('same-value');
      const b = cipher.encrypt('same-value');
      expect(a).not.toBe(b);
      expect(a?.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(true);
    });
  });
}
