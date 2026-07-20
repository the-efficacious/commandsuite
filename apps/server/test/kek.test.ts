import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptField,
  ENCRYPTED_FIELD_PREFIX,
  EncryptedFieldError,
  encryptField,
  KekResolutionError,
  resolveKek,
  testKek,
} from '../src/kek.js';

const dirsToClean: string[] = [];

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'csuite-kek-test-'));
  dirsToClean.push(dir);
  return dir;
}

describe('encryptField / decryptField', () => {
  it('round-trips a plaintext string through enc-v1', () => {
    const kek = testKek();
    const ct = encryptField('JBSWY3DPEHPK3PXP', kek);
    expect(ct).not.toBeNull();
    expect(ct?.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(true);
    const pt = decryptField(ct, kek);
    expect(pt).toBe('JBSWY3DPEHPK3PXP');
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const kek = testKek();
    const ct1 = encryptField('same', kek);
    const ct2 = encryptField('same', kek);
    expect(ct1).not.toBe(ct2);
    expect(decryptField(ct1, kek)).toBe('same');
    expect(decryptField(ct2, kek)).toBe('same');
  });

  it('encryptField passes null/undefined through', () => {
    const kek = testKek();
    expect(encryptField(null, kek)).toBeNull();
    expect(encryptField(undefined, kek)).toBeNull();
  });

  it('encryptField is idempotent on an already-encrypted value', () => {
    const kek = testKek();
    const ct = encryptField('foo', kek);
    expect(ct).not.toBeNull();
    // Re-wrapping must NOT produce ciphertext of ciphertext.
    const ct2 = encryptField(ct, kek);
    expect(ct2).toBe(ct);
  });

  it('decryptField passes plaintext through unchanged (migration path)', () => {
    const kek = testKek();
    expect(decryptField('plaintext-value', kek)).toBe('plaintext-value');
  });

  it('decryptField throws with the wrong KEK', () => {
    const kek1 = testKek();
    const kek2 = testKek();
    const ct = encryptField('secret', kek1);
    expect(() => decryptField(ct, kek2)).toThrow(EncryptedFieldError);
  });

  it('decryptField throws on tampered ciphertext', () => {
    const kek = testKek();
    const ct = encryptField('secret', kek);
    if (!ct) throw new Error('unreachable');
    // Flip a byte in the ciphertext segment (last of 4).
    const parts = ct.split(':');
    const tampered = Buffer.from(parts[3] ?? '', 'base64url');
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    parts[3] = tampered.toString('base64url');
    const bad = parts.join(':');
    expect(() => decryptField(bad, kek)).toThrow(EncryptedFieldError);
  });

  it('decryptField throws on structurally malformed enc-v1 values', () => {
    const kek = testKek();
    expect(() => decryptField('enc-v1:only-two-parts', kek)).toThrow(EncryptedFieldError);
  });
});

describe('resolveKek', () => {
  it('reads a base64-encoded KEK from CSUITE_KEK when set', () => {
    const explicit = Buffer.alloc(32, 0xab);
    const configPath = join(tmpDir(), 'csuite.json');
    const resolved = resolveKek(configPath, { CSUITE_KEK: explicit.toString('base64') });
    expect(resolved.equals(explicit)).toBe(true);
  });

  it('rejects CSUITE_KEK with wrong byte length', () => {
    const short = Buffer.alloc(16).toString('base64');
    const configPath = join(tmpDir(), 'csuite.json');
    expect(() => resolveKek(configPath, { CSUITE_KEK: short })).toThrow(KekResolutionError);
  });

  it('auto-generates a key file alongside the config when no env var is set', () => {
    const dir = tmpDir();
    const configPath = join(dir, 'csuite.json');
    const kek1 = resolveKek(configPath, {});
    expect(kek1.length).toBe(32);
    expect(existsSync(join(dir, 'csuite-kek.bin'))).toBe(true);
    // A second call returns the same key (reads the same file).
    const kek2 = resolveKek(configPath, {});
    expect(kek2.equals(kek1)).toBe(true);
  });

  it('rejects a key file with incorrect byte length', () => {
    const dir = tmpDir();
    const configPath = join(dir, 'csuite.json');
    writeFileSync(join(dir, 'csuite-kek.bin'), Buffer.alloc(17));
    expect(() => resolveKek(configPath, {})).toThrow(KekResolutionError);
  });

  it('env var takes precedence over an existing key file', () => {
    const dir = tmpDir();
    const configPath = join(dir, 'csuite.json');
    writeFileSync(join(dir, 'csuite-kek.bin'), Buffer.alloc(32, 0x11));
    const envKek = Buffer.alloc(32, 0x22);
    const resolved = resolveKek(configPath, { CSUITE_KEK: envKek.toString('base64') });
    expect(resolved.equals(envKek)).toBe(true);
    // Key file on disk is untouched.
    expect(readFileSync(join(dir, 'csuite-kek.bin'))[0]).toBe(0x11);
  });
});

/**
 * Regression: every server entry point that loads or writes the
 * team config MUST install the KEK first, or
 * `loadTeamConfigFromFile` will return `enc-v1:...` ciphertext
 * in the in-memory `LoadedMember.totpSecret` field and TOTP login
 * silently rejects every code (since `Secret.fromBase32` can't parse
 * the ciphertext).
 *
 * The original at-rest-encryption hardening commit added KEK install
 * to the CLI subcommands (serve, setup, rotate, enroll) but missed
 * the standalone `csuite-server` bin entry at apps/server/src/index.ts.
 * This test pins the contract so a future entry point can't regress.
 */
describe('KEK install contract — server entry points', () => {
  it('apps/server/src/index.ts installs the KEK before loading the config', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'),
    );
    expect(source).toMatch(/setKek\s*\(\s*resolveKek\s*\(/);
    // And it has to happen before the *invocation* of config loading,
    // not after. The function definition appears earlier in the file,
    // so we match the awaited call site (inside main()) specifically.
    const setKekIdx = source.search(/setKek\s*\(\s*resolveKek/);
    const loadIdx = source.search(/await\s+loadOrCreateServerConfig\s*\(/);
    expect(setKekIdx).toBeGreaterThan(0);
    expect(loadIdx).toBeGreaterThan(setKekIdx);
  });
});
