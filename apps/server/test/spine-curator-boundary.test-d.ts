/**
 * Compile-time negatives for the curator's boundary.
 *
 * TWO ARCHITECTURAL CLAIMS, neither of which a runtime test can
 * establish, because both are about what the surface DOES NOT OFFER:
 *
 *   1  a receipt cannot be advanced by anything but a READ. The
 *      curator's own pushes have no way to move one — not a
 *      discouraged way, no way — because `ReceiptVia` is a closed
 *      union of read events and there is no other entry point.
 *   2  the ledger is an ACCOUNT and not an archive. There is no field
 *      for the injected text, so the audit trail cannot become a
 *      second copy of the member's traffic and therefore a second
 *      place it leaks from.
 *
 * A runtime test of claim 1 exists too (`spine-curator.test.ts`: a
 * push happens and the receipt does not move), and it is the weaker
 * instrument: it proves the paths it drove did not advance a receipt.
 * This proves no path can.
 *
 * Type-only: no runtime assertions, checked by `tsc --noEmit`.
 */

import type { CuratorStore, LeaseRecord } from '../src/spine/index.js';

declare const store: CuratorStore;
declare const lease: LeaseRecord;

// ─── The positive control ────────────────────────────────────────────
// If the surface stopped being usable, every negative below would pass
// vacuously. These are the legitimate calls the deviations deviate
// from — one read-driven receipt, one delivery-driven lease, one
// ledger row.

store.advanceReceipt('rune', 42, 'orient', 1_700_000_000_000);
store.advanceReceipt('rune', 43, 'annex_read', 1_700_000_000_000);
store.grantLeases('rune', ['evt_1'], 42, 'class1', 1_700_000_000_000);
store.logInjection({
  member: 'rune',
  class: 1,
  kind: 'addressed',
  refs: ['evt_1'],
  cursor: 42,
  bytes: 180,
  delivered: true,
  at: 1_700_000_000_000,
});
store.leaseState(lease, 1000, 1_700_000_000_000);

// ─── 1. Receipts advance on reads and on nothing else ────────────────
//
// Enumerated one route at a time, because closing one does not close
// the boundary. A push, a delivery, a nudge and an injection are four
// different words for the same wrong idea, and each is a plausible
// thing for a future caller to reach for.

// @ts-expect-error a push is not a read: visiting is not handling, structurally
store.advanceReceipt('rune', 42, 'push', 1_700_000_000_000);

// @ts-expect-error a confirmed delivery proves the sink took it, not that anybody read it
store.advanceReceipt('rune', 42, 'delivery', 1_700_000_000_000);

// @ts-expect-error a nudge is a pointer at `orient`, so it cannot stand in for one
store.advanceReceipt('rune', 42, 'nudge', 1_700_000_000_000);

// @ts-expect-error there is no second entry point that skips the `via` question entirely
store.setReceipt('rune', 42);

// ─── 2. The ledger accounts; it does not archive ─────────────────────

store.logInjection({
  member: 'rune',
  class: 1,
  kind: 'addressed',
  refs: ['evt_1'],
  cursor: 42,
  bytes: 180,
  delivered: true,
  at: 1_700_000_000_000,
  // @ts-expect-error the ledger records the spend, never the text — keeping it would make the audit trail leak
  body: 'spine: criterion_verdict evt_1 …',
});

store.logInjection({
  member: 'rune',
  // @ts-expect-error class 3 is SILENCE, so a ledger row claiming it is a budget line for something never spent
  class: 3,
  kind: 'addressed',
  refs: [],
  cursor: 0,
  bytes: 0,
  delivered: false,
  at: 1_700_000_000_000,
});
