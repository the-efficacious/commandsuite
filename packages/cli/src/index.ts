/**
 * `csuite` — command-line interface for csuite.
 *
 * Subcommands:
 *   csuite setup       — first-run wizard: create team config + enroll TOTP
 *   csuite member        — list / create / update / delete team members
 *   csuite enroll      — (re-)enroll a member for web UI login (TOTP)
 *   csuite rotate      — rotate a member's bearer token
 *   csuite claude      — run Claude Code headlessly as an agent member
 *   csuite push        — push an event to a teammate or broadcast
 *   csuite roster      — list members and connection state
 *   csuite objectives  — list / view / mutate team objectives
 *   csuite serve       — run a local broker (optional peer: csuite-server)
 *
 * The internal `csuite mcp-bridge` verb is hidden from the top-level
 * help; agents spawn it from the MCP server entry each runner injects
 * (SDK options for claude, config.toml for codex) and it connects back
 * to the runner over UDS.
 *
 * Global env vars (defaults):
 *   CSUITE_URL       = http://127.0.0.1:8717
 *   CSUITE_TOKEN     (required for claude / push / roster / objectives)
 */

import { Client } from 'csuite-sdk/client';
import { DEFAULT_PORT, ENV } from 'csuite-sdk/protocol';
import { parseDataFlag, parseSubcommandArgs } from './args.js';
import { runAuthCommand } from './commands/auth.js';
import { findAuthEntry, formatHeadlessNoAuth } from './commands/auth-config.js';
import { runClaudeCommand } from './commands/claude.js';
import { runCodexCommand } from './commands/codex.js';
import { runConnectCommand } from './commands/connect.js';
import { runConnectApproveCommand, runConnectPendingCommand } from './commands/connect-approve.js';
import { formatReport, runAgentDoctor, type SavedAuthInput } from './commands/doctor.js';
import { runEnrollCommand } from './commands/enroll.js';
import { UsageError } from './commands/errors.js';
import { runMemberCommand } from './commands/member.js';
import { runNotificationsCommand } from './commands/notifications.js';
import { runObjectivesCommand } from './commands/objectives.js';
import { runPruneTracesCommand } from './commands/prune-traces.js';
import { type PushCommandInput, runPushCommand } from './commands/push.js';
import { QuickstartError, runQuickstartCommand } from './commands/quickstart.js';
import { runRosterCommand } from './commands/roster.js';
import { type RotateCommandInput, runRotateCommand } from './commands/rotate.js';
import { runSecretsCommand } from './commands/secrets.js';
import { runServeCommand } from './commands/serve.js';
import { runSetupCommand } from './commands/setup.js';
import { runTeamCommand } from './commands/team.js';
import { runToolsCommand } from './commands/tools.js';
import { runVariablesCommand } from './commands/variables.js';
import { createClaudeAdapter } from './runtime/agents/claude-agent.js';
import { createCodexAdapter } from './runtime/agents/codex/codex-agent.js';
import { CLI_VERSION } from './version.js';

