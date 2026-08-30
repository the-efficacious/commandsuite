/**
 * `csuite connect pending` / `csuite connect approve` — the approver's
 * side of device enrollment from the CLI.
 *
 * The commands are thin wrappers over two SDK calls, so the contract is
 * the payload each call receives and the text the operator reads —
 * asserted on both. Every refusal has a positive control beside it: a
 * validator that says no to everything would pass a suite of refusals.
 */

import type { Client } from 'csuite-sdk/client';
import type {
  ApproveEnrollmentRequest,
  ApproveEnrollmentResponse,
  PendingEnrollment,
} from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import {
  runConnectApproveCommand,
  runConnectPendingCommand,
  terminalSafe,
  UsageError,
} from '../../src/commands/connect-approve.js';

function approved(name: string, title: string): ApproveEnrollmentResponse {
  return {
    member: { name, role: { title, description: '' }, permissions: [], kind: 'agent' },
    tokenInfo: {
      id: '11111111-2222-4333-8444-555555555555',
      memberName: name,
      label: 'lab',
      origin: 'enrollment',
      createdAt: 1,
      lastUsedAt: null,
      expiresAt: null,
      createdBy: 'admin',
    },
  } as unknown as ApproveEnrollmentResponse;
}

function fakeClient(opts: {
  pending?: PendingEnrollment[];
  approve?: (p: ApproveEnrollmentRequest) => ApproveEnrollmentResponse;
}) {
  const calls: { approve: ApproveEnrollmentRequest[]; pending: number } = {
    approve: [],
    pending: 0,
  };
  const client = {
    async listPendingEnrollments() {
      calls.pending++;
      return opts.pending ?? [];
    },
    async approveEnrollment(p: ApproveEnrollmentRequest) {
      calls.approve.push(p);
      return (opts.approve ?? (() => approved(p.memberName, 'member')))(p);
    },
  } as unknown as Client;
  return { client, calls };
}

function out() {
  const lines: string[] = [];
  return { lines, stdout: (l: string) => lines.push(l), text: () => lines.join('\n') };
}

describe('csuite connect pending', () => {
  it('renders code, seconds left, label and source for each request', async () => {
    const now = 1_000_000;
    const { client, calls } = fakeClient({
      pending: [
        {
          userCode: 'AB12-CD34',
          labelHint: 'ci-runner',
          sourceIp: '10.0.0.5',
          sourceUa: 'csuite-cli/0.8.0',
          createdAt: now - 10_000,
          expiresAt: now + 290_000,
        },
        {
          userCode: 'ZZ99-YY88',
          labelHint: '',
          sourceIp: null,
          sourceUa: null,
          createdAt: now,
          expiresAt: now - 1, // already expired: never negative
        },
      ],
    });
    const o = out();
    await runConnectPendingCommand(client, o.stdout, () => now);
    expect(calls.pending).toBe(1);
    expect(o.text()).toContain('AB12-CD34');
    expect(o.text()).toContain('290s');
    expect(o.text()).toContain('ci-runner');
    expect(o.text()).toContain('10.0.0.5 csuite-cli/0.8.0');
    expect(o.text()).toContain('ZZ99-YY88');
    expect(o.text()).toContain('0s');
    expect(o.text()).not.toContain('[object Object]');
    expect(o.text()).not.toContain('null');
  });

  it('renders requester-controlled fields terminal-safe: one record is one line, no controls survive', async () => {
    // An unauthenticated requester chose these. Newlines would forge a
    // second row; ESC would start a sequence; CR would overwrite the
    // line; C1 and Unicode line separators are the same trick in other
    // encodings. None may reach the operator's terminal.
    const now = 1_000_000;
    const hostile = {
      userCode: 'AB12-CD34',
      labelHint: 'ok\nZZ99-YY88  300s     forged-row',
      sourceIp: '10.0.0.5\r\x1b[2K\x1b[31mred',
      sourceUa: 'ua\u2028line\u0085sep\x7fdel\u200bzw\u202eRLO end',
      createdAt: now,
      expiresAt: now + 100_000,
    };
    const { client } = fakeClient({ pending: [hostile] });
    const o = out();
    await runConnectPendingCommand(client, o.stdout, () => now);
    // Header + exactly one record.
    expect(o.lines).toHaveLength(2);
    const row = o.lines[1] ?? '';
    expect(row.startsWith('AB12-CD34')).toBe(true);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the controls are the subject under test
    expect(row).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u200b\u202e]/);
    // The forged text may survive as inert characters inside the label
    // column (truncated); what must not survive is a second row.
    expect(o.lines.filter((l) => /^[A-Z0-9]{4}-[A-Z0-9]{4}/.test(l))).toHaveLength(1);
    expect(row).toContain('10.0.0.5');
    expect(row).toContain('end');
    // The user code is not the requester's to shape either — the
    // schema guarantees it, but the row starts with it unchanged.
    expect(row.slice(0, 9)).toBe('AB12-CD34');
  });

  it('terminalSafe: replaces every control with a visible placeholder, collapses whitespace, caps width', () => {
    expect(terminalSafe('a\nb\x1b[31mc\rd', 40)).toBe('a\ufffdb\ufffd[31mc\ufffdd');
    expect(terminalSafe('  many   spaces \t here ', 40)).toBe('many spaces here');
    expect(terminalSafe('x'.repeat(50), 10)).toHaveLength(10);
    expect(terminalSafe('x'.repeat(50), 10).endsWith('…')).toBe(true);
    expect(terminalSafe(null, 10)).toBe('');
    // Positive control: ordinary text passes through untouched.
    expect(terminalSafe('csuite-cli/0.8.0 (linux)', 40)).toBe('csuite-cli/0.8.0 (linux)');
  });

  it('says so when nothing is pending', async () => {
    const { client } = fakeClient({});
    const o = out();
    await runConnectPendingCommand(client, o.stdout);
    expect(o.text()).toContain('no pending enrollments');
  });
});

