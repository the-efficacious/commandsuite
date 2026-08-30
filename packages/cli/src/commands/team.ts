/**
 * `csuite team` — read or update the team config.
 *
 * Subcommands:
 *   csuite team get
 *   csuite team set [--name <n>] [--context <c>] [--context-file <path>]
 *   csuite team status [--stalled <duration>] [--json]
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
import { formatTextMetrics } from 'csuite-sdk/text-metrics';
import { UsageError } from './errors.js';

export async function runTeamCommand(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '-h' || sub === '--help') {
    throw new UsageError('team subcommand required. Use: get | set | status');
  }
  switch (sub) {
    case 'get':
      await runGet(rest, client, stdout);
      return;
    case 'set':
    case 'update':
      await runSet(rest, client, stdout);
      return;
    case 'status':
      await runStatus(rest, client, stdout);
      return;
    default:
      throw new UsageError(`unknown team subcommand: ${sub}`);
  }
}

function durationMs(input: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(input);
  if (!match) throw new UsageError('--stalled must be a duration such as 30m, 2h, or 1d');
  const value = Number(match[1]);
  const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as 'ms' | 's' | 'm' | 'h' | 'd'
  ];
  const result = value * factor;
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new UsageError('--stalled must be positive');
  return result;
}

async function runStatus(
  args: string[],
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const time = (value: number | null): string =>
    value === null ? 'absent' : new Date(value).toISOString();
  const { values } = parseArgs({
    args,
    options: { stalled: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: false,
  });
  const report = await client.teamStatus({
    ...(values.stalled ? { stalledMs: durationMs(values.stalled) } : {}),
  });
  if (values.json) {
    stdout(JSON.stringify(report, null, 2));
    return;
  }
  if (report.members.length === 0) {
    stdout('(no matching members)');
    return;
  }
  for (const row of report.members) {
    const presence =
      row.presence === null
        ? 'presence=absent'
        : `connected=${row.presence.connected} authBlocked=${row.presence.authBlocked ?? 'unreported'}`;
    stdout(`${row.member.name}  ${presence}  last-activity=${time(row.lastActivityAt)}`);
    if (row.presence?.runnerReports?.length) {
      for (const runner of row.presence.runnerReports) {
        stdout(
          `  runner ${runner.runner} model=${runner.modelId ?? 'agent default — not resolved locally'} version=${runner.runnerVersion}${runner.versionSkew.skew ? ` SKEW broker=${runner.versionSkew.brokerVersion}` : ''}`,
        );
      }
    } else stdout('  runner unreported');
    for (const objective of row.activeObjectives) {
      stdout(
        `  ${objective.id} ${objective.status}${objective.stalled ? ` STALLED missing=${objective.staleSignals.join(',')}` : ''} last-post=${time(objective.lastThreadPostAt)} last-pr=${time(objective.lastPrLinkAt)} last-lifecycle=${time(objective.lastLifecycleAt)}`,
      );
    }
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
  stdout(`  [${formatTextMetrics(team.context)}]`);
  if (team.context.trim().length === 0) {
    stdout('  (none)');
  } else {
    for (const line of team.context.split('\n')) stdout(`  ${line}`);
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
  if (patch.context !== undefined) stdout(`  context: ${formatTextMetrics(team.context)}`);
}