const USAGE = `csuite cli v${CLI_VERSION}

usage:
  csuite setup       [--config-path <path>]                 first-run wizard (team + first member + TOTP)
  csuite setup       --non-interactive --team <name> --member <name> --token-file <path> [--totp-secret-file <path>] [--config-path <path>]
                                    seed a team + first member with no prompts; bearer token to --token-file (0600), never stdout
  csuite member        list|create|update|delete [--config-path <path>]   offline member management (runs without the broker)
  csuite connect     [--url <broker>] [--label <hint>] [--workspace <dir>] [--global] [--no-write] [--quiet]
  csuite connect     pending                                 list device enrollments waiting for approval (members.manage)
  csuite connect     approve --code <XXXX-XXXX> --member <name> [--label <l>]     approve a device: bind it to an existing member
  csuite connect     approve --code <XXXX-XXXX> --create --member <name> --title <t> [--description <d>] [--permissions <leaf,...>] [--instructions <i>]
                                    approve a device: create a new member for it (same routes and check as the web UI's /enroll page)
                                    enroll this device with the broker (device-code flow); saves to the user-global auth store, scoped to cwd (or --workspace / --global)
  csuite auth          list|migrate                         inspect the local auth store; fold a legacy project-scoped .csuite/auth.json into it
  csuite enroll      --member <name> [--config-path <path>]   (re-)enroll a member for web UI login (TOTP — separate from 'csuite connect')
  csuite rotate      --member <name> [--config-path <path>]   rotate a member's bearer token (atomic; prints new token once)
  csuite quickstart  [--skip-browser] [--assignee <name>]   seed a demo objective + open the web UI
  csuite claude      [--no-trace] [--no-secrets] [--doctor] [--skip-doctor] [--cwd <dir>] [--model <name>] [--resume [<sessionId>]]   run Claude Code headlessly (Agent SDK) as an agent member of a csuite team (--resume alone continues the most recent session; alias: claude-code)
  csuite codex       [--no-trace] [--no-secrets] [--doctor] [--skip-doctor] [--cwd <dir>] [--model <name>] [--resume [<threadId>]] [-- <codex args>...]   spawn OpenAI Codex CLI as a headless agent member of a csuite team (--resume alone picks up the most recent thread)
  csuite push        --body <text> (--agent <id> | --broadcast) [--title <t>] [--level <lvl>] [--data key=value]...
  csuite roster      [--reveal-token --member <name> [--config-path <path>]]
                                    list teammates (no flags) or rotate+print a member's token (alias over 'csuite rotate')
  csuite objectives  list|view|create|update|complete|cancel|reassign   team objectives
  csuite tools       list|show|add|rm|enable|disable|cred|bind|unbind|def|def-rm|refresh   tool-source registry (platform tools)
  csuite secrets     list|view|add|update|set-value|delete-value|bind|unbind|rm   broker-held env secrets (values are write-only)
  csuite variables   list|view|add|update|set-value|delete-value|bind|unbind|rm   broker-held env variables that are NOT secrets (values readable, never redacted from traces)
  csuite notifications list|view|add|update|rm|set-secret|delete-secret|deliveries|replay|profiles   external-notification endpoints (inbound webhooks → agents; alias: hooks)
  csuite serve       [--config-path <path>] [--port <n>] [--host <h>] [--db <path>]
  csuite prune-traces --older-than <duration> [--activity-db <path>] [--yes]   delete activity rows older than the cutoff

global options (or via env):
  --url <url>       broker base URL (env: ${ENV.url}, default: http://127.0.0.1:${DEFAULT_PORT})
  --token <secret>  broker bearer token (env: ${ENV.token})
  -h, --help        print this message
  -v, --version     print the installed CLI version and exit
`;

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`csuite: ${message}\n`);
  process.exit(code);
}

function getString(values: Record<string, unknown>, key: string): string | undefined {
  const v = values[key];
  return typeof v === 'string' ? v : undefined;
}

function getBoolean(values: Record<string, unknown>, key: string): boolean {
  return values[key] === true;
}

function makeClient(values: Record<string, unknown>): Client {
  const { url, token } = resolveAuth({
    url: getString(values, 'url'),
    token: getString(values, 'token'),
  });
  return new Client({ url, token });
}

/**
 * Three-step token resolution: explicit flag → env var → saved
 * auth.json entry for this URL. Used by every verb that needs to
 * authenticate to the broker — including the runner verbs (`csuite
 * claude`, `csuite codex`), so `csuite connect` actually closes the
 * loop and the runner picks up the saved token without touching env
 * vars. Returns `null` for `token` only if the caller explicitly
 * opted out of failing (none currently); the normal path fails the
 * process with a clear message if no source provides a token.
 */
function resolveAuth(input: { url?: string; token?: string }): {
  url: string;
  token: string;
} {
  const url = input.url ?? process.env[ENV.url] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  let token = input.token ?? process.env[ENV.token];
  if (!token) {
    const saved = findAuthEntry(url);
    if (saved) token = saved.token;
  }
  if (!token) {
    fail(`--token or ${ENV.token} is required (or run \`csuite connect\` to enroll this device).`);
  }
  return { url, token };
}

