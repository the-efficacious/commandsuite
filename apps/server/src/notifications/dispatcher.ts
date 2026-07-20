/**
 * External Notifications dispatcher — the delivery-policy engine
 * between the `/hooks/:slug` ingress and `broker.push`.
 *
 * Pipeline per inbound request (after the route verified transport
 * basics): rate limit → verify signature → dedupe → filter →
 * render → debounce/coalesce → per-target policy:
 *
 *   channel target   → deliver immediately (channels have no
 *                      offline/busy state)
 *   member offline   → `if_offline`: drop (receipt says so) or
 *                      queue until the runner's next subscribe
 *   member mid-turn  → `if_busy`: deliver now (steer) or wait for
 *                      idle, with a `maxWaitMs` starvation guard
 *
 * `critical` deliveries skip debounce and busy-wait — they punch
 * through. Everything the pipeline decides lands on the delivery
 * receipt (`notification_deliveries`), which doubles as the wake
 * queue's backing store.
 *
 * Wake/idle signals arrive from the HTTP layer: the `/subscribe`
 * handler calls `onWake` for runner-authenticated attaches, the
 * `/presence/activity` handler calls `onActivityReport`. A sweep
 * interval (owned by `createApp`) expires stale queue rows, force-
 * delivers starved busy-waits, and backstops debounce timers.
 *
 * Messages are pushed with `from: 'hook:<slug>'` — member names
 * can't contain `:`, so the sender identity is collision-free and
 * visibly foreign. That, plus the non-templatable wrap composed in
 * render.ts, is the injection boundary: external content never
 * arrives looking like a teammate.
 */

import type { Broker } from 'csuite-core';
import type {
  ActivityState,
  LogLevel,
  NotificationDeliveryStatus,
  NotificationEndpoint,
  NotificationOverrides,
} from 'csuite-sdk/types';
import type { ActivityTracker } from '../activity-tracker.js';
import { type ChannelStore, GENERAL_CHANNEL_ID } from '../channels.js';
import type { Logger } from '../logger.js';
import type { MemberStore } from '../members.js';
import {
  applyFilters,
  composeBody,
  defaultRender,
  parsePayload,
  renderTemplate,
} from './render.js';
import {
  type DeliveryRecord,
  NotificationsError,
  type NotificationsStore,
  type PendingRecord,
} from './store.js';
import { verifyInbound } from './verify.js';

/** Per-endpoint ingress rate limit (sliding window). */
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;

export interface IngestInput {
  endpoint: NotificationEndpoint;
  rawBody: Buffer;
  contentType: string | null;
  getHeader: (name: string) => string | undefined;
  overrides: NotificationOverrides | null;
}

export interface IngestResult {
  /** Delivery id (existing row's id for duplicates; null when rate-limited). */
  id: string | null;
  status: NotificationDeliveryStatus | 'rate_limited';
  httpStatus: number;
}

export interface NotificationDispatcher {
  ingest(input: IngestInput): Promise<IngestResult>;
  /** Re-run a stored delivery (no verify/dedupe/rate limit; filters + policy apply). */
  replay(deliveryId: string): Promise<DeliveryRecord>;
  /** Runner attached — flush this member's queued + waiting deliveries. */
  onWake(memberName: string): Promise<void>;
  /** Presence report — a non-working state flushes this member's busy-waits. */
  onActivityReport(memberName: string, state: ActivityState): Promise<void>;
  /** Expire stale queue rows, force starved waits, backstop debounce. */
  sweep(): Promise<void>;
  /** Re-dispatch deliveries stranded mid-debounce by a restart. */
  recover(): Promise<void>;
  /** Clear debounce timers (shutdown). */
  stop(): void;
}

export interface NotificationDispatcherOptions {
  store: NotificationsStore;
  broker: Broker;
  members: MemberStore;
  channels?: ChannelStore;
  activity: ActivityTracker;
  logger: Logger;
  now?: () => number;
}

interface DebounceBuffer {
  deliveryIds: string[];
  firstAt: number;
  timer: NodeJS.Timeout | null;
}

