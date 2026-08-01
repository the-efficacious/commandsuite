/**
 * `csuite variables` — manage broker-held runner environment variables
 * that are NOT secrets.
 *
 * Same lifecycle as `csuite secrets`: an immutable slug maps to a
 * target environment variable, the runner resolves the set bound to
 * its member and injects them into the agent child's env at spawn, and
 * every mutation requires `secrets.manage`.
 *
 * Two differences, and they are the reason this command exists:
 *
 *   - The VALUE IS READABLE. `list` and `view` print it for a caller
 *     holding `secrets.manage`. An operator who cannot read back a git
 *     author name cannot check that it is the right one.
 *   - The value is NEVER registered with the trace redactor, so it
 *     appears verbatim in captured traces. Storing a published value
 *     as a secret is what made members' own names vanish from their
 *     own traces.
 *
 * Use a secret for anything confidential. Use a variable for values
 * that are already public — git identity is the motivating case, and
 * `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_NAME` /
 * `GIT_COMMITTER_EMAIL` migrate here automatically at broker start.
 *
 * Subcommands:
 *   csuite variables list         [--json]
 *   csuite variables view         <slug> [--json]
 *   csuite variables add          <slug> --env <ENV_NAME> [--description <text>]
 *                                 [--all-members] [--disabled]
 *   csuite variables update       <slug> [--env <ENV_NAME>] [--description <text>]
 *                                 [--all-members true|false] [--enabled true|false]
 *   csuite variables set-value    <slug> --value <value>
 *   csuite variables delete-value <slug>
 *   csuite variables bind         <slug> <member...> / unbind <slug> <member...>
 *   csuite variables rm           <slug>
 *
 * `set-value` also accepts a piped stdin value. There is no hidden
 * prompt: hiding the input of a value this command will happily print
 * back would be theatre.
 */

import { parseArgs } from 'node:util';
import type { Client } from 'csuite-sdk/client';
import type { VariableSummary } from 'csuite-sdk/types';
import { UsageError } from './errors.js';

export async function runVariablesCommand(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '-h' || sub === '--help') {
    throw new UsageError(
      'variables subcommand required. Use: list | view | add | update | set-value | delete-value | bind | unbind | rm',
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
      throw new UsageError(`unknown variables subcommand: ${sub}`);
  }
}

function requireSlug(positionals: string[]): string {
  const slug = positionals[0];
  if (!slug) throw new UsageError('a variable slug is required');
  return slug;
}

/** Parse a `--flag true|false` string option; parseArgs booleans can't take a value. */
function parseBoolFlag(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new UsageError(`--${name} takes true or false`);
}

function formatVariableLine(v: VariableSummary): string {
  const flags = [v.enabled ? null : 'disabled', v.allMembers ? 'all-members' : null]
    .filter(Boolean)
    .join(', ');
  // The value is the point of this surface — show it when the caller
  // is allowed to see it, and say which of "unset" and "not visible to
  // you" applies when it is absent.
  const shown =
    v.value !== undefined ? `= ${v.value}` : v.hasValue ? '(value hidden)' : '(no value)';
  const suffix = flags.length > 0 ? `  (${flags})` : '';
  return `- ${v.slug}  ${v.envName} ${shown}${suffix}`;
}

async function runList(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
  const variables = await client.listVariables();
  if (values.json) {
    stdout(JSON.stringify(variables, null, 2));
    return;
  }
  if (variables.length === 0) {
    stdout('no variables registered');
    stdout('add one with: csuite variables add <slug> --env <ENV_NAME>');
    return;
  }
  for (const v of variables) stdout(formatVariableLine(v));
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
  const result = await client.getVariable(slug);
  if (values.json) {
    stdout(JSON.stringify(result, null, 2));
    return;
  }
  const v = result.variable;
  stdout(`${v.slug}  ${v.envName}`);
  if (v.description) stdout(`  ${v.description}`);
  stdout(`  value:       ${v.value !== undefined ? v.value : v.hasValue ? '(hidden)' : '(unset)'}`);
  stdout(`  enabled:     ${v.enabled}`);
  stdout(`  all members: ${v.allMembers}`);
  if (result.boundMembers) {
    stdout(
      `  bound:       ${result.boundMembers.length > 0 ? result.boundMembers.join(', ') : '(none)'}`,
    );
  }
  stdout('  redaction:   never registered — appears verbatim in captured traces');
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
  const variable = await client.createVariable({
    slug,
    envName: values.env,
    ...(values.description !== undefined ? { description: values.description } : {}),
    ...(values['all-members'] ? { allMembers: true } : {}),
    ...(values.disabled ? { enabled: false } : {}),
  });
  stdout(`registered variable '${variable.slug}' (env ${variable.envName})`);
  stdout('this value is NOT a secret and is not redacted from traces');
  stdout(`next: csuite variables set-value ${slug} --value <value>`);
  if (!values['all-members']) {
    stdout(`      csuite variables bind ${slug} <member>`);
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
  const variable = await client.updateVariable(slug, patch);
  stdout(`updated variable '${variable.slug}' (env ${variable.envName})`);
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
  const value = values.value ?? (await readStdinValue());
  if (!value) {
    throw new UsageError('a non-empty value is required (--value or piped stdin)');
  }
  await client.setVariableValue(slug, { value });
  stdout(`value set for '${slug}'. It is readable, and it is not redacted from traces.`);
}

async function runDeleteValue(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const slug = requireSlug(positionals);
  await client.deleteVariableValue(slug);
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
  if (!slug) throw new UsageError('a variable slug is required');
  if (memberNames.length === 0) {
    throw new UsageError(`at least one member name is required to ${bind ? 'bind' : 'unbind'}`);
  }
  for (const member of memberNames) {
    if (bind) {
      await client.bindVariable(slug, { member });
      stdout(`bound ${member} to '${slug}'`);
    } else {
      await client.unbindVariable(slug, member);
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
  await client.deleteVariable(slug);
  stdout(`deleted variable '${slug}' (bindings and stored value removed)`);
}

/** Read the whole stdin stream as the value, trailing newline trimmed. */
async function readStdinValue(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}
