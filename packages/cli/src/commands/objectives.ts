/**
 * `csuite objectives` — team objective management from the terminal.
 *
 * Subcommands:
 *   csuite objectives list [--mine] [--assignee X] [--status active|blocked|done|cancelled]
 *   csuite objectives view <id>
 *   csuite objectives create --title <t> --outcome <o> --assignee <slot> [--body <b>]
 *   csuite objectives update <id> --status <blocked|active> [--block-reason <r>] [--note <n>]
 *   csuite objectives complete <id> --result <r>
 *   csuite objectives cancel <id> [--reason <r>]
 *   csuite objectives reassign <id> --to <slot> [--note <n>]
 *
 * Create / cancel / reassign each require the matching `objectives.*`
 * permission (`objectives.create`, `objectives.cancel`,
 * `objectives.reassign`) server-side. List / view / update / complete
 * work from any slot (with appropriate scoping server-side).
 */

import { parseArgs } from 'node:util';
import type { Client } from 'csuite-sdk/client';
import type { Objective, ObjectiveStatus } from 'csuite-sdk/types';
import { UsageError } from './push.js';

export async function runObjectivesCommand(client: Client, args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (!sub) {
    throw new UsageError(
      'objectives subcommand required. Use: list | view | create | update | complete | cancel | reassign',
    );
  }
  switch (sub) {
    case 'list':
      return renderList(await runList(client, rest));
    case 'view':
      return renderView(await runView(client, rest));
    case 'create':
      return renderObjective(await runCreate(client, rest), 'created');
    case 'update':
      return renderObjective(await runUpdate(client, rest), 'updated');
    case 'complete':
      return renderObjective(await runComplete(client, rest), 'completed');
    case 'cancel':
      return renderObjective(await runCancel(client, rest), 'cancelled');
    case 'reassign':
      return renderObjective(await runReassign(client, rest), 'reassigned');
    default:
      throw new UsageError(`unknown objectives subcommand: ${sub}`);
  }
}

// ── subcommand runners ─────────────────────────────────────────────

async function runList(client: Client, args: string[]): Promise<Objective[]> {
  const { values } = parseArgs({
    args,
    options: {
      mine: { type: 'boolean', default: false },
      assignee: { type: 'string' },
      status: { type: 'string' },
    },
    allowPositionals: false,
  });
  const query: { assignee?: string; status?: ObjectiveStatus } = {};
  if (values.mine === true) {
    // --mine resolves server-side via the session's own name;
    // passing the string literal 'self' would be wrong, so we fetch
    // the briefing first to learn our own name.
    const briefing = await client.briefing();
    query.assignee = briefing.name;
  }
  if (typeof values.assignee === 'string') query.assignee = values.assignee;
  if (typeof values.status === 'string') {
    query.status = assertObjectiveStatus(values.status);
  }
  return client.listObjectives(query);
}

async function runView(
  client: Client,
  args: string[],
): Promise<{ objective: Objective; events: Array<Record<string, unknown>> }> {
  const id = args[0];
  if (!id) throw new UsageError('objectives view <id> — id is required');
  const { objective, events } = await client.getObjective(id);
  return {
    objective,
    events: events.map((e) => ({
      ts: e.ts,
      actor: e.actor,
      kind: e.kind,
      payload: e.payload,
    })),
  };
}

async function runCreate(client: Client, args: string[]): Promise<Objective> {
  const { values } = parseArgs({
    args,
    options: {
      title: { type: 'string' },
      outcome: { type: 'string' },
      assignee: { type: 'string' },
      body: { type: 'string' },
    },
    allowPositionals: false,
  });
  const title = values.title;
  const outcome = values.outcome;
  const assignee = values.assignee;
  if (typeof title !== 'string' || title.length === 0) {
    throw new UsageError('objectives create: --title is required');
  }
  if (typeof outcome !== 'string' || outcome.length === 0) {
    throw new UsageError(
      'objectives create: --outcome is required (the tangible definition of "done")',
    );
  }
  if (typeof assignee !== 'string' || assignee.length === 0) {
    throw new UsageError('objectives create: --assignee <name> is required');
  }
  return client.createObjective({
    title,
    outcome,
    assignee,
    ...(typeof values.body === 'string' ? { body: values.body } : {}),
  });
}

