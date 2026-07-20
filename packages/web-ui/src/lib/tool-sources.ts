/**
 * Tool-sources signal — the registry of platform-defined external
 * tools, mirroring the server's `GET /tool-sources` projection.
 *
 * Used by:
 *   - `NavColumn` to render the tools.manage-gated "Tools" nav item
 *   - `ToolSourcesPanel` (list) and `ToolSourceDetail` (per-source)
 *   - `live.ts` to refresh on `data.kind === 'tool_source'` events —
 *     registry changes fan out as channel events, so the list stays
 *     current without polling
 *
 * Mutation helpers follow the channels.ts convention: thin wrappers
 * around `Client` methods that re-list afterwards. Tool sources are
 * low-volume config — a re-list keeps the source of truth cheap to
 * reason about.
 *
 * Detail state is keyed per-slug in a second signal so the detail
 * view survives list refreshes without flashing.
 */

import { signal } from '@preact/signals';
import type {
  CustomToolBinding,
  GetToolSourceResponse,
  ToolSourceKind,
  ToolSourceSummary,
} from 'csuite-sdk/types';
import { getClient } from './client.js';

/** Registry summaries. `null` = not yet loaded. */
export const toolSources = signal<ToolSourceSummary[] | null>(null);

/** Most-recent list-load failure, surfaced inline if non-null. */
export const toolSourcesError = signal<string | null>(null);

/** True while a list load/refresh is in flight. */
export const toolSourcesLoading = signal(false);

/** Per-slug detail responses (tools + bindings for admins). */
export const toolSourceDetails = signal<Record<string, GetToolSourceResponse>>({});

export async function loadToolSources(): Promise<void> {
  toolSourcesLoading.value = true;
  try {
    toolSources.value = await getClient().listToolSources();
    toolSourcesError.value = null;
  } catch (err) {
    toolSourcesError.value = err instanceof Error ? err.message : String(err);
  } finally {
    toolSourcesLoading.value = false;
  }
}

/** Look up a source summary by slug. Null when unknown or unloaded. */
export function toolSourceBySlug(slug: string): ToolSourceSummary | null {
  const list = toolSources.value;
  if (list === null) return null;
  return list.find((s) => s.slug === slug) ?? null;
}

/** Fetch (and cache) one source's detail — tools + admin bindings. */
export async function loadToolSourceDetail(slug: string): Promise<void> {
  const detail = await getClient().getToolSource(slug);
  toolSourceDetails.value = { ...toolSourceDetails.value, [slug]: detail };
}

/** Refresh both the list and one detail after a mutation. */
async function refreshAfterMutation(slug: string | null): Promise<void> {
  await loadToolSources();
  if (slug !== null && toolSourceBySlug(slug) !== null) {
    await loadToolSourceDetail(slug);
  }
}

export async function createToolSource(input: {
  slug: string;
  kind: ToolSourceKind;
  displayName?: string;
  url?: string;
  allMembers?: boolean;
}): Promise<void> {
  await getClient().createToolSource({
    slug: input.slug,
    kind: input.kind,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.url ? { config: { url: input.url } } : {}),
    ...(input.allMembers !== undefined ? { allMembers: input.allMembers } : {}),
  });
  await refreshAfterMutation(input.slug);
}

export async function updateToolSource(
  slug: string,
  patch: { displayName?: string; enabled?: boolean; allMembers?: boolean; url?: string },
): Promise<void> {
  await getClient().updateToolSource(slug, {
    ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.allMembers !== undefined ? { allMembers: patch.allMembers } : {}),
    ...(patch.url !== undefined ? { config: { url: patch.url } } : {}),
  });
  await refreshAfterMutation(slug);
}

export async function deleteToolSource(slug: string): Promise<void> {
  await getClient().deleteToolSource(slug);
  const { [slug]: _dropped, ...rest } = toolSourceDetails.value;
  toolSourceDetails.value = rest;
  await loadToolSources();
}

export async function setToolCredential(
  slug: string,
  input: { kind: 'bearer' | 'header'; headerName?: string; secret: string },
): Promise<void> {
  await getClient().setToolCredential(slug, {
    kind: input.kind,
    ...(input.headerName !== undefined ? { headerName: input.headerName } : {}),
    secret: input.secret,
  });
  await refreshAfterMutation(slug);
}

export async function deleteToolCredential(slug: string): Promise<void> {
  await getClient().deleteToolCredential(slug);
  await refreshAfterMutation(slug);
}

export async function bindToolSource(slug: string, member: string): Promise<void> {
  await getClient().bindToolSource(slug, { member });
  await refreshAfterMutation(slug);
}

export async function unbindToolSource(slug: string, member: string): Promise<void> {
  await getClient().unbindToolSource(slug, member);
  await refreshAfterMutation(slug);
}

export async function setCustomTool(
  slug: string,
  name: string,
  input: { description: string; inputSchema: Record<string, unknown>; binding: CustomToolBinding },
): Promise<void> {
  await getClient().setCustomTool(slug, name, input);
  await refreshAfterMutation(slug);
}

export async function deleteCustomTool(slug: string, name: string): Promise<void> {
  await getClient().deleteCustomTool(slug, name);
  await refreshAfterMutation(slug);
}

/** Re-discover an MCP source's upstream tools. Returns the count. */
export async function refreshToolSource(slug: string): Promise<number> {
  const { tools } = await getClient().refreshToolSource(slug);
  await refreshAfterMutation(slug);
  return tools.length;
}

/** Test-only reset so unit tests start clean. */
export function __resetToolSourcesForTests(): void {
  toolSources.value = null;
  toolSourcesError.value = null;
  toolSourcesLoading.value = false;
  toolSourceDetails.value = {};
}
