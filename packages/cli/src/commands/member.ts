/**
 * `csuite member` — manage team members via the running broker.
 *
 * Subcommands:
 *   csuite member list
 *   csuite member create --name <n> --title <t> [--description <d>] [--instructions <i>]
 *                     [--permissions <preset|leaf,...>]
 *   csuite member update --name <n> [--title <t>] [--description <d>] [--instructions <i>]
 *                     [--permissions <preset|leaf,...>]
 *   csuite member delete --name <n>
 *
 * All operations go through the HTTP API (`/members` endpoints), so the
 * broker must be running. Mutations require `members.manage`. The
 * "last admin" invariant is enforced server-side.
 *
 * `create` prints the bearer token exactly once. To enable web UI
 * login, run `csuite enroll --user <name>` afterwards.
 */

import { parseArgs } from 'node:util';
import type { Client } from 'csuite-sdk/client';
import { UsageError } from './errors.js';

const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

export async function runMemberCommand(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '-h' || sub === '--help') {
    throw new UsageError('member subcommand required. Use: list | create | update | delete');
  }
  switch (sub) {
    case 'list':
      await runList(rest, client, stdout);
      return;
    case 'create':
      await runCreate(rest, client, stdout);
      return;
    case 'update':
      await runUpdate(rest, client, stdout);
      return;
    case 'delete':
    case 'remove':
      await runDelete(rest, client, stdout);
      return;
    default:
      throw new UsageError(`unknown member subcommand: ${sub}`);
  }
}

async function runList(
  _args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const all = await client.listMembers();
  if (all.length === 0) {
    stdout('(no members)');
    return;
  }
  stdout(`${'name'.padEnd(20)}${'role'.padEnd(18)}permissions`);
  for (const m of all) {
    const perms = m.permissions.length === 0 ? 'baseline' : m.permissions.join(',');
    stdout(`${m.name.padEnd(20)}${m.role.title.padEnd(18)}${perms}`);
  }
}

async function runCreate(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      instructions: { type: 'string' },
      permissions: { type: 'string' },
    },
    allowPositionals: false,
  });
  const name = stringOrUndef(values.name);
  const title = stringOrUndef(values.title);
  const description = stringOrUndef(values.description) ?? '';
  const instructions = stringOrUndef(values.instructions) ?? '';
  const permsRaw = stringOrUndef(values.permissions);

  if (!name) throw new UsageError('member create: --name <name> is required');
  if (!NAME_REGEX.test(name)) {
    throw new UsageError(
      `member create: invalid --name '${name}' (must be alphanumeric with . _ - allowed)`,
    );
  }
  if (!title) throw new UsageError('member create: --title <role-title> is required');

  const permissions = permsRaw
    ? permsRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  const result = await client.createMember({
    name,
    role: { title, description },
    instructions,
    permissions,
  });

  stdout('');
  stdout(
    `✓ created member '${result.member.name}' (role=${title}, permissions=${permissions.join(',') || 'baseline'})`,
  );
  stdout('');
  stdout('  ┌─ BEARER TOKEN — save this now; it is not persisted anywhere else ─┐');
  stdout(`  │ ${result.token}`);
  stdout('  └────────────────────────────────────────────────────────────────────┘');
  stdout('');
  stdout(`  To enable web UI login, run: csuite enroll --user ${name}`);
  stdout('');
}

async function runUpdate(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      instructions: { type: 'string' },
      permissions: { type: 'string' },
    },
    allowPositionals: false,
  });
  const name = stringOrUndef(values.name);
  const title = stringOrUndef(values.title);
  const description = stringOrUndef(values.description);
  const instructions = stringOrUndef(values.instructions);
  const permsRaw = stringOrUndef(values.permissions);

  if (!name) throw new UsageError('member update: --name <name> is required');
  if (
    title === undefined &&
    description === undefined &&
    instructions === undefined &&
    permsRaw === undefined
  ) {
    throw new UsageError(
      'member update: at least one of --title, --description, --instructions, --permissions is required',
    );
  }

  const patch: {
    role?: { title: string; description: string };
    instructions?: string;
    permissions?: string[];
  } = {};
  if (title !== undefined || description !== undefined) {
    // The server merges role atomically, so we pass whichever fields
    // the operator supplied; missing values are filled in by the
    // server from the current row.
    patch.role = {
      title: title ?? '',
      description: description ?? '',
    };
  }
  if (instructions !== undefined) patch.instructions = instructions;
  if (permsRaw !== undefined) {
    patch.permissions = permsRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  await client.updateMember(name, patch);
  stdout(`✓ updated member '${name}'`);
}

async function runDelete(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { name: { type: 'string' } },
    allowPositionals: false,
  });
  const name = stringOrUndef(values.name);
  if (!name) throw new UsageError('member delete: --name <name> is required');

  await client.deleteMember(name);
  stdout(`✓ deleted member '${name}'`);
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