async function runUpdate(client: Client, args: string[]): Promise<Objective> {
  const id = args[0];
  if (!id) throw new UsageError('objectives update <id> — id is required');
  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      status: { type: 'string' },
      'block-reason': { type: 'string' },
      note: { type: 'string' },
    },
    allowPositionals: false,
  });
  const statusRaw = typeof values.status === 'string' ? values.status : undefined;
  if (statusRaw !== undefined && statusRaw !== 'active' && statusRaw !== 'blocked') {
    throw new UsageError(
      `objectives update: --status must be 'active' or 'blocked' (use complete/cancel for terminal states)`,
    );
  }
  const blockReason =
    typeof values['block-reason'] === 'string' ? values['block-reason'] : undefined;
  const note = typeof values.note === 'string' ? values.note : undefined;
  if (statusRaw === undefined && blockReason === undefined && note === undefined) {
    throw new UsageError(
      'objectives update: must include at least one of --status, --block-reason, --note',
    );
  }
  return client.updateObjective(id, {
    ...(statusRaw ? { status: statusRaw } : {}),
    ...(blockReason !== undefined ? { blockReason } : {}),
    ...(note !== undefined ? { note } : {}),
  });
}

async function runComplete(client: Client, args: string[]): Promise<Objective> {
  const id = args[0];
  if (!id) throw new UsageError('objectives complete <id> — id is required');
  const { values } = parseArgs({
    args: args.slice(1),
    options: { result: { type: 'string' } },
    allowPositionals: false,
  });
  const result = typeof values.result === 'string' ? values.result : '';
  if (!result) {
    throw new UsageError('objectives complete: --result is required');
  }
  return client.completeObjective(id, result);
}

async function runCancel(client: Client, args: string[]): Promise<Objective> {
  const id = args[0];
  if (!id) throw new UsageError('objectives cancel <id> — id is required');
  const { values } = parseArgs({
    args: args.slice(1),
    options: { reason: { type: 'string' } },
    allowPositionals: false,
  });
  return client.cancelObjective(id, {
    ...(typeof values.reason === 'string' ? { reason: values.reason } : {}),
  });
}

async function runReassign(client: Client, args: string[]): Promise<Objective> {
  const id = args[0];
  if (!id) throw new UsageError('objectives reassign <id> — id is required');
  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      to: { type: 'string' },
      note: { type: 'string' },
    },
    allowPositionals: false,
  });
  const to = typeof values.to === 'string' ? values.to : '';
  if (!to) throw new UsageError('objectives reassign: --to <name> is required');
  return client.reassignObjective(id, {
    to,
    ...(typeof values.note === 'string' ? { note: values.note } : {}),
  });
}

// ── renderers ──────────────────────────────────────────────────────

function renderList(list: Objective[]): string {
  if (list.length === 0) return 'no objectives match';
  const header = `${'id'.padEnd(20)}${'status'.padEnd(10)}${'assignee'.padEnd(16)}title`;
  const rows = list.map(
    (o) => `${o.id.padEnd(20)}${o.status.padEnd(10)}${o.assignee.padEnd(16)}${o.title}`,
  );
  return [header, ...rows].join('\n');
}

function renderView(view: {
  objective: Objective;
  events: Array<Record<string, unknown>>;
}): string {
  const { objective, events } = view;
  const lines: string[] = [
    `${objective.id} [${objective.status}] ${objective.title}`,
    `assignee:   ${objective.assignee}`,
    `originator: ${objective.originator}`,
    `outcome:    ${objective.outcome}`,
  ];
  if (objective.body) lines.push(`body:       ${objective.body}`);
  if (objective.blockReason) lines.push(`blocked:    ${objective.blockReason}`);
  if (objective.result) lines.push(`result:     ${objective.result}`);
  lines.push(`created:    ${new Date(objective.createdAt).toISOString()}`);
  lines.push(`updated:    ${new Date(objective.updatedAt).toISOString()}`);
  if (objective.completedAt) {
    lines.push(`completed:  ${new Date(objective.completedAt).toISOString()}`);
  }
  lines.push('events:');
  for (const ev of events) {
    const ts = new Date(ev.ts as number).toISOString();
    lines.push(`  ${ts} ${ev.actor as string} ${ev.kind as string} ${JSON.stringify(ev.payload)}`);
  }
  return lines.join('\n');
}

function renderObjective(o: Objective, verb: string): string {
  return `${verb} ${o.id} [${o.status}] ${o.title}`;
}

function assertObjectiveStatus(v: string): ObjectiveStatus {
  if (v === 'active' || v === 'blocked' || v === 'done' || v === 'cancelled') return v;
  throw new UsageError(
    `unknown --status '${v}'. Must be one of: active, blocked, done, cancelled.`,
  );
}
