import type { Client } from 'csuite-sdk/client';
import { describe, expect, it, vi } from 'vitest';
import { runRosterCommand } from '../../src/commands/roster.js';

const member = {
  name: 'builder',
  role: { title: 'engineer', description: '' },
  permissions: [],
};

describe('csuite roster runner identity', () => {
  it('renders typed identity, instrument status, and both skew versions', async () => {
    const client = {
      roster: vi.fn().mockResolvedValue({
        teammates: [member],
        connected: [
          {
            ...member,
            connected: 2,
            createdAt: 1,
            lastSeen: 2,
            runnerReports: [
              {
                runner: 'stub',
                modelId: null,
                runnerVersion: '0.8.0+main.aaaa',
                runnerBuildSource: 'main',
                connections: 1,
                versionSkew: {
                  skew: true,
                  runnerVersion: '0.8.0+main.aaaa',
                  brokerVersion: '0.8.0+main.bbbb',
                },
              },
            ],
            clientReports: [
              {
                kind: 'runner',
                runnerIdentity: {
                  runner: 'stub',
                  modelId: null,
                  runnerVersion: '0.8.0+main.aaaa',
                  runnerBuildSource: 'main',
                },
                connections: 1,
                versionSkew: {
                  skew: true,
                  runnerVersion: '0.8.0+main.aaaa',
                  brokerVersion: '0.8.0+main.bbbb',
                },
              },
              { kind: 'browser', clientVersion: '0.8.0', connections: 1 },
            ],
            unreportedConnections: 1,
          },
        ],
      }),
    } as unknown as Client;

    const output = await runRosterCommand(client);
    expect(output).toContain('stub · agent default — not resolved locally');
    expect(output).toContain('TEST/CI INSTRUMENT');
    expect(output).toContain('SKEW runner=0.8.0+main.aaaa broker=0.8.0+main.bbbb');
    expect(output).toContain('browser · 0.8.0');
    expect(output).toContain('1 connection(s) without client identity');
  });

  it('distinguishes an old broker from a new broker reporting zero identities', async () => {
    const oldClient = {
      roster: vi.fn().mockResolvedValue({
        teammates: [member],
        connected: [{ ...member, connected: 1, createdAt: 1, lastSeen: 2 }],
      }),
    } as unknown as Client;
    const newClient = {
      roster: vi.fn().mockResolvedValue({
        teammates: [member],
        connected: [
          {
            ...member,
            connected: 1,
            createdAt: 1,
            lastSeen: 2,
            runnerReports: [],
            clientReports: [],
            unreportedConnections: 1,
          },
        ],
      }),
    } as unknown as Client;

    expect(await runRosterCommand(oldClient)).toContain('broker predates client identity');
    const newOutput = await runRosterCommand(newClient);
    expect(newOutput).not.toContain('broker predates client identity');
    expect(newOutput).toContain('1 connection(s) without client identity');
  });
});
