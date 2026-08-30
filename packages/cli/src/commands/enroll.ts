/**
 * `csuite enroll` — rotate or add a TOTP secret for a member.
 *
 * Calls `POST /members/:name/enroll-totp` on the running broker.
 * Authenticated as the caller; requires `members.manage` (admin
 * enrolling someone else) or self (re-enrolling your own auth).
 *
 * The server generates and persists a fresh secret immediately on the
 * call — the response carries the new `totpSecret` + `totpUri` for
 * the QR render. Any authenticator currently bound to a previous
 * secret stops working as of that moment, so the member's next sign-in
 * must use the new code.
 */

import { createRequire } from 'node:module';
import type { Client } from 'csuite-sdk/client';
import { UsageError } from './errors.js';

export { UsageError };

export interface EnrollCommandInput {
  /** Name of the member to (re-)enroll. Required. */
  member?: string;
  /** Test-only: replace the QR renderer, e.g. with one that throws. */
  qr?: (uri: string) => QrResult;
}

export type QrResult = { ok: true; text: string } | { ok: false; reason: string };

export async function runEnrollCommand(
  input: EnrollCommandInput,
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  if (!input.member) {
    throw new UsageError('enroll: --member <name> is required');
  }

  const result = await client.enrollTotp(input.member);

  // The broker has ALREADY rotated the secret by the time we get here.
  // The secret is therefore the deliverable and goes out first; the QR
  // is a convenience that may fail (a missing optional dependency, an
  // ESM bundle without a require shim) and must never take the secret
  // with it — that leaves the member locked out with nothing to paste
  // (commandsuite#212).
  stdout('');
  stdout(`✓ enrolled '${input.member}' for web UI login`);
  stdout('');
  stdout('Secret (base32) — paste into your authenticator, or keep it where a');
  stdout('headless sign-in can read it:');
  stdout(`  ${result.totpSecret}`);
  stdout('');
  stdout(`otpauth URI: ${result.totpUri}`);
  stdout('');

  let qr: QrResult;
  try {
    qr = (input.qr ?? renderQr)(result.totpUri);
  } catch (err) {
    qr = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (qr.ok) {
    stdout('Or scan this QR with your authenticator app (Google Authenticator, Authy,');
    stdout('1Password, etc.):');
    stdout('');
    for (const line of qr.text.split('\n')) stdout(line);
    stdout('');
  } else {
    stdout(`(QR code unavailable: ${qr.reason} — use the secret above.)`);
    stdout('');
  }
  stdout('  Any authenticator previously bound to this member is now invalid.');
  stdout('  The next web UI sign-in must use a 6-digit code from the new secret.');
  stdout('');
}

/**
 * Render an `otpauth://` URI as a terminal QR code using
 * `qrcode-terminal`'s small (half-block) mode. Resolved lazily from
 * `csuite-server`'s node_modules so the CLI doesn't ship a direct dep
 * on a package most paths never load. Never throws: the caller has
 * already printed the secret, and a QR failure is reported, not fatal.
 */
export function renderQr(uri: string): QrResult {
  try {
    const req = nodeRequire('qrcode-terminal');
    const qrcode = req as {
      generate: (text: string, opts: { small: boolean }, cb: (out: string) => void) => void;
      setErrorLevel: (level: 'L' | 'M' | 'Q' | 'H') => void;
    };
    qrcode.setErrorLevel('L');
    let out = '';
    qrcode.generate(uri, { small: true }, (q) => {
      out = q;
    });
    if (out.length === 0) return { ok: false, reason: 'renderer produced no output' };
    return { ok: true, text: out };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function nodeRequire(moduleId: string): unknown {
  // `createRequire` from a static import — a bare `require()` does not
  // exist in this ESM bundle (that was the crash in #212).
  const base = createRequire(import.meta.url);
  // Try the server's node_modules first (where qrcode-terminal lives as
  // a transitive dep); fall back to direct resolution if the user has
  // it installed elsewhere in the CLI's resolution scope.
  try {
    const serverPkgPath = base.resolve('csuite-server/package.json');
    const fromServer = createRequire(serverPkgPath);
    return fromServer(moduleId);
  } catch {
    return base(moduleId);
  }
}
