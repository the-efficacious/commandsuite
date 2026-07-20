/**
 * OTLP → TelemetryRecord parser tests.
 *
 * Pins the two load-bearing guarantees of the sink:
 *   - NAME-AGNOSTIC: a known event/metric name and an unknown one are
 *     parsed identically — no allowlist.
 *   - Faithful flattening: string/int/double/bool attributes,
 *     resource attrs, scope, body, and per-data-point metric values all
 *     survive the round trip into a flat record.
 */

import { describe, expect, it } from 'vitest';
import {
  anyValueToJs,
  flattenAttributes,
  parseOtlpLogs,
  parseOtlpMetrics,
} from '../src/otlp-parse.js';

const LOGS_PAYLOAD = {
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'claude-code' } },
          { key: 'service.version', value: { stringValue: '1.2.3' } },
          { key: 'os.type', value: { stringValue: 'linux' } },
        ],
      },
      scopeLogs: [
        {
          scope: { name: 'com.anthropic.claude_code.events', version: '0.1.0' },
          logRecords: [
            {
              timeUnixNano: '1700000000000000000',
              observedTimeUnixNano: '1700000000000000000',
              severityNumber: 9,
              severityText: 'INFO',
              body: { stringValue: 'API request succeeded' },
              attributes: [
                { key: 'event.name', value: { stringValue: 'claude_code.api_request' } },
                { key: 'model', value: { stringValue: 'claude-sonnet-4-5' } },
                { key: 'cost_usd', value: { doubleValue: 0.0123 } },
                { key: 'input_tokens', value: { intValue: '1500' } },
                { key: 'cache_read', value: { boolValue: true } },
              ],
            },
            {
              // Deliberately an event.name the broker has never heard of.
              timeUnixNano: '1700000000123000000',
              severityText: 'INFO',
              body: { stringValue: 'something new happened' },
              attributes: [
                { key: 'event.name', value: { stringValue: 'claude_code.some_future_event' } },
                { key: 'novel_field', value: { intValue: '7' } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const METRICS_PAYLOAD = {
  resourceMetrics: [
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }],
      },
      scopeMetrics: [
        {
          scope: { name: 'com.anthropic.claude_code', version: '0.1.0' },
          metrics: [
            {
              name: 'claude_code.token.usage',
              unit: 'tokens',
              description: 'Number of tokens used',
              sum: {
                aggregationTemporality: 2,
                isMonotonic: true,
                dataPoints: [
                  {
                    timeUnixNano: '1700000000000000000',
                    asInt: '1500',
                    attributes: [{ key: 'type', value: { stringValue: 'input' } }],
                  },
                  {
                    timeUnixNano: '1700000000000000000',
                    asInt: '42',
                    attributes: [{ key: 'type', value: { stringValue: 'output' } }],
                  },
                ],
              },
            },
            {
              name: 'claude_code.session.count',
              gauge: {
                dataPoints: [
                  {
                    timeUnixNano: '1700000000000000000',
                    asDouble: 1,
                    attributes: [],
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};

describe('anyValueToJs / flattenAttributes', () => {
  it('coerces each AnyValue scalar shape', () => {
    expect(anyValueToJs({ stringValue: 'x' })).toBe('x');
    expect(anyValueToJs({ boolValue: false })).toBe(false);
    expect(anyValueToJs({ intValue: '99' })).toBe(99);
    expect(anyValueToJs({ doubleValue: 1.5 })).toBe(1.5);
  });

  it('recurses through arrayValue and kvlistValue', () => {
    expect(
      anyValueToJs({ arrayValue: { values: [{ stringValue: 'a' }, { intValue: '2' }] } }),
    ).toEqual(['a', 2]);
    expect(
      anyValueToJs({
        kvlistValue: { values: [{ key: 'k', value: { stringValue: 'v' } }] },
      }),
    ).toEqual({ k: 'v' });
  });

  it('flattens an attribute list and skips keyless entries', () => {
    expect(
      flattenAttributes([
        { key: 'a', value: { stringValue: 'x' } },
        { value: { stringValue: 'orphan' } },
        { key: 'b', value: { intValue: '3' } },
      ]),
    ).toEqual({ a: 'x', b: 3 });
  });

  it('never throws on garbage input', () => {
    expect(flattenAttributes(null)).toEqual({});
    expect(flattenAttributes('nope')).toEqual({});
    expect(anyValueToJs(undefined)).toBe(null);
  });
});

describe('parseOtlpLogs', () => {
  it('parses both a known and an unknown event (name-agnostic)', () => {
    const records = parseOtlpLogs(LOGS_PAYLOAD);
    expect(records).toHaveLength(2);
    const names = records.map((r) => r.name);
    expect(names).toContain('claude_code.api_request');
    expect(names).toContain('claude_code.some_future_event');
    for (const r of records) expect(r.signal).toBe('log');
  });

  it('flattens attributes across every scalar type', () => {
    const [known] = parseOtlpLogs(LOGS_PAYLOAD);
    expect(known?.attributes).toMatchObject({
      'event.name': 'claude_code.api_request',
      model: 'claude-sonnet-4-5',
      cost_usd: 0.0123,
      input_tokens: 1500,
      cache_read: true,
    });
    expect(typeof known?.attributes.input_tokens).toBe('number');
    expect(typeof known?.attributes.cache_read).toBe('boolean');
  });

  it('captures resource, scope, body, severity, and timestamp', () => {
    const [known] = parseOtlpLogs(LOGS_PAYLOAD);
    expect(known?.resource).toMatchObject({
      'service.name': 'claude-code',
      'service.version': '1.2.3',
      'os.type': 'linux',
    });
    expect(known?.scope).toEqual({
      name: 'com.anthropic.claude_code.events',
      version: '0.1.0',
    });
    expect(known?.payload.body).toBe('API request succeeded');
    expect(known?.payload.severityText).toBe('INFO');
    expect(known?.payload.severityNumber).toBe(9);
    expect(known?.tsUnixNano).toBeGreaterThan(0);
  });

  it('returns [] for malformed / empty payloads', () => {
    expect(parseOtlpLogs(null)).toEqual([]);
    expect(parseOtlpLogs({})).toEqual([]);
    expect(parseOtlpLogs({ resourceLogs: 'nope' })).toEqual([]);
  });

  it('strips codex operator PII (user.email / user.account_id) at ingest', () => {
    // Shape codex 0.130.0 emits: identity attrs on every log record.
    const CODEX_LOGS = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'codex_exec' } },
              { key: 'user.email', value: { stringValue: 'leak@example.com' } },
            ],
          },
          scopeLogs: [
            {
              scope: { name: 'codex', version: '0.130.0' },
              logRecords: [
                {
                  timeUnixNano: '1700000000000000000',
                  body: { stringValue: 'ok' },
                  attributes: [
                    { key: 'event.name', value: { stringValue: 'codex.api_request' } },
                    { key: 'user.email', value: { stringValue: 'leak@example.com' } },
                    { key: 'user.account_id', value: { stringValue: 'debf9ad1-uuid' } },
                    { key: 'input_token_count', value: { intValue: '17148' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const [rec] = parseOtlpLogs(CODEX_LOGS);
    // Operational data survives; identity is gone from both attrs + resource.
    expect(rec?.attributes.input_token_count).toBe(17148);
    expect(rec?.attributes['user.email']).toBeUndefined();
    expect(rec?.attributes['user.account_id']).toBeUndefined();
    expect(rec?.resource['user.email']).toBeUndefined();
    expect(rec?.resource['service.name']).toBe('codex_exec');
  });
});

describe('parseOtlpMetrics', () => {
  it('emits one record per data point with value + temporality + attributes', () => {
    const records = parseOtlpMetrics(METRICS_PAYLOAD);
    // 2 sum data points + 1 gauge data point.
    expect(records).toHaveLength(3);
    for (const r of records) expect(r.signal).toBe('metric');

    const usage = records.filter((r) => r.name === 'claude_code.token.usage');
    expect(usage).toHaveLength(2);
    const byType = new Map(usage.map((r) => [r.attributes.type, r]));
    expect(byType.get('input')?.payload.value).toBe(1500);
    expect(byType.get('output')?.payload.value).toBe(42);
    for (const r of usage) {
      expect(r.payload.metricType).toBe('sum');
      expect(r.payload.temporality).toBe(2);
      expect(r.payload.isMonotonic).toBe(true);
      expect(r.payload.unit).toBe('tokens');
      expect(r.payload.valueType).toBe('int');
    }
  });

  it('parses a gauge data point (name-agnostic, double value)', () => {
    const records = parseOtlpMetrics(METRICS_PAYLOAD);
    const gauge = records.find((r) => r.name === 'claude_code.session.count');
    expect(gauge?.payload.metricType).toBe('gauge');
    expect(gauge?.payload.value).toBe(1);
    expect(gauge?.payload.valueType).toBe('double');
    expect(gauge?.payload.isMonotonic).toBeNull();
  });

  it('returns [] for malformed / empty payloads', () => {
    expect(parseOtlpMetrics(null)).toEqual([]);
    expect(parseOtlpMetrics({})).toEqual([]);
    expect(parseOtlpMetrics({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{}] }] }] })).toEqual(
      [],
    );
  });
});
