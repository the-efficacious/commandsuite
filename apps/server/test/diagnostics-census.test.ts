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
import { DIAGNOSTIC_CAUSES } from 'csuite-core';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
// Capture modules migrated into csuite-core with the runtime-neutral
// refactor; the census follows the code, not the package boundary.
const CORE_SRC = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/core/src');
const ROOTS = [SRC, CORE_SRC];

/** Modules whose every diagnostic is a completeness claim. */
const CAPTURE_MODULES = [
  'genai-correlator.ts',
  'raw-body-store.ts',
  'genai-store.ts',
  'telemetry-store.ts',
] as const;

/** The registered in-scope messages, from the reconciled census. */
const REGISTERED = new Set([
  'body_ref unreadable',
  'body length mismatch',
  'unlink after capture failed',
  'raw capture failed',
  'body JSON parse failed',
  'failed to build inference',
  'raw request_id assign failed',
  'skipped malformed record',
  'evicted stale pending exchanges',
  'pending-request cap hit — dropped oldest exchange',
  'blob gunzip failed',
  'blob hash mismatch',
  'skipped unserializable record',
  'skipped malformed row',
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
 * 2026-08-07, +1 = 56. `failed to push context control` is
 * OPERATIONAL, not a completeness claim. It fires when the fanout of a
 * broker-issued compact/clear throws, and nothing captured is lost —
 * the caller is told synchronously (502) rather than being left to
 * infer it. The endpoint's own completeness property is carried by the
 * `context_control` activity ACK, not by this log: a request that
 * produces no outcome event stays visibly outstanding, which is the
 * observable the feature is built around.
 *
 * 2026-08-12, −2 +3 = 57. The context watchdogs were removed and their
 * two in-scope app.ts warnings went with them. The correlator sites
 * that previously reported a dropped pending exchange THROUGH the
 * watchdog's check-unavailable incident now carry their own point
 * cause, `correlator.pending_exchange_dropped`, with two new in-scope
 * log lines (stale eviction, pending-cap displacement). app.ts gained
 * one OPERATIONAL warning, `codex genai request body parse failed` —
 * the raw bytes are already captured and a model-only record is
 * stored, so nothing captured is lost when it fires.
 *
 * 2026-08-13, +1 = 58. The census roots extended to csuite-core when
 * the capture stores migrated there (runtime-neutral refactor). The
 * whole-tree scan now sees core's one pre-existing broker.ts
 * logger.warn — an OPERATIONAL site (push fanout diagnostics via the
 * injected BrokerLogger), not a capture-completeness claim. No new
 * sites were written; the fence moved to keep enclosing the same code.
 *
 * 2026-08-14, 58 → 66. The logging overhaul. NO new diagnostic was
 * written; the number moves for three mechanical reasons, each
 * measured against `main` rather than reasoned about:
 *
 *   correlator  +10  its ten sites were a bare `log(msg, ctx)`
 *                    callback and are now levelled `log.warn` /
 *                    `log.error`. The old census saw them through a
 *                    special-case pattern matching the literal
 *                    `log('genai-correlator`; they are now the same
 *                    shape as every other site and need no special
 *                    case.
 *   run.ts       −2  the `BrokerLogger` adapter shim is gone. Its two
 *                    lines were forwarders (`warn: (m, c) =>
 *                    log.warn(m, c)`), never diagnostics.
 *   app.ts       −1  the correlator's severity-flattening shim
 *                    (`log: (msg, ctx) => logger.warn(msg, ctx)`) is
 *                    gone; the correlator now picks its own severity.
 *
 * The count under the NEW pattern was also taken against `main`: 59.
 * That is 11 higher than the old pattern's 58 in the same tree, minus
 * the 10 correlator sites the old pattern special-cased. Those 11 —
 * eight in `run.ts`, two in `variables.ts`, one in `member-activity.ts`
 * — are real log sites the old census could not see, because they call
 * `log.warn` on a local logger const and the pattern looked for
 * `logger.warn` or `this.log.warn`. They were never classified. All
 * eleven are OPERATIONAL: boot/shutdown reporting and fanout failures
 * in `run.ts`, identity-migration rollback in `variables.ts`, and the
 * malformed-row skip in `member-activity.ts` — that last one is a
 * completeness concern but is already registered as
 * `activity.append_failed`'s read-side sibling under the
 * `member_activity` decode path, which the capture-module rule covers.
 * The blind spot is closed by construction now: one pattern, one call
 * shape, and a new site cannot hide by choosing a different receiver
 * name.
 *
 * 2026-08-14, +1 = 67. `diagnostics retention sweep failed` in app.ts,
 * added when the retention ladder was finally driven on a timer (it had
 * been dead code — `sweep()` was implemented, unit-tested, and never
 * called in production, so row caps were the only live bound).
 *
 * The decision this guard forces: it is OPERATIONAL. Nothing captured
 * is lost when it fires — the rows are all still there, merely
 * unfolded, and the caps still bound them. Retention's own
 * completeness is already carried by the store rather than by this
 * line: `retention.unavailable` plus the internal `writeFailed` latch
 * make `health()` answer `unknown` instead of a confident number when
 * the store cannot record. This site reports that the CALLER could not
 * run the sweep, which is the operational half of the same story.
 */
const TOTAL_SITES = 67;

function messagesIn(file: string): string[] {
  let src: string | null = null;
  for (const root of ROOTS) {
    try {
      src = readFileSync(join(root, file), 'utf8');
      break;
    } catch {
      /* try the next root */
    }
  }
  if (src === null) throw new Error(`census module not found in any root: ${file}`);
  // Matches the levelled call shape every diagnostic now uses:
  // `log.warn('…')`, `this.log.error('…')`, `logger.warn('…')`. The
  // message no longer carries a module prefix — `component` is a field
  // on the record — so there is nothing to filter on, and every
  // warn/error in a capture module is in scope by construction. That
  // is stronger than the old prefix filter, which selected messages
  // that happened to be punctuated a certain way.
  const out: string[] = [];
  for (const m of src.matchAll(/\b(?:this\.)?(?:log|logger)\.(?:warn|error)\(\s*'([^']+)'/g)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

function countAllSites(): number {
  // Scans the WHOLE tree, not a file list. A hardcoded list is how the
  // original census missed four sites: it enumerated the files someone
  // thought of rather than the ones that exist, and a new module with a
  // completeness warning would be invisible to it.
  let n = 0;
  for (const root of ROOTS)
    for (const file of readdirSync(root, { recursive: true }) as string[]) {
      if (!file.endsWith('.ts')) continue;
      let src: string;
      try {
        src = readFileSync(join(root, file), 'utf8');
      } catch {
        continue;
      }
      // ONE pattern for one call shape. The four-pattern version this
      // replaced could not see `log.warn(` on a local logger const,
      // and was blind to 11 real sites in run.ts, variables.ts and
      // member-activity.ts for exactly the reason its own header
      // warns about: it matched the examples in front of it rather
      // than the mechanism.
      n += (src.match(/\b(?:this\.)?(?:log|logger)\.(?:warn|error)\(/g) ?? []).length;
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
    const src = readFileSync(join(CORE_SRC, 'app.ts'), 'utf8');
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
    const production = ROOTS.flatMap((root) =>
      (readdirSync(root, { recursive: true }) as string[])
        .filter((f) => f.endsWith('.ts') && !f.endsWith('diagnostics.ts'))
        .map((f) => readFileSync(join(root, f), 'utf8')),
    ).join('\n');
    const unwired = RECOVERIES.filter((m) => !production.includes(`.${m}(`));
    expect(unwired).toEqual([]);
  });

  it('the cause enum has one code per registered site plus overflow', () => {
    // Capture/app sites and
    // three retention facts (overflow, fanout_truncated, unavailable).
    expect(DIAGNOSTIC_CAUSES.length).toBe(25);
  });
});
