/**
 * `csuite connect pending` / `csuite connect approve` — the approver's
 * side of device-code enrollment, from the CLI.
 *
 * `csuite connect` (the device side) prints a code and waits; until
 * now the only way to approve it was the web UI's /enroll page. These
 * two verbs are thin wrappers over the same broker routes the page
 * uses (`GET /enroll/pending`, `POST /enroll/approve`) with the same
 * `members.manage` check, so an agent holding that permission — or a
 * provisioning script running as the bootstrap member — can onboard
 * a device with no browser and no human.
 *
 *   csuite connect pending
 *   csuite connect approve --code <XXXX-XXXX> --member <name> [--label <l>]
 *   csuite connect approve --code <XXXX-XXXX> --create --member <name> --title <t>
 *                          [--description <d>] [--permissions <leaf,...>]
 *                          [--instructions <i>] [--label <l>]
 *
 * The approver never sees the token: the broker hands it to the
 * polling device, exactly as with the web UI. Nothing here changes how
 * a token is minted, stored, or resolved.
 */

import type { Client } from 'csuite-sdk/client';
import type { ApproveEnrollmentRequest, Permission } from 'csuite-sdk/types';
import { UsageError } from './errors.js';

export { UsageError };

const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
const USER_CODE_REGEX = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export interface ConnectApproveInput {
  code?: string;
  member?: string;
  create?: boolean;
  title?: string;
  description?: string;
  instructions?: string;
  /** Comma-separated permission leaves, as on `csuite member create`. */
  permissions?: string;
  label?: string;
  /** Clock for the "expires in" column. Tests inject. */
  now?: () => number;
}

export async function runConnectPendingCommand(
  client: Client,
  stdout: (line: string) => void,
  now: () => number = Date.now,
): Promise<void> {
  const pending = await client.listPendingEnrollments();
  if (pending.length === 0) {
    stdout('(no pending enrollments)');
    return;
  }
  stdout(`${'code'.padEnd(11)}${'expires'.padEnd(9)}${'label'.padEnd(22)}source`);
  for (const p of pending) {
    const secondsLeft = Math.max(0, Math.round((p.expiresAt - now()) / 1000));
    const source = [p.sourceIp, p.sourceUa].filter((s) => s !== null && s.length > 0).join(' ');
    stdout(
      `${p.userCode.padEnd(11)}${`${secondsLeft}s`.padEnd(9)}${(p.labelHint || '-').padEnd(22)}${source || '-'}`,
    );
  }
}

export async function runConnectApproveCommand(
  input: ConnectApproveInput,
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  const code = (input.code ?? '').trim().toUpperCase();
  if (!code) throw new UsageError('connect approve: --code <XXXX-XXXX> is required');
  if (!USER_CODE_REGEX.test(code)) {
    throw new UsageError(
      `connect approve: invalid --code '${input.code}' (expected XXXX-XXXX as printed by csuite connect)`,
    );
  }
  const member = input.member?.trim() ?? '';
  if (!member) {
    throw new UsageError(
      'connect approve: --member <name> is required (the member to bind the device to, or with --create the member to create)',
    );
  }
  if (!NAME_REGEX.test(member)) {
    throw new UsageError(
      `connect approve: invalid --member '${member}' (must be alphanumeric with . _ - allowed)`,
    );
  }

  let payload: ApproveEnrollmentRequest;
  if (input.create === true) {
    const title = input.title?.trim() ?? '';
    if (!title) throw new UsageError('connect approve: --create requires --title <role-title>');
    const permissions = (input.permissions ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0) as Permission[];
    payload = {
      mode: 'create',
      userCode: code,
      memberName: member,
      role: { title, description: input.description ?? '' },
      instructions: input.instructions ?? '',
      permissions,
      ...(input.label !== undefined ? { label: input.label } : {}),
    };
  } else {
    for (const [flag, value] of [
      ['--title', input.title],
      ['--description', input.description],
      ['--permissions', input.permissions],
      ['--instructions', input.instructions],
    ] as const) {
      if (value !== undefined) {
        throw new UsageError(`connect approve: ${flag} only applies with --create`);
      }
    }
    payload = {
      mode: 'bind',
      userCode: code,
      memberName: member,
      ...(input.label !== undefined ? { label: input.label } : {}),
    };
  }

  const result = await client.approveEnrollment(payload);
  const verb = payload.mode === 'create' ? 'created member' : 'bound to member';
  stdout(`✓ approved ${code} — ${verb} '${result.member.name}' (${result.member.role.title})`);
  stdout(`  token: ${result.tokenInfo.label || '(no label)'} · id ${result.tokenInfo.id}`);
  stdout('  The device that ran `csuite connect` receives the token on its next poll.');
}
