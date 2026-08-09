/**
 * The spine — the team's annex, its subjects, and the contracts folded
 * out of them.
 *
 * One barrel so the rest of the server imports `./spine/index.js` and
 * nothing reaches past it into a table or a row shape.
 */

export type { SpineErrorCode, SpineErrorDetail } from './errors.js';
export { SpineError, staleStateRev } from './errors.js';
export type { AnnexStore, AppendContext, AppendResult } from './store.js';
export { createSqliteAnnexStore, SPINE_EVENTS_DEFAULT_LIMIT } from './store.js';
