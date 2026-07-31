/**
 * Runner-local OTLP relay for Claude Code.
 *
 * Claude's FILE raw-body mode emits absolute `body_ref` paths. Those paths
 * are meaningful only on the runner. This relay receives Claude's native
 * OTLP/HTTP JSON on loopback, replaces every in-spool `body_ref` attribute
 * with the byte-exact UTF-8 body, and forwards the otherwise unchanged batch
 * to the broker. Operational logs and metrics pass through untouched.
 *
 * A broker 2xx is not sufficient acknowledgement: the OTLP route deliberately
 * contains ingest errors so an exporter is not wedged forever. CommandSuite's
 * broker therefore returns `csuite.rawBodiesCaptured`; files are unlinked only
 * when that count exactly equals the number resolved in this batch.
 */

import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { isAbsolute, relative, resolve } from 'node:path';

const MAX_OTLP_BYTES = 256 * 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

type Log = (msg: string, ctx?: Record<string, unknown>) => void;

export interface OtlpRelayOptions {
  brokerUrl: string;
  token: string;
  rawBodiesDir: string;
  fetch?: typeof fetch;
  log?: Log;
}

export interface OtlpRelay {
  /** Base endpoint for `OTEL_EXPORTER_OTLP_ENDPOINT` (ends in `/otlp`). */
  readonly endpoint: string;
  close(): Promise<void>;
}

interface OtlpAttribute {
  key?: unknown;
  value?: { stringValue?: unknown };
}

