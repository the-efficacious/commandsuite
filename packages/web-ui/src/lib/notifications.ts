/**
 * External Notifications signals — the registry of inbound webhook
 * endpoints, shared auth profiles, and per-endpoint delivery
 * receipts, mirroring the server's `/notifications/*` projections.
 *
 * Used by:
 *   - `NavColumn` to render the notifications.manage-gated
 *     "Notifications" nav item
 *   - `NotificationsPanel` (list + profiles) and
 *     `NotificationDetail` (per-endpoint + deliveries)
 *   - `live.ts` to refresh on `data.kind === 'notification_endpoint'`
 *     events — registry changes fan out as channel events, so the
 *     list stays current without polling
 *
 * Signing secrets are write-only: summaries carry `hasSecret` and
 * nothing here ever holds or renders one. Mutation helpers follow
 * the secrets/tool-sources convention: thin wrappers around `Client`
 * methods that re-list afterwards. Deliveries are receipts (bounded
 * by the server's ingress rate limit) and load on demand per slug.
 */

import { signal } from '@preact/signals';
import type {
  CreateNotificationEndpointRequest,
  CreateNotificationProfileRequest,
  NotificationDelivery,
  NotificationEndpointSummary,
  NotificationProfileSummary,
  UpdateNotificationEndpointRequest,
} from 'csuite-sdk/types';
import { getClient } from './client.js';

/** Registry summaries. `null` = not yet loaded. */
export const notificationEndpoints = signal<NotificationEndpointSummary[] | null>(null);

/** Most-recent list-load failure, surfaced inline if non-null. */
export const notificationsError = signal<string | null>(null);

/** True while a list load/refresh is in flight. */
export const notificationsLoading = signal(false);

/** Shared auth profiles. `null` = not yet loaded. */
export const notificationProfiles = signal<NotificationProfileSummary[] | null>(null);

/** Per-slug delivery receipts (newest first), loaded on demand. */
export const notificationDeliveries = signal<Record<string, NotificationDelivery[]>>({});

export async function loadNotificationEndpoints(): Promise<void> {
  notificationsLoading.value = true;
  try {
    notificationEndpoints.value = await getClient().listNotificationEndpoints();
    notificationsError.value = null;
  } catch (err) {
    notificationsError.value = err instanceof Error ? err.message : String(err);
  } finally {
    notificationsLoading.value = false;
  }
}

/** Look up an endpoint summary by slug. Null when unknown or unloaded. */
export function notificationEndpointBySlug(slug: string): NotificationEndpointSummary | null {
  const list = notificationEndpoints.value;
  if (list === null) return null;
  return list.find((e) => e.slug === slug) ?? null;
}

export async function loadNotificationProfiles(): Promise<void> {
  notificationProfiles.value = await getClient().listNotificationProfiles();
}

/** Fetch (and cache) one endpoint's delivery receipts, newest first. */
export async function loadNotificationDeliveries(slug: string, limit = 20): Promise<void> {
  const deliveries = await getClient().listNotificationDeliveries(slug, { limit });
  notificationDeliveries.value = { ...notificationDeliveries.value, [slug]: deliveries };
}

export async function createNotificationEndpoint(
  input: CreateNotificationEndpointRequest,
): Promise<void> {
  await getClient().createNotificationEndpoint(input);
  await loadNotificationEndpoints();
}

export async function updateNotificationEndpoint(
  slug: string,
  patch: UpdateNotificationEndpointRequest,
): Promise<void> {
  await getClient().updateNotificationEndpoint(slug, patch);
  await loadNotificationEndpoints();
}

export async function deleteNotificationEndpoint(slug: string): Promise<void> {
  await getClient().deleteNotificationEndpoint(slug);
  const { [slug]: _dropped, ...rest } = notificationDeliveries.value;
  notificationDeliveries.value = rest;
  await loadNotificationEndpoints();
}

/** Set/replace the signing secret. Write-only — nothing here retains it. */
export async function setNotificationEndpointSecret(slug: string, secret: string): Promise<void> {
  await getClient().setNotificationEndpointSecret(slug, { secret });
  await loadNotificationEndpoints();
}

export async function deleteNotificationEndpointSecret(slug: string): Promise<void> {
  await getClient().deleteNotificationEndpointSecret(slug);
  await loadNotificationEndpoints();
}

/** Replay a stored delivery, then refresh the endpoint's receipts. */
export async function replayNotificationDelivery(
  endpointSlug: string,
  deliveryId: string,
): Promise<void> {
  await getClient().replayNotificationDelivery(deliveryId);
  await loadNotificationDeliveries(endpointSlug);
}

export async function createNotificationProfile(
  input: CreateNotificationProfileRequest,
): Promise<void> {
  await getClient().createNotificationProfile(input);
  await loadNotificationProfiles();
}

export async function deleteNotificationProfile(slug: string): Promise<void> {
  await getClient().deleteNotificationProfile(slug);
  await loadNotificationProfiles();
}

/** Set/rotate a profile's shared secret — re-keys every referencing endpoint. */
export async function setNotificationProfileSecret(slug: string, secret: string): Promise<void> {
  await getClient().setNotificationProfileSecret(slug, { secret });
  await loadNotificationProfiles();
}

/** Test-only reset so unit tests start clean. */
export function __resetNotificationsForTests(): void {
  notificationEndpoints.value = null;
  notificationsError.value = null;
  notificationsLoading.value = false;
  notificationProfiles.value = null;
  notificationDeliveries.value = {};
}
