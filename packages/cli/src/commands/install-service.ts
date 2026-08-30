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
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import type { Client } from 'csuite-sdk/client';
import { findAuthEntry, formatHeadlessNoAuth, workspaceContains } from './auth-config.js';
import { UsageError } from './errors.js';

export { UsageError };

/** Runner verbs a service can supervise. Kept in sync with the CLI. */
export type ServiceVerb = 'claude' | 'codex' | 'stub';

export function unitNameFor(user: string): string {
  return `csuite-${user}`;
}

// ─── systemd value hygiene ──────────────────────────────────────────

/**
 * Refuse control characters outright (a \n in any value is a unit-file
 * directive injection), escape systemd's % specifier, and quote
 * ExecStart tokens containing whitespace. Values we cannot render
 * safely are refused, never mangled.
 */
export function systemdValue(value: string, label: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we refuse
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new UsageError(
      `install-service: ${label} contains control characters and cannot be rendered into a unit file`,
    );
  }
  return value.replace(/%/g, '%%');
}

/** One ExecStart token: hygiene + quoting for whitespace; refuses quotes/backslashes. */
export function execStartToken(value: string, label: string): string {
  const clean = systemdValue(value, label);
  if (/["\\]/.test(clean)) {
    throw new UsageError(
      `install-service: ${label} contains quotes or backslashes and cannot be rendered into ExecStart`,
    );
  }
  return /\s/.test(clean) ? `"${clean}"` : clean;
}

/** One Environment= line; quoted when the assignment contains whitespace, quotes refused. */
export function envAssignment(name: string, value: string): string {
  const clean = systemdValue(value, name);
  if (/["\\]/.test(clean)) {
    throw new UsageError(
      `install-service: ${name} contains a quote or backslash and cannot be rendered into a unit file`,
    );
  }
  const assignment = `${name}=${clean}`;
  return /\s/.test(assignment) ? `Environment="${assignment}"` : `Environment=${assignment}`;
}

export interface UnitRenderOptions {
  user: string;
  verb: ServiceVerb;
  /** Broker URL — becomes Environment=CSUITE_URL and --url. */
  url: string;
  /** Workspace: WorkingDirectory and --cwd (auth resolves from here). */
  workspace: string;
  /** ExecStart argv tokens (each validated/quoted independently). */
  execArgv: string[];
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
    `User=${systemdValue(opts.user, 'user')}`,
    `WorkingDirectory=${systemdValue(opts.workspace, 'workspace')}`,
    envAssignment('HOME', opts.home),
    envAssignment('USER', opts.user),
    envAssignment('PATH', `${opts.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`),
    '# Saved auth is keyed on (broker URL, workspace). Without CSUITE_URL the',
    '# lookup uses the loopback default and finds nothing, however correct',
    '# WorkingDirectory is.',
    envAssignment('CSUITE_URL', opts.url),
    `ExecStart=${[
      ...opts.execArgv.map((token, i) =>
        execStartToken(token, i === 0 ? 'exec path' : 'exec argument'),
      ),
      opts.verb,
      '--url',
      execStartToken(opts.url, 'url'),
      '--cwd',
      execStartToken(opts.workspace, 'workspace'),
      '--resume',
    ].join(' ')}`,
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
        .filter((e) => e.workspace !== null && workspaceContains(e.workspace, input.workspace))
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
  /** Read an existing installed unit's bytes; null when absent. Injectable for tests. */
  readExisting?: (path: string) => string | null;
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

  // systemd requires absolute ExecStart paths: the honest default is the
  // exact interpreter + entry script THIS invocation runs under, which is
  // correct for a packaged install, a checkout dist, and a deploy tree
  // alike. --exec overrides with a single binary token (never split —
  // a path may contain spaces).
  const execArgv = input.execPath
    ? [input.execPath]
    : [process.execPath, resolvePath(process.argv[1] as string)];
  const unitText = renderRunnerUnit({ user, verb: input.verb, url, workspace, execArgv, home });
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

  // Replacement safety: capture the previous unit (bytes + active
  // state) BEFORE overwriting, so a failed liveness check can put the
  // previous runner back exactly as it was.
  const readExisting =
    deps.readExisting ??
    ((path: string): string | null => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    });
  const previousUnit = readExisting(unitPath);
  const previousSudoers = readExisting(sudoersPath);
  const anyPrevious = previousUnit !== null || previousSudoers !== null;
  const wasActive =
    previousUnit !== null &&
    runSync('systemctl', ['is-active', unit], { stdio: 'ignore', timeout: 10_000 }).status === 0;
  const wasEnabled =
    previousUnit !== null &&
    runSync('systemctl', ['is-enabled', unit], { stdio: 'ignore', timeout: 10_000 }).status === 0;

  // The staged-sudoers syntax gate runs before ANY privileged mutation.
  priv(['visudo', '-c', '-f', stagedSudoers]);

  // From the first privileged mutation through liveness this is ONE
  // transaction. `started` gates the stop: until we restart the unit
  // ourselves, a previous runner's process was never touched and must
  // not be stopped by rollback. Per-destination: a previous file is
  // restored byte-exact; a destination we created fresh is removed —
  // an unvalidated privileged artifact (a half-installed sudoers rule)
  // must not outlive its failed install. Staged copies in $HOME remain
  // as evidence either way.
  let started = false;
  const rollback = (): string => {
    if (started) priv(['systemctl', started && previousUnit === null ? 'disable' : 'stop', unit]);
    if (started && previousUnit === null) {
      // disable above removed the wants-symlink; now stop it too.
      priv(['systemctl', 'stop', unit]);
    }
    const restored: string[] = [];
    if (previousUnit !== null) {
      const restoreStage = join(stageDir, `${unit}.service.previous`);
      writeFile0600(restoreStage, previousUnit);
      priv(['install', '-m', '644', restoreStage, unitPath]);
      restored.push(`restored the previous ${unitPath}`);
    } else {
      priv(['rm', '-f', unitPath]);
      restored.push(`removed the fresh ${unitPath}`);
    }
    if (previousSudoers !== null) {
      const restoreStage = join(stageDir, `${sudoersFileNameFor(user)}.previous`);
      writeFile0600(restoreStage, previousSudoers);
      priv(['install', '-m', '440', restoreStage, sudoersPath]);
      restored.push(`restored the previous ${sudoersPath}`);
    } else {
      priv(['rm', '-f', sudoersPath]);
      restored.push(`removed the fresh ${sudoersPath}`);
    }
    priv(['systemctl', 'daemon-reload']);
    if (previousUnit !== null) {
      if (!wasEnabled) priv(['systemctl', 'disable', unit]);
      if (started && wasActive) priv(['systemctl', 'start', unit]);
    }
    return (
      `${restored.join(', ')}` +
      `${previousUnit !== null && !wasEnabled ? ' (left disabled, as found)' : ''}` +
      `${previousUnit !== null && started && wasActive ? ' and restarted it' : ''}` +
      `${previousUnit !== null && !started && wasActive ? ' (previous runner was never stopped)' : ''}; ` +
      `staged renders kept: ${stagedUnit}, ${stagedSudoers}`
    );
  };

  const sinceMs = (deps.now ?? Date.now)();
  let memberName = '(unknown)';
  let live = false;
  try {
    priv(['install', '-m', '644', stagedUnit, unitPath]);
    priv(['install', '-m', '440', stagedSudoers, sudoersPath]);
    priv(['systemctl', 'daemon-reload']);
    deps.stdout(`installed ${unitPath} and ${sudoersPath}`);
    // enable and restart separately: `enable --now` is a no-op start on
    // an already-active replacement, which would leave the OLD process
    // running and let its presence pass the liveness check for the new
    // unit. `restart` makes the successor real before we measure it.
    priv(['systemctl', 'enable', unit]);
    started = true;
    priv(['systemctl', 'restart', unit]);
    const client = deps.clientFor(url, entry.token);
    memberName = (await client.instructions({})).name;
    live = await waitForMemberLive(
      client,
      memberName,
      sinceMs,
      input.timeoutMs ?? 90_000,
      deps.sleep,
    );
  } catch (err) {
    const restored = rollback();
    throw new UsageError(
      `install-service: installing or verifying the unit failed (${err instanceof Error ? err.message : String(err)}) — ` +
        `${restored}; logs: journalctl -u ${unit}`,
    );
  }
  if (!live) {
    const restored = rollback();
    throw new UsageError(
      `install-service: '${memberName}' never showed connected with a fresh lastSeen at ${url} — ` +
        `${restored}; logs: journalctl -u ${unit}`,
    );
  }
  const replaced = anyPrevious ? ' (replaced the previous install)' : '';
  deps.stdout(
    `✓ ${unit} enabled and live: '${memberName}' connected at ${url}${replaced} (journalctl -u ${unit} -f)`,
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
