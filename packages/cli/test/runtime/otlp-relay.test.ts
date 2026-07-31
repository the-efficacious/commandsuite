import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type OtlpRelay, startOtlpRelay } from '../../src/runtime/trace/otlp-relay.js';

function otlpBodyRecord(bodyRef: string): Record<string, unknown> {
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  { key: 'event.name', value: { stringValue: 'api_request_body' } },
                  { key: 'body_ref', value: { stringValue: bodyRef } },
                  { key: 'body_length', value: { intValue: '13' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

async function startBroker(
  response: (body: unknown, req: { url?: string; rawCount?: string }) => unknown,
): Promise<{ url: string; server: Server; received: unknown[] }> {
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      received.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          response(body, {
            ...(req.url !== undefined ? { url: req.url } : {}),
            ...(req.headers['x-csuite-raw-bodies'] !== undefined
              ? { rawCount: String(req.headers['x-csuite-raw-bodies']) }
              : {}),
          }),
        ),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('broker did not bind');
  return { url: `http://127.0.0.1:${address.port}`, server, received };
}

describe('runner-local OTLP relay', () => {
  const dirs: string[] = [];
  const relays: OtlpRelay[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(relays.splice(0).map((relay) => relay.close()));
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reads FILE-mode bodies on the runner, forwards exact inline bytes, and unlinks on ack', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csuite-relay-'));
    dirs.push(dir);
    const bodyPath = join(dir, 'request.json');
    const body = '{"hello":"世界"}';
    writeFileSync(bodyPath, body);
    const broker = await startBroker((_payload, req) => ({
      partialSuccess: {},
      csuite: { rawBodiesCaptured: Number(req.rawCount) },
    }));
    servers.push(broker.server);
    const relay = await startOtlpRelay({
      brokerUrl: broker.url,
      token: 'tok_test',
      rawBodiesDir: dir,
    });
    relays.push(relay);

    const response = await fetch(`${relay.endpoint}/v1/logs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok_test', 'Content-Type': 'application/json' },
      body: JSON.stringify(otlpBodyRecord(bodyPath)),
    });

    expect(response.status).toBe(200);
    expect(existsSync(bodyPath)).toBe(false);
    const forwarded = broker.received[0] as {
      resourceLogs: Array<{
        scopeLogs: Array<{
          logRecords: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }>;
        }>;
      }>;
    };
    const attrs = forwarded.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes ?? [];
    expect(attrs.find((attr) => attr.key === 'body')?.value.stringValue).toBe(body);
    expect(attrs.some((attr) => attr.key === 'body_ref')).toBe(false);
  });

  it('retains the only body copy and returns retryable failure without an exact capture ack', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csuite-relay-'));
    dirs.push(dir);
    const bodyPath = join(dir, 'request.json');
    writeFileSync(bodyPath, '{"hello":true}');
    const broker = await startBroker(() => ({
      partialSuccess: {},
      csuite: { rawBodiesCaptured: 0 },
    }));
    servers.push(broker.server);
    const relay = await startOtlpRelay({
      brokerUrl: broker.url,
      token: 'tok_test',
      rawBodiesDir: dir,
    });
    relays.push(relay);

    const response = await fetch(`${relay.endpoint}/v1/logs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok_test', 'Content-Type': 'application/json' },
      body: JSON.stringify(otlpBodyRecord(bodyPath)),
    });

    expect(response.status).toBe(503);
    expect(existsSync(bodyPath)).toBe(true);
  });

  it('forwards metrics without interpreting the payload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csuite-relay-'));
    dirs.push(dir);
    const broker = await startBroker(() => ({ partialSuccess: {} }));
    servers.push(broker.server);
    const relay = await startOtlpRelay({
      brokerUrl: broker.url,
      token: 'tok_test',
      rawBodiesDir: dir,
    });
    relays.push(relay);
    const payload = { resourceMetrics: [{ scopeMetrics: [] }] };

    const response = await fetch(`${relay.endpoint}/v1/metrics`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok_test', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(broker.received).toEqual([payload]);
  });

  it('does not turn loopback reachability into broker authority', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csuite-relay-'));
    dirs.push(dir);
    const broker = await startBroker(() => ({ partialSuccess: {} }));
    servers.push(broker.server);
    const relay = await startOtlpRelay({
      brokerUrl: broker.url,
      token: 'tok_test',
      rawBodiesDir: dir,
    });
    relays.push(relay);

    const response = await fetch(`${relay.endpoint}/v1/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceMetrics: [] }),
    });

    expect(response.status).toBe(401);
    expect(broker.received).toEqual([]);
  });

  it('serializes forwarding so stateful cross-batch correlation keeps exporter order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csuite-relay-'));
    dirs.push(dir);
    let active = 0;
    let maxActive = 0;
    const fetchImpl = (async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return new Response(JSON.stringify({ partialSuccess: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const relay = await startOtlpRelay({
      brokerUrl: 'http://broker.invalid',
      token: 'tok_test',
      rawBodiesDir: dir,
      fetch: fetchImpl,
    });
    relays.push(relay);
    const request = () =>
      fetch(`${relay.endpoint}/v1/metrics`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tok_test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceMetrics: [] }),
      });

    const responses = await Promise.all([request(), request()]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(maxActive).toBe(1);
  });
});
