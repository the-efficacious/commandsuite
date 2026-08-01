/**
 * Census guard — the next completeness warning cannot bypass retention.
 *
 * WHY A TEST AND NOT A CONVENTION
 * -------------------------------
 * The scope of this work is a census taken by hand: 21 completeness
 * sites out of 50. A hand census is true on the day it is taken. The
 * failure mode is not that someone disagrees with the classification —
 * it is that someone adds a twenty-second site, logs it to stderr as
 * every existing site did, and every fixture stays green because
 * nothing asserts the census still holds.
 *
 * That is the same shape as the defect this whole line of work exists
 * to close, applied to its own scope: the product would know about a
 * completeness failure and nothing would surface it.
 *
 * My own census was wrong twice before it was right. Published 46/15/31;
 * actual 50/21/29. The grep behind it was `this.log.warn('raw-body-store`
 * — PREFIXED — so it matched the example rather than the mechanism, and
 * missed four sites in genai-store and telemetry-store, two of them on
 * the read path. A number that is wrong by hand once will be wrong by
 * hand again; this file is why it will be noticed.
 *
 * WHAT IT ASSERTS, AND THE LIMIT OF IT
 * ------------------------------------
 * `CAPTURE_MODULES` are wholly about capture — every diagnostic in them
 * is in scope by construction, so an unregistered message there is a
 * hard failure. `app.ts` is mixed, so the guard pins the known in-scope
 * messages by exact text (catching a rename or deletion) plus the total
 * site count (catching an addition). The total pin is the coarser
 * signal and it is deliberately coarse: a new operational log in app.ts
 * will also trip it, and the fix is to update the number having decided
 * which side of the line it falls on. That decision is the point.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_CAUSES } from '../src/diagnostics.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

/** Modules whose every diagnostic is a completeness claim. */
const CAPTURE_MODULES = [
  'genai-correlator.ts',
  'raw-body-store.ts',
  'genai-store.ts',
  'telemetry-store.ts',
] as const;

/** The registered in-scope messages, from the reconciled census. */
const REGISTERED = new Set([
  'genai-correlator: body_ref unreadable',
  'genai-correlator: body length mismatch',
  'genai-correlator: unlink after capture failed',
  'genai-correlator: raw capture failed',
  'genai-correlator: body JSON parse failed',
  'genai-correlator: failed to build inference',
  'genai-correlator: raw request_id assign failed',
  'genai-correlator: skipped malformed record',
  'raw-body-store: blob gunzip failed',
  'raw-body-store: blob hash mismatch',
  'genai-store: skipped unserializable record',
  'genai-store: skipped malformed row',
  'telemetry-store: skipped unserializable record',
  'telemetry-store: skipped malformed row',
]);

/** In-scope messages that live in app.ts among operational ones. */
const APP_IN_SCOPE = [
  'otlp logs store failed',
  'otlp genai ingest failed',
  'otlp metrics store failed',
  'codex genai ingest entry failed',
  'agent activity append failed',
  'tool invoke audit append failed',
  'enrollment source label truncated',
  'context watchdog telemetry append failed',
  'context watchdog resend failed',
];

/**
 * Total broker log sites at the time of the census.
 *
 * Measured, not estimated: 33 `logger.warn` + 3 `logger.error` +
 * 8 correlator `log()` + 6 `this.log.warn` = 50.
 *
 * 2026-08-01, +1 = 51. `app.ts` gained `failed to fanout variable
 * event` with the variables registry. The decision this guard exists
 * to force: it is OPERATIONAL, not a completeness claim. It reports a
 * change-notification that did not reach members — the same class as
 * the `failed to fanout secret event` and `failed to fanout
 * tool-source event` sites beside it, neither of which is in
 * `APP_IN_SCOPE`. Nothing captured is lost when it fires; a member
 * simply has to be told about a variable some other way. It therefore
 * stays out of scope, and the count moves rather than the
 * classification.
 *
 * 2026-08-01, +2 = 53. Persistent-context recovery added one telemetry
 * retention warning and one failed-delivery warning. Both are in scope:
 * the first makes the per-block denominator incomplete, and the second
 * means an instruction block known to be absent was not re-delivered.
 */
const TOTAL_SITES = 53;

