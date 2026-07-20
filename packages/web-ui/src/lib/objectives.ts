/**
 * Objectives signal + actions for the web UI.
 *
 * Mirrors the pattern of `roster.ts` and `messages.ts`: one signal,
 * thin fetch wrappers that refresh it, and a couple of synchronous
 * selectors that components read. The signal is the single source of
 * truth; SSE event handling in `sse.ts` triggers `loadObjectives()`
 * whenever an objective event crosses the stream.
 */

import { signal } from '@preact/signals';
import type {
  CancelObjectiveRequest,
  CreateObjectiveRequest,
  DiscussObjectiveRequest,
  Message,
  Objective,
  ObjectiveEvent,
  ReassignObjectiveRequest,
  UpdateObjectiveRequest,
  UpdateWatchersRequest,
} from 'csuite-sdk/types';
import { getClient } from './client.js';

export const objectives = signal<Objective[]>([]);
export const objectivesLoaded = signal(false);

/**
 * Full refresh of the caller-scoped objective list. Agents get only
 * their own; admins / operators / lead-agents get the team-wide list
 * because the server widens the scope for them.
 */
export async function loadObjectives(): Promise<void> {
  const list = await getClient().listObjectives();
  objectives.value = list;
  objectivesLoaded.value = true;
}

/** Apply a server-side mutation and replace the row in the local list. */
function upsertLocal(updated: Objective): void {
  const idx = objectives.value.findIndex((o) => o.id === updated.id);
  if (idx < 0) {
    objectives.value = [updated, ...objectives.value];
    return;
  }
  const next = [...objectives.value];
  next[idx] = updated;
  objectives.value = next;
}

export async function createObjective(req: CreateObjectiveRequest): Promise<Objective> {
  const created = await getClient().createObjective(req);
  upsertLocal(created);
  return created;
}

export async function updateObjective(id: string, req: UpdateObjectiveRequest): Promise<Objective> {
  const updated = await getClient().updateObjective(id, req);
  upsertLocal(updated);
  return updated;
}

export async function completeObjective(id: string, result: string): Promise<Objective> {
  const updated = await getClient().completeObjective(id, result);
  upsertLocal(updated);
  return updated;
}

export async function cancelObjective(
  id: string,
  req: CancelObjectiveRequest = {},
): Promise<Objective> {
  const updated = await getClient().cancelObjective(id, req);
  upsertLocal(updated);
  return updated;
}

export async function reassignObjective(
  id: string,
  req: ReassignObjectiveRequest,
): Promise<Objective> {
  const updated = await getClient().reassignObjective(id, req);
  upsertLocal(updated);
  return updated;
}

export async function updateObjectiveWatchers(
  id: string,
  req: UpdateWatchersRequest,
): Promise<Objective> {
  const updated = await getClient().updateObjectiveWatchers(id, req);
  upsertLocal(updated);
  return updated;
}

export async function fetchObjectiveDetail(
  id: string,
): Promise<{ objective: Objective; events: ObjectiveEvent[] }> {
  return getClient().getObjective(id);
}

/**
 * Post a discussion message into an objective's thread. Fans out
 * server-side to all thread members. The local `messagesByThread`
 * store picks up the caller's own echo via the SSE stream and
 * renders it in the inline thread view — no optimistic append.
 */
export async function discussObjective(id: string, req: DiscussObjectiveRequest): Promise<Message> {
  return getClient().discussObjective(id, req);
}

export function __resetObjectivesForTests(): void {
  objectives.value = [];
  objectivesLoaded.value = false;
}