function bodyRefsToInline(
  raw: unknown,
  spoolDir: string,
): { payload: unknown; refs: string[]; unresolved: string[] } {
  const refs: string[] = [];
  const unresolved: string[] = [];
  if (!raw || typeof raw !== 'object') return { payload: raw, refs, unresolved };
  const resourceLogs = (raw as { resourceLogs?: unknown }).resourceLogs;
  if (!Array.isArray(resourceLogs)) return { payload: raw, refs, unresolved };

  for (const resource of resourceLogs) {
    if (!resource || typeof resource !== 'object') continue;
    const scopeLogs = (resource as { scopeLogs?: unknown }).scopeLogs;
    if (!Array.isArray(scopeLogs)) continue;
    for (const scope of scopeLogs) {
      if (!scope || typeof scope !== 'object') continue;
      const records = (scope as { logRecords?: unknown }).logRecords;
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (!record || typeof record !== 'object') continue;
        const attrs = (record as { attributes?: unknown }).attributes;
        if (!Array.isArray(attrs)) continue;
        const refAttr = (attrs as OtlpAttribute[]).find((attr) => attr?.key === 'body_ref');
        const bodyRef = refAttr?.value?.stringValue;
        if (typeof bodyRef !== 'string' || bodyRef.length === 0) continue;
        const inlineAttr = (attrs as OtlpAttribute[]).findLast(
          (attr) => attr?.key === 'body' && typeof attr.value?.stringValue === 'string',
        );

        try {
          const absoluteRef = resolve(bodyRef);
          const rel = relative(spoolDir, absoluteRef);
          if (!isAbsolute(absoluteRef) || rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
            throw new Error('outside the runner spool');
          }
          const stat = statSync(absoluteRef);
          if (!stat.isFile()) throw new Error('not a file');
          if (stat.size > MAX_BODY_BYTES) throw new Error(`exceeds ${MAX_BODY_BYTES} bytes`);
          const bytes = readFileSync(absoluteRef);
          const text = bytes.toString('utf8');
          if (!Buffer.from(text, 'utf8').equals(bytes)) {
            throw new Error('not byte-exact UTF-8 JSON');
          }
          if (refAttr === undefined) continue;
          // Claude may emit an inline `body` beside the FILE-mode
          // `body_ref`. Converting the ref in place without removing that
          // attribute creates duplicate `body` keys; the broker flattens
          // attributes last-wins, so array order would decide whether the
          // acknowledged spool bytes were actually stored. A resolved ref is
          // authoritative: leave exactly one body attribute carrying its
          // byte-exact contents before the file can enter the unlink set.
          for (let i = attrs.length - 1; i >= 0; i--) {
            const attr = (attrs as OtlpAttribute[])[i];
            if (attr !== refAttr && attr?.key === 'body') attrs.splice(i, 1);
          }
          refAttr.key = 'body';
          refAttr.value = { stringValue: text };
          refs.push(absoluteRef);
        } catch (err) {
          // A broken ref must not suppress a usable inline body. The broker's
          // correlator prefers body_ref and only considers body in an `else
          // if`, so forwarding both would discard the fallback. Keep exactly
          // one inline body, remove the failed ref, and do not add the ref to
          // the acknowledgement/unlink set. Without an inline fallback,
          // preserve the ref for the broker's established per-record skip.
          if (inlineAttr !== undefined && refAttr !== undefined) {
            for (let i = attrs.length - 1; i >= 0; i--) {
              const attr = (attrs as OtlpAttribute[])[i];
              if (attr === refAttr || (attr !== inlineAttr && attr?.key === 'body')) {
                attrs.splice(i, 1);
              }
            }
          }
          unresolved.push(`${bodyRef}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  return { payload: raw, refs, unresolved };
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OTLP_BYTES) {
        reject(new Error(`OTLP payload exceeded ${MAX_OTLP_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startOtlpRelay(options: OtlpRelayOptions): Promise<OtlpRelay> {
  const log = options.log ?? (() => {});
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const brokerBase = options.brokerUrl.replace(/\/+$/, '');
  const spoolDir = resolve(options.rawBodiesDir);
  let closing = false;
  let forwardTail: Promise<void> = Promise.resolve();

  const server: Server = createServer(async (req, res) => {
    if (closing || req.method !== 'POST' || !/^\/otlp\/v1\/(logs|metrics)$/.test(req.url ?? '')) {
      res.writeHead(closing ? 503 : 404, { 'Content-Type': 'text/plain' });
      res.end(closing ? 'relay closing' : 'not found');
      return;
    }
    // Loopback is a reachability boundary, not an authority boundary. Claude
    // already sends this bearer from OTEL_EXPORTER_OTLP_HEADERS; require it
    // before proxying anything with the member's broker credential.
    if (req.headers.authorization !== `Bearer ${options.token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing or invalid relay credentials' }));
      return;
    }
    // The broker correlator holds FIFO/request-id state across OTLP batches.
    // Preserve exporter arrival order even when an earlier batch has larger
    // body files and therefore takes longer to resolve than a later batch.
    const predecessor = forwardTail;
    let releaseQueue = () => {};
    forwardTail = new Promise<void>((resolveQueue) => {
      releaseQueue = resolveQueue;
    });
    await predecessor;
    try {
      const input = await readRequestBody(req);
      let output = input;
      let refs: string[] = [];
      if (req.url === '/otlp/v1/logs') {
        const parsed = JSON.parse(input.toString('utf8')) as unknown;
        const transformed = bodyRefsToInline(parsed, spoolDir);
        refs = transformed.refs;
        if (transformed.unresolved.length > 0) {
          log('otlp-relay: raw body unavailable; forwarding record for broker-side skip', {
            count: transformed.unresolved.length,
            errors: transformed.unresolved,
          });
        }
        output = Buffer.from(JSON.stringify(transformed.payload), 'utf8');
      }

      const upstream = await fetchImpl(`${brokerBase}${req.url}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
          'X-CSuite-Raw-Bodies': String(refs.length),
        },
        body: Uint8Array.from(output),
      });
      const responseBytes = Buffer.from(await upstream.arrayBuffer());
      let captured = 0;
      if (refs.length > 0) {
        try {
          const result = JSON.parse(responseBytes.toString('utf8')) as {
            csuite?: { rawBodiesCaptured?: unknown };
          };
          if (typeof result.csuite?.rawBodiesCaptured === 'number') {
            captured = result.csuite.rawBodiesCaptured;
          }
        } catch {
          // The count remains zero; the exporter gets a retryable failure below.
        }
      }
      const acknowledged = upstream.ok && (refs.length === 0 || captured === refs.length);
      if (acknowledged) {
        for (const ref of new Set(refs)) unlinkSync(ref);
      } else if (refs.length > 0) {
        log('otlp-relay: broker did not acknowledge every raw body', {
          expected: refs.length,
          captured,
          status: upstream.status,
        });
      }

      res.writeHead(acknowledged ? upstream.status : 503, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      });
      res.end(responseBytes);
    } catch (err) {
      log('otlp-relay: forward failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'capture relay failed' }));
    } finally {
      releaseQueue();
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('OTLP relay did not bind a TCP port');
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}/otlp`,
    async close() {
      if (closing) return;
      closing = true;
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
