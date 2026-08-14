/**
 * The diagnostics retention ladder is actually driven.
 *
 * `DiagnosticStore.sweep()` implements a detail -> hour -> day
 * compaction ladder, and for its whole life nothing in production ever
 * called it. Every unit test exercised `sweep()` directly, so the ladder
 * was proven and its caller was not — the helper-versus-caller failure
 * this repo has a written rule about. In production the row caps were
 * the only bound.
 *
 * These assert the CALLER. The store is a spy, so what is measured is
 * whether `createApp` drives it, not whether the ladder works — that is
 * covered elsewhere, and re-proving it here would repeat the mistake.
 */

import {
  Broker,
  createApp,
  createTokenStoreFromMembers,
  type DiagnosticStore,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import type { Team } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { silentLogger } from './helpers/logger.js';
import { mockTeamStore } from './helpers/test-stores.js';

const TEAM: Team = { name: 'demo-team', context: 'ctx', permissionPresets: {} };

/** A DiagnosticStore that records only whether `sweep` was called. */
function spyDiagnostics(): { store: DiagnosticStore; sweep: ReturnType<typeof vi.fn> } {
  const sweep = vi.fn();
  const store = {
    // Every emitter method is a no-op; this suite measures the caller
    // of `sweep`, not what the store records.
    emit: new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }) as unknown as DiagnosticStore['emit'],
    unresolved: () => [],
    query: () => ({ kind: 'exact' as const, total: 0, buckets: [] }),
    sweep,
    health: () => 'healthy' as const,
    coverageFloor: () => 0,
  } as unknown as DiagnosticStore;
  return { store, sweep };
}

async function boot(diagnostics?: DiagnosticStore): Promise<{ shutdown: AbortController }> {
  const db = openDatabase(':memory:');
  const members = createMemberStore([
    { name: 'op-1', role: { title: 'op', description: '' }, permissions: [], token: 'csuite_t' },
  ]);
  const shutdown = new AbortController();
  createApp({
    broker: new Broker({ eventLog: new InMemoryEventLog() }),
    members,
    tokens: await createTokenStoreFromMembers(db, members),
    sessions: new SqliteSessionStore(db),
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    logger: silentLogger(),
    shutdownSignal: shutdown.signal,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  });
  return { shutdown };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('diagnostics retention is driven by the broker', () => {
  it('sweeps once at startup', async () => {
    // A broker restarted more often than the interval would otherwise
    // never fold, which is the common case for a dev or CI deployment.
    const { store, sweep } = spyDiagnostics();
    const { shutdown } = await boot(store);
    expect(sweep).toHaveBeenCalledTimes(1);
    shutdown.abort();
  });

  it('sweeps again on the interval', async () => {
    const { store, sweep } = spyDiagnostics();
    const { shutdown } = await boot(store);
    sweep.mockClear();

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    shutdown.abort();
  });

  it('stops sweeping after shutdown', async () => {
    const { store, sweep } = spyDiagnostics();
    const { shutdown } = await boot(store);
    shutdown.abort();
    sweep.mockClear();

    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('a sweep that throws does not take the broker down', async () => {
    // Retention is the least important thing in the process; it must
    // never be able to kill the operation it observes.
    const { store, sweep } = spyDiagnostics();
    sweep.mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(boot(store)).resolves.toBeDefined();
  });

  it('boots with no diagnostics store wired at all', async () => {
    // Positive control on the guard: the timer is conditional, and a
    // deployment without retention must still start.
    await expect(boot(undefined)).resolves.toBeDefined();
  });
});
