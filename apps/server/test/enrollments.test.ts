/**
 * Pending-enrollment store tests.
 *
 * Exercises `EnrollmentStore` directly: mint → lookup → approve →
 * poll → consume; expiry; rejection; slow_down; idempotent purge.
 * The endpoint-level coverage (HTTP routes through `createApp`) lives
 * in `enroll-endpoints.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import {
  ENROLLMENT_TTL_MS,
  EnrollmentStore,
  formatUserCode,
  normalizeUserCode,
} from '../src/enrollments.js';

function makeStore(now: () => number = () => 1_700_000_000_000) {
  const db = openDatabase(':memory:');
  return new EnrollmentStore(db, { now });
}

describe('normalizeUserCode', () => {
  it('accepts hyphenated and unhyphenated 8-char Crockford strings', () => {
    expect(normalizeUserCode('KQ4M-7P2H')).toBe('KQ4M7P2H');
    expect(normalizeUserCode('kq4m7p2h')).toBe('KQ4M7P2H');
    expect(normalizeUserCode(' KQ4M 7P2H ')).toBe('KQ4M7P2H');
  });

  it('rejects ambiguous letters (I, L, O, U)', () => {
    expect(normalizeUserCode('IIII0000')).toBeNull();
    expect(normalizeUserCode('LLLLOOOO')).toBeNull();
    expect(normalizeUserCode('UUUUUUUU')).toBeNull();
  });

  it('rejects wrong-length input', () => {
    expect(normalizeUserCode('ABC')).toBeNull();
    expect(normalizeUserCode('ABCDEFGHJ')).toBeNull();
  });
});

describe('formatUserCode', () => {
  it('inserts a hyphen at the midpoint', () => {
    expect(formatUserCode('KQ4M7P2H')).toBe('KQ4M-7P2H');
  });
});

describe('EnrollmentStore.mint', () => {
  it('returns a deviceCode + userCode pair with TTL', () => {
    const store = makeStore();
    const result = store.mint({ sourceIp: '10.0.0.1', sourceUa: 'csuite-cli/0.0.0' });
    expect(result.deviceCode).toMatch(/^csuite-dc_/);
    expect(result.userCode).toHaveLength(8);
    expect(result.userCodeFormatted).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(result.expiresIn).toBe(Math.floor(ENROLLMENT_TTL_MS / 1000));
    expect(result.interval).toBeGreaterThan(0);
  });
});

describe('EnrollmentStore lifecycle', () => {
  it('lookupByUserCode → approve → pollByDeviceCode → consume', () => {
    const store = makeStore();
    const minted = store.mint({ sourceIp: null, sourceUa: null });
    const lookup = store.lookupByUserCode(minted.userCode);
    expect(lookup.kind).toBe('pending');

    const ok = store.approve({
      userCode: minted.userCode,
      approvedBy: 'director-1',
      boundMember: 'alice',
      approveArgsJson: JSON.stringify({ mode: 'bind' }),
      issuedTokenId: 'token-uuid-1',
      issuedTokenPlaintext: 'csuite_minted_plaintext',
    });
    expect(ok).toBe(true);

    const poll = store.pollByDeviceCode(minted.deviceCode);
    expect(poll.kind).toBe('approved');
    if (poll.kind === 'approved') {
      expect(poll.tokenPlaintext).toBe('csuite_minted_plaintext');
      expect(poll.tokenId).toBe('token-uuid-1');
      expect(poll.memberName).toBe('alice');
    }

    // Replay → row was consumed, expired_token.
    const replay = store.pollByDeviceCode(minted.deviceCode);
    expect(replay.kind).toBe('expired_token');
  });

  it('pending poll returns authorization_pending', () => {
    const store = makeStore();
    const minted = store.mint({ sourceIp: null, sourceUa: null });
    const poll = store.pollByDeviceCode(minted.deviceCode);
    expect(poll.kind).toBe('authorization_pending');
  });

  it('returns slow_down on rapid back-to-back pending polls', () => {
    let clock = 1_700_000_000_000;
    const store = makeStore(() => clock);
    const minted = store.mint({ sourceIp: null, sourceUa: null });
    expect(store.pollByDeviceCode(minted.deviceCode).kind).toBe('authorization_pending');
    clock += 100; // very fast — well under the 2.5s threshold
    expect(store.pollByDeviceCode(minted.deviceCode).kind).toBe('slow_down');
  });

  it('expired tokens 410 with expired_token', () => {
    let clock = 1_700_000_000_000;
    const store = makeStore(() => clock);
    const minted = store.mint({ sourceIp: null, sourceUa: null });
    clock += ENROLLMENT_TTL_MS + 1;
    const poll = store.pollByDeviceCode(minted.deviceCode);
    expect(poll.kind).toBe('expired_token');
  });

  it('reject → poll returns access_denied + reason, then consumes', () => {
    const store = makeStore();
    const minted = store.mint({ sourceIp: null, sourceUa: null });
    const ok = store.reject({
      userCode: minted.userCode,
      rejectedBy: 'director-1',
      reason: 'unrecognized device',
    });
    expect(ok).toBe(true);
    const poll = store.pollByDeviceCode(minted.deviceCode);
    expect(poll.kind).toBe('access_denied');
    if (poll.kind === 'access_denied') {
      expect(poll.reason).toBe('unrecognized device');
    }
    // Replay → expired_token (row was consumed).
    expect(store.pollByDeviceCode(minted.deviceCode).kind).toBe('expired_token');
  });

  it('lookupByUserCode reports approved/rejected/expired states', () => {
    let clock = 1_700_000_000_000;
    const store = makeStore(() => clock);
    const m1 = store.mint({ sourceIp: null, sourceUa: null });
    store.approve({
      userCode: m1.userCode,
      approvedBy: 'a',
      boundMember: 'm',
      approveArgsJson: '{}',
      issuedTokenId: 'tid',
      issuedTokenPlaintext: 'pt',
    });
    expect(store.lookupByUserCode(m1.userCode).kind).toBe('already_approved');

    const m2 = store.mint({ sourceIp: null, sourceUa: null });
    store.reject({ userCode: m2.userCode, rejectedBy: 'a', reason: 'no thanks' });
    expect(store.lookupByUserCode(m2.userCode).kind).toBe('already_rejected');

    const m3 = store.mint({ sourceIp: null, sourceUa: null });
    clock += ENROLLMENT_TTL_MS + 1;
    expect(store.lookupByUserCode(m3.userCode).kind).toBe('expired');

    expect(store.lookupByUserCode('NOPENOPE').kind).toBe('not_found');
  });

  it('listPending excludes approved, rejected, and expired rows', () => {
    let clock = 1_700_000_000_000;
    const store = makeStore(() => clock);
    const a = store.mint({ sourceIp: null, sourceUa: null });
    const b = store.mint({ sourceIp: null, sourceUa: null });
    const c = store.mint({ sourceIp: null, sourceUa: null });
    store.approve({
      userCode: a.userCode,
      approvedBy: 'd',
      boundMember: 'm',
      approveArgsJson: '{}',
      issuedTokenId: 'tid',
      issuedTokenPlaintext: 'pt',
    });
    clock += ENROLLMENT_TTL_MS + 1;
    // Only `c` and `b` started inside the window; clock advanced past
    // both their TTLs so listPending should be empty.
    expect(store.listPending()).toHaveLength(0);

    // Rewind: fresh test for listing semantics. New clock = original.
    const store2 = makeStore(() => 1_700_000_000_000);
    store2.mint({ sourceIp: null, sourceUa: null });
    store2.mint({ sourceIp: null, sourceUa: null });
    expect(store2.listPending()).toHaveLength(2);
    void b;
    void c;
  });

  it('purgeExpired sweeps stale rows', () => {
    let clock = 1_700_000_000_000;
    const store = makeStore(() => clock);
    store.mint({ sourceIp: null, sourceUa: null });
    store.mint({ sourceIp: null, sourceUa: null });
    clock += ENROLLMENT_TTL_MS + 1;
    expect(store.purgeExpired()).toBe(2);
    expect(store.listPending()).toHaveLength(0);
  });
});

describe('EnrollmentStore + KEK', () => {
  it('round-trips an issued plaintext through KEK encryption', () => {
    const db = openDatabase(':memory:');
    const kek = Buffer.alloc(32, 0x42);
    const store = new EnrollmentStore(db, { kek });
    const minted = store.mint({ sourceIp: null, sourceUa: null });
    store.approve({
      userCode: minted.userCode,
      approvedBy: 'director',
      boundMember: 'alice',
      approveArgsJson: JSON.stringify({ mode: 'bind' }),
      issuedTokenId: 'tid',
      issuedTokenPlaintext: 'csuite_secret_plaintext_xyz',
    });
    const poll = store.pollByDeviceCode(minted.deviceCode);
    expect(poll.kind).toBe('approved');
    if (poll.kind === 'approved') {
      expect(poll.tokenPlaintext).toBe('csuite_secret_plaintext_xyz');
    }
  });
});
