/**
 * The spine — the team's annex, its subjects, and the contracts folded
 * out of them.
 *
 * One barrel so the rest of the server imports `./spine/index.js` and
 * nothing reaches past it into a table or a row shape.
 */

export type { AnnexWritePath, AppendHook } from './append.js';
export { createAnnexWritePath } from './append.js';
export type { Curator, CuratorOptions, OrientLike } from './curator.js';
export { createCurator } from './curator.js';
export {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_NUDGE_MIN_INTERVAL_MS,
  SPINE_CURATOR_TABLES,
} from './curator-schema.js';
export type { CuratorStore, LeaseRecord, LeaseState, ReceiptVia } from './curator-store.js';
export { createSqliteCuratorStore } from './curator-store.js';
// NO `createSqliteAnnexStore` AND NO `AnnexWriter` HERE, deliberately.
// The barrel hands out the read surface and the hooked write path; a
// consumer that wants a raw append-capable handle has to name
// `./store.js` itself, which is exactly what the import scanner reads.
export type { EgressPolicy, EgressPolicyOptions, ProbeTransport } from './egress.js';
export {
  blockedAddressReason,
  createEgressPolicy,
  createPinnedFetch,
  hostAsIpLiteral,
} from './egress.js';
export type { SpineErrorCode, SpineErrorDetail } from './errors.js';
export { SpineError, staleStateRev } from './errors.js';
export { SPINE_CHECK_TABLES } from './probe-schema.js';
export type { CheckStore } from './probe-store.js';
export { createSqliteCheckStore } from './probe-store.js';
export type { ProbeEngine, ProbeEngineOptions } from './probes.js';
export { createProbeEngine } from './probes.js';
export type { AnnexStore, AppendContext, AppendResult } from './store.js';
export { SPINE_EVENTS_DEFAULT_LIMIT } from './store.js';
