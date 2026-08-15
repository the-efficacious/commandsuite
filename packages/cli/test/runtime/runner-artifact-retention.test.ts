/**
 * The two runner artefacts that used to grow forever.
 *
 * `<spool>.quarantine` held the only copy of every body the relay could
 * not resolve, and its own comment said retention there was unbounded —
 * deliberately, because deleting a payload by age would erase the only
 * record that a gap existed. `~/.cache/commandsuite/session-<pid>.log`
 * was never rotated or cleaned at all.
 *
 * The quarantine sweep separates the bytes from the fact: it appends a
 * manifest line describing what went missing, THEN unlinks the payload.
 * So the assertions below come in pairs — the payload is gone AND the
 * record of it survives. A sweep that satisfied only the first would be
 * the data loss this design exists to avoid.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepStaleSessionLogs } from '../../src/runtime/session-log.js';
import { QUARANTINE_MAX_AGE_MS, sweepQuarantine } from '../../src/runtime/trace/otlp-relay.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_770_000_000_000;

let roots: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'csuite-retention-test-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  roots = [];
});

/** Write a quarantined payload aged `ageMs` before NOW. */
function quarantined(spool: string, name: string, ageMs: number, body = 'x'.repeat(64)): string {
  const dir = `${spool}.quarantine`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${name}.invalid-utf8.1700000000000.abc.quarantined`);
  writeFileSync(file, body);
  const when = new Date(NOW - ageMs);
  utimesSync(file, when, when);
  return file;
}

function manifestLines(spool: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(`${spool}.quarantine`, 'swept.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe('quarantine retention', () => {
  it('reclaims an aged payload AND keeps a durable record of the gap', () => {
    const spool = join(scratch(), 'csuite-otel-bodies-alice-999');
    quarantined(spool, 'body-1', 30 * DAY, 'y'.repeat(128));

    const result = sweepQuarantine(spool, { now: NOW });

    expect(result.removed).toBe(1);
    expect(result.bytesReclaimed).toBe(128);
    // The bytes are gone…
    const left = readdirSync(`${spool}.quarantine`).filter((f) => f.endsWith('.quarantined'));
    expect(left).toEqual([]);
    // …and the fact that a body went missing is not.
    const lines = manifestLines(spool);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ reason: 'invalid-utf8', bytes: 128, sweptAt: NOW });
    expect(String(lines[0]?.name)).toContain('body-1');
  });

  it('KEEPS a payload inside the retention window', () => {
    // The nearest valid thing the sweep must not touch. Without this a
    // sweep that deleted everything would pass the test above.
    const spool = join(scratch(), 'csuite-otel-bodies-alice-998');
    quarantined(spool, 'recent', 1 * DAY);

    const result = sweepQuarantine(spool, { now: NOW });

    expect(result.removed).toBe(0);
    expect(readdirSync(`${spool}.quarantine`).some((f) => f.includes('recent'))).toBe(true);
    expect(manifestLines(spool)).toEqual([]);
  });

  it('sweeps exactly at the boundary, not one side of it only', () => {
    const spool = join(scratch(), 'csuite-otel-bodies-alice-997');
    quarantined(spool, 'just-old', QUARANTINE_MAX_AGE_MS + 1000);
    quarantined(spool, 'just-new', QUARANTINE_MAX_AGE_MS - 1000);

    sweepQuarantine(spool, { now: NOW });

    const left = readdirSync(`${spool}.quarantine`).filter((f) => f.endsWith('.quarantined'));
    expect(left).toHaveLength(1);
    expect(left[0]).toContain('just-new');
  });

  it('accumulates one manifest line per sweep rather than overwriting', () => {
    // The record is durable across runs, not just within one.
    const spool = join(scratch(), 'csuite-otel-bodies-alice-996');
    quarantined(spool, 'first', 30 * DAY);
    sweepQuarantine(spool, { now: NOW });
    quarantined(spool, 'second', 30 * DAY);
    sweepQuarantine(spool, { now: NOW + 1000 });

    const lines = manifestLines(spool);
    expect(lines).toHaveLength(2);
    expect(String(lines[0]?.name)).toContain('first');
    expect(String(lines[1]?.name)).toContain('second');
  });

  it('is a no-op on a spool that never quarantined anything', () => {
    const spool = join(scratch(), 'csuite-otel-bodies-alice-995');
    expect(sweepQuarantine(spool, { now: NOW })).toEqual({
      removed: 0,
      bytesReclaimed: 0,
      failed: 0,
    });
  });
});

describe('session log retention', () => {
  it('removes an aged log and spares a recent one', () => {
    const dir = scratch();
    const old = join(dir, 'session-1234.log');
    const recent = join(dir, 'session-5678.log');
    writeFileSync(old, '{}\n');
    writeFileSync(recent, '{}\n');
    const aged = new Date(NOW - 30 * DAY);
    utimesSync(old, aged, aged);
    const fresh = new Date(NOW - 60_000);
    utimesSync(recent, fresh, fresh);

    const result = sweepStaleSessionLogs({ dir, now: NOW });

    expect(result.removed).toBe(1);
    const left = readdirSync(dir);
    expect(left).toContain('session-5678.log');
    expect(left).not.toContain('session-1234.log');
  });

  it('never removes the live process own log, however old the mtime', () => {
    // A long-running runner holds its fd; deleting the file it is
    // writing to would silently orphan every later record.
    const dir = scratch();
    const own = join(dir, `session-${process.pid}.log`);
    writeFileSync(own, '{}\n');
    const aged = new Date(NOW - 365 * DAY);
    utimesSync(own, aged, aged);

    const result = sweepStaleSessionLogs({ dir, now: NOW });

    expect(result.removed).toBe(0);
    expect(readdirSync(dir)).toContain(`session-${process.pid}.log`);
  });

  it('leaves unrelated files alone', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'notes.txt'), 'keep me');
    const aged = new Date(NOW - 365 * DAY);
    utimesSync(join(dir, 'notes.txt'), aged, aged);

    sweepStaleSessionLogs({ dir, now: NOW });

    expect(readdirSync(dir)).toContain('notes.txt');
  });

  it('is a no-op on a directory that does not exist', () => {
    expect(sweepStaleSessionLogs({ dir: join(tmpdir(), 'csuite-nope-does-not-exist') })).toEqual({
      removed: 0,
      failed: 0,
    });
  });
});
