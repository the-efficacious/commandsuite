/**
 * `csuite rotate` — regenerate a member's bearer token.
 *
 * Calls `POST /members/:name/rotate-token` on the running broker.
 * Authenticated as the caller; requires `members.manage` (admin
 * rotating someone else) or self (rotating your own token).
 *
 * Multi-token rotate semantics: every other active token for this
 * member is revoked along with the rotation, so a leaked token can be
 * fully retired in one step. Members who want to add a new token
 * without nuking peers should use `csuite connect` (device-code flow).
 *
 * Recovery: if you lose the new token between the print and saving
 * it, just re-run — it invalidates the current and mints another.
 */

import type { Client } from 'csuite-sdk/client';
import { UsageError } from './errors.js';

export { UsageError };

export interface RotateCommandInput {
  /** Name of the member to rotate. Required. */
  member?: string;
}

export async function runRotateCommand(
  input: RotateCommandInput,
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  if (!input.member) {
    throw new UsageError('rotate: --member <name> is required');
  }

  const result = await client.rotateToken(input.member);

  stdout('');
  stdout(`✓ rotated bearer token for '${input.member}'`);
  stdout('');
  stdout('  ┌─ NEW TOKEN — save this now; it is not persisted anywhere else ─┐');
  stdout(`  │ ${result.token}`);
  stdout('  └────────────────────────────────────────────────────────────────┘');
  stdout('');
  stdout('  The previous token for this member is now invalid. Any process using');
  stdout('  it (runners, CI, scripts) will need the new value to re-authenticate.');
  stdout('');
}
