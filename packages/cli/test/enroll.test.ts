/**
 * Tests for `csuite enroll`.
 *
 * The new CLI calls `POST /members/:name/enroll-totp` via the SDK
 * Client. The server generates and persists a fresh TOTP secret in
 * one round-trip; the CLI's job is to render the QR + secret and
 * surface auth/usage errors clearly. These tests stub the Client and
 * confirm the dispatch + output contract.
 */

import type { Client } from 'csuite-sdk/client';
import { describe, expect, it, vi } from 'vitest';
import { runEnrollCommand } from '../src/commands/enroll.js';
import { UsageError } from '../src/commands/errors.js';

function fakeClient(
  enrollImpl: () => Promise<{ totpSecret: string; totpUri: string }> = async () => ({
    totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    totpUri: 'otpauth://totp/csuite:alice?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=csuite',
  }),
): { client: Client; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(enrollImpl);
  const client = { enrollTotp: spy } as unknown as Client;
  return { client, spy };
}

function captureStdout(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (l) => lines.push(l) };
}

describe('runEnrollCommand', () => {
  it('errors when --member is missing', async () => {
    const { client } = fakeClient();
    await expect(runEnrollCommand({}, client, () => {})).rejects.toBeInstanceOf(UsageError);
  });

  it('calls Client.enrollTotp with the supplied member name', async () => {
    const { client, spy } = fakeClient();
    const out = captureStdout();
    await runEnrollCommand({ member: 'alice' }, client, out.write);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith('alice');
  });

  it('prints the success banner with the secret + invalidation note', async () => {
    const { client } = fakeClient();
    const out = captureStdout();
    await runEnrollCommand({ member: 'alice' }, client, out.write);
    const joined = out.lines.join('\n');
    expect(joined).toContain("enrolled 'alice'");
    expect(joined).toContain('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    expect(joined.toLowerCase()).toContain('previously bound');
  });

  it('propagates ClientError from the broker as a useful failure', async () => {
    const { client } = fakeClient(async () => {
      throw new Error('broker error 403: enroll-totp requires members.manage, or self');
    });
    await expect(runEnrollCommand({ member: 'alice' }, client, () => {})).rejects.toThrow(
      /members\.manage/,
    );
  });
});
