/**
 * First-run interactive wizard for the csuite broker.
 *
 * Triggered when the server boots without a config file at the
 * expected path AND stdin is a TTY. Identity + auth only: the
 * operator picks a team name and their own name, saves a generated
 * bearer token, and enrolls in TOTP (admins need web UI login by
 * default). Standing context — team context, roles, per-member
 * instructions — is deliberately NOT collected here; it is
 * configured after boot via the web UI, CLI, or MCP tools.
 *
 * The wizard is I/O only: it returns the captured data and lets the
 * caller decide where to persist it. Today that caller is the boot
 * entry (`index.ts`), which inserts the team + admin into SQLite via
 * the team/member/token stores and writes a slim infra-only
 * `csuite.json` to disk.
 *
 * Subsequent members are added by the admin through the web UI
 * (Members admin page) or the CLI (`csuite member create`).
 */

import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import type { Permission, PermissionPresets, Role, Team } from 'csuite-sdk/types';
import { PERMISSIONS } from 'csuite-sdk/types';
// qrcode-terminal is CJS; default-import the namespace and destructure.
import qrcodeTerminal from 'qrcode-terminal';
import { MemberLoadError } from './members.js';
import { generateSecret, otpauthUri, verifyCode } from './totp.js';

const { generate: generateQrCode, setErrorLevel } = qrcodeTerminal;

// `qrcode-terminal` lazily initializes its error-correction level and
// some code paths read it unset. Set at module load so generate() sees
// a valid state. 'L' = smallest (~7% recovery), compact enough for a
// terminal.
setErrorLevel('L');

const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
const TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'csuite_';
const TOTP_ISSUER = 'csuite';
const TOTP_MAX_CONFIRM_ATTEMPTS = 3;

/**
 * Role stamped on the first admin. The wizard no longer asks — the
 * title is a plain default the admin can edit later (Members page /
 * `csuite member update`) like any other member's role.
 */
export const DEFAULT_ADMIN_ROLE_TITLE = 'director';

/**
 * Default permission presets seeded with every new team. The operator
 * can edit them via the API/CLI/MCP after first boot.
 */
export const DEFAULT_PERMISSION_PRESETS: PermissionPresets = {
  admin: [...PERMISSIONS],
  operator: ['objectives.create', 'objectives.cancel', 'objectives.reassign'],
};

export interface WizardIO {
  prompt(question: string): Promise<string>;
  println(line: string): void;
  /** Best-effort wipe of the last N lines, for TOTP secret redaction. */
  redactLines?(count: number): void;
  isInteractive: boolean;
}

export interface RunWizardOptions {
  configPath: string;
  io: WizardIO;
  tokenFactory?: () => string;
  totpSecretFactory?: () => string;
  now?: () => number;
  qrRenderer?: (uri: string) => string;
}

/**
 * Captured wizard data, ready to seed the DB-backed stores. The
 * caller is responsible for inserting the team + presets + admin into
 * SQLite (via `TeamStore` / `MemberStore` / `TokenStore`) and writing
 * the slim infra-only config file.
 */
export interface WizardResult {
  team: Team;
  admin: {
    name: string;
    role: Role;
    instructions: string;
    rawPermissions: string[];
    permissions: Permission[];
    /** Plaintext bearer token — show once, then hash and discard. */
    token: string;
    /** Plaintext base32 TOTP secret — caller encrypts before persisting. */
    totpSecret: string;
  };
}

/**
 * Drive the wizard to completion. Throws `MemberLoadError` if IO is
 * not interactive — the CLI catches that and prints a non-interactive
 * hint instead.
 */
export async function runFirstRunWizard(options: RunWizardOptions): Promise<WizardResult> {
  const { io, configPath } = options;
  const mintToken = options.tokenFactory ?? defaultTokenFactory;
  const mintTotpSecret = options.totpSecretFactory ?? generateSecret;
  const nowFn = options.now ?? Date.now;
  const renderQr = options.qrRenderer ?? defaultQrRenderer;

  if (!io.isInteractive) {
    throw new MemberLoadError(
      `no config file at ${configPath} and stdin is not a TTY. ` +
        'Create the file manually, pass --config-path, or re-run interactively.',
    );
  }

  io.println('');
  io.println('csuite: no config file found at');
  io.println(`  ${configPath}`);
  io.println('');
  io.println("Let's set up a team: a team name, your name, a bearer token (shown once)");
  io.println('and a TOTP secret for web UI login. Save the token as it appears — it is');
  io.println('hashed on disk and cannot be recovered afterward.');
  io.println('');
  io.println('Everything else — team context, roles, member instructions, more members —');
  io.println('is configured once the server is running, via the web UI or the CLI.');
  io.println('');

  // ── Team ────────────────────────────────────────────────────
  io.println('-- team --');
  const teamName = await promptRequired(io, 'team name [my-team]: ', 'my-team', (v) =>
    v.length > 0 && v.length <= 128 ? null : 'must be 1-128 characters',
  );

  // ── First admin member ─────────────────────────────────────
  io.println('');
  io.println('-- first admin member --');
  const name = await promptName(io);
  const role: Role = { title: DEFAULT_ADMIN_ROLE_TITLE, description: '' };
  const token = mintToken();
  const bannerLines = printTokenBanner(io, name, role, token);
  await io.prompt('press enter once you have saved the token above ');
  io.redactLines?.(bannerLines + 1);

  // TOTP is always-on for the first admin — no yes/no prompt. The
  // wizard's whole point is to leave the operator with a working web
  // UI login.
  io.println('');
  io.println('-- TOTP enrollment --');
  io.println(`The admin signs into the web UI with a 6-digit code from an authenticator app.`);
  io.println('Scan the QR below and enter the current code to confirm pairing.');
  const totpSecret = await enrollTotp(io, name, {
    mintTotpSecret,
    now: nowFn,
    renderQr,
  });

  const team: Team = {
    name: teamName,
    context: '',
    permissionPresets: DEFAULT_PERMISSION_PRESETS,
  };

  return {
    team,
    admin: {
      name,
      role,
      instructions: '',
      rawPermissions: ['admin'],
      permissions: DEFAULT_PERMISSION_PRESETS.admin ?? [],
      token,
      totpSecret,
    },
  };
}

