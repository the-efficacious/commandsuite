/**
 * `csuite secrets` — manage broker-held environment secrets.
 *
 * Each secret maps an immutable slug to a target environment
 * variable; the runner resolves the secrets bound to its member and
 * injects them into the agent child's env at spawn. Values are
 * write-only: set here, KEK-encrypted at rest, and never returned by
 * any endpoint — this command must not print one either. Registry
 * mutations require `secrets.manage`; delivery = enabled &&
 * (allMembers || bound), the same rule as tool sources.
 *
 * Subcommands:
 *   csuite secrets list         [--json]
 *   csuite secrets view         <slug> [--json]
 *   csuite secrets add          <slug> --env <ENV_NAME> [--description <text>]
 *                               [--all-members] [--disabled]
 *   csuite secrets update       <slug> [--env <ENV_NAME>] [--description <text>]
 *                               [--all-members true|false] [--enabled true|false]
 *   csuite secrets set-value    <slug> [--value <value>]
 *   csuite secrets delete-value <slug>
 *   csuite secrets bind         <slug> <member...> / unbind <slug> <member...>
 *   csuite secrets rm           <slug>
 *
 * `set-value` without `--value` reads the value from stdin: a hidden
 * prompt on a TTY, or the whole stream when piped (so
 * `cat token.txt | csuite secrets set-value gh` works).
 */

import { parseArgs } from 'node:util';
import type { Client } from 'csuite-sdk/client';
import type { SecretSummary } from 'csuite-sdk/types';
import { UsageError } from './errors.js';

export async function runSecretsCommand(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '-h' || sub === '--help') {
    throw new UsageError(
      'secrets subcommand required. Use: list | view | add | update | set-value | delete-value | bind | unbind | rm',
    );
  }
  switch (sub) {
    case 'list':
      await runList(rest, client, stdout);
      return;
    case 'view':
    case 'show':
      await runView(rest, client, stdout);
      return;
    case 'add':
    case 'create':
      await runAdd(rest, client, stdout);
      return;
    case 'update':
      await runUpdate(rest, client, stdout);
      return;
    case 'set-value':
      await runSetValue(rest, client, stdout);
      return;
    case 'delete-value':
      await runDeleteValue(rest, client, stdout);
      return;
    case 'bind':
      await runBind(true, rest, client, stdout);
      return;
    case 'unbind':
      await runBind(false, rest, client, stdout);
      return;
    case 'rm':
    case 'remove':
    case 'delete':
      await runRm(rest, client, stdout);
      return;
    default:
      throw new UsageError(`unknown secrets subcommand: ${sub}`);
  }
}

function requireSlug(positionals: string[]): string {
  const slug = positionals[0];
  if (!slug) throw new UsageError('a secret slug is required');
  return slug;
}

/** Parse a `--flag true|false` string option; parseArgs booleans can't take a value. */
function parseBoolFlag(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new UsageError(`--${name} takes true or false`);
}

function formatSecretLine(s: SecretSummary): string {
  const flags = [
    s.enabled ? null : 'disabled',
    s.allMembers ? 'all-members' : null,
    s.hasValue ? 'value' : 'no-value',
  ]
    .filter(Boolean)
    .join(', ');
  return `- ${s.slug}  env=${s.envName}  (${flags})`;
}

async function runList(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { json: { type: 'boolean' } },
    allowPositionals: false,
  });
  const secrets = await client.listSecrets();
  if (values.json) {
    stdout(JSON.stringify(secrets, null, 2));
    return;
  }
  if (secrets.length === 0) {
    stdout('(no secrets registered)');
    return;
  }
  for (const s of secrets) stdout(formatSecretLine(s));
}

async function runView(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: 'boolean' } },
    allowPositionals: true,
  });
  const slug = requireSlug(positionals);
  const detail = await client.getSecret(slug);
  if (values.json) {
    stdout(JSON.stringify(detail, null, 2));
    return;
  }
  stdout(formatSecretLine(detail.secret));
  if (detail.secret.description) {
    stdout(`  description: ${detail.secret.description}`);
  }
  if (detail.boundMembers !== undefined) {
    stdout(
      detail.boundMembers.length > 0
        ? `  bound: ${detail.boundMembers.join(', ')}`
        : '  bound: (none)',
    );
  }
}

