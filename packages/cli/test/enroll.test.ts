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

  it('prints the secret and otpauth URI BEFORE any QR output, and the QR cannot take the secret with it', async () => {
    // commandsuite#212: the broker has already rotated the secret when
    // the QR renders; a renderer failure after the rotation left the
    // member locked out with nothing to paste.
    const { client } = fakeClient();
    const out = captureStdout();
    await runEnrollCommand(
      {
        member: 'alice',
        qr: () => {
          throw new Error('Dynamic require of "module" is not supported');
        },
      },
      client,
      out.write,
    );
    const joined = out.lines.join('\n');
    expect(joined).toContain('  JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    expect(joined).toContain('otpauth://totp/csuite:alice?secret=');
    expect(joined).toContain('QR code unavailable: Dynamic require of "module" is not supported');
    expect(joined.toLowerCase()).toContain('previously bound');
  });

  it('with a working renderer, the secret still precedes the QR block', async () => {
    const { client } = fakeClient();
    const out = captureStdout();
    await runEnrollCommand(
      { member: 'alice', qr: () => ({ ok: true, text: '▄▄▄\n███' }) },
      client,
      out.write,
    );
    const joined = out.lines.join('\n');
    const secretAt = joined.indexOf('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    const qrAt = joined.indexOf('▄▄▄');
    expect(secretAt).toBeGreaterThan(-1);
    expect(qrAt).toBeGreaterThan(secretAt);
    expect(joined).not.toContain('QR code unavailable');
  });

  it('a renderer that returns a failure is reported, not fatal (positive control for the ok path above)', async () => {
    const { client } = fakeClient();
    const out = captureStdout();
    await runEnrollCommand(
      { member: 'alice', qr: () => ({ ok: false, reason: 'no terminal' }) },
      client,
      out.write,
    );
    expect(out.lines.join('\n')).toContain('QR code unavailable: no terminal');
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

// ─────────────────────────────────────────────────────────────────────
// The built CLI as a process against a stub broker: the exit status and
// stdout are what a person at a terminal (or a script reading it) gets.
// Before #212 this exact invocation printed "✓ enrolled" then died with
// exit 1 and no secret.
// ─────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

describe('csuite enroll (built CLI as a process)', () => {
  it('exits 0 with the secret on stdout even when the QR renderer cannot load', async () => {
    // The stub broker runs on this event loop, so the CLI must be spawned
    // asynchronously — spawnSync would block the loop and the request
    // would never be answered.
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/members/alice/enroll-totp') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
            totpUri:
              'otpauth://totp/csuite:alice?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=csuite',
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{"error":"not found"}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const cli = resolve(__dirname, '../dist/index.js');
      const child = spawn(process.execPath, [cli, 'enroll', '--member', 'alice'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CSUITE_URL: `http://127.0.0.1:${port}`,
          CSUITE_TOKEN: 'csuite_test',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      const status = await new Promise<number | null>((r, reject) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          reject(
            new Error(
              `csuite enroll did not exit within 30s\nstdout: ${stdout}\nstderr: ${stderr}`,
            ),
          );
        }, 30_000);
        child.on('exit', (code) => {
          clearTimeout(t);
          r(code);
        });
      });
      expect(status, stderr).toBe(0);
      expect(stdout).toContain('  JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
      expect(stdout).toContain("enrolled 'alice'");
      expect(stdout.indexOf('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP')).toBeLessThan(
        stdout.indexOf('QR code unavailable') === -1
          ? Number.MAX_SAFE_INTEGER
          : stdout.indexOf('QR code unavailable'),
      );
      expect(stderr).not.toContain('Dynamic require');
    } finally {
      server.close();
    }
  });
});