async function promptRequired(
  io: WizardIO,
  prompt: string,
  defaultValue: string,
  validate: (v: string) => string | null,
): Promise<string> {
  while (true) {
    const raw = (await io.prompt(prompt)).trim();
    const candidate = raw.length === 0 ? defaultValue : raw;
    const err = validate(candidate);
    if (err !== null) {
      io.println(`  ${err}`);
      continue;
    }
    return candidate;
  }
}

async function promptName(io: WizardIO): Promise<string> {
  const suggested = 'director-1';
  while (true) {
    const raw = (await io.prompt(`your name [${suggested}]: `)).trim();
    const candidate = raw.length === 0 ? suggested : raw;
    if (!candidate) {
      io.println('  name cannot be empty');
      continue;
    }
    if (candidate.length > 128) {
      io.println('  name must be 128 characters or fewer');
      continue;
    }
    if (!NAME_REGEX.test(candidate)) {
      io.println('  name must be alphanumeric with . _ - allowed');
      continue;
    }
    return candidate;
  }
}

/**
 * Render the token banner and return the number of terminal lines
 * emitted so the caller can wipe scrollback cleanly.
 */
function printTokenBanner(io: WizardIO, name: string, role: Role, token: string): number {
  const bar = '='.repeat(68);
  const lines = [
    '',
    bar,
    `  ${name} (${role.title})`,
    '',
    `  ${token}`,
    bar,
    'save this token NOW — it will be hashed and removed from scrollback.',
  ];
  for (const line of lines) io.println(line);
  return lines.length;
}

async function enrollTotp(
  io: WizardIO,
  adminName: string,
  deps: {
    mintTotpSecret: () => string;
    now: () => number;
    renderQr: (uri: string) => string;
  },
): Promise<string> {
  let redactCount = 0;
  const printRedacted = (line: string) => {
    io.println(line);
    redactCount++;
  };

  const secret = deps.mintTotpSecret();
  const uri = otpauthUri({
    secret,
    issuer: TOTP_ISSUER,
    label: `${TOTP_ISSUER}:${adminName}`,
  });
  const qr = deps.renderQr(uri);

  printRedacted('');
  printRedacted('scan this QR code with Google Authenticator, Authy, 1Password, …');
  printRedacted('');
  for (const line of qr.split('\n')) printRedacted(line);
  printRedacted('');
  printRedacted('or paste this secret manually:');
  printRedacted(`  ${secret}`);
  printRedacted('');

  for (let attempt = 0; attempt < TOTP_MAX_CONFIRM_ATTEMPTS; attempt++) {
    const raw = (await io.prompt('enter the 6-digit code to confirm: ')).trim();
    redactCount += 1;
    const result = verifyCode(secret, raw, 0, deps.now());
    if (result.ok) {
      io.redactLines?.(redactCount);
      io.println(`  ✓ TOTP enrolled for ${adminName}`);
      return secret;
    }
    io.println(`  ${describeVerifyError(result.reason)} — try again`);
    redactCount += 1;
  }

  io.redactLines?.(redactCount);
  throw new MemberLoadError(
    'TOTP enrollment failed after 3 attempts. Re-run the wizard; the admin must ' +
      'enroll to sign into the web UI on first boot.',
  );
}

function describeVerifyError(reason: 'malformed' | 'invalid' | 'replay'): string {
  switch (reason) {
    case 'malformed':
      return 'that code is not 6 digits';
    case 'invalid':
      return 'that code is incorrect';
    case 'replay':
      return 'that code is expired (enter the next one your app shows)';
  }
}

function defaultQrRenderer(uri: string): string {
  let out = '';
  generateQrCode(uri, { small: true }, (qr) => {
    out = qr;
  });
  return out;
}

function defaultTokenFactory(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export function createTtyWizardIO(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): { io: WizardIO; close: () => void } {
  const rl = createInterface({ input: stdin, output: stdout });
  const isInteractive = Boolean(stdin.isTTY && stdout.isTTY);
  const io: WizardIO = {
    prompt: (question) => rl.question(question),
    println: (line) => {
      stdout.write(`${line}\n`);
    },
    redactLines: (count) => {
      if (!stdout.isTTY) return;
      try {
        stdout.moveCursor?.(0, -count);
        stdout.clearScreenDown?.();
      } catch {
        // best-effort
      }
    },
    isInteractive,
  };
  return { io, close: () => rl.close() };
}
