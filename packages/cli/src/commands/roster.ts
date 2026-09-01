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

  const header = `${'name'.padEnd(20)}${'role'.padEnd(18)}${'permissions'.padEnd(28)}${'connected'.padEnd(12)}${'executor'.padEnd(16)}last_acted`;
  const rows = teammates.map((t) => {
    const name = t.name.padEnd(20);
    const role = t.role.title.padEnd(18);
    const perms = (t.permissions.length > 0 ? t.permissions.join(',') : 'baseline').padEnd(28);
    const state = connectedByName.get(t.name);
    const conn = String(state?.connected ?? 0).padEnd(12);
    const executor = (state?.executor?.state ?? 'unreported').padEnd(16);
    const last = state?.executor?.lastActedAt
      ? new Date(state.executor.lastActedAt).toISOString()
      : '-';
    return `${name}${role}${perms}${conn}${executor}${last}`;
  });
  const identityLines: string[] = [];
  for (const teammate of teammates) {
    const state = connectedByName.get(teammate.name);
    if (state === undefined || state.connected === 0) continue;
    if (state.clientReports === undefined || state.unreportedConnections === undefined) {
      identityLines.push(
        `  ${teammate.name}: client identity unreported (broker predates client identity)`,
      );
      continue;
    }
    for (const report of state.clientReports) {
      if (report.kind !== 'runner') {
        identityLines.push(
          `  ${teammate.name}: ${report.kind} · ${report.clientVersion} · connections=${report.connections}`,
        );
        continue;
      }
      const identity = report.runnerIdentity;
      const model = identity.modelId ?? 'agent default — not resolved locally';
      const instrument = identity.runner === 'stub' ? ' · TEST/CI INSTRUMENT' : '';
      const skew = report.versionSkew.skew
        ? ` · SKEW runner=${report.versionSkew.runnerVersion} broker=${report.versionSkew.brokerVersion}`
        : ' · version matches broker';
      identityLines.push(
        `  ${teammate.name}: runner/${identity.runner} · ${model} · ${identity.runnerVersion} · ${identity.runnerBuildSource} · supervision claim=${identity.supervision?.kind ?? 'unreported'} · connections=${report.connections}${instrument}${skew}`,
      );
    }
    if (state.unreportedConnections > 0) {
      identityLines.push(
        `  ${teammate.name}: ${state.unreportedConnections} connection(s) without client identity`,
      );
    }
  }
  return [
    header,
    ...rows,
    ...(identityLines.length > 0 ? ['', 'client identity', ...identityLines] : []),
  ].join('\n');
}
