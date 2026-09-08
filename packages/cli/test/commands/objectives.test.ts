/**
 * `csuite objectives` command tests.
 *
 * Two rules are under test here.
 *
 * The first is that `reassign` is one verb all the way down. The
 * subcommand used to spell a handover as `updateObjective({ assignee
 * })` — the CLI said so in a comment — which left the permission
 * (`objectives.reassign`), the audit event (`reassigned`), the store
 * method and the CLI verb with nothing matching on the wire.
 *
 * The second is which flags `update` actually carries. `--note` was
 * advertised in the usage block, parsed, and forwarded as `note` on
 * the PATCH payload, where the broker dropped it: `note` is read only
 * as handover context for an assignee change, and `objectives update`
 * cannot change the assignee. Passed alone it earned a 400 from a
 * schema that requires one of status / blockReason / assignee /
 * addWatchers / removeWatchers; passed beside `--status` it vanished
 * in silence. Either way an operator's note went nowhere and nothing
 * said so. These pin both halves — the flag is gone from `update`, and
 * it still lands on `reassign`, the one verb where the field means
 * something.
 *
 * The command takes a `Client`; a stub implementing only the methods
 * the verb touches keeps this tightly scoped, matching the MCP tool
 * tests. The payload assertions are exact rather than partial: a
 * version that quietly re-attached `note`, or that reached the new
 * route but dropped `note`, passes a `toMatchObject`.
 */

import type { Client } from 'csuite-sdk/client';
import type { Objective } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { runObjectivesCommand } from '../../src/commands/objectives.js';
import { UsageError } from '../../src/commands/push.js';

function objective(over: Partial<Objective> = {}): Objective {
  return {
    id: 'obj-1',
    title: 'Ship the thing',
    body: '',
    outcome: 'PR merged to main',
    status: 'active',
    assignee: 'dave',
    originator: 'alice',
    watchers: ['carol'],
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    result: null,
    blockReason: null,
    attachments: [],
    ...over,
  } as Objective;
}

function stubClient() {
  const updateObjective = vi.fn(async () => objective());
  return { updateObjective, client: { updateObjective } as unknown as Client };
}

describe('csuite objectives reassign', () => {
  it('calls the reassign route with the whole handover, not the update route', async () => {
    const reassignObjective = vi.fn(async () => objective());
    const updateObjective = vi.fn();
    const client = { reassignObjective, updateObjective } as unknown as Client;

    const out = await runObjectivesCommand(client, [
      'reassign',
      'obj-1',
      '--to',
      'dave',
      '--note',
      'carol is on leave',
    ]);

    expect(reassignObjective).toHaveBeenCalledWith('obj-1', {
      to: 'dave',
      note: 'carol is on leave',
    });
    expect(updateObjective).not.toHaveBeenCalled();
    expect(out).toBe('reassigned obj-1 [active] Ship the thing');
  });

  it('omits `note` rather than sending an empty one when the flag is absent', async () => {
    const reassignObjective = vi.fn(async () => objective());
    const client = { reassignObjective } as unknown as Client;

    await runObjectivesCommand(client, ['reassign', 'obj-1', '--to', 'dave']);

    expect(reassignObjective).toHaveBeenCalledWith('obj-1', { to: 'dave' });
  });

  it('requires --to before it touches the broker', async () => {
    const reassignObjective = vi.fn();
    const client = { reassignObjective } as unknown as Client;

    await expect(runObjectivesCommand(client, ['reassign', 'obj-1'])).rejects.toThrow(/--to/);
    expect(reassignObjective).not.toHaveBeenCalled();
  });
});

describe('csuite objectives update', () => {
  it('does not accept --note, and sends nothing when it is passed', async () => {
    const { updateObjective, client } = stubClient();

    await expect(
      runObjectivesCommand(client, ['update', 'obj-1', '--note', 'handover']),
    ).rejects.toThrow(/--note/);
    // The half that matters: a rejected flag must not reach the wire
    // at all. The old build accepted it and posted it.
    expect(updateObjective).not.toHaveBeenCalled();
  });

  it('sends exactly the fields the server reads', async () => {
    const { updateObjective, client } = stubClient();

    await runObjectivesCommand(client, [
      'update',
      'obj-1',
      '--status',
      'blocked',
      '--block-reason',
      'waiting on infra',
    ]);

    expect(updateObjective).toHaveBeenCalledWith('obj-1', {
      status: 'blocked',
      blockReason: 'waiting on infra',
    });
  });

  it('still takes --block-reason on its own', async () => {
    const { updateObjective, client } = stubClient();

    await runObjectivesCommand(client, ['update', 'obj-1', '--block-reason', 'waiting on infra']);

    // `UpdateObjectiveRequestSchema` accepts `blockReason` alone, so
    // dropping `--note` must not tighten the guard past it. Without
    // this, a "fix" that made --status mandatory passes every other
    // test in this file.
    expect(updateObjective).toHaveBeenCalledWith('obj-1', { blockReason: 'waiting on infra' });
  });

  it('names only the flags it has when nothing is passed', async () => {
    const { updateObjective, client } = stubClient();

    await expect(runObjectivesCommand(client, ['update', 'obj-1'])).rejects.toThrow(UsageError);
    await expect(runObjectivesCommand(client, ['update', 'obj-1'])).rejects.toThrow(
      'objectives update: must include at least one of --status, --block-reason',
    );
    expect(updateObjective).not.toHaveBeenCalled();
  });
});
