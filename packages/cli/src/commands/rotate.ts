/**
 * `csuite rotate` — regenerate a member's bearer token.
 *
 * Calls `POST /members/:name/rotate-token` on the running broker.
 * Authenticated as the caller; requires `members.manage` (admin
 * rotating someone else) or self (rotating your own token).
 *
 * Multi-token rotate semantics are explicit: `--token-id` replaces one
 * device credential while `--all` invalidates every active token and
 * mints one clean replacement.
 *
 * Plaintext is written once to an O_EXCL 0600 file and never stdout.
 */

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Client } from 'csuite-sdk/client';
import { UsageError } from './errors.js';

export { UsageError };

export interface RotateCommandInput {
  /** Name of the member to rotate. Required. */
  member?: string;
  tokenId?: string;
  all?: boolean;
  tokenFile?: string;
}

export async function runRotateCommand(
  input: RotateCommandInput,
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  if (!input.member) {
    throw new UsageError('rotate: --member <name> is required');
  }
  if ((input.tokenId ? 1 : 0) + (input.all ? 1 : 0) !== 1) {
    throw new UsageError('rotate: choose exactly one of --token-id <id> or --all');
  }
  if (!input.tokenFile) {
    throw new UsageError(
      'rotate: --token-file <path> is required; token plaintext is never printed',
    );
  }

  mkdirSync(dirname(input.tokenFile), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(input.tokenFile, 'wx', 0o600);
  } catch (err) {
    const message =
      (err as NodeJS.ErrnoException).code === 'EEXIST'
        ? `${input.tokenFile} already exists — refusing to overwrite a credential file`
        : `cannot create ${input.tokenFile}: ${(err as Error).message}`;
    throw new UsageError(`rotate: ${message}`);
  }

  let result: Awaited<ReturnType<Client['rotateToken']>>;
  try {
    result = await client.rotateToken(
      input.member,
      input.tokenId ? { scope: 'token', tokenId: input.tokenId } : { scope: 'all' },
    );
    writeSync(fd, `${result.token}\n`);
  } catch (err) {
    closeSync(fd);
    throw new UsageError(
      `rotate failed; reserved credential file remains at ${input.tokenFile} (inspect it before retrying): ${(err as Error).message}`,
    );
  }
  closeSync(fd);

  stdout(
    `✓ rotated ${input.tokenId ? `token ${input.tokenId}` : 'all bearer tokens'} for '${input.member}'`,
  );
  stdout(`  new token id: ${result.tokenInfo?.id ?? '(metadata unavailable)'}`);
  stdout(`  credential written to ${input.tokenFile} (0600; plaintext not printed)`);
}
