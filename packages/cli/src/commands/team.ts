/**
 * `csuite team` — read or update the team config.
 *
 * Subcommands:
 *   csuite team get
 *   csuite team set [--name <n>] [--context <c>] [--context-file <path>]
 *
 * Talks to the running broker via the HTTP API. Mutations require
 * the calling member to have `team.manage`. Changes apply
 * immediately on the server side; agents already in an MCP session
 * still need a runner restart to pick up changes that flow into the
 * MCP `instructions` string (team context), since that string is
 * frozen for the lifetime of a session by the MCP protocol.
 */

import { parseArgs } from 'node:util';
import type { Client } from 'csuite-sdk/client';
import { UsageError } from './errors.js';

export async function runTeamCommand(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '-h' || sub === '--help') {
    throw new UsageError('team subcommand required. Use: get | set');
  }
  switch (sub) {
    case 'get':
      await runGet(rest, client, stdout);
      return;
    case 'set':
    case 'update':
      await runSet(rest, client, stdout);
      return;
    default:
      throw new UsageError(`unknown team subcommand: ${sub}`);
  }
}

async function runGet(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { json: { type: 'boolean' } },
    allowPositionals: false,
  });
  const team = await client.getTeam();
  if (values.json) {
    stdout(JSON.stringify(team, null, 2));
    return;
  }
  stdout(`name      ${team.name}`);
  stdout('context');
  if (team.context.trim().length === 0) {
    stdout('  (none)');
  } else {
    for (const line of team.context.split('\n')) stdout(`  ${line}`);
  }
  const presetNames = Object.keys(team.permissionPresets);
  stdout(`presets   ${presetNames.length === 0 ? '(none)' : presetNames.join(', ')}`);
}

async function runSet(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      context: { type: 'string' },
      'context-file': { type: 'string' },
    },
    allowPositionals: false,
  });
  const patch: { name?: string; context?: string } = {};
  if (typeof values.name === 'string') patch.name = values.name;
  if (typeof values.context === 'string') patch.context = values.context;
  if (typeof values['context-file'] === 'string') {
    const { readFileSync } = await import('node:fs');
    patch.context = readFileSync(values['context-file'], 'utf8');
  }
  if (Object.keys(patch).length === 0) {
    throw new UsageError('team set requires at least one of --name, --context, --context-file');
  }
  const team = await client.updateTeam(patch);
  stdout(`updated team '${team.name}'`);
  stdout(`  fields: ${Object.keys(patch).join(', ')}`);
}
