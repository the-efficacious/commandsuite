/**
 * Defensive OTLP → `TelemetryRecord[]` parsers.
 *
 * Claude Code AND codex both export OpenTelemetry to the broker over
 * OTLP/HTTP-JSON (Claude via env-configured OTLP, codex via its
 * config.toml `[otel]` block). These functions turn a raw, untrusted
 * request body into the flat `TelemetryRecord` primitives the telemetry
 * store persists — one record per log record, one record per metric data
 * point — the same way for either producer.
 *
 * Contract:
 *   - NEVER throw. A malformed resource / scope / record / data point
 *     is skipped, not propagated. The worst case for a garbage body is
 *     an empty array.
 *   - NAME-AGNOSTIC. Every record is emitted regardless of its
 *     `event.name` / metric name — there is no allowlist. Downstream
 *     analytics decides what it cares about.
 *   - Secret-redacted. Each record's `attributes` and (for logs) the
 *     message `body` pass through core `redactJson`, which only rewrites
 *     known secret-pattern strings and otherwise leaves the primitive
 *     untouched.
 *   - PII-stripped. Codex stamps operator identity (`user.email`,
 *     `user.account_id`) on every record; those keys are removed from
 *     attributes + resource at ingest so the store never holds them.
 *
 * OTLP attribute shape:
 *   attributes: [{ key: string, value: AnyValue }]
 *   AnyValue:   { stringValue | intValue | doubleValue | boolValue |
 *                 bytesValue | arrayValue | kvlistValue }
 * Note int64 fields (`intValue`, `asInt`, `timeUnixNano`, bucket counts,
 * …) are JSON-encoded as strings; `toNumber` coerces them, accepting
 * the same `Number()`-level precision the record contract already uses.
 */

import { redactJson } from 'csuite-core';
import type { TelemetryRecord } from './telemetry-store.js';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Operator-identity attribute keys codex stamps on every OTEL record.
 * Removed from attributes + resource before storage so the telemetry
 * store never holds PII. A no-op for producers that don't emit them
 * (e.g. Claude Code).
 */
const PII_ATTR_KEYS = ['user.email', 'user.account_id'] as const;

function stripPii(obj: Record<string, unknown>): Record<string, unknown> {
  for (const k of PII_ATTR_KEYS) {
    if (k in obj) delete obj[k];
  }
  return obj;
}

/**
 * Coerce an OTLP numeric field (number, or int64-as-string) to a JS
 * number. Returns `null` when the value is absent or non-numeric.
 */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/** Like `toNumber`, but preserves the raw value when it won't coerce. */
function numberOrRaw(v: unknown): unknown {
  const n = toNumber(v);
  return n === null ? v : n;
}

/**
 * Convert a single OTLP `AnyValue` to a plain JS value. Unknown or
 * malformed shapes are returned as-is so nothing is silently dropped.
 */
export function anyValueToJs(v: unknown): unknown {
  if (!isObject(v)) return v ?? null;
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return v.boolValue;
  if ('intValue' in v) return numberOrRaw(v.intValue);
  if ('doubleValue' in v) return numberOrRaw(v.doubleValue);
  // bytesValue arrives base64-encoded; keep the string faithfully.
  if ('bytesValue' in v) return v.bytesValue;
  if ('arrayValue' in v) {
    const values = isObject(v.arrayValue) ? v.arrayValue.values : undefined;
    return asArray(values).map((e) => anyValueToJs(e));
  }
  if ('kvlistValue' in v) {
    const values = isObject(v.kvlistValue) ? v.kvlistValue.values : undefined;
    return flattenAttributes(values);
  }
  // Empty AnyValue ({}) or an unrecognized shape — pass it through.
  return v;
}

/**
 * Flatten an OTLP attribute list `[{ key, value }]` into a plain
 * object. Entries without a string `key` are skipped.
 */
export function flattenAttributes(attrs: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of asArray(attrs)) {
    if (!isObject(kv)) continue;
    const key = kv.key;
    if (typeof key !== 'string') continue;
    out[key] = anyValueToJs(kv.value);
  }
  return out;
}

/** Instrumentation scope → `{ name, version }`, or null when empty. */
function scopeToJson(scope: unknown): Record<string, unknown> | null {
  if (!isObject(scope)) return null;
  const name = typeof scope.name === 'string' ? scope.name : null;
  const version = typeof scope.version === 'string' ? scope.version : null;
  if (name === null && version === null) return null;
  return { name, version };
}

/**
 * Parse an OTLP/JSON `ExportLogsServiceRequest` into one record per log
 * record. Every record is kept regardless of `event.name`.
 */
