/**
 * `csuite presets` — list, set, and delete permission presets.
 *
 * Subcommands:
 *   csuite presets list
 *   csuite presets set    --name <n> --permissions <leaf,leaf,…>
 *   csuite presets delete --name <n>
 *
 * Presets are referenced by members in their raw permission list. A
 * change here re-resolves all members on the next read — no admin
 * sweep is required. Mutations require `team.manage`.
 */

import { parseArgs } from 'node:util';
import type { Client } from 'csuite-sdk/client';
import type { Permission } from 'csuite-sdk/types';
import { PERMISSIONS } from 'csuite-sdk/types';
import { UsageError } from './errors.js';

export async function runPresetsCommand(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '-h' || sub === '--help') {
    throw new UsageError('presets subcommand required. Use: list | set | delete');
  }
  switch (sub) {
    case 'list':
      await runList(rest, client, stdout);
      return;
    case 'set':
    case 'put':
      await runSet(rest, client, stdout);
      return;
    case 'delete':
    case 'remove':
    case 'rm':
      await runDelete(rest, client, stdout);
      return;
    default:
      throw new UsageError(`unknown presets subcommand: ${sub}`);
  }
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
  const presets = await client.listPresets();
  if (values.json) {
    stdout(JSON.stringify(presets, null, 2));
    return;
  }
  const entries = Object.entries(presets);
  if (entries.length === 0) {
    stdout('(no presets)');
    return;
  }
  const widest = entries.reduce((m, [n]) => Math.max(m, n.length), 0);
  for (const [name, leaves] of entries) {
    stdout(`${name.padEnd(widest)}  ${leaves.join(', ')}`);
  }
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
      permissions: { type: 'string' },
    },
    allowPositionals: false,
  });
  const name = typeof values.name === 'string' ? values.name : null;
  const permsRaw = typeof values.permissions === 'string' ? values.permissions : null;
  if (!name) throw new UsageError('--name is required');
  if (!permsRaw) {
    throw new UsageError(
      `--permissions is required (comma-separated). Valid leaves: ${PERMISSIONS.join(', ')}`,
    );
  }
  const leaves = permsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const leaf of leaves) {
    if (!(PERMISSIONS as readonly string[]).includes(leaf)) {
      throw new UsageError(
        `unknown permission leaf '${leaf}'. Valid leaves: ${PERMISSIONS.join(', ')}`,
      );
    }
  }
  const result = await client.setPreset(name, leaves as Permission[]);
  stdout(`preset '${result.name}' set: ${result.permissions.join(', ')}`);
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
  const name = typeof values.name === 'string' ? values.name : null;
  if (!name) throw new UsageError('--name is required');
  const result = await client.deletePreset(name);
  stdout(`preset '${result.deleted}' deleted`);
  if (result.referencedBy.length > 0) {
    stdout(`  still referenced by: ${result.referencedBy.join(', ')}`);
    stdout(`  (their resolved permissions drop these leaves on next read)`);
  }
}
