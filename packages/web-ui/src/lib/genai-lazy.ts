/**
 * Lazy full-record loader for the activity timeline and its call
 * rows.
 *
 * The feed hydrates light call SUMMARIES (see genai-feed.ts) and
 * joins them onto turn markers deterministically (trace-join.ts) —
 * so by the time a viewer expands a call, its record IDENTITY is
 * already known. This module just fetches the heavy body
 * (`GET /members/:name/genai/:id`) on first expand and caches it by
 * record id. No window queries, no re-derived heuristics: the join
 * happens once, upstream, and this loader trusts it.
 *
 * The cache is cleared when the subscribed member changes so one
 * agent's contexts can't surface on another's feed.
 */

import { signal } from '@preact/signals';
import type { GenAiInferenceRecord } from 'csuite-sdk/types';
import { getClient } from './client.js';
import { memberActivityName } from './member-activity.js';

export type LazyRecordState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; record: GenAiInferenceRecord }
  | { status: 'error'; message: string };

/** Full-record cache, keyed by the record's server-assigned id. */
const recordById = signal<Map<number, LazyRecordState>>(new Map());

/** Current cache state for a record — `idle` until first expanded. */
export function genAiRecordState(id: number): LazyRecordState {
  return recordById.value.get(id) ?? { status: 'idle' };
}

function setState(id: number, state: LazyRecordState): void {
  const next = new Map(recordById.value);
  next.set(id, state);
  recordById.value = next;
}

/**
 * Load (once) the full record for a call. No-op if already loading
 * or loaded; a previous error retries. Safe to call on every expand.
 */
export async function loadGenAiRecord(id: number): Promise<void> {
  const current = recordById.value.get(id);
  if (current && (current.status === 'loading' || current.status === 'loaded')) return;
  const name = memberActivityName.value;
  if (name === null) return;
  setState(id, { status: 'loading' });
  try {
    const record = await getClient().getGenaiInference(name, id);
    // The member may have changed while we were in flight.
    if (memberActivityName.value !== name) return;
    setState(id, { status: 'loaded', record });
  } catch (err) {
    setState(id, { status: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

/** Drop all cached records — called when the subscribed member changes. */
export function resetGenAiRecords(): void {
  recordById.value = new Map();
}

/** Test-only alias. */
export const __resetGenAiRecordsForTests = resetGenAiRecords;
