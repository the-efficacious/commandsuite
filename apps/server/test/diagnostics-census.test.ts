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
 *
 * 2026-08-01, +1 = 54. `instructions runner version rejected` is
 * OPERATIONAL, not a completeness claim: the broker substitutes a
 * bounded `unknown` in complimentary context and still returns the
 * complete packet. The warning distinguishes a rejected report
 * from an older client that sent no report at all.
 *
 * 2026-08-01, +1 = 55. `instructions exceed legacy runner cap` is
 * OPERATIONAL: no content is lost by the broker, but a pre-0.4.0
 * runner will reject the response locally and fail to start.
 *
 * 2026-08-01, +1 = 56. `failed to fanout instructions event` is
 * OPERATIONAL, same class as the secret/variable/tool-source fanout
 * sites beside it: a change-notification that did not reach members.
 * Nothing captured is lost; the affected members surface as
 * restart-pending on the roster regardless, because pending derives
 * from the issued-vs-current hash comparison, not from the event.
 *
 * 2026-08-01, −1 = 55. `instructions exceed legacy runner cap`
 * removed along with the legacy-cap machinery it served: it warned
 * about pre-0.4.0 runners rejecting oversized packets locally, and
 * zero deployed runners remained when the wire renamed (protocol v2).
 *
 * 2026-08-09, +3 = 58. The spine curator: `spine curator sweep
 * failed`, `spine curator append hook failed` (both in app.ts) and
 * `spine: injection push failed` (curator.ts). All three are
 * OPERATIONAL, and the reason is the floor rule rather than a judgement
 * call about severity — no correctness property rests on an injection
 * being delivered. A failed push costs latency: the member's next
 * `orient` carries everything the push would have said, and their next
 * stale write is refused with the delta regardless. Nothing captured
 * is lost, because the curator captures nothing.
 *
 * 2026-08-09, +8 −1 = 65. The probe engine, and one deletion. The
 * deletion is `spine curator append hook failed`: the curator's hook
 * moved onto the annex write path, which logs `spine append hook
 * failed` for any hook, so the site is one rather than one per
 * subscriber. The additions are `spine append hook failed`
 * (append.ts), `spine probe sweep failed` (app.ts), `spine probe tap
 * failed` (dispatcher.ts), and five in probes.ts: `spine: stored
 * carrier holds an unarmable recipe`, `spine: carrier declares a
 * recipe with no subject`, `spine: poll failed`, `spine: check fired
 * but produced no observation`, `spine: check fired but the contract
 * did not re-light`.
 *
 * ALL OPERATIONAL, and two of them deserve the argument rather than
 * the assertion, because they are the two where something real is
 * lost. `check fired but produced no observation` means the world did
 * the thing and the annex holds no photograph of it; `did not
 * re-light` means a contract stayed `waiting_for` after its check
 * fired. Neither is a completeness claim in this census's sense — that
 * scope is CAPTURE retention, where the only record of a loss is the
 * log line — because in both cases the loss is recorded where the
 * member looks for it: the check row carries `disarmed_reason` and is
 * served at `GET /spine/checks`, and the observation stands in the
 * annex whatever the lifecycle did. The line is an operator's copy of
 * a fact the product already surfaces.
 *
 * 2026-08-10, −2 = 63. The objectives cut-over, and the only census
 * movement it caused. Four `logger.*` calls left app.ts with the
 * subsystem — `failed to fanout objective event`, `objective created`,
 * `failed to fanout objective discuss`, `objective context watchdog
 * fired` — but only TWO of them were census sites: this census counts
 * sites whose message carries a `': '`, and the other two do not.
 * Recorded as the count it is rather than as the number of lines
 * deleted, because a census that moves by "how much code went away"
 * has stopped being a census.
 */
const TOTAL_SITES = 63;

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
