/**
 * `csuite-connect-platform` — server side of the platform registration
 * device flow. Connects this self-hosted csuite to a hosted control
 * plane (the platform); csuite stays standalone-capable without it.
 *
 * Usage:
 *
 *   csuite-connect-platform \
 *     --url https://csuite.acme.com \
 *     --member-name alice \
 *     --platform https://app.example.com \
 *     [--config-path ./csuite.json]
 *
 * What it does:
 *
 *   1. POSTs { hostedAt } to the platform's
 *      /api/servers/register/start. Gets back a deviceCode +
 *      userCode + verificationUrl.
 *   2. Prints the verification URL + userCode; waits for the admin
 *      to open it and confirm.
 *   3. Polls /api/servers/register/status with the deviceCode every
 *      few seconds until authorized or expired.
 *   4. On authorized, receives the jwt block (issuer + jwksUrl +
 *      audience) and writes it to the overlay file sibling to the
 *      primary config (`<config>.platform.json`). The overlay is
 *      precedence-merged into the loaded config at server startup —
 *      see `members.ts:platformOverlayPathFor`.
 *
 * `--member-name` is recorded on the platform side for the admin's
 * owner binding. It must match a Member entry in the server's own
 * `config.json`; the server will reject JWTs naming an unknown
 * member regardless of what the platform mints.
 *
 * The overlay file is written atomically (write to a tempfile,
 * fsync, rename) with 0600 permissions — it carries the same
 * sensitivity as the JWKS URL in the primary config.
 */

import { chmodSync, closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { defaultConfigPath, platformOverlayPathFor } from './members.js';

interface CliArgs {
  hostedAt: string;
  memberName: string;
  platformOrigin: string;
  configPath: string;
}

const USAGE = `csuite-connect-platform

usage:
  csuite-connect-platform --url <hosted-url> --member-name <name> --platform <url> [options]

options:
  --url <url>            Public URL of this csuite server (required).
                         Must match what you'll connect to from the
                         platform's team rail — the registration pins
                         to this origin.
  --member-name <name>   Your member name on this server (required).
                         Must exist in config.json's members list.
  --platform <url>       Hosted control-plane origin (required).
  --config-path <path>   Path to the primary config. Defaults to
                         the same default as csuite-server (CSUITE_CONFIG_PATH
                         or ./csuite.json). The overlay is written as
                         a sibling with ".platform" before ".json".
  -h, --help             Print this message.
`;

function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      'member-name': { type: 'string' },
      platform: { type: 'string' },
      'config-path': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help === true) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (typeof values.url !== 'string' || values.url.length === 0) {
    process.stderr.write(`csuite-connect-platform: --url is required\n\n${USAGE}`);
    process.exit(2);
  }
  if (typeof values['member-name'] !== 'string' || values['member-name'].length === 0) {
    process.stderr.write(`csuite-connect-platform: --member-name is required\n\n${USAGE}`);
    process.exit(2);
  }
  if (typeof values.platform !== 'string' || values.platform.length === 0) {
    process.stderr.write(`csuite-connect-platform: --platform is required\n\n${USAGE}`);
    process.exit(2);
  }
  const platformOrigin = values.platform.replace(/\/+$/, '');
  const configPath =
    typeof values['config-path'] === 'string' && values['config-path'].length > 0
      ? values['config-path']
      : defaultConfigPath();
  return {
    hostedAt: values.url.replace(/\/+$/, ''),
    memberName: values['member-name'],
    platformOrigin,
    configPath,
  };
}

interface StartResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  pollIntervalSec: number;
}

type StatusResponse =
  | { status: 'pending' }
  | { status: 'expired' }
  | {
      status: 'authorized';
      teamId: string;
      teamSlug: string;
      jwt: { issuer: string; jwksUrl: string; audience: string };
    };

async function postJson<T>(
  url: string,
  body: unknown,
): Promise<{ status: number; body: T | null }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: T | null = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      parsed = null;
    }
  }
  return { status: res.status, body: parsed };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function start(args: CliArgs): Promise<StartResponse> {
  const res = await postJson<StartResponse & { error?: string; detail?: string }>(
    `${args.platformOrigin}/api/servers/register/start`,
    { hostedAt: args.hostedAt },
  );
  if (res.status === 409 && res.body?.error === 'server already registered') {
    process.stderr.write(
      `\nThis server is already registered with ${args.platformOrigin}.\n` +
        `Ask the current team owner for an invite instead of re-registering.\n`,
    );
    process.exit(3);
  }
  if (res.status !== 201 || !res.body) {
    const msg = res.body?.detail ?? res.body?.error ?? `HTTP ${res.status}`;
    throw new Error(`failed to start registration: ${msg}`);
  }
  return res.body;
}

async function poll(
  args: CliArgs,
  deviceCode: string,
  intervalSec: number,
  expiresAt: number,
): Promise<StatusResponse> {
  const intervalMs = Math.max(1000, intervalSec * 1000);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() >= expiresAt) {
      return { status: 'expired' };
    }
    const res = await postJson<StatusResponse>(
      `${args.platformOrigin}/api/servers/register/status`,
      { deviceCode },
    );
    if (res.status === 200 && res.body) {
      if (res.body.status === 'authorized' || res.body.status === 'expired') {
        return res.body;
      }
    }
    await sleepMs(intervalMs);
  }
}

function writeOverlayAtomic(
  overlayPath: string,
  jwt: { issuer: string; jwksUrl: string; audience: string },
): void {
  const body = `${JSON.stringify({ jwt }, null, 2)}\n`;
  const tmp = `${overlayPath}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  const fd = openSync(tmp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, overlayPath);
  // chmod again post-rename in case the filesystem stripped bits.
  chmodSync(overlayPath, 0o600);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  process.stdout.write(
    `csuite-connect-platform: registering ${args.hostedAt} with ${args.platformOrigin}\n\n`,
  );

  let started: StartResponse;
  try {
    started = await start(args);
  } catch (err) {
    process.stderr.write(`\n${(err as Error).message}\n`);
    process.exit(1);
  }

  const pretty =
    started.userCode.length === 8
      ? `${started.userCode.slice(0, 4)}-${started.userCode.slice(4)}`
      : started.userCode;

  process.stdout.write(
    `→ Open this URL while signed in to the platform:\n` +
      `    ${started.verificationUrl}\n\n` +
      `  Then verify the code:\n` +
      `    ${pretty}\n\n` +
      `  (Code expires in 10 minutes. Waiting for your confirmation…)\n\n`,
  );

  const outcome = await poll(args, started.deviceCode, started.pollIntervalSec, started.expiresAt);
  if (outcome.status !== 'authorized') {
    process.stderr.write(
      `\nRegistration expired before you confirmed. Re-run csuite-connect-platform to try again.\n`,
    );
    process.exit(4);
  }

  const overlayPath = platformOverlayPathFor(args.configPath);
  writeOverlayAtomic(overlayPath, outcome.jwt);

  process.stdout.write(
    `\n✓ Registered. Wrote ${overlayPath}.\n` +
      `  Team id:  ${outcome.teamId}\n` +
      `  Audience: ${outcome.jwt.audience}\n` +
      `  Issuer:   ${outcome.jwt.issuer}\n\n` +
      `  Restart csuite-server (or send SIGHUP if hot-reload is wired) to pick up the new config.\n` +
      `  Open the team in the platform:\n` +
      `    ${args.platformOrigin}/t/${outcome.teamSlug}\n`,
  );
}

// Run when invoked directly.
main().catch((err) => {
  process.stderr.write(`\ncsuite-connect-platform: ${(err as Error).message}\n`);
  process.exit(1);
});