export function createNotificationDispatcher(
  options: NotificationDispatcherOptions,
): NotificationDispatcher {
  const { store, broker, members, channels, activity, logger } = options;
  const now = options.now ?? Date.now;

  const debounceBuffers = new Map<string, DebounceBuffer>();
  const rateWindows = new Map<string, number[]>();
  let stopped = false;

  function rateLimited(endpointId: string): boolean {
    const ts = now();
    const window = rateWindows.get(endpointId) ?? [];
    const fresh = window.filter((t) => ts - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length >= RATE_LIMIT_MAX) {
      rateWindows.set(endpointId, fresh);
      return true;
    }
    fresh.push(ts);
    rateWindows.set(endpointId, fresh);
    return false;
  }

  function memberExists(name: string): boolean {
    return members.members().some((m) => m.name === name);
  }

  function isConnected(name: string): boolean {
    for (const p of broker.listPresences()) {
      if (p.name === name) return p.connected > 0;
    }
    return false;
  }

  async function pushMessage(
    endpoint: NotificationEndpoint,
    body: string,
    level: LogLevel,
    title: string | null,
    data: Record<string, unknown>,
    target: { member: string } | { channel: string },
  ): Promise<string | null> {
    const from = `hook:${endpoint.slug}`;
    try {
      if ('member' in target) {
        const result = await broker.push({ to: target.member, body, title, level, data }, { from });
        return result.message.id;
      }
      const channelId = target.channel;
      const payload = {
        body,
        title,
        level,
        data: { ...data, thread: `chan:${channelId}` },
      };
      if (channels && channelId !== GENERAL_CHANNEL_ID) {
        const recipients = channels.recipientNames(channelId);
        if (recipients === null) return null;
        const result = await broker.push(payload, { from, recipients });
        return result.message.id;
      }
      // General (or no channel store): implicit membership → broadcast.
      const result = await broker.push(payload, { from });
      return result.message.id;
    } catch (err) {
      logger.warn('notification push failed', {
        endpoint: endpoint.slug,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Deliver a (possibly coalesced) group to the endpoint's targets,
   * applying per-member offline/busy policy. Updates every delivery
   * row in the group with the outcome.
   */
  async function dispatchGroup(
    endpoint: NotificationEndpoint,
    group: DeliveryRecord[],
    opts?: { queuedMs?: number; queuedReason?: 'offline' | 'busy'; forceMember?: string },
  ): Promise<void> {
    if (group.length === 0) return;
    const newest = [...group].sort((a, b) => b.receivedAt - a.receivedAt);
    const primary = newest[0] as DeliveryRecord;
    const level = primary.level;
    const title = primary.title;
    const overrides = primary.overrides;
    const policy = {
      ...endpoint.policy,
      ...(overrides?.ifOffline ? { ifOffline: overrides.ifOffline } : {}),
      ...(overrides?.ifBusy ? { ifBusy: overrides.ifBusy } : {}),
    };

    const body = composeBody({
      endpointSlug: endpoint.slug,
      displayName: endpoint.displayName,
      deliveries: newest,
      ...(opts?.queuedMs !== undefined ? { queuedMs: opts.queuedMs } : {}),
      ...(opts?.queuedReason !== undefined ? { queuedReason: opts.queuedReason } : {}),
      now: now(),
    });
    const data: Record<string, unknown> = {
      kind: 'external_notification',
      endpoint: endpoint.slug,
      delivery_ids: newest.map((d) => d.id),
      ...(newest.length > 1 ? { coalesced: newest.length } : {}),
      ...(opts?.queuedMs !== undefined ? { queued_ms: opts.queuedMs } : {}),
    };

    const messageIds: string[] = [];
    const notes: string[] = [];
    let queued = 0;

    // When flushing a queue we deliver to exactly the queued member —
    // other targets already got their copies on the original pass.
    const targets = opts?.forceMember ? [{ member: opts.forceMember }] : endpoint.targets;

    for (const target of targets) {
      if (target.channel !== undefined) {
        const id = await pushMessage(endpoint, body, level, title, data, {
          channel: target.channel,
        });
        if (id !== null) messageIds.push(id);
        else notes.push(`channel ${target.channel} unavailable`);
        continue;
      }
      if (target.member === undefined) continue;
      const name = target.member;
      if (!memberExists(name)) {
        notes.push(`member ${name} no longer exists`);
        continue;
      }

      const online = isConnected(name);
      const busy = activity.getActivity(name) === 'working';
      const force = opts?.forceMember === name;

      if (!online && !force) {
        if (policy.ifOffline === 'queue') {
          store.insertPending({
            endpointId: endpoint.id,
            memberName: name,
            reason: 'offline',
            deliveryIds: newest.map((d) => d.id),
            level,
            title,
            createdAt: now(),
            deadlineAt: now() + endpoint.policy.queueTtlMs,
          });
          queued += 1;
          notes.push(`queued for ${name} (offline)`);
        } else {
          notes.push(`dropped for ${name} (offline)`);
        }
        continue;
      }

      if (online && busy && policy.ifBusy === 'wait' && level !== 'critical' && !force) {
        store.insertPending({
          endpointId: endpoint.id,
          memberName: name,
          reason: 'busy',
          deliveryIds: newest.map((d) => d.id),
          level,
          title,
          createdAt: now(),
          deadlineAt: now() + endpoint.policy.maxWaitMs,
        });
        queued += 1;
        notes.push(`waiting for ${name} (mid-task)`);
        continue;
      }

      const id = await pushMessage(endpoint, body, level, title, data, { member: name });
      if (id !== null) messageIds.push(id);
      else notes.push(`push to ${name} failed`);
    }

    const reason = notes.length > 0 ? notes.join('; ') : null;
    const status: NotificationDeliveryStatus =
      messageIds.length > 0 ? 'delivered' : queued > 0 ? 'pending' : 'dropped';

    for (const [index, delivery] of newest.entries()) {
      // Preserve terminal facts already on the row (e.g. a wake flush
      // adding messageIds to an already-delivered delivery).
      const rowStatus: NotificationDeliveryStatus =
        messageIds.length > 0 && index > 0 ? 'coalesced' : status;
      store.updateDelivery(delivery.id, {
        status:
          delivery.status === 'delivered' || delivery.status === 'coalesced'
            ? delivery.status
            : rowStatus,
        statusReason: reason,
        addMessageIds: messageIds,
        ...(messageIds.length > 0 ? { deliveredAt: now() } : {}),
      });
    }
  }

  function flushDebounce(endpointId: string): void {
    const buffer = debounceBuffers.get(endpointId);
    if (!buffer) return;
    debounceBuffers.delete(endpointId);
    if (buffer.timer !== null) clearTimeout(buffer.timer);
    const endpoint = store.get(endpointId);
    if (!endpoint) return;
    const group = store.deliveriesByIds(buffer.deliveryIds);
    void dispatchGroup(endpoint, group).catch((err) => {
      logger.warn('notification debounce flush failed', {
        endpoint: endpoint.slug,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /** Flush a member's pending rows (optionally one reason only). */
  async function flushPendingFor(memberName: string, reason?: 'offline' | 'busy'): Promise<void> {
    const rows = store.pendingForMember(memberName, reason);
    if (rows.length === 0) return;
    await flushPendingRows(rows, memberName);
  }

  async function flushPendingRows(rows: PendingRecord[], memberName: string): Promise<void> {
    // Group by endpoint so one wake produces one coalesced message
    // per endpoint, not one per held delivery.
    const byEndpoint = new Map<string, PendingRecord[]>();
    for (const row of rows) {
      const list = byEndpoint.get(row.endpointId) ?? [];
      list.push(row);
      byEndpoint.set(row.endpointId, list);
    }
    for (const [endpointId, group] of byEndpoint) {
      store.deletePending(group.map((r) => r.id));
      const endpoint = store.get(endpointId);
      if (!endpoint) continue;
      const deliveryIds = [...new Set(group.flatMap((r) => r.deliveryIds))];
      const deliveries = store.deliveriesByIds(deliveryIds);
      if (deliveries.length === 0) continue;
      const oldest = Math.min(...group.map((r) => r.createdAt));
      const queuedReason = group.every((r) => r.reason === 'busy') ? 'busy' : 'offline';
      await dispatchGroup(endpoint, deliveries, {
        queuedMs: now() - oldest,
        queuedReason,
        forceMember: memberName,
      });
    }
  }

  async function runPipeline(
    endpoint: NotificationEndpoint,
    delivery: DeliveryRecord,
  ): Promise<IngestResult> {
    const payload = parsePayload(delivery.body);

    const filter = applyFilters(endpoint.filters, payload);
    if (!filter.pass) {
      store.updateDelivery(delivery.id, { status: 'filtered', statusReason: filter.reason });
      return { id: delivery.id, status: 'filtered', httpStatus: 202 };
    }

    const rendered =
      endpoint.template !== null
        ? renderTemplate(endpoint.template, payload)
        : defaultRender(delivery.body, payload);
    store.updateDelivery(delivery.id, { rendered });
    const record = store.getDeliveryRecord(delivery.id) as DeliveryRecord;

    // Debounce (critical punches through).
    if (endpoint.policy.debounceMs > 0 && record.level !== 'critical') {
      const buffer = debounceBuffers.get(endpoint.id) ?? {
        deliveryIds: [],
        firstAt: now(),
        timer: null,
      };
      buffer.deliveryIds.push(record.id);
      if (!debounceBuffers.has(endpoint.id)) {
        debounceBuffers.set(endpoint.id, buffer);
        if (!stopped) {
          buffer.timer = setTimeout(() => flushDebounce(endpoint.id), endpoint.policy.debounceMs);
          buffer.timer.unref?.();
        }
      }
      store.updateDelivery(record.id, { status: 'pending', statusReason: 'debouncing' });
      if (buffer.deliveryIds.length >= endpoint.policy.debounceMax) {
        flushDebounce(endpoint.id);
      }
      return { id: record.id, status: 'pending', httpStatus: 202 };
    }

    await dispatchGroup(endpoint, [record]);
    const final = store.getDeliveryRecord(record.id) as DeliveryRecord;
    return { id: final.id, status: final.status, httpStatus: 202 };
  }

  return {
    async ingest(input: IngestInput): Promise<IngestResult> {
      const { endpoint } = input;

      if (rateLimited(endpoint.id)) {
        // Deliberately NOT recorded — receipts under a flood would be
        // their own denial of service.
        return { id: null, status: 'rate_limited', httpStatus: 429 };
      }

      // Verify. Failures are recorded (security visibility) but the
      // HTTP response stays a detail-free 401.
      let verifyReason: string | null = null;
      try {
        const verification = store.resolveVerification(endpoint.id);
        const result = verifyInbound(verification, input.rawBody, input.getHeader);
        if (!result.ok) verifyReason = result.reason;
      } catch (err) {
        verifyReason =
          err instanceof NotificationsError && err.code === 'no_kek'
            ? 'encryption key unavailable'
            : `verification error: ${err instanceof Error ? err.message : String(err)}`;
      }

      const bodyText = input.rawBody.toString('utf8');
      const level = input.overrides?.level ?? endpoint.level;
      const title = endpoint.title ?? (endpoint.displayName || endpoint.slug);

      if (verifyReason !== null) {
        const rejected = store.insertDelivery({
          endpointId: endpoint.id,
          endpointSlug: endpoint.slug,
          receivedAt: now(),
          status: 'rejected',
          statusReason: verifyReason,
          body: bodyText,
          contentType: input.contentType,
          level,
          title,
          overrides: input.overrides,
        });
        logger.warn('hook delivery rejected', { endpoint: endpoint.slug, reason: verifyReason });
        return { id: rejected.id, status: 'rejected', httpStatus: 401 };
      }

      // Dedupe on the provider's delivery id, when configured.
      let dedupeKey: string | null = null;
      if (endpoint.dedupeHeader !== null) {
        const headerValue = input.getHeader(endpoint.dedupeHeader);
        if (headerValue !== undefined && headerValue.length > 0) {
          dedupeKey = headerValue.slice(0, 256);
          const existing = store.findDeliveryByDedupe(endpoint.id, dedupeKey);
          if (existing) {
            return { id: existing.id, status: 'duplicate', httpStatus: 202 };
          }
        }
      }

      const delivery = store.insertDelivery({
        endpointId: endpoint.id,
        endpointSlug: endpoint.slug,
        receivedAt: now(),
        status: 'pending',
        dedupeKey,
        body: bodyText,
        contentType: input.contentType,
        level,
        title,
        overrides: input.overrides,
      });

      return runPipeline(endpoint, delivery);
    },

    async replay(deliveryId: string): Promise<DeliveryRecord> {
      const source = store.getDeliveryRecord(deliveryId);
      if (!source) throw new NotificationsError('not_found', `delivery ${deliveryId} not found`);
      const endpoint = store.get(source.endpointId);
      if (!endpoint) {
        throw new NotificationsError('not_found', 'the delivery’s endpoint no longer exists');
      }
      const fresh = store.insertDelivery({
        endpointId: endpoint.id,
        endpointSlug: endpoint.slug,
        receivedAt: now(),
        status: 'pending',
        body: source.body,
        contentType: source.contentType,
        level: endpoint.level,
        title: endpoint.title ?? (endpoint.displayName || endpoint.slug),
        replayOf: source.id,
      });
      await runPipeline(endpoint, fresh);
      return store.getDeliveryRecord(fresh.id) as DeliveryRecord;
    },

    async onWake(memberName: string): Promise<void> {
      await flushPendingFor(memberName);
    },

    async onActivityReport(memberName: string, state: ActivityState): Promise<void> {
      if (state === 'working') return;
      await flushPendingFor(memberName, 'busy');
    },

    async sweep(): Promise<void> {
      const ts = now();

      // Debounce backstop — timers normally handle this; a sweep pass
      // covers timer loss (stopped flag flips, clock injection in tests).
      for (const [endpointId, buffer] of debounceBuffers) {
        const endpoint = store.get(endpointId);
        const windowMs = endpoint?.policy.debounceMs ?? 0;
        if (ts - buffer.firstAt >= windowMs) flushDebounce(endpointId);
      }

      const due = store.pendingDue(ts);
      if (due.length === 0) return;

      // Expire offline-queued rows past their TTL.
      const expired = due.filter((r) => r.reason === 'offline');
      if (expired.length > 0) {
        store.deletePending(expired.map((r) => r.id));
        for (const row of expired) {
          for (const delivery of store.deliveriesByIds(row.deliveryIds)) {
            if (delivery.status === 'pending') {
              store.updateDelivery(delivery.id, {
                status: 'expired',
                statusReason: `queue TTL lapsed before ${row.memberName} woke`,
              });
            }
          }
        }
      }

      // Force-deliver starved busy-waits (the starvation guard).
      const starved = due.filter((r) => r.reason === 'busy');
      const byMember = new Map<string, PendingRecord[]>();
      for (const row of starved) {
        const list = byMember.get(row.memberName) ?? [];
        list.push(row);
        byMember.set(row.memberName, list);
      }
      for (const [memberName, rows] of byMember) {
        await flushPendingRows(rows, memberName);
      }
    },

    async recover(): Promise<void> {
      const stranded = store.listStrandedDebounce();
      if (stranded.length === 0) return;
      const byEndpoint = new Map<string, DeliveryRecord[]>();
      for (const delivery of stranded) {
        const list = byEndpoint.get(delivery.endpointId) ?? [];
        list.push(delivery);
        byEndpoint.set(delivery.endpointId, list);
      }
      for (const [endpointId, group] of byEndpoint) {
        const endpoint = store.get(endpointId);
        if (!endpoint) continue;
        await dispatchGroup(endpoint, group);
      }
    },

    stop(): void {
      stopped = true;
      for (const buffer of debounceBuffers.values()) {
        if (buffer.timer !== null) clearTimeout(buffer.timer);
        buffer.timer = null;
      }
    },
  };
}