/**
 * Same as `resolveAuth` but runs the device-code `csuite connect` flow
 * inline when no token can be resolved, returning the freshly-minted
 * token instead of failing. Used by the long-running runner verbs
 * (`csuite claude`, `csuite codex`) where the natural UX on first run
 * is "set me up, then start the session" rather than bouncing the
 * operator out to a separate command.
 *
 * Single-use verbs (push, roster, objectives) keep the hard fail —
 * those are typically scripted, and prompting from the middle of a
 * pipeline would be surprising.
 */
async function resolveAuthOrConnect(input: { url?: string; token?: string }): Promise<{
  url: string;
  token: string;
}> {
  const url = input.url ?? process.env[ENV.url] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  let token = input.token ?? process.env[ENV.token];
  if (!token) {
    const saved = findAuthEntry(url);
    if (saved) token = saved.token;
  }
  if (token) return { url, token };

  // No auth for (url, cwd). Headless, the wizard below cannot prompt —
  // it would exit 0 at the URL question (a supervisor with
  // Restart=always then loops it forever) or hang on a device code
  // until it expires (commandsuite#199). Fail like every single-use
  // verb does, and name the whole lookup key: "this directory" hides
  // the URL half, which is the half that bites when a service unit
  // forgets CSUITE_URL and the lookup silently runs against loopback.
  if (!process.stdin.isTTY) {
    fail(
      formatHeadlessNoAuth({
        url,
        cwd: process.cwd(),
        urlDefaulted: input.url === undefined && !process.env[ENV.url],
      }),
    );
  }

  // No auth in this project. Fall through to the device-code flow.
  // Pass `input.url` through (not the resolved fallback) so connect
  // re-runs its own resolution — that way an unset `--url` still
  // triggers connect's own prompt path with the right default.
  process.stdout.write('csuite: no saved auth for this directory — running `csuite connect`...\n');
  try {
    const result = await runConnectCommand(
      input.url !== undefined ? { url: input.url } : {},
      (line) => process.stdout.write(`${line}\n`),
      (line) => process.stderr.write(`${line}\n`),
    );
    return { url: result.url, token: result.token };
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Gather what the runner will authenticate with, for the doctor's
 * `saved auth` check. Mirrors `resolveAuthOrConnect`'s lookup exactly
 * (same URL default, same cwd) so the report and the runner agree.
 */
function savedAuthInput(input: { url?: string; token?: string }): SavedAuthInput {
  const url = input.url ?? process.env[ENV.url] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  const tokenFromEnv = Boolean(input.token ?? process.env[ENV.token]);
  const entry = tokenFromEnv ? null : findAuthEntry(url);
  return {
    url,
    urlDefaulted: input.url === undefined && !process.env[ENV.url],
    cwd: process.cwd(),
    tokenFromEnv,
    entry: entry === null ? null : { workspace: entry.workspace },
    interactive: Boolean(process.stdin.isTTY),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  if (argv[0] === '-v' || argv[0] === '--version') {
    process.stdout.write(`csuite ${CLI_VERSION}\n`);
    return;
  }

  const subcommand = argv[0];
  const rest = argv.slice(1);

  switch (subcommand) {
    case 'setup':
      await handleSetup(rest);
      return;
    case 'member':
      await handleUser(rest);
      return;
    case 'enroll':
      await handleEnroll(rest);
      return;
    case 'connect':
      await handleConnect(rest);
      return;
    case 'auth':
      handleAuth(rest);
      return;
    case 'rotate':
      await handleRotate(rest);
      return;
    case 'quickstart':
      await handleQuickstart(rest);
      return;
    case 'push':
      await handlePush(rest);
      return;
    case 'roster':
      await handleRoster(rest);
      return;
    case 'objectives':
      await handleObjectives(rest);
      return;
    case 'team':
      await handleTeam(rest);
      return;
    case 'tools':
      await handleTools(rest);
      return;
    case 'secrets':
      await handleSecrets(rest);
      return;
    case 'variables':
    case 'vars':
      await handleVariables(rest);
      return;
    case 'notifications':
    case 'hooks':
      await handleNotifications(rest);
      return;
    case 'serve':
      await handleServe(rest);
      return;
    case 'prune-traces':
      await handlePruneTraces(rest);
      return;
    case 'mcp-bridge':
      await handleMcpBridge(rest);
      return;
    case 'claude':
    // Deprecated alias — the verb was `claude` pre-release; kept
    // so existing scripts and muscle memory don't break.
    case 'claude-code':
      await handleClaude(rest);
      return;
    case 'codex':
      await handleCodex(rest);
      return;
    default:
      process.stderr.write(USAGE);
      fail(`unknown subcommand: ${subcommand}`);
  }
}

async function handleSetup(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    'config-path': { type: 'string' },
    config: { type: 'string' },
    'non-interactive': { type: 'boolean' },
    team: { type: 'string' },
    member: { type: 'string' },
    'token-file': { type: 'string' },
    'totp-secret-file': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    await runSetupCommand(
      {
        configPath: getString(values, 'config-path') ?? getString(values, 'config'),
        nonInteractive: values['non-interactive'] === true,
        team: getString(values, 'team'),
        member: getString(values, 'member'),
        tokenFile: getString(values, 'token-file'),
        totpSecretFile: getString(values, 'totp-secret-file'),
      },
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleEnroll(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    member: { type: 'string', short: 'm' },
    url: { type: 'string' },
    token: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    const client = makeClient(values);
    await runEnrollCommand({ member: getString(values, 'member') }, client, (line) => log(line));
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleConnect(args: string[]): Promise<void> {
  // The approver's side lives under the same verb: `connect pending`
  // and `connect approve` are what the device-side `connect` waits on.
  if (args[0] === 'pending' || args[0] === 'approve') {
    await handleConnectApprover(args[0], args.slice(1));
    return;
  }
  const { values } = parseSubcommandArgs(args, {
    url: { type: 'string' },
    label: { type: 'string', short: 'l' },
    'no-write': { type: 'boolean' },
    quiet: { type: 'boolean', short: 'q' },
    'auth-config': { type: 'string' },
    workspace: { type: 'string' },
    global: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  try {
    if (getBoolean(values, 'global') === true && getString(values, 'workspace') !== undefined) {
      throw new UsageError('connect: --global and --workspace are mutually exclusive.');
    }
    await runConnectCommand(
      {
        url: getString(values, 'url'),
        label: getString(values, 'label'),
        noWrite: getBoolean(values, 'no-write'),
        quiet: getBoolean(values, 'quiet'),
        authConfigPath: getString(values, 'auth-config'),
        workspace: getString(values, 'workspace'),
        global: getBoolean(values, 'global'),
      },
      (line) => process.stdout.write(`${line}\n`),
      (line) => process.stderr.write(`${line}\n`),
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleConnectApprover(sub: 'pending' | 'approve', args: string[]): Promise<void> {
  const { values, positionals } = parseSubcommandArgs(args, {
    url: { type: 'string' },
    token: { type: 'string' },
    code: { type: 'string' },
    member: { type: 'string' },
    create: { type: 'boolean' },
    title: { type: 'string' },
    description: { type: 'string' },
    instructions: { type: 'string' },
    permissions: { type: 'string' },
    label: { type: 'string', short: 'l' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  try {
    if (positionals.length > 0) {
      throw new UsageError(`connect ${sub}: unexpected argument '${positionals[0]}'`);
    }
    const client = makeClient(values);
    if (sub === 'pending') {
      await runConnectPendingCommand(client, (line) => log(line));
      return;
    }
    await runConnectApproveCommand(
      {
        code: getString(values, 'code'),
        member: getString(values, 'member'),
        create: getBoolean(values, 'create'),
        title: getString(values, 'title'),
        description: getString(values, 'description'),
        instructions: getString(values, 'instructions'),
        permissions: getString(values, 'permissions'),
        label: getString(values, 'label'),
      },
      client,
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleRotate(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    member: { type: 'string', short: 'm' },
    url: { type: 'string' },
    token: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    const client = makeClient(values);
    await runRotateCommand(
      {
        member: getString(values, 'member'),
      },
      client,
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleUser(args: string[]): Promise<void> {
  // `member` has internal subcommand routing (list/create/update/delete)
  // with flags that differ per-subcommand — parse out the client opts
  // here, then pass everything else through.
  if (args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  const { clientOpts, passthrough } = splitClientOpts(args);
  try {
    const client = makeClient(clientOpts);
    await runMemberCommand(passthrough, client, (line) => log(line));
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handlePruneTraces(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    'older-than': { type: 'string' },
    'activity-db': { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  try {
    await runPruneTracesCommand(
      {
        olderThan: getString(values, 'older-than'),
        activityDbPath: getString(values, 'activity-db'),
        yes: getBoolean(values, 'yes'),
      },
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handlePush(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    agent: { type: 'string', short: 'a' },
    body: { type: 'string', short: 'b' },
    title: { type: 'string', short: 't' },
    level: { type: 'string', short: 'l' },
    broadcast: { type: 'boolean' },
    data: { type: 'string', multiple: true },
    url: { type: 'string' },
    token: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const dataRaw = values.data as string[] | undefined;
  let data: Record<string, unknown> | undefined;
  try {
    data = parseDataFlag(dataRaw);
  } catch (err) {
    fail((err as Error).message);
  }

  const input: PushCommandInput = {
    to: getString(values, 'agent'),
    body: getString(values, 'body') ?? '',
    title: getString(values, 'title'),
    level: getString(values, 'level'),
    broadcast: getBoolean(values, 'broadcast'),
    data,
  };

  try {
    const client = makeClient(values);
    const output = await runPushCommand(input, client);
    log(output);
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleQuickstart(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    url: { type: 'string' },
    token: { type: 'string' },
    'skip-browser': { type: 'boolean' },
    assignee: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    const client = makeClient(values);
    const url =
      getString(values, 'url') ?? process.env[ENV.url] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
    const token = getString(values, 'token') ?? process.env[ENV.token] ?? '';
    await runQuickstartCommand(
      {
        url,
        token,
        skipBrowser: getBoolean(values, 'skip-browser'),
        assignee: getString(values, 'assignee'),
      },
      client,
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof QuickstartError) fail(err.message);
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleRoster(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    url: { type: 'string' },
    token: { type: 'string' },
    'reveal-token': { type: 'boolean' },
    member: { type: 'string', short: 'm' },
    'config-path': { type: 'string' },
    config: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  // `--reveal-token` is an alias over `csuite rotate --member X`: the only
  // honest way to surface a member's bearer plaintext is to mint a fresh
  // one, since hash-on-disk (I1 posture) means the existing plaintext
  // was never persisted. Invoking this command therefore has a visible
  // side effect — the previous token is invalidated. We disclose that
  // up front so it's impossible to miss, then delegate to the exact
  // same code path `csuite rotate` uses.
  if (getBoolean(values, 'reveal-token')) {
    const member = getString(values, 'member');
    if (!member) {
      fail('roster --reveal-token: --member <name> is required', 2);
    }
    log('');
    log(`csuite roster --reveal-token → rotating '${member}' token.`);
    log('  (csuite never persists token plaintext; the only honest "reveal"');
    log('   is to mint a fresh token and print it once. This invalidates');
    log('   any previous token for this member.)');
    const rotateInput: RotateCommandInput = { member };
    try {
      const client = makeClient(values);
      await runRotateCommand(rotateInput, client, (line) => log(line));
    } catch (err) {
      if (err instanceof UsageError) fail(err.message, 2);
      fail(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  try {
    const client = makeClient(values);
    const output = await runRosterCommand(client);
    log(output);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleServe(args: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(args, {
    'config-path': { type: 'string' },
    config: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    db: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const portStr = getString(values, 'port');
  let port: number | undefined;
  if (portStr !== undefined) {
    const parsed = Number(portStr);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 65_535) {
      fail(`invalid --port: ${portStr}`, 2);
    }
    port = parsed;
  }

  let running: Awaited<ReturnType<typeof runServeCommand>> | null = null;
  try {
    running = await runServeCommand(
      {
        configPath: getString(values, 'config-path') ?? getString(values, 'config'),
        port,
        host: getString(values, 'host'),
        dbPath: getString(values, 'db'),
      },
      (line) => log(line),
    );
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }

  const shutdown = async (signal: NodeJS.Signals) => {
    process.stderr.write(`\ncsuite serve: stopping (${signal})...\n`);
    await running?.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function handleObjectives(args: string[]): Promise<void> {
  // Objectives has its own internal subcommand routing that parses
  // flags per-subcommand. We still pull `--url` / `--token` out of
  // argv here so `csuite objectives list --url http://...` works the
  // same way the other subcommands do.
  //
  // Strategy: extract --url and --token pairs from argv, passing the
  // rest through to runObjectivesCommand. parseArgs would reject
  // unknown options, so we do this by hand with a tight loop.
  const clientOpts: Record<string, string> = {};
  const passthrough: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return;
    }
    if (arg === '--url' || arg === '--token') {
      const next = args[i + 1];
      if (next === undefined) {
        fail(`${arg} requires a value`, 2);
      }
      clientOpts[arg.slice(2)] = next as string;
      i++;
      continue;
    }
    if (arg === undefined) continue;
    passthrough.push(arg);
  }

  try {
    const client = makeClient(clientOpts);
    const output = await runObjectivesCommand(client, passthrough);
    log(output);
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Split off `--url` / `--token` for `makeClient`, pass everything else
 * through to the subcommand. Same pattern as `handleObjectives`.
 */
function splitClientOpts(args: string[]): {
  clientOpts: Record<string, string>;
  passthrough: string[];
} {
  const clientOpts: Record<string, string> = {};
  const passthrough: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--url' || arg === '--token') {
      const next = args[i + 1];
      if (next === undefined) fail(`${arg} requires a value`, 2);
      clientOpts[arg.slice(2)] = next as string;
      i++;
      continue;
    }
    if (arg === undefined) continue;
    passthrough.push(arg);
  }
  return { clientOpts, passthrough };
}

async function handleTeam(args: string[]): Promise<void> {
  const { clientOpts, passthrough } = splitClientOpts(args);
  try {
    const client = makeClient(clientOpts);
    await runTeamCommand(passthrough, client, (line) => log(line));
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleTools(args: string[]): Promise<void> {
  const { clientOpts, passthrough } = splitClientOpts(args);
  try {
    const client = makeClient(clientOpts);
    await runToolsCommand(passthrough, client, (line) => log(line));
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleSecrets(args: string[]): Promise<void> {
  const { clientOpts, passthrough } = splitClientOpts(args);
  try {
    const client = makeClient(clientOpts);
    await runSecretsCommand(passthrough, client, (line) => log(line));
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleVariables(args: string[]): Promise<void> {
  const { clientOpts, passthrough } = splitClientOpts(args);
  try {
    const client = makeClient(clientOpts);
    await runVariablesCommand(passthrough, client, (line) => log(line));
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleNotifications(args: string[]): Promise<void> {
  const { clientOpts, passthrough } = splitClientOpts(args);
  try {
    const client = makeClient(clientOpts);
    await runNotificationsCommand(passthrough, client, (line) => log(line));
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * `csuite auth` — local auth-store inspection and maintenance. No broker
 * client and no auth resolution: this verb's whole job is to explain the
 * file that auth resolution reads, so it has to work when that file is
 * missing, stale, or holds a token for a broker that is down.
 */
function handleAuth(args: string[]): void {
  const [subcommand, ...rest] = args;
  const { values } = parseSubcommandArgs(rest, {
    'auth-config': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  try {
    const code = runAuthCommand(
      subcommand,
      { authConfigPath: getString(values, 'auth-config') },
      (line) => process.stdout.write(`${line}\n`),
      (line) => process.stderr.write(`${line}\n`),
    );
    if (code !== 0) process.exit(code);
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * `csuite claude` — run Claude Code headlessly (via the Claude Agent
 * SDK) as a csuite team member.
 *
 * No interactive TUI: the agent runs as an SDK-driven stream-json
 * subprocess under our control. The invoking member communicates with the
 * agent through the broker (chat / DMs / objectives / `csuite push`);
 * channel events arrive as streaming-input user messages.
 *
 * Arg handling: `--url` and `--token` are csuite knobs; `--no-trace`,
 * `--cwd`, `--model`, and `--resume` are runner knobs. There is no
 * pass-through tail — the agent invocation is composed by the SDK, so
 * unrecognized args are an error rather than silently forwarded.
 */
async function handleClaude(args: string[]): Promise<void> {
  let url: string | undefined;
  let token: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let resume: string | true | undefined;
  let noTrace = false;
  let noSecrets = false;
  let doctor = false;
  let skipDoctor = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return;
    }
    if (arg === '--no-trace') {
      noTrace = true;
      continue;
    }
    if (arg === '--no-secrets') {
      noSecrets = true;
      continue;
    }
    if (arg === '--doctor') {
      doctor = true;
      continue;
    }
    if (arg === '--skip-doctor') {
      skipDoctor = true;
      continue;
    }
    if (arg === '--resume') {
      // Optional value: `--resume <sessionId>` resumes that session,
      // bare `--resume` continues the member's most recent session in
      // the cwd. A following flag is NOT the value.
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        resume = next;
        i++;
      } else {
        resume = true;
      }
      continue;
    }
    if (arg === '--url' || arg === '--token' || arg === '--cwd' || arg === '--model') {
      const next = args[i + 1];
      if (next === undefined) {
        fail(`${arg} requires a value`, 2);
      }
      switch (arg) {
        case '--url':
          url = next as string;
          break;
        case '--token':
          token = next as string;
          break;
        case '--cwd':
          cwd = next as string;
          break;
        case '--model':
          model = next as string;
          break;
      }
      i++;
      continue;
    }
    // The old CLI wrapper forwarded unknown args to the claude TUI;
    // the SDK runner composes the agent invocation itself, so an
    // unknown arg is a mistake worth stopping on.
    fail(
      `csuite claude: unknown argument ${arg} (the TUI pass-through was removed; supported: --model, --resume, --cwd, --no-trace, --no-secrets, --doctor, --skip-doctor)`,
      2,
    );
  }

  // Explicit `--doctor` is the "run doctor, print the full report, exit"
  // mode. Unchanged.
  if (doctor) {
    const report = await runAgentDoctor(createClaudeAdapter({}), {
      auth: savedAuthInput({ url, token }),
    });
    log(formatReport(report));
    process.exit(report.anyFail ? 1 : 0);
  }

  // Default preflight: run doctor silently before spawning claude so a
  // broken environment surfaces as a readable report instead of a
  // cryptic runtime error three seconds into the session. `--skip-doctor`
  // opts out for members who know the environment is fine (CI,
  // scripted reruns, etc.). WARNs are advisory — we proceed. Only FAILs
  // abort, and when they do we dump the full report so the member can
  // see which check tripped. The version probe is skipped here — it
  // spawns the agent binary and would tax every session start; the
  // explicit `--doctor` mode includes it.
  if (!skipDoctor) {
    const report = await runAgentDoctor(createClaudeAdapter({}), {
      includeVersion: false,
      auth: savedAuthInput({ url, token }),
    });
    if (report.anyFail) {
      process.stderr.write(formatReport(report));
      process.stderr.write(
        `\ncsuite claude: preflight FAILED — fix the above or pass --skip-doctor to bypass\n`,
      );
      process.exit(1);
    }
  }

  try {
    const resolved = await resolveAuthOrConnect({ url, token });
    const code = await runClaudeCommand({
      url: resolved.url,
      token: resolved.token,
      cwd,
      model,
      resume,
      noTrace,
      noSecrets,
    });
    process.exit(code);
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * `csuite codex` — spawn OpenAI Codex CLI as a headless team member.
 *
 * No interactive TUI: codex runs as `codex app-server` (a JSON-RPC
 * daemon) under our control. The invoking member communicates with the
 * agent through the broker (chat / DMs / objectives / `csuite push`).
 * Channel events arrive at codex as `turn/start` (when idle) or
 * `turn/steer` (mid-turn) — the structural equivalent of claude's
 * streaming-input injection.
 *
 * Arg handling: `--url` and `--token` are csuite knobs; `--no-trace`,
 * `--cwd`, `--model`, and `--resume` are runner knobs. Everything after
 * a literal `--` is forwarded verbatim to `codex app-server`.
 * Unrecognized args before `--` also fall through to codex (same
 * pattern as claude).
 *
 * Use codex's own -c key=value syntax to override config.toml entries:
 *   csuite codex -- -c 'model_provider="qwen"' \
 *               -c 'model_providers.qwen.base_url="http://localhost:8000/v1"'
 */
async function handleCodex(args: string[]): Promise<void> {
  let url: string | undefined;
  let token: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let resume: string | true | undefined;
  let noTrace = false;
  let noSecrets = false;
  let doctor = false;
  let skipDoctor = false;
  const codexArgs: string[] = [];
  let seenDashDash = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (seenDashDash) {
      codexArgs.push(arg);
      continue;
    }
    if (arg === '--') {
      seenDashDash = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return;
    }
    if (arg === '--no-trace') {
      noTrace = true;
      continue;
    }
    if (arg === '--no-secrets') {
      noSecrets = true;
      continue;
    }
    if (arg === '--doctor') {
      doctor = true;
      continue;
    }
    if (arg === '--skip-doctor') {
      skipDoctor = true;
      continue;
    }
    if (arg === '--resume') {
      // Optional value: `--resume <threadId>` resumes that thread,
      // bare `--resume` resumes the member's most recent one. A
      // following flag (or `--`) is NOT the value.
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        resume = next;
        i++;
      } else {
        resume = true;
      }
      continue;
    }
    if (arg === '--url' || arg === '--token' || arg === '--cwd' || arg === '--model') {
      const next = args[i + 1];
      if (next === undefined) {
        fail(`${arg} requires a value`, 2);
      }
      switch (arg) {
        case '--url':
          url = next as string;
          break;
        case '--token':
          token = next as string;
          break;
        case '--cwd':
          cwd = next as string;
          break;
        case '--model':
          model = next as string;
          break;
      }
      i++;
      continue;
    }
    // Anything unrecognized falls through to codex — same pattern as
    // handleClaude. This lets `csuite codex -c 'key=value'` work the
    // same as `csuite codex -- -c 'key=value'`.
    codexArgs.push(arg);
  }

  // Explicit `--doctor`: run the full preflight report (version probe
  // included) and exit — mirrors `csuite claude --doctor`.
  if (doctor) {
    const report = await runAgentDoctor(createCodexAdapter({}), {
      auth: savedAuthInput({ url, token }),
    });
    log(formatReport(report));
    process.exit(report.anyFail ? 1 : 0);
  }

  // Default silent preflight, same contract as claude: only FAILs
  // abort (with the full report); WARNs proceed; `--skip-doctor` opts
  // out; the version probe is skipped for startup latency.
  if (!skipDoctor) {
    const report = await runAgentDoctor(createCodexAdapter({}), {
      includeVersion: false,
      auth: savedAuthInput({ url, token }),
    });
    if (report.anyFail) {
      process.stderr.write(formatReport(report));
      process.stderr.write(
        `\ncsuite codex: preflight FAILED — fix the above or pass --skip-doctor to bypass\n`,
      );
      process.exit(1);
    }
  }

  try {
    const resolved = await resolveAuthOrConnect({ url, token });
    const code = await runCodexCommand({
      url: resolved.url,
      token: resolved.token,
      cwd,
      model,
      resume,
      noTrace,
      noSecrets,
      codexArgs: codexArgs.length > 0 ? codexArgs : undefined,
    });
    process.exit(code);
  } catch (err) {
    if (err instanceof UsageError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * `csuite mcp-bridge` — internal verb spawned by agents as their
 * `csuite` MCP server.
 *
 * Hidden from the top-level `--help` usage because members never
 * invoke it directly; each runner injects the MCP server entry that
 * points here (SDK options for claude, config.toml for codex). If a
 * member does run it by hand, the bridge will immediately error out
 * with "CSUITE_RUNNER_SOCKET is required" which is the closest thing
 * we can give them to a useful message.
 */
async function handleMcpBridge(_args: string[]): Promise<void> {
  // The bridge ignores args entirely — it reads config only from
  // env vars (`CSUITE_RUNNER_SOCKET`) and stdio. The `_args` param is
  // kept to match the subcommand handler shape.
  const bridgeModule = await import('./runtime/bridge.js');
  try {
    await bridgeModule.runBridge();
  } catch (err) {
    if (err instanceof bridgeModule.BridgeStartupError) {
      process.stderr.write(`csuite mcp-bridge: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
