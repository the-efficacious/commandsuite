/**
 * Variables signal — the registry of broker-held runner environment
 * variables that are NOT secrets, mirroring `GET /variables`.
 *
 * Used by:
 *   - `EnvironmentPanel` (the Variables section) and `VariableDetail`
 *   - `live.ts` to refresh on `data.kind === 'variable'` events, the
 *     same fan-out the secrets registry gets
 *
 * The one structural difference from lib/secrets.ts: a summary carries
 * the VALUE for a `secrets.manage` holder. That is the capability the
 * store exists to provide — an operator who cannot read back a git
 * author name cannot check it is right — so nothing here strips it.
 *
 * `hasValue` is still consulted separately from `value`, because a
 * viewer without `secrets.manage` gets `hasValue: true` and no `value`.
 * Rendering those two states identically is how a configured variable
 * reads as missing, so callers must distinguish them.
 */

import { signal } from '@preact/signals';
import type { GetVariableResponse, VariableSummary } from 'csuite-sdk/types';
import { getClient } from './client.js';

/** Registry summaries. `null` = not yet loaded. */
export const variables = signal<VariableSummary[] | null>(null);

/** Most-recent list-load failure, surfaced inline if non-null. */
export const variablesError = signal<string | null>(null);

/** True while a list load/refresh is in flight. */
export const variablesLoading = signal(false);

/** Per-slug detail responses (summary + bindings for admins). */
export const variableDetails = signal<Record<string, GetVariableResponse>>({});

export async function loadVariables(): Promise<void> {
  variablesLoading.value = true;
  try {
    variables.value = await getClient().listVariables();
    variablesError.value = null;
  } catch (err) {
    variablesError.value = err instanceof Error ? err.message : String(err);
  } finally {
    variablesLoading.value = false;
  }
}

/** Look up a variable summary by slug. Null when unknown or unloaded. */
export function variableBySlug(slug: string): VariableSummary | null {
  const list = variables.value;
  if (list === null) return null;
  return list.find((v) => v.slug === slug) ?? null;
}

/** Fetch (and cache) one variable's detail — summary + managed bindings. */
export async function loadVariableDetail(slug: string): Promise<void> {
  const detail = await getClient().getVariable(slug);
  variableDetails.value = { ...variableDetails.value, [slug]: detail };
}

/** Refresh both the list and one detail after a mutation. */
async function refreshAfterMutation(slug: string | null): Promise<void> {
  await loadVariables();
  if (slug !== null && variableBySlug(slug) !== null) {
    await loadVariableDetail(slug);
  }
}

export async function createVariable(input: {
  slug: string;
  envName: string;
  description?: string;
  allMembers?: boolean;
}): Promise<void> {
  await getClient().createVariable({
    slug: input.slug,
    envName: input.envName,
    ...(input.description ? { description: input.description } : {}),
    ...(input.allMembers !== undefined ? { allMembers: input.allMembers } : {}),
  });
  await refreshAfterMutation(input.slug);
}

export async function updateVariable(
  slug: string,
  patch: { envName?: string; description?: string; enabled?: boolean; allMembers?: boolean },
): Promise<void> {
  await getClient().updateVariable(slug, {
    ...(patch.envName !== undefined ? { envName: patch.envName } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.allMembers !== undefined ? { allMembers: patch.allMembers } : {}),
  });
  await refreshAfterMutation(slug);
}

export async function deleteVariable(slug: string): Promise<void> {
  await getClient().deleteVariable(slug);
  const { [slug]: _dropped, ...rest } = variableDetails.value;
  variableDetails.value = rest;
  await loadVariables();
}

/**
 * Set/replace the value. Unlike a secret's, it is readable afterwards
 * and is never registered with the trace redactor.
 */
export async function setVariableValue(slug: string, value: string): Promise<void> {
  await getClient().setVariableValue(slug, { value });
  await refreshAfterMutation(slug);
}

export async function deleteVariableValue(slug: string): Promise<void> {
  await getClient().deleteVariableValue(slug);
  await refreshAfterMutation(slug);
}

export async function bindVariable(slug: string, member: string): Promise<void> {
  await getClient().bindVariable(slug, { member });
  await refreshAfterMutation(slug);
}

export async function unbindVariable(slug: string, member: string): Promise<void> {
  await getClient().unbindVariable(slug, member);
  await refreshAfterMutation(slug);
}

/** Test-only reset so unit tests start clean. */
export function __resetVariablesForTests(): void {
  variables.value = null;
  variablesError.value = null;
  variablesLoading.value = false;
  variableDetails.value = {};
}
