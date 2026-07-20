/**
 * Secrets signal — the registry of broker-held environment secrets,
 * mirroring the server's `GET /secrets` projection.
 *
 * Used by:
 *   - `NavColumn` to render the secrets.manage-gated "Secrets" nav item
 *   - `SecretsPanel` (list) and `SecretDetail` (per-secret)
 *   - `live.ts` to refresh on `data.kind === 'secret'` events —
 *     registry changes fan out as channel events, so the list stays
 *     current without polling
 *
 * Values are write-only: summaries carry `hasValue` and nothing here
 * ever holds or renders a secret value. Mutation helpers follow the
 * tool-sources convention: thin wrappers around `Client` methods that
 * re-list afterwards — secrets are low-volume config, so a re-list
 * keeps the source of truth cheap to reason about.
 *
 * Detail state is keyed per-slug in a second signal so the detail
 * view survives list refreshes without flashing.
 */

import { signal } from '@preact/signals';
import type { GetSecretResponse, SecretSummary } from 'csuite-sdk/types';
import { getClient } from './client.js';

/** Registry summaries. `null` = not yet loaded. */
export const secrets = signal<SecretSummary[] | null>(null);

/** Most-recent list-load failure, surfaced inline if non-null. */
export const secretsError = signal<string | null>(null);

/** True while a list load/refresh is in flight. */
export const secretsLoading = signal(false);

/** Per-slug detail responses (summary + bindings for admins). */
export const secretDetails = signal<Record<string, GetSecretResponse>>({});

export async function loadSecrets(): Promise<void> {
  secretsLoading.value = true;
  try {
    secrets.value = await getClient().listSecrets();
    secretsError.value = null;
  } catch (err) {
    secretsError.value = err instanceof Error ? err.message : String(err);
  } finally {
    secretsLoading.value = false;
  }
}

/** Look up a secret summary by slug. Null when unknown or unloaded. */
export function secretBySlug(slug: string): SecretSummary | null {
  const list = secrets.value;
  if (list === null) return null;
  return list.find((s) => s.slug === slug) ?? null;
}

/** Fetch (and cache) one secret's detail — summary + admin bindings. */
export async function loadSecretDetail(slug: string): Promise<void> {
  const detail = await getClient().getSecret(slug);
  secretDetails.value = { ...secretDetails.value, [slug]: detail };
}

/** Refresh both the list and one detail after a mutation. */
async function refreshAfterMutation(slug: string | null): Promise<void> {
  await loadSecrets();
  if (slug !== null && secretBySlug(slug) !== null) {
    await loadSecretDetail(slug);
  }
}

export async function createSecret(input: {
  slug: string;
  envName: string;
  description?: string;
  allMembers?: boolean;
}): Promise<void> {
  await getClient().createSecret({
    slug: input.slug,
    envName: input.envName,
    ...(input.description ? { description: input.description } : {}),
    ...(input.allMembers !== undefined ? { allMembers: input.allMembers } : {}),
  });
  await refreshAfterMutation(input.slug);
}

export async function updateSecret(
  slug: string,
  patch: { envName?: string; description?: string; enabled?: boolean; allMembers?: boolean },
): Promise<void> {
  await getClient().updateSecret(slug, {
    ...(patch.envName !== undefined ? { envName: patch.envName } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.allMembers !== undefined ? { allMembers: patch.allMembers } : {}),
  });
  await refreshAfterMutation(slug);
}

export async function deleteSecret(slug: string): Promise<void> {
  await getClient().deleteSecret(slug);
  const { [slug]: _dropped, ...rest } = secretDetails.value;
  secretDetails.value = rest;
  await loadSecrets();
}

/** Set/replace the value. Write-only — nothing here retains it. */
export async function setSecretValue(slug: string, value: string): Promise<void> {
  await getClient().setSecretValue(slug, { value });
  await refreshAfterMutation(slug);
}

export async function deleteSecretValue(slug: string): Promise<void> {
  await getClient().deleteSecretValue(slug);
  await refreshAfterMutation(slug);
}

export async function bindSecret(slug: string, member: string): Promise<void> {
  await getClient().bindSecret(slug, { member });
  await refreshAfterMutation(slug);
}

export async function unbindSecret(slug: string, member: string): Promise<void> {
  await getClient().unbindSecret(slug, member);
  await refreshAfterMutation(slug);
}

/** Test-only reset so unit tests start clean. */
export function __resetSecretsForTests(): void {
  secrets.value = null;
  secretsError.value = null;
  secretsLoading.value = false;
  secretDetails.value = {};
}
