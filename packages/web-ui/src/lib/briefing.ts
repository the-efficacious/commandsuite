/**
 * Briefing signal — the /briefing packet for the signed-in slot.
 *
 * Fetched once on shell mount and cached forever (per page load). The
 * team name, directive, name, role, and teammate list don't change
 * during a single session — any runtime edits land via future admin
 * endpoints that reload the SPA anyway.
 */

import { signal } from '@preact/signals';
import type { BriefingResponse } from 'csuite-sdk/types';
import { getClient } from './client.js';

export const briefing = signal<BriefingResponse | null>(null);

export async function loadBriefing(): Promise<BriefingResponse> {
  const resp = await getClient().briefing();
  briefing.value = resp;
  return resp;
}

/**
 * Test hook — resets the briefing signal between it() blocks.
 */
export function __resetBriefingForTests(): void {
  briefing.value = null;
}
