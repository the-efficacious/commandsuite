/**
 * `csuite <verb> install-service` / `csuite <verb> cycle` — the runner
 * installs (and later restarts) its own supervisor.
 *
 * Productizes the hand-built kit every seat on the first team ran
 * (obj-mtfvz379-i): a systemd system unit + a sudoers rule scoped to
 * exactly that unit, with the two traps that cost real outages built
 * in as refusals:
 *
 *   - saved auth is keyed on (broker URL, workspace): the unit gets
 *     `Environment=CSUITE_URL` and a WorkingDirectory that resolves the
 *     credential, and install-service REFUSES up front — naming the
 *     exact lookup key — when nothing resolves headlessly (#199's
 *     preflight; without it `Restart=always` loops a wizard forever).
 *   - liveness is judged at the BROKER (member connected with a fresh
 *     lastSeen), never by pid or `is-active`: a stuck enrolment wizard
 *     stays "active" for systemd while the agent is gone.
 *
 * Root-explicit rule: without root (and without passwordless sudo for
 * the install step) nothing is written outside $HOME — the unit and
 * sudoers text print with the exact operator commands instead
 * (`--print` forces that mode). Failure paths delete nothing: they
 * stop what they started and report exactly what was created.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'csuite-sdk/client';
import { findAuthEntry, formatHeadlessNoAuth } from './auth-config.js';
import { UsageError } from './errors.js';

export { UsageError };

/** Runner verbs a service can supervise. Kept in sync with the CLI. */
export type ServiceVerb = 'claude' | 'codex' | 'stub';

export function unitNameFor(user: string): string {
  return `csuite-${user}`;
}

export interface UnitRenderOptions {
  user: string;
  verb: ServiceVerb;
  /** Broker URL — becomes Environment=CSUITE_URL and --url. */
  url: string;
  /** Workspace: WorkingDirectory and --cwd (auth resolves from here). */
  workspace: string;
  /** ExecStart binary. Default: the packaged `csuite` on PATH. */
  execPath: string;
  home: string;
}

/**
 * Render the unit. Shape follows the field-tested kit: Restart=always
 * with StartLimitIntervalSec=0 (an agent that gives up is an agent
 * that is gone — safe because the headless no-auth path exits before
 * any wizard could hang), journald logging, and the auth-keying pair
 * (CSUITE_URL + WorkingDirectory) spelled out with the reason.
 */
export function renderRunnerUnit(opts: UnitRenderOptions): string {
  return [
    '[Unit]',
    `Description=CommandSuite runner - ${opts.user} (csuite ${opts.verb})`,
    'Documentation=https://docs.commandsuite.io',
    'After=network-online.target',
    'Wants=network-online.target',
    '# Never stop retrying: an agent that gives up is an agent that is gone.',
    '# Safe because the runner exits non-zero (no wizard, no hang) when auth',
    '# cannot resolve headlessly, so a broken box fails loudly in journald.',
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'Type=simple',
    `User=${opts.user}`,
    `WorkingDirectory=${opts.workspace}`,
    `Environment=HOME=${opts.home}`,
    `Environment=USER=${opts.user}`,
    `Environment=PATH=${opts.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    '# Saved auth is keyed on (broker URL, workspace). Without CSUITE_URL the',
    '# lookup uses the loopback default and finds nothing, however correct',
    '# WorkingDirectory is.',
    `Environment=CSUITE_URL=${opts.url}`,
    `ExecStart=${opts.execPath} ${opts.verb} --url ${opts.url} --cwd ${opts.workspace} --resume`,
    'Restart=always',
    'RestartSec=5',
    'KillMode=mixed',
    'TimeoutStopSec=45',
    'StandardOutput=journal',
    'StandardError=journal',
    `SyslogIdentifier=${unitNameFor(opts.user)}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

/**
 * Sudoers rule scoped to exactly the five systemctl verbs on exactly
 * this unit — no wildcards. This is what lets `csuite <verb> cycle`
 * restart the unit from inside the runner without a password.
 */
export function renderRunnerSudoers(user: string): string {
  const unit = unitNameFor(user);
  const verbs = ['start', 'stop', 'restart', 'is-active', 'status']
    .map((v) => `/usr/bin/systemctl ${v} ${unit}`)
    .join(', ');
  return [
    `# ${sudoersFileNameFor(user)} — installed by \`csuite <verb> install-service\`.`,
    `# Lets ${user} (re)start ONLY its own runner unit, password-free. No wildcards.`,
    `# Validate with \`visudo -c -f <file>\` before installing by hand.`,
    `${user} ALL=(root) NOPASSWD: ${verbs}`,
    '',
  ].join('\n');
}

export function unitFilePathFor(user: string): string {
  return `/etc/systemd/system/${unitNameFor(user)}.service`;
}

export function sudoersFileNameFor(user: string): string {
  return `${user}-csuite-runner`;
}

export function sudoersFilePathFor(user: string): string {
  return `/etc/sudoers.d/${sudoersFileNameFor(user)}`;
}

// ─── Privilege detection ────────────────────────────────────────────

export type InstallPrivilege = 'root' | 'sudo' | 'none';

/** How (if at all) this process can write the two system files. */
export function detectInstallPrivilege(runSync: typeof spawnSync = spawnSync): InstallPrivilege {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return 'root';
  const probe = runSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 5_000 });
  return probe.status === 0 ? 'sudo' : 'none';
}

