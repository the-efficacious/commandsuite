/**
 * Telemetry store + OTLP route tests.
 *
 * Covers:
 *   - append/count/list round-trip for the raw record store, including
 *     the nanosecond-timestamp read path (values above JS-number safe
 *     range must not throw on read).
 *   - The `/otlp/v1/logs` route: a bearer-authed POST returns the OTLP
 *     200 success shape and actually persists rows.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import type { Team } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { SessionStore } from '../src/sessions.js';
import { createTelemetryStore, type TelemetryRecord } from '../src/telemetry-store.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

function logRecord(
  name: string,
  tsUnixNano: number,
  extra?: Partial<TelemetryRecord>,
): TelemetryRecord {
  return {
    signal: 'log',
    name,
    tsUnixNano,
    attributes: { 'event.name': name, model: 'claude-sonnet-4-5' },
    resource: { 'service.name': 'claude-code' },
    scope: { name: 'com.anthropic.claude_code.events', version: '0.1.0' },
    payload: { body: 'hello', severityNumber: 9, severityText: 'INFO' },
    ...extra,
  };
}

describe('telemetry store', () => {
  it('appends, counts, and round-trips a read', () => {
    const db = openDatabase(':memory:');
    const store = createTelemetryStore(db);
    store.append('alice', [
      logRecord('claude_code.api_request', 1_700_000_000_000_000_000),
      {
        signal: 'metric',
        name: 'claude_code.token.usage',
        tsUnixNano: 1_700_000_000_000_000_000,
        attributes: { type: 'input' },
        resource: { 'service.name': 'claude-code' },
        scope: null,
        payload: { value: 1500, valueType: 'int', metricType: 'sum', temporality: 2 },
      },
    ]);

    expect(store.count()).toBe(2);

    const rows = store.list({ memberName: 'alice' });
    expect(rows).toHaveLength(2);

    const log = rows.find((r) => r.signal === 'log');
    expect(log?.name).toBe('claude_code.api_request');
    expect(log?.attributes.model).toBe('claude-sonnet-4-5');
    expect(log?.resource['service.name']).toBe('claude-code');
    expect(log?.scope).toEqual({ name: 'com.anthropic.claude_code.events', version: '0.1.0' });
    expect(log?.payload.body).toBe('hello');

    const metric = rows.find((r) => r.signal === 'metric');
    expect(metric?.payload.value).toBe(1500);
    expect(metric?.scope).toBeNull();
  });

  it('reads back a nanosecond timestamp without overflowing (setReadBigInts path)', () => {
    const db = openDatabase(':memory:');
    const store = createTelemetryStore(db);
    const ns = Number('1700000000000000000'); // ~1.7e18, past MAX_SAFE_INTEGER
    store.append('bob', [logRecord('claude_code.api_request', ns)]);
    // Would throw ERR_OUT_OF_RANGE without setReadBigInts on the read.
    const [row] = store.list({ memberName: 'bob' });
    expect(row).toBeDefined();
    expect(row?.tsMs).toBe(Math.trunc(ns / 1_000_000));
    expect(Number.isFinite(row?.tsUnixNano)).toBe(true);
  });

  it('filters by name and signal', () => {
    const db = openDatabase(':memory:');
    const store = createTelemetryStore(db);
    store.append('alice', [
      logRecord('claude_code.api_request', 1_000_000),
      logRecord('claude_code.api_error', 2_000_000),
    ]);
    expect(store.list({ memberName: 'alice', name: 'claude_code.api_error' })).toHaveLength(1);
    expect(store.list({ memberName: 'alice', signal: 'metric' })).toHaveLength(0);
  });

  it('is a no-op on an empty batch', () => {
    const db = openDatabase(':memory:');
    const store = createTelemetryStore(db);
    store.append('alice', []);
    expect(store.count()).toBe(0);
  });
});

const TEAM: Team = {
  name: 'demo-team',
  context: '',
  permissionPresets: {},
};

const TOKEN = 'csuite_test_telemetry';

function makeApp() {
  const broker = new Broker({ eventLog: new InMemoryEventLog() });
  const members = createMemberStore([
    {
      name: 'engineer-1',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: TOKEN,
    },
  ]);
  const db = openDatabase(':memory:');
  const telemetryStore = createTelemetryStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions: new SessionStore(db),
    telemetryStore,
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { app, telemetryStore };
}

const OTLP_LOGS_BODY = {
  resourceLogs: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
      scopeLogs: [
        {
          scope: { name: 'com.anthropic.claude_code.events', version: '0.1.0' },
          logRecords: [
            {
              timeUnixNano: '1700000000000000000',
              body: { stringValue: 'API request' },
              attributes: [
                { key: 'event.name', value: { stringValue: 'claude_code.api_request' } },
                { key: 'cost_usd', value: { doubleValue: 0.01 } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe('POST /otlp/v1/logs', () => {
  it('accepts a bearer-authed OTLP batch and stores rows', async () => {
    const { app, telemetryStore } = makeApp();
    const res = await app.request('/otlp/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(OTLP_LOGS_BODY),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partialSuccess: {} });
    expect(telemetryStore.count()).toBe(1);
    const [row] = telemetryStore.list({ memberName: 'engineer-1' });
    expect(row?.name).toBe('claude_code.api_request');
    expect(row?.attributes.cost_usd).toBe(0.01);
  });

  it('accepts the OTEL Bearer%20 header form', async () => {
    const { app, telemetryStore } = makeApp();
    const res = await app.request('/otlp/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer%20${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(OTLP_LOGS_BODY),
    });
    expect(res.status).toBe(200);
    expect(telemetryStore.count()).toBe(1);
  });

  it('401s an unauthenticated post', async () => {
    const { app, telemetryStore } = makeApp();
    const res = await app.request('/otlp/v1/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(OTLP_LOGS_BODY),
    });
    expect(res.status).toBe(401);
    expect(telemetryStore.count()).toBe(0);
  });
});
