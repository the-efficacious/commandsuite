/**
 * Compile-time negatives for the emitter boundary.
 *
 * Criterion 9's guarantee is architectural: every in-scope site routes
 * through the typed emitter. A boundary asserted in prose is a
 * convention; these make the compiler assert it.
 *
 * `@ts-expect-error` INVERTS the question. Testing "my hostile snippet
 * fails to compile" means checking by eye, once, and never noticing
 * when it silently starts passing. Here the compiler fails the build
 * with `TS2578: unused '@ts-expect-error'` the moment a bypass
 * REOPENS — a positive control for a negative claim. (Rune's
 * technique; it is how the third door below was found.)
 *
 * THERE WERE THREE DOORS TO THE SAME ROOM. Generic `record` was closed
 * first, then `emit.recovered`, and `store.resolve` was still public
 * both times — able to clear any incident, including a point cause
 * that can never have one. Twice I closed a route and concluded the
 * boundary was closed. That is why this file enumerates rather than
 * argues.
 *
 * Type-only: no runtime assertions, checked by `tsc --noEmit`.
 */

import { createDiagnosticStore } from 'csuite-core';

declare const db: Parameters<typeof createDiagnosticStore>[0];
const store = createDiagnosticStore(db);

// Door 1 — generic record. Would manufacture an affected-corruption
// attribution with a hand-picked member list, no hash, and none of the
// emitter's raw_exchange lookup.
// @ts-expect-error record is not on the production interface
store.record({ cause: 'rawstore.blob_hash_mismatch', members: ['caller-selected-member'] });

// Door 2 — generic recovery on the emitter. Would let a site that
// succeeded at writing activity clear a correlator incident.
// @ts-expect-error recovered() is not on the emitter
store.emit.recovered('correlator.body_ref_unreadable', 'someone-else');

// Door 3 — raw resolve on the store. Same capability, third route, and
// it survived both previous closures.
// @ts-expect-error resolve is not on the production interface
await store.resolve('genaistore.malformed_row_skipped', 'm');

// Point causes have no recovery method at all: they never create
// unresolved state, so recovering one is meaningless.
// @ts-expect-error no recovery method exists for a point cause
store.emit.genaistoreMalformedRowRecovered(1);

// NOT A DOOR, and the directive proved it. I wrote a probe here
// asserting a forged SafeFields literal could not be passed to an
// emitter method — and `TS2578: unused` fired, because the third
// parameter is `err: unknown` and accepts anything. The method takes a
// RAW error by design and converts it; there is no fields argument to
// forge. The bypass I claimed did not exist.
//
// The brand still matters, on the internal `record` path. It is not
// reachable from here, which is the point of the three doors above.
// Left as a comment because a probe that cannot fail is worse than no
// probe, and this one failed in the direction of inventing a defect.

// POSITIVE CONTROLS — the surface must still be usable. Without these,
// deleting the whole interface would satisfy every negative above.
store.emit.rawstoreBlobHashMismatch('a'.repeat(64));
store.emit.activityAppendFailed('m', 3);
store.emit.activityAppended('m');
store.unresolved('m');
store.query({ member: 'm', from: 0, to: 1 });
store.health();
