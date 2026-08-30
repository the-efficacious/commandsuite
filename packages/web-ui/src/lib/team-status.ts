import { signal } from '@preact/signals';
import type { TeamStatusResponse } from 'csuite-sdk/types';
import { getClient } from './client.js';

export const teamStatus = signal<TeamStatusResponse | null>(null);

export async function loadTeamStatus(): Promise<TeamStatusResponse> {
  const response = await getClient().teamStatus();
  teamStatus.value = response;
  return response;
}

export function __resetTeamStatusForTests(): void {
  teamStatus.value = null;
}
