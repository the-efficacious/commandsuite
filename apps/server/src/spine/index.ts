/**
 * The spine — the team's annex, its subjects, and the contracts folded
 * out of them.
 *
 * One barrel so the rest of the server imports `./spine/index.js` and
 * nothing reaches past it into a table or a row shape.
 */

export type { Curator, CuratorOptions, OrientLike } from './curator.js';
export { createCurator } from './curator.js';
export {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_NUDGE_MIN_INTERVAL_MS,
  SPINE_CURATOR_TABLES,
} from './curator-schema.js';
export type { CuratorStore, LeaseRecord, LeaseState, ReceiptVia } from './curator-store.js';
export { createSqliteCuratorStore } from './curator-store.js';
export type { SpineErrorCode, SpineErrorDetail } from './errors.js';
export { SpineError, staleStateRev } from './errors.js';
export type { AnnexStore, AppendContext, AppendResult } from './store.js';
export { createSqliteAnnexStore, SPINE_EVENTS_DEFAULT_LIMIT } from './store.js';
