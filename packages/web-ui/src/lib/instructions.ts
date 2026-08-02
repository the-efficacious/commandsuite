/**
 * Instructions signal — the /instructions packet for the signed-in slot.
 *
 * Fetched once on shell mount, refreshed via `loadInstructions()` after
 * mutations that change it (e.g. editing the team context from
 * TeamHome).
 */

import { signal } from '@preact/signals';
import type { InstructionsResponse } from 'csuite-sdk/types';
import { getClient } from './client.js';

export const instructions = signal<InstructionsResponse | null>(null);

export async function loadInstructions(): Promise<InstructionsResponse> {
  const resp = await getClient().instructions();
  instructions.value = resp;
  return resp;
}

/**
 * Test hook — resets the instructions signal between it() blocks.
 */
export function __resetInstructionsForTests(): void {
  instructions.value = null;
}
