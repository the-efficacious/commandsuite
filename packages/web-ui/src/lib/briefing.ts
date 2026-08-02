/**
 * Briefing signal — the /briefing packet for the signed-in slot.
 *
 * Fetched once on shell mount, refreshed via `loadBriefing()` after
 * mutations that change it (e.g. editing the team context from
 * TeamHome).
 */

import { signal } from '@preact/signals';
import type { InstructionsResponse } from 'csuite-sdk/types';
import { getClient } from './client.js';

export const briefing = signal<InstructionsResponse | null>(null);

export async function loadBriefing(): Promise<InstructionsResponse> {
  const resp = await getClient().instructions();
  briefing.value = resp;
  return resp;
}

/**
 * Test hook — resets the briefing signal between it() blocks.
 */
export function __resetBriefingForTests(): void {
  briefing.value = null;
}
