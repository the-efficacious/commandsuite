/**
 * `csuite-core/conformance` — reusable behavioral contract suites for
 * the injected drivers and ports.
 *
 * A host binding (or a custom store implementation) imports these into
 * its own test files and hands each suite a factory for its
 * implementation; the suite registers `describe`/`it` blocks that
 * assert the behavior the broker application depends on. The Node
 * binding (`csuite-server`) runs every suite against its own
 * implementations in CI, so the kit is load-bearing here — not a
 * courtesy export.
 *
 * Requires `vitest` (declared as an optional peer dependency): the
 * suites call its `describe`/`it`/`expect` when imported. Nothing in
 * this subpath is needed at runtime.
 */

export { blobStoreConformance } from './blob-store.js';
export { type BrokerAppHarness, brokerAppConformance } from './broker-app.js';
export { fieldCipherConformance } from './field-cipher.js';
export { sqlDriverConformance } from './sql-driver.js';
