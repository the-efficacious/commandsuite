/**
 * Tests for `csuite member <list|create|update|delete>`.
 *
 * The new CLI talks to the running broker via the SDK Client. These
 * tests stub a thin Client double and assert that each subcommand
 * dispatches to the right Client method with the right arguments.
 * The broker-side semantics (last-admin protection, permission gates,
 * preset resolution) are covered by `apps/server/test/members-endpoints.test.ts`,
 * so no live broker is needed here.
 */

import type { Client } from 'csuite-sdk/client';
import type { Member } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { UsageError } from '../../src/commands/errors.js';
import { runMemberCommand } from '../../src/commands/member.js';

interface FakeClient {
  listMembers: ReturnType<typeof vi.fn>;
  createMember: ReturnType<typeof vi.fn>;
  updateMember: ReturnType<typeof vi.fn>;
  deleteMember: ReturnType<typeof vi.fn>;
}

function fakeClient(overrides: Partial<FakeClient> = {}): { client: Client; calls: FakeClient } {
  const calls: FakeClient = {
    listMembers: vi.fn().mockResolvedValue([]),
    createMember: vi
      .fn()
      .mockResolvedValue({ member: { name: 'newbie' }, token: 'csuite_fake_token' }),
    updateMember: vi.fn().mockResolvedValue({ name: 'alice' }),
    deleteMember: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { client: calls as unknown as Client, calls };
}

function captureStdout(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (l) => lines.push(l) };
}

describe('csuite member list', () => {
  it('renders an empty banner when no members exist', async () => {
    const { client, calls } = fakeClient();
    const out = captureStdout();
    await runMemberCommand(['list'], client, out.write);
    expect(calls.listMembers).toHaveBeenCalledOnce();
    expect(out.lines).toContain('(no members)');
  });

  it('renders a name + role + permissions table when members exist', async () => {
    const members: Member[] = [
      {
        name: 'alice',
        role: { title: 'admin', description: '' },
        permissions: ['members.manage'],
        instructions: '',
      },
      {
        name: 'bob',
        role: { title: 'engineer', description: '' },
        permissions: [],
        instructions: '',
      },
    ];
    const { client } = fakeClient({ listMembers: vi.fn().mockResolvedValue(members) });
    const out = captureStdout();
    await runMemberCommand(['list'], client, out.write);
    expect(out.lines.some((l) => l.includes('alice'))).toBe(true);
    expect(out.lines.some((l) => l.includes('bob'))).toBe(true);
    expect(out.lines.some((l) => l.includes('baseline'))).toBe(true);
  });
});

describe('csuite member create', () => {
  it('POSTs to createMember with the supplied flags and prints the token banner', async () => {
    const { client, calls } = fakeClient();
    const out = captureStdout();
    await runMemberCommand(
      [
        'create',
        '--name',
        'newbie',
        '--title',
        'engineer',
        '--description',
        'ships code',
        '--permissions',
        'operator',
      ],
      client,
      out.write,
    );
    expect(calls.createMember).toHaveBeenCalledOnce();
    expect(calls.createMember).toHaveBeenCalledWith({
      name: 'newbie',
      role: { title: 'engineer', description: 'ships code' },
      instructions: '',
      permissions: ['operator'],
    });
    expect(out.lines.some((l) => l.includes('csuite_fake_token'))).toBe(true);
  });

  it('errors when --name is missing', async () => {
    const { client } = fakeClient();
    await expect(
      runMemberCommand(['create', '--title', 'engineer'], client, () => {}),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('errors when --title is missing', async () => {
    const { client } = fakeClient();
    await expect(
      runMemberCommand(['create', '--name', 'newbie'], client, () => {}),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('rejects an invalid --name', async () => {
    const { client } = fakeClient();
    await expect(
      runMemberCommand(['create', '--name', 'has spaces', '--title', 'engineer'], client, () => {}),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe('csuite member update', () => {
  it('PATCHes role + instructions + permissions when supplied', async () => {
    const { client, calls } = fakeClient();
    const out = captureStdout();
    await runMemberCommand(
      [
        'update',
        '--name',
        'alice',
        '--title',
        'lead',
        '--description',
        'leads the team',
        '--instructions',
        'review every PR',
        '--permissions',
        'admin',
      ],
      client,
      out.write,
    );
    expect(calls.updateMember).toHaveBeenCalledOnce();
    expect(calls.updateMember).toHaveBeenCalledWith('alice', {
      role: { title: 'lead', description: 'leads the team' },
      instructions: 'review every PR',
      permissions: ['admin'],
    });
  });

  it('errors when no fields are provided', async () => {
    const { client } = fakeClient();
    await expect(
      runMemberCommand(['update', '--name', 'alice'], client, () => {}),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('errors when --name is missing', async () => {
    const { client } = fakeClient();
    await expect(
      runMemberCommand(['update', '--title', 'lead'], client, () => {}),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe('csuite member delete', () => {
  it('DELETEs by name', async () => {
    const { client, calls } = fakeClient();
    await runMemberCommand(['delete', '--name', 'alice'], client, () => {});
    expect(calls.deleteMember).toHaveBeenCalledOnce();
    expect(calls.deleteMember).toHaveBeenCalledWith('alice');
  });

  it('aliases `remove` to `delete`', async () => {
    const { client, calls } = fakeClient();
    await runMemberCommand(['remove', '--name', 'alice'], client, () => {});
    expect(calls.deleteMember).toHaveBeenCalledOnce();
  });

  it('errors when --name is missing', async () => {
    const { client } = fakeClient();
    await expect(runMemberCommand(['delete'], client, () => {})).rejects.toBeInstanceOf(UsageError);
  });
});

describe('runMemberCommand dispatch', () => {
  it('errors on an unknown subcommand', async () => {
    const { client } = fakeClient();
    await expect(runMemberCommand(['nope'], client, () => {})).rejects.toBeInstanceOf(UsageError);
  });

  it('errors on no subcommand', async () => {
    const { client } = fakeClient();
    await expect(runMemberCommand([], client, () => {})).rejects.toBeInstanceOf(UsageError);
  });
});