// ─── The operator hand-off (no-root path and --print) ───────────────

/**
 * Liveness at the broker, never at the pid: the member must appear in
 * the roster's `connected` presences with `lastSeen` at or after
 * `sinceMs`. Returns true once seen, false on timeout.
 */
export async function waitForMemberLive(
  client: Pick<Client, 'roster'>,
  memberName: string,
  sinceMs: number,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const roster = await client.roster();
      const presence = roster.connected.find((p) => p.name === memberName);
      if (presence !== undefined && presence.connected >= 1 && presence.lastSeen >= sinceMs) {
        return true;
      }
    } catch {
      // Broker briefly unreachable mid-restart — keep polling.
    }
    if (Date.now() >= deadline) return false;
    await sleep(2_000);
  }
}

/**
 * Resolve the broker URL for the workspace: an explicit value wins;
 * otherwise the auth store's entries scoped to this workspace decide —
 * exactly one is the answer, zero or several is a refusal that names
 * them (guessing a broker is how a unit gets installed against the
 * wrong one).
 */
export function resolveServiceUrl(input: {
  explicit?: string;
  workspace: string;
  entries: Array<{ url: string; workspace: string | null }>;
}): string {
  if (input.explicit) return input.explicit;
  const urls = [
    ...new Set(
      input.entries
        .filter((e) => e.workspace !== null && input.workspace.startsWith(e.workspace))
        .map((e) => e.url),
    ),
  ];
  if (urls.length === 1) return urls[0] as string;
  if (urls.length === 0) {
    throw new UsageError(
      `install-service: no saved auth entry is scoped to ${input.workspace}; ` +
        'enroll first (csuite connect) or pass --url <broker>',
    );
  }
  throw new UsageError(
    `install-service: ${urls.length} brokers have entries scoped to ${input.workspace} ` +
      `(${urls.join(', ')}); pass --url to choose one`,
  );
}

export function formatOperatorHandoff(input: {
  user: string;
  unitText: string;
  sudoersText: string;
}): string {
  const unitPath = unitFilePathFor(input.user);
  const sudoersPath = sudoersFilePathFor(input.user);
  const unit = unitNameFor(input.user);
  return [
    'no root available — nothing outside $HOME was written. Hand the two files',
    'below to an operator (or re-run with sudo access):',
    '',
    `# ── ${unitPath} ──`,
    input.unitText.trimEnd(),
    '',
    `# ── ${sudoersPath} (validate: visudo -c -f <file>) ──`,
    input.sudoersText.trimEnd(),
    '',
    '# ── operator commands ──',
    `sudo install -m 644 <unit-file> ${unitPath}`,
    `sudo visudo -c -f <sudoers-file> && sudo install -m 440 <sudoers-file> ${sudoersPath}`,
    'sudo systemctl daemon-reload',
    `sudo systemctl enable --now ${unit}`,
  ].join('\n');
}

// ─── install-service flow ───────────────────────────────────────────

