/**
 * `csuite roster` — list the team's members and their current state.
 */

import type { Client } from 'csuite-sdk/client';

export async function runRosterCommand(client: Client): Promise<string> {
  const { teammates, connected } = await client.roster();
  if (teammates.length === 0) {
    return 'no members defined';
  }

  const connectedByName = new Map(connected.map((a) => [a.name, a]));

  const header = `${'name'.padEnd(20)}${'role'.padEnd(18)}${'permissions'.padEnd(28)}${'connected'.padEnd(12)}${'auth'.padEnd(14)}last_seen`;
  const rows = teammates.map((t) => {
    const name = t.name.padEnd(20);
    const role = t.role.title.padEnd(18);
    const perms = (t.permissions.length > 0 ? t.permissions.join(',') : 'baseline').padEnd(28);
    const state = connectedByName.get(t.name);
    const conn = String(state?.connected ?? 0).padEnd(12);
    const auth = (state?.authBlocked ? `blocked(${state.authBlocked})` : 'ok').padEnd(14);
    const last = state ? new Date(state.lastSeen).toISOString() : '-';
    return `${name}${role}${perms}${conn}${auth}${last}`;
  });
  return [header, ...rows].join('\n');
}
