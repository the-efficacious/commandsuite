/**
 * Runner secrets tests — the broker-held env-secret consumption path.
 *
 * Proves against the fake broker that startRunner:
 *   1. Resolves /secrets/resolve and exposes the env map on
 *      `RunnerHandle.secretsEnv` (what the runner commands merge into
 *      the agent child's environment).
 *   2. Defensively drops reserved / malformed env names even when the
 *      broker sends them.
 *   3. Registers the literal values with the core redactor so an
 *      echoed secret is scrubbed from captured content.
 *   4. Degrades to no secrets — without failing startup — when the
 *      broker predates the endpoint (404) and when `noSecrets` is set.
 */

import { clearRegisteredSecretValues, REDACTED, redactSecrets } from 'csuite-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerHandle } from '../../src/runtime/runner.js';
import { startRunner } from '../../src/runtime/runner.js';
import {
  FAKE_BROKER_TOKEN,
  type FakeBroker,
  fakeBrokerSecrets,
  startFakeBroker,
} from './fake-broker.js';

describe('runner secrets', () => {
  let broker: FakeBroker | null = null;
  let runner: RunnerHandle | null = null;

  afterEach(async () => {
    if (runner) {
      await runner.shutdown('test-teardown');
      await runner.waitClosed;
      runner = null;
    }
    await broker?.close();
    broker = null;
    fakeBrokerSecrets.env = {};
    fakeBrokerSecrets.secretEnvNames = undefined;
    clearRegisteredSecretValues();
  });

  it('exposes resolved secrets on the handle', async () => {
    fakeBrokerSecrets.env = {
      GITHUB_TOKEN: 'ghx_fake_value_for_test',
      NPM_TOKEN: 'npm_fake_value_for_test',
    };
    broker = await startFakeBroker();
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      log: () => {},
      noTrace: true,
    });
    expect(runner.secretsEnv).toEqual({
      GITHUB_TOKEN: 'ghx_fake_value_for_test',
      NPM_TOKEN: 'npm_fake_value_for_test',
    });
  });

  it('drops reserved and malformed env names a broker might send', async () => {
    fakeBrokerSecrets.env = {
      GOOD_ONE: 'a-perfectly-fine-value',
      PATH: '/evil/bin',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://exfil.example',
      CSUITE_TOKEN: 'clobbered',
      NODE_OPTIONS: '--require /tmp/evil.js',
      LD_PRELOAD: '/tmp/evil.so',
      'lower-case': 'nope',
    };
    broker = await startFakeBroker();
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      log: () => {},
      noTrace: true,
    });
    expect(runner.secretsEnv).toEqual({ GOOD_ONE: 'a-perfectly-fine-value' });
  });

  it('registers resolved values with the core redactor', async () => {
    fakeBrokerSecrets.env = { GITHUB_TOKEN: 'ghx_should_be_scrubbed' };
    broker = await startFakeBroker();
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      log: () => {},
      noTrace: true,
    });
    expect(redactSecrets('stdout: ghx_should_be_scrubbed end')).toBe(`stdout: ${REDACTED} end`);
  });

  it('registers only the values the broker classified as secrets', async () => {
    // Criterion 2's runner half. Variables reach the agent environment
    // exactly like secrets and must NOT be registered — registering
    // them is what scrubbed members' own git identity from their own
    // traces. Both values are present in `env`; only one is in
    // `secretEnvNames`.
    fakeBrokerSecrets.env = {
      GITHUB_TOKEN: 'ghx_should_be_scrubbed',
      GIT_AUTHOR_NAME: 'Turnerlike',
    };
    fakeBrokerSecrets.secretEnvNames = ['GITHUB_TOKEN'];
    broker = await startFakeBroker();
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      log: () => {},
      noTrace: true,
    });

    // Both are injected — classification changes redaction, not delivery.
    expect(runner.secretsEnv).toEqual({
      GITHUB_TOKEN: 'ghx_should_be_scrubbed',
      GIT_AUTHOR_NAME: 'Turnerlike',
    });
    // One request, both behaviours, so a fixture cannot pass by
    // scrubbing everything or by scrubbing nothing.
    expect(redactSecrets('commit by Turnerlike using ghx_should_be_scrubbed')).toBe(
      `commit by Turnerlike using ${REDACTED}`,
    );
  });

  it('registers every value when the broker sends no classification', async () => {
    // The fallback, pinned beside the behaviour above deliberately: a
    // test asserting "only secretEnvNames are registered" invites an
    // implementation that drops the undefined case, and that case is
    // the fail-closed direction against a broker predating the split.
    // An unredacted secret is a leak; an over-redacted variable is only
    // a loss.
    fakeBrokerSecrets.env = {
      GITHUB_TOKEN: 'ghx_should_be_scrubbed',
      GIT_AUTHOR_NAME: 'Turnerlike',
    };
    fakeBrokerSecrets.secretEnvNames = undefined; // older broker
    broker = await startFakeBroker();
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      log: () => {},
      noTrace: true,
    });

    expect(redactSecrets('commit by Turnerlike using ghx_should_be_scrubbed')).toBe(
      `commit by ${REDACTED} using ${REDACTED}`,
    );
  });

  it('starts with empty secretsEnv when the broker predates /secrets/resolve', async () => {
    fakeBrokerSecrets.env = null; // endpoint 404s
    broker = await startFakeBroker();
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      log: () => {},
      noTrace: true,
    });
    expect(runner.secretsEnv).toEqual({});
  });

  it('skips resolution entirely under noSecrets', async () => {
    fakeBrokerSecrets.env = { GITHUB_TOKEN: 'ghx_should_not_appear' };
    broker = await startFakeBroker();
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      log: () => {},
      noTrace: true,
      noSecrets: true,
    });
    expect(runner.secretsEnv).toEqual({});
    // Nothing was registered with the redactor either.
    expect(redactSecrets('ghx_should_not_appear')).toBe('ghx_should_not_appear');
  });
});