async function runAdd(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      env: { type: 'string' },
      description: { type: 'string' },
      'all-members': { type: 'boolean' },
      disabled: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const slug = requireSlug(positionals);
  if (!values.env) {
    throw new UsageError('--env <ENV_NAME> is required');
  }
  const secret = await client.createSecret({
    slug,
    envName: values.env,
    ...(values.description !== undefined ? { description: values.description } : {}),
    ...(values['all-members'] ? { allMembers: true } : {}),
    ...(values.disabled ? { enabled: false } : {}),
  });
  stdout(`registered secret '${secret.slug}' (env ${secret.envName})`);
  stdout(`next: csuite secrets set-value ${slug}`);
  if (!values['all-members']) {
    stdout(`      csuite secrets bind ${slug} <member>`);
  }
}

async function runUpdate(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      env: { type: 'string' },
      description: { type: 'string' },
      'all-members': { type: 'string' },
      enabled: { type: 'string' },
    },
    allowPositionals: true,
  });
  const slug = requireSlug(positionals);
  const allMembers = parseBoolFlag('all-members', values['all-members']);
  const enabled = parseBoolFlag('enabled', values.enabled);
  const patch = {
    ...(values.env !== undefined ? { envName: values.env } : {}),
    ...(values.description !== undefined ? { description: values.description } : {}),
    ...(allMembers !== undefined ? { allMembers } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };
  if (Object.keys(patch).length === 0) {
    throw new UsageError(
      'nothing to update — pass --env, --description, --all-members, or --enabled',
    );
  }
  const secret = await client.updateSecret(slug, patch);
  stdout(`updated secret '${secret.slug}' (env ${secret.envName})`);
}

async function runSetValue(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { value: { type: 'string' } },
    allowPositionals: true,
  });
  const slug = requireSlug(positionals);
  let value = values.value;
  if (value === undefined) {
    value = process.stdin.isTTY
      ? await promptHidden(`value for '${slug}' (input hidden): `)
      : await readStdinValue();
  }
  if (!value) {
    throw new UsageError('a non-empty value is required (--value, hidden prompt, or piped stdin)');
  }
  await client.setSecretValue(slug, { value });
  stdout(`value set for '${slug}'. The value is write-only from here.`);
}

async function runDeleteValue(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const slug = requireSlug(positionals);
  await client.deleteSecretValue(slug);
  stdout(`value removed from '${slug}'`);
}

async function runBind(
  bind: boolean,
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const [slug, ...memberNames] = positionals;
  if (!slug) throw new UsageError('a secret slug is required');
  if (memberNames.length === 0) {
    throw new UsageError(`at least one member name is required to ${bind ? 'bind' : 'unbind'}`);
  }
  for (const member of memberNames) {
    if (bind) {
      await client.bindSecret(slug, { member });
      stdout(`bound ${member} to '${slug}'`);
    } else {
      await client.unbindSecret(slug, member);
      stdout(`unbound ${member} from '${slug}'`);
    }
  }
}

async function runRm(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const slug = requireSlug(positionals);
  await client.deleteSecret(slug);
  stdout(`deleted secret '${slug}' (bindings and stored value removed)`);
}

/**
 * Prompt on the TTY with echo disabled. readline still needs an
 * output stream for the prompt text and cursor handling, so we hand
 * it one that swallows writes once the question has been printed —
 * keystrokes (and the terminating Enter) never reach the terminal.
 * Dynamic imports keep the cold-start cost off every other verb,
 * same as the prompts in connect.ts / prune-traces.ts.
 */
async function promptHidden(question: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  const { Writable } = await import('node:stream');
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer));
      // question() writes its prompt synchronously; everything after
      // this point is the member typing the value.
      muted = true;
    });
  } finally {
    rl.close();
    // The muted Enter never echoed a newline.
    process.stdout.write('\n');
  }
}

/**
 * Read the whole piped stdin as the value, stripping exactly one
 * trailing newline so `cat token.txt | ...` and `echo token | ...`
 * store the token itself, not the shell's line terminator. Interior
 * newlines are preserved — multi-line values (PEM keys) pass through.
 */
async function readStdinValue(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}