export function parseOtlpLogs(payload: unknown): TelemetryRecord[] {
  const out: TelemetryRecord[] = [];
  const root = isObject(payload) ? payload : {};
  for (const rl of asArray(root.resourceLogs)) {
    if (!isObject(rl)) continue;
    const resource = stripPii(
      flattenAttributes(isObject(rl.resource) ? rl.resource.attributes : undefined),
    );
    for (const sl of asArray(rl.scopeLogs)) {
      if (!isObject(sl)) continue;
      const scope = scopeToJson(sl.scope);
      for (const lr of asArray(sl.logRecords)) {
        if (!isObject(lr)) continue;
        try {
          const attributes = stripPii(redactJson(flattenAttributes(lr.attributes)));
          const eventName = attributes['event.name'];
          const name =
            typeof eventName === 'string' && eventName.length > 0 ? eventName : '(unnamed)';
          const tsUnixNano = toNumber(lr.timeUnixNano) ?? toNumber(lr.observedTimeUnixNano) ?? 0;
          out.push({
            signal: 'log',
            name,
            tsUnixNano,
            attributes,
            resource,
            scope,
            payload: {
              body: redactJson(anyValueToJs(lr.body)),
              severityNumber: lr.severityNumber ?? null,
              severityText: lr.severityText ?? null,
            },
          });
        } catch {
          // Skip a single malformed record; never abort the batch.
        }
      }
    }
  }
  return out;
}

const METRIC_KINDS = ['sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary'] as const;
type MetricKind = (typeof METRIC_KINDS)[number];

/** Identify which data container a metric carries (first one wins). */
function metricKind(
  metric: Record<string, unknown>,
): { metricType: MetricKind; container: Record<string, unknown> } | null {
  for (const k of METRIC_KINDS) {
    const container = metric[k];
    if (isObject(container)) return { metricType: k, container };
  }
  return null;
}

function numberArray(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((e) => toNumber(e) ?? 0);
}

/**
 * Extract the value + a `valueType` tag from a single data point. Scalar
 * points carry `asInt`/`asDouble`; histogram/summary points carry an
 * aggregate object faithfully capturing count/sum/bounds.
 */
function dataPointValue(
  dp: Record<string, unknown>,
  metricType: MetricKind,
): { value: unknown; valueType: string } {
  if (dp.asInt !== undefined && dp.asInt !== null) {
    return { value: numberOrRaw(dp.asInt), valueType: 'int' };
  }
  if (dp.asDouble !== undefined && dp.asDouble !== null) {
    return { value: numberOrRaw(dp.asDouble), valueType: 'double' };
  }
  if (metricType === 'histogram') {
    return {
      value: {
        count: toNumber(dp.count),
        sum: toNumber(dp.sum),
        min: toNumber(dp.min),
        max: toNumber(dp.max),
        bucketCounts: numberArray(dp.bucketCounts),
        explicitBounds: numberArray(dp.explicitBounds),
      },
      valueType: 'histogram',
    };
  }
  if (metricType === 'exponentialHistogram') {
    return {
      value: {
        count: toNumber(dp.count),
        sum: toNumber(dp.sum),
        min: toNumber(dp.min),
        max: toNumber(dp.max),
        scale: toNumber(dp.scale),
        zeroCount: toNumber(dp.zeroCount),
      },
      valueType: 'exponentialHistogram',
    };
  }
  if (metricType === 'summary') {
    const quantiles = asArray(dp.quantileValues)
      .filter(isObject)
      .map((q) => ({ quantile: toNumber(q.quantile), value: toNumber(q.value) }));
    return {
      value: {
        count: toNumber(dp.count),
        sum: toNumber(dp.sum),
        quantileValues: quantiles,
      },
      valueType: 'summary',
    };
  }
  // Scalar sum/gauge point with neither asInt nor asDouble present.
  return { value: null, valueType: 'unknown' };
}

/**
 * Parse an OTLP/JSON `ExportMetricsServiceRequest` into one record per
 * metric data point. Every metric is kept regardless of name.
 */
export function parseOtlpMetrics(payload: unknown): TelemetryRecord[] {
  const out: TelemetryRecord[] = [];
  const root = isObject(payload) ? payload : {};
  for (const rm of asArray(root.resourceMetrics)) {
    if (!isObject(rm)) continue;
    const resource = stripPii(
      flattenAttributes(isObject(rm.resource) ? rm.resource.attributes : undefined),
    );
    for (const sm of asArray(rm.scopeMetrics)) {
      if (!isObject(sm)) continue;
      const scope = scopeToJson(sm.scope);
      for (const metric of asArray(sm.metrics)) {
        if (!isObject(metric)) continue;
        const kind = metricKind(metric);
        if (kind === null) continue;
        const { metricType, container } = kind;
        const name = typeof metric.name === 'string' ? metric.name : '(unnamed)';
        const unit = typeof metric.unit === 'string' ? metric.unit : null;
        const description = typeof metric.description === 'string' ? metric.description : null;
        const temporality = container.aggregationTemporality ?? null;
        const isMonotonic =
          metricType === 'sum' && typeof container.isMonotonic === 'boolean'
            ? container.isMonotonic
            : null;
        for (const dp of asArray(container.dataPoints)) {
          if (!isObject(dp)) continue;
          try {
            const attributes = stripPii(redactJson(flattenAttributes(dp.attributes)));
            const tsUnixNano = toNumber(dp.timeUnixNano) ?? 0;
            const { value, valueType } = dataPointValue(dp, metricType);
            out.push({
              signal: 'metric',
              name,
              tsUnixNano,
              attributes,
              resource,
              scope,
              payload: {
                value,
                valueType,
                metricType,
                unit,
                description,
                temporality,
                isMonotonic,
              },
            });
          } catch {
            // Skip a single malformed data point; never abort the batch.
          }
        }
      }
    }
  }
  return out;
}
