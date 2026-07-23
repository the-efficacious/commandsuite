/**
 * Graceful shutdown regression test.
 *
 * Previously `runServer().stop()` would hang indefinitely if any SSE
 * subscriber was still attached, because `http.Server.close()` only
 * stops accepting new connections — it doesn't terminate ongoing
 * request handlers. The fix: `runServer` now owns an AbortController
 * that fans out to every open SSE handler, so stop() can complete.
 *
 * This test opens a real SSE subscription via the SDK client, lets
 * the connection settle, then calls stop() with a hard ceiling of
 * 3 seconds. If the fix regresses, the test will exceed the ceiling
 * and fail instead of hanging the suite.
 */

import { Client } from 'csuite-sdk/client';
import type { Team } from 'csuite-sdk/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServer, runServer } from '../src/run.js';
import { seedStores } from './helpers/test-stores.js';

const OP_TOKEN = 'csuite_shutdown_test_op';
const TEAM: Pick<Team, 'name' | 'context'> = {
  name: 'shutdown-test-team',
  context: '',
};

describe('runServer shutdown with live SSE subscriber', () => {
  let server: RunningServer;
  let client: Client;

  beforeAll(async () => {
    const seeded = seedStores({
      team: TEAM,
      members: [
        {
          name: 'director-1',
          role: { title: 'director', description: '' },
          rawPermissions: ['members.manage'],
          permissions: ['members.manage'],
          token: OP_TOKEN,
        },
      ],
    });
    server = await runServer({
      db: seeded.db,
      port: 0,
      host: '127.0.0.1',
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });
    client = new Client({ url: `http://${server.host}:${server.port}`, token: OP_TOKEN });
  }, 10_000);

  it('stop() completes quickly even with an active SSE subscription', async () => {
    const ac = new AbortController();
    let iterationsBeforeClose = 0;
    const subPromise = (async () => {
      try {
        for await (const _msg of client.subscribe('director-1', ac.signal)) {
          iterationsBeforeClose++;
        }
      } catch {
        // Expected when the server closes the stream or the signal aborts.
      }
    })();

    // Give the server time to actually register the SSE handler.
    // Without this, stop() might win the race and never see a real
    // live stream — which would make the test pass trivially.
    await new Promise((r) => setTimeout(r, 150));

    const start = Date.now();
    await Promise.race([
      server.stop(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('stop() exceeded 3s ceiling')), 3_000),
      ),
    ]);
    const elapsed = Date.now() - start;

    ac.abort();
    await subPromise;

    expect(elapsed).toBeLessThan(3_000);
    expect(iterationsBeforeClose).toBeGreaterThanOrEqual(0);
  }, 10_000);

  afterAll(() => {
    // Nothing to do — the test itself owns stop().
  });
});