describe('csuite connect approve', () => {
  it('bind: sends mode=bind with the normalized code and member, prints what happened, never a token', async () => {
    const { client, calls } = fakeClient({
      approve: () => approved('builder', 'engineer'),
    });
    const o = out();
    await runConnectApproveCommand(
      { code: ' ab12-cd34 ', member: 'builder', label: 'ci box' },
      client,
      o.stdout,
    );
    expect(calls.approve).toEqual([
      { mode: 'bind', userCode: 'AB12-CD34', memberName: 'builder', label: 'ci box' },
    ]);
    expect(o.text()).toContain("bound to member 'builder' (engineer)");
    expect(o.text()).toContain('11111111-2222-4333-8444-555555555555');
    expect(o.text()).not.toMatch(/csuite_[A-Za-z0-9_-]{20,}/);
  });

  it('create: sends mode=create with role, permissions and instructions', async () => {
    const { client, calls } = fakeClient({
      approve: () => approved('scout', 'researcher'),
    });
    const o = out();
    await runConnectApproveCommand(
      {
        code: 'AB12-CD34',
        create: true,
        member: 'scout',
        title: 'researcher',
        description: 'reads things',
        permissions: 'objectives.create, activity.read',
        instructions: 'be brief',
      },
      client,
      o.stdout,
    );
    expect(calls.approve).toEqual([
      {
        mode: 'create',
        userCode: 'AB12-CD34',
        memberName: 'scout',
        role: { title: 'researcher', description: 'reads things' },
        instructions: 'be brief',
        permissions: ['objectives.create', 'activity.read'],
      },
    ]);
    expect(o.text()).toContain("created member 'scout' (researcher)");
  });

  it('create without --title is refused, naming the flag', async () => {
    const { client, calls } = fakeClient({});
    await expect(
      runConnectApproveCommand(
        { code: 'AB12-CD34', create: true, member: 'scout' },
        client,
        () => {},
      ),
    ).rejects.toThrow(/--create requires --title/);
    expect(calls.approve).toHaveLength(0);
  });

  it('bind with create-only flags is refused rather than silently ignored', async () => {
    const { client, calls } = fakeClient({});
    await expect(
      runConnectApproveCommand(
        { code: 'AB12-CD34', member: 'builder', permissions: 'activity.read' },
        client,
        () => {},
      ),
    ).rejects.toThrow(/--permissions only applies with --create/);
    expect(calls.approve).toHaveLength(0);
  });

  it('refuses a missing or malformed code and a missing or invalid member, before any call', async () => {
    const { client, calls } = fakeClient({});
    const cases: Array<[Parameters<typeof runConnectApproveCommand>[0], RegExp]> = [
      [{ member: 'builder' }, /--code <XXXX-XXXX> is required/],
      [{ code: 'nope', member: 'builder' }, /invalid --code 'nope'/],
      [{ code: 'AB12-CD34' }, /--member <name> is required/],
      [{ code: 'AB12-CD34', member: 'bad name' }, /invalid --member 'bad name'/],
    ];
    for (const [input, re] of cases) {
      await expect(runConnectApproveCommand(input, client, () => {})).rejects.toThrow(re);
      await expect(runConnectApproveCommand(input, client, () => {})).rejects.toThrow(UsageError);
    }
    expect(calls.approve).toHaveLength(0);
  });

  it('propagates the broker refusal (e.g. unknown or expired code) unchanged', async () => {
    const { client } = fakeClient({
      approve: () => {
        throw new Error('approve failed: 404 Not Found: {"error":"unknown or expired code"}');
      },
    });
    await expect(
      runConnectApproveCommand({ code: 'AB12-CD34', member: 'builder' }, client, () => {}),
    ).rejects.toThrow(/unknown or expired code/);
  });
});
