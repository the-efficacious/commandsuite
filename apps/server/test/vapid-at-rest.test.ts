/**
 * VAPID private key at-rest encryption.
 *
 * The KEK module was built to wrap TOTP secrets AND the VAPID private
 * key at rest, but the VAPID half was never wired: `runServer`
 * persisted generated keys verbatim, so the private key sat plaintext
 * in `csuite.json` (protected only by the file's `0o600` mode). These
 * tests pin the fix — under an active KEK the private key is stored
 * `enc-v1:...`, legacy plaintext keys migrate on boot, and an already-
 * encrypted key is reused as-is (no needless rewrite that would churn
 * the file on every restart).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptField, ENCRYPTED_FIELD_PREFIX, testKek } from '../src/kek.js';
import { defaultHttpsConfig, setKek, type WebPushConfig } from '../src/members.js';
import { generateVapidKeys } from '../src/push/vapid.js';
import { type RunningServer, runServer } from '../src/run.js';
import { seedStores } from './helpers/test-stores.js';

const TEAM = { name: 'vapid-team', context: '' };
const ADMIN_TOKEN = 'csuite_vapid_test_admin_token';

const dirsToClean: string[] = [];
const serversToStop: RunningServer[] = [];
let kek: Buffer;

beforeEach(() => {
  kek = testKek();
  setKek(kek);
});

afterEach(async () => {
  for (const s of serversToStop.splice(0)) await s.stop();
  for (const dir of dirsToClean.splice(0)) rmSync(dir, { recursive: true, force: true });
  setKek(null);
});

function tmpConfig(initial: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'csuite-vapid-'));
  dirsToClean.push(dir);
  const path = join(dir, 'csuite.json');
  writeFileSync(path, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function seededDb() {
  return seedStores({
    team: TEAM,
    members: [
      {
        name: 'alice',
        role: { title: 'admin', description: '' },
        rawPermissions: ['members.manage'],
        permissions: ['members.manage'],
        token: ADMIN_TOKEN,
      },
    ],
  }).db;
}

function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function boot(configPath: string, webPush: WebPushConfig | null): Promise<RunningServer> {
  const running = await runServer({
    db: seededDb(),
    https: { ...defaultHttpsConfig(), mode: 'off' },
    webPush,
    configPath,
    port: 0,
    host: '127.0.0.1',
    publicRoot: null,
    logger: silentLogger(),
  });
  serversToStop.push(running);
  return running;
}

function readWebPush(configPath: string): WebPushConfig {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { webPush: WebPushConfig };
  return parsed.webPush;
}

describe('VAPID private key at rest', () => {
  it('encrypts a freshly-generated private key before persisting it', async () => {
    const configPath = tmpConfig({});
    await boot(configPath, null);

    const wp = readWebPush(configPath);
    expect(wp.vapidPrivateKey.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(true);
    // The public key is not a secret — it's served to browsers verbatim.
    expect(wp.vapidPublicKey.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(false);
    // And the ciphertext decrypts back to a real plaintext key.
    const plaintext = decryptField(wp.vapidPrivateKey, kek);
    expect(plaintext).toBeTruthy();
    expect(plaintext?.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(false);
  });

  it('migrates a legacy plaintext private key to encrypted on boot', async () => {
    const legacy = generateVapidKeys();
    const configPath = tmpConfig({ webPush: legacy });

    await boot(configPath, legacy);

    const wp = readWebPush(configPath);
    expect(wp.vapidPrivateKey.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(true);
    // Decrypts back to exactly the original plaintext key — no data loss.
    expect(decryptField(wp.vapidPrivateKey, kek)).toBe(legacy.vapidPrivateKey);
    expect(wp.vapidPublicKey).toBe(legacy.vapidPublicKey);
  });

  it('reuses an already-encrypted key without rewriting it', async () => {
    const configPath = tmpConfig({});
    await boot(configPath, null);
    const afterFirst = readWebPush(configPath);

    // Second boot loads the encrypted block; it must not re-wrap it
    // (a fresh IV every restart would be pointless churn).
    await boot(configPath, afterFirst);
    const afterSecond = readWebPush(configPath);

    expect(afterSecond.vapidPrivateKey).toBe(afterFirst.vapidPrivateKey);
    expect(decryptField(afterSecond.vapidPrivateKey, kek)).toBe(
      decryptField(afterFirst.vapidPrivateKey, kek),
    );
  });
});
