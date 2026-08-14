import { afterEach, describe, expect, it } from 'vitest';
import { type RunnerHandle, startRunner } from '../../src/runtime/runner.js';
import { silentLogger } from '../helpers/logger.js';
import {
  FAKE_BROKER_TOKEN,
  type FakeBroker,
  fakeBrokerCapabilities,
  startFakeBroker,
} from './fake-broker.js';

describe('runner capture compatibility', () => {
  let broker: FakeBroker | null = null;
  let runner: RunnerHandle | null = null;

  afterEach(async () => {
    if (runner !== null) {
      await runner.shutdown('test-teardown');
      await runner.waitClosed;
      runner = null;
    }
    await broker?.close();
    broker = null;
    fakeBrokerCapabilities.rawBodyAck = true;
  });

  it('fails loudly before Claude launches against a broker without raw-body acknowledgement', async () => {
    fakeBrokerCapabilities.rawBodyAck = false;
    broker = await startFakeBroker();

    await expect(
      startRunner({
        url: broker.url,
        token: FAKE_BROKER_TOKEN,
        logger: silentLogger(),
        noSecrets: true,
        requireRawBodyAck: true,
      }),
    ).rejects.toThrow('upgrade the broker before launching the runner');
  });

  it('does not impose the Claude acknowledgement capability on Codex capture', async () => {
    fakeBrokerCapabilities.rawBodyAck = false;
    broker = await startFakeBroker();

    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      logger: silentLogger(),
      noSecrets: true,
    });

    expect(runner.captureHost).not.toBeNull();
  });
});