function messagesIn(file: string): string[] {
  const src = readFileSync(join(SRC, file), 'utf8');
  const out: string[] = [];
  for (const pat of [/this\.log\.warn\(/g, /(?<!\.)\blog\(\s*'/g]) {
    for (const m of src.matchAll(pat)) {
      const q = /'([^']+)'/.exec(src.slice(m.index, m.index + 200));
      if (q?.[1]?.includes(': ') === true) out.push(q[1]);
    }
  }
  return out;
}

function countAllSites(): number {
  // Scans the WHOLE tree, not a file list. A hardcoded list is how the
  // original census missed four sites: it enumerated the files someone
  // thought of rather than the ones that exist, and a new module with a
  // completeness warning would be invisible to it.
  let n = 0;
  for (const file of readdirSync(SRC, { recursive: true }) as string[]) {
    if (!file.endsWith('.ts')) continue;
    let src: string;
    try {
      src = readFileSync(join(SRC, file), 'utf8');
    } catch {
      continue;
    }
    n += (src.match(/\blogger\.warn\(/g) ?? []).length;
    n += (src.match(/\blogger\.error\(/g) ?? []).length;
    n += (src.match(/(?<!\.)\blog\(\s*'genai-correlator/g) ?? []).length;
    n += (src.match(/this\.log\.warn\(/g) ?? []).length;
  }
  return n;
}

describe('diagnostic census guard', () => {
  it('every diagnostic in a capture module is registered', () => {
    // These modules exist only to capture and store. A new warning in
    // one of them is a completeness claim by construction, so an
    // unregistered message is a site that would bypass retention.
    const unregistered: string[] = [];
    for (const file of CAPTURE_MODULES) {
      for (const msg of messagesIn(file)) {
        if (!REGISTERED.has(msg)) unregistered.push(`${file}: ${msg}`);
      }
    }
    expect(unregistered).toEqual([]);
  });

  it('every registered capture message still exists in source', () => {
    // The other direction. A registry that outlives its sites drifts
    // silently and the cause enum stops matching reality.
    const present = new Set(CAPTURE_MODULES.flatMap(messagesIn));
    const missing = [...REGISTERED].filter((m) => !present.has(m));
    expect(missing).toEqual([]);
  });

  it('app.ts still carries each in-scope message it was censused with', () => {
    // app.ts is mixed, so the guard pins the known in-scope messages by
    // exact text — a rename or removal is caught even though a blanket
    // rule cannot apply here.
    const src = readFileSync(join(SRC, 'app.ts'), 'utf8');
    const missing = APP_IN_SCOPE.filter((m) => !src.includes(m));
    expect(missing).toEqual([]);
  });

  it('the total site count is unchanged since the census', () => {
    // The coarse signal, deliberately coarse. Any new log site trips
    // this, including an operational one, and the fix is to decide
    // which side of the line it falls on and update the number. That
    // decision is the thing being forced.
    expect(countAllSites()).toBe(TOTAL_SITES);
  });

  it('every observed-recovery method has a production call site', () => {
    // Rune found all eight recovery methods referenced ONLY in their
    // own definitions: the failure half was wired and the healing half
    // was not, so the first incident latched a member unresolved
    // forever. `rg` found it in one command; this makes that command a
    // test.
    //
    // LIMIT, stated: this is a static reference check, not behavioural.
    // It proves a call site exists, not that it fires on the right
    // success. My behavioural attempt called the emitter directly and
    // survived unwiring the correlator entirely — a wiring test that
    // did not test the wiring, which is why this guard is here instead
    // of in place of one.
    const RECOVERIES = [
      'correlatorBodyRefRead',
      'correlatorRawCaptureSucceeded',
      'otlpLogsStored',
      'otlpGenaiIngested',
      'otlpMetricsStored',
      'codexGenaiIngestEntrySucceeded',
      'activityAppended',
      'toolinvokeAuditAppended',
    ];
    const production = (readdirSync(SRC, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.endsWith('diagnostics.ts'))
      .map((f) => readFileSync(join(SRC, f), 'utf8'))
      .join('\n');
    const unwired = RECOVERIES.filter((m) => !production.includes(`.${m}(`));
    expect(unwired).toEqual([]);
  });

  it('the cause enum has one code per registered site plus overflow', () => {
    // Capture/app sites plus three current context-watchdog conditions and
    // three retention facts (overflow, fanout_truncated, unavailable).
    expect(DIAGNOSTIC_CAUSES.length).toBe(27);
  });
});
