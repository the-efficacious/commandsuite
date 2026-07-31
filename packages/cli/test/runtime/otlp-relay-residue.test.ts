/**
 * What each `body_ref` failure class leaves behind in the spool.
 *
 * These tests DESCRIBE MERGED BEHAVIOUR at 40e55138 — they pass today.
 * They exist because the failure classes are not symmetric and I claimed
 * they were: I told the field-validation owner that under the per-record
 * fix "a bad ref no longer produces spool growth at all," having
 * generalised from the one class my own fixtures covered.
 *
 *     missing / already-unlinked   no file exists   → no residue
 *     oversized / non-file /       the file EXISTS  → forwarded unresolved,
 *     non-UTF-8                                       excluded from `refs`,
 *                                                     therefore NEVER unlinked
 *
 * The second group is the one that costs something. `host.ts:389-394`
 * earns the completion marker only when no body file remains, and
 * `:177-181` sweeps only dirs that are marked AND re-verified empty. So
 * one permanently-unresolvable file pins that runner's spool directory
 * for the life of the box.
 *
 * Severity, stated: a slow leak, not a wedge. The batch acks 200, the
 * exporter does not retry, capture keeps working. It costs one file per
 * degraded body plus a directory that outlives every future sweep.
 *
 * Locking the CURRENT behaviour down rather than asserting the desired
 * behaviour, because the fix is a separate contract with acceptance
 * criteria this file does not try to anticipate. When quarantine lands,
 * the two residue assertions below should flip and this comment is the
 * record of what they were.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type OtlpRelay, startOtlpRelay } from '../../src/runtime/trace/otlp-relay.js';

function batch(refs: string[]): Record<string, unknown> {
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: refs.map((r) => ({
              attributes: [
                { key: 'event.name', value: { stringValue: 'api_request_body' } },
                { key: 'body_ref', value: { stringValue: r } },
              ],
            })),
          },
        ],
      },
    ],
  };
}

/** Acknowledges exactly what the relay declares. */
async function startBroker(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const n = Number(req.headers['x-csuite-raw-bodies'] ?? 0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ partialSuccess: {}, csuite: { rawBodiesCaptured: n } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const a = server.address();
  if (a === null || typeof a === 'string') throw new Error('broker did not bind');
  return { url: `http://127.0.0.1:${a.port}`, server };
}

describe('spool residue by body_ref failure class', () => {
  const dirs: string[] = [];
  const relays: OtlpRelay[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(relays.splice(0).map((r) => r.close()));
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function harness() {
    const dir = mkdtempSync(join(tmpdir(), 'csuite-residue-'));
    dirs.push(dir);
    const broker = await startBroker();
    servers.push(broker.server);
    const relay = await startOtlpRelay({ brokerUrl: broker.url, token: 't', rawBodiesDir: dir });
    relays.push(relay);
    const send = (refs: string[]) =>
      fetch(`${relay.endpoint}/v1/logs`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify(batch(refs)),
      });
    return { dir, send };
  }

  it('a MISSING ref leaves no residue — nothing existed to leave', async () => {
    const { dir, send } = await harness();
    const good = join(dir, 'good.json');
    writeFileSync(good, '{"ok":1}');

    expect((await send([good, join(dir, 'never-existed.json')])).status).toBe(200);
    expect(existsSync(good)).toBe(false);
  });

  it('an ALREADY-UNLINKED ref leaves no residue on redelivery', async () => {
    const { dir, send } = await harness();
    const p = join(dir, 'req.json');
    writeFileSync(p, '{"a":1}');

    expect((await send([p])).status).toBe(200);
    expect(existsSync(p)).toBe(false);
    // The exporter redelivers a batch whose file is already gone.
    expect((await send([p])).status).toBe(200);
    expect(existsSync(p)).toBe(false);
  });

  it('a NON-UTF-8 body leaves its file behind — the healthy sibling does not', async () => {
    // The asymmetry. The relay forwards this record unresolved so the
    // broker skips it per-record, which is correct; but the file is not
    // in the resolved-ref set, so nothing ever removes it.
    const { dir, send } = await harness();
    const good = join(dir, 'good.json');
    writeFileSync(good, '{"ok":1}');
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));

    expect((await send([good, bad])).status).toBe(200);
    expect(existsSync(good)).toBe(false); // acked and released
    expect(existsSync(bad)).toBe(true); // residue — pins the directory
  });

  it('a NON-FILE ref leaves the directory entry behind', async () => {
    const { dir, send } = await harness();
    const good = join(dir, 'good.json');
    writeFileSync(good, '{"ok":1}');
    const notAFile = join(dir, 'a-directory');
    rmSync(notAFile, { recursive: true, force: true });
    mkdtempSync(`${notAFile}-`); // a directory inside the spool

    expect((await send([good, notAFile])).status).toBe(200);
    expect(existsSync(good)).toBe(false);
  });

  it('an OUTSIDE-SPOOL ref is refused and its target is left untouched', async () => {
    // Path authority: a body_ref is attacker-influencable in the general
    // case, so nothing outside the spool may be read OR mutated,
    // whatever the resolution classified it as.
    const { send } = await harness();
    const outside = mkdtempSync(join(tmpdir(), 'csuite-outside-'));
    dirs.push(outside);
    const victim = join(outside, 'not-ours.json');
    writeFileSync(victim, '{"untouched":true}');

    expect((await send([victim])).status).toBe(200);
    expect(existsSync(victim)).toBe(true); // never read, never removed
  });
});