export interface InstallServiceInput {
  verb: ServiceVerb;
  /** Broker URL; default resolved from the auth store for the workspace. */
  url?: string;
  /** ExecStart binary override (main-build deploy trees). */
  execPath?: string;
  /** Render unit + sudoers + operator commands to stdout; write nothing. */
  print?: boolean;
  /** Workspace; defaults to process.cwd(). */
  workspace?: string;
  /** Liveness timeout after enable --now. */
  timeoutMs?: number;
}

export interface InstallServiceDeps {
  stdout: (line: string) => void;
  /** Client for the liveness check, built from the resolved (url, token). */
  clientFor: (url: string, token: string) => Pick<Client, 'roster' | 'instructions'>;
  runSync?: typeof spawnSync;
  authStorePath?: string;
  user?: string;
  home?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The install sequence: preflight auth → render → (print | install via
 * root/sudo) → daemon-reload → enable --now → broker liveness. On a
 * liveness timeout: stop the unit, keep both installed files, report
 * exactly what was created, throw.
 */
export async function runInstallServiceCommand(
  input: InstallServiceInput,
  deps: InstallServiceDeps,
): Promise<void> {
  const runSync = deps.runSync ?? spawnSync;
  const user = deps.user ?? userInfo().username;
  const home = deps.home ?? (process.env.HOME as string);
  const workspace = input.workspace ?? process.cwd();
  const unit = unitNameFor(user);

  // 1. Broker URL + headless auth preflight (the #199 trap, refused early).
  const { listAuthEntries } = await import('./auth-config.js');
  const url = resolveServiceUrl({
    explicit: input.url ?? process.env.CSUITE_URL,
    workspace,
    entries: listAuthEntries(deps.authStorePath),
  });
  const entry = findAuthEntry(url, { cwd: workspace, path: deps.authStorePath });
  if (entry === null) {
    throw new UsageError(
      `install-service: ${formatHeadlessNoAuth({ url, cwd: workspace, urlDefaulted: false })}`,
    );
  }

  const execPath = input.execPath ?? 'csuite';
  const unitText = renderRunnerUnit({ user, verb: input.verb, url, workspace, execPath, home });
  const sudoersText = renderRunnerSudoers(user);
  const unitPath = unitFilePathFor(user);
  const sudoersPath = sudoersFilePathFor(user);

  // 2. --print or the no-root hand-off: render, write nothing.
  const privilege = input.print ? 'none' : detectInstallPrivilege(runSync);
  if (input.print || privilege === 'none') {
    deps.stdout(formatOperatorHandoff({ user, unitText, sudoersText }));
    if (input.print) return;
    throw new UsageError(
      'install-service: no root and no passwordless sudo — printed the hand-off above instead',
    );
  }

  // 3. Stage in $HOME (0600 dir), install via root or sudo. Staging
  //    means the privileged step is `install`, which reads no stdin —
  //    a secret-handling rule this team paid for.
  const stageDir = join(home, '.config', 'csuite', 'service');
  mkdirSync(stageDir, { recursive: true, mode: 0o700 });
  const stagedUnit = join(stageDir, `${unit}.service`);
  const stagedSudoers = join(stageDir, sudoersFileNameFor(user));
  writeFile0600(stagedUnit, unitText);
  writeFile0600(stagedSudoers, sudoersText);

  const priv = (argv: string[]): void => {
    const cmd = privilege === 'root' ? argv : ['sudo', '-n', ...argv];
    const res = runSync(cmd[0] as string, cmd.slice(1), { stdio: 'pipe', timeout: 30_000 });
    if (res.status !== 0) {
      throw new UsageError(
        `install-service: \`${argv.join(' ')}\` failed (${res.status}): ${String(res.stderr ?? '').slice(0, 300)}`,
      );
    }
  };

  priv(['visudo', '-c', '-f', stagedSudoers]);
  priv(['install', '-m', '644', stagedUnit, unitPath]);
  priv(['install', '-m', '440', stagedSudoers, sudoersPath]);
  priv(['systemctl', 'daemon-reload']);
  deps.stdout(`installed ${unitPath} and ${sudoersPath}`);

  // 4. Start + broker-side liveness (a live pid is not a live agent).
  const sinceMs = (deps.now ?? Date.now)();
  priv(['systemctl', 'enable', '--now', unit]);
  const client = deps.clientFor(url, entry.token);
  const memberName = (await client.instructions({})).name;
  const live = await waitForMemberLive(
    client,
    memberName,
    sinceMs,
    input.timeoutMs ?? 90_000,
    deps.sleep,
  );
  if (!live) {
    priv(['systemctl', 'stop', unit]);
    throw new UsageError(
      `install-service: the unit started but '${memberName}' never showed connected with a fresh lastSeen at ${url} — ` +
        `stopped ${unit}; created files kept for inspection: ${unitPath}, ${sudoersPath}; ` +
        `logs: journalctl -u ${unit}`,
    );
  }
  deps.stdout(
    `✓ ${unit} enabled and live: '${memberName}' connected at ${url} (journalctl -u ${unit} -f)`,
  );
}

function writeFile0600(path: string, text: string): void {
  const fd = openSync(path, 'w', 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

// ─── cycle flow ─────────────────────────────────────────────────────

export interface CycleInput {
  verb: ServiceVerb;
  timeoutMs?: number;
  /** Internal: run the worker inline (the detached half). */
  worker?: boolean;
  workspace?: string;
  url?: string;
}

/**
 * Restart the unit from inside the runner. The requester is a
 * descendant of the process being restarted, so the work happens in a
 * detached worker (setsid-equivalent: detached spawn, ignored stdio,
 * unref) that survives its parent's death; the parent returns
 * immediately after pointing at the log.
 */
export async function runCycleCommand(
  input: CycleInput,
  deps: InstallServiceDeps & { execArgv?: string[]; logPath?: string },
): Promise<void> {
  const user = deps.user ?? userInfo().username;
  const home = deps.home ?? (process.env.HOME as string);
  const unit = unitNameFor(user);
  const logPath = deps.logPath ?? join(home, '.local', 'var', 'csuite-cycle.log');

  if (!input.worker) {
    mkdirSync(join(home, '.local', 'var'), { recursive: true });
    const argv = deps.execArgv ?? [
      ...process.execArgv,
      process.argv[1] as string,
      input.verb,
      'cycle',
      '--worker',
    ];
    const fd = openSync(logPath, 'a');
    const child = spawn(process.execPath, argv, {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
    child.unref();
    closeSync(fd);
    deps.stdout(`cycle dispatched (worker pid ${child.pid}); tail ${logPath}`);
    return;
  }

  // Worker half: restart via the scoped sudoers rule, then prove
  // liveness at the broker before declaring success.
  const runSync = deps.runSync ?? spawnSync;
  const workspace = input.workspace ?? process.cwd();
  const url = resolveServiceUrl({
    explicit: input.url ?? process.env.CSUITE_URL,
    workspace,
    entries: (await import('./auth-config.js')).listAuthEntries(deps.authStorePath),
  });
  const entry = findAuthEntry(url, { cwd: workspace, path: deps.authStorePath });
  if (entry === null) {
    throw new UsageError(
      `cycle: ${formatHeadlessNoAuth({ url, cwd: workspace, urlDefaulted: false })}`,
    );
  }
  const sinceMs = (deps.now ?? Date.now)();
  const res = runSync('sudo', ['-n', 'systemctl', 'restart', unit], {
    stdio: 'pipe',
    timeout: 60_000,
  });
  if (res.status !== 0) {
    throw new UsageError(
      `cycle: \`sudo -n systemctl restart ${unit}\` failed (${res.status}) — is the scoped sudoers rule installed? (install-service writes it)`,
    );
  }
  const client = deps.clientFor(url, entry.token);
  const memberName = (await client.instructions({})).name;
  const live = await waitForMemberLive(
    client,
    memberName,
    sinceMs,
    input.timeoutMs ?? 90_000,
    deps.sleep,
  );
  if (!live) {
    throw new UsageError(
      `cycle: restarted ${unit} but '${memberName}' never showed connected with a fresh lastSeen at ${url}; ` +
        `logs: journalctl -u ${unit}`,
    );
  }
  deps.stdout(`✓ cycled ${unit}: '${memberName}' live at ${url}`);
}
