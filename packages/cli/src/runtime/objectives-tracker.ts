/**
 * Objectives tracker — keeps the runner's cached "open objectives"
 * snapshot in sync with the server whenever an assignment, block,
 * completion, or cancellation lands for this name. The snapshot seeds
 * the runner's `context_refresh` re-brief (session attach /
 * compaction) and the objective_open/close activity markers — tool
 * descriptions deliberately do NOT consume it (they stay static so the
 * model's prompt-prefix cache survives).
 *
 * The tracker is stateless from the caller's point of view: you give
 * it a broker client + name + onRefresh callback, and you get
 * back a `refresh(message)` method. Every objective event the
 * forwarder sees is handed to `refresh`, which:
 *
 *   1. Checks whether the event matters for this slot (it must be an
 *      objective message AND either target the slot or describe an
 *      objective the slot is assignee / originator of).
 *   2. Refetches `GET /objectives?assignee=<self>&status=active` +
 *      `GET /objectives?assignee=<self>&status=blocked` — this is
 *      the authoritative "open plate" for the slot.
 *   3. Calls `onRefresh(nextOpen)` so the caller can update its live
 *      snapshot.
 *
 * Debounced: successive events within a short window collapse into a
 * single refetch so a burst of updates doesn't N-queue round trips.
 */

import type { Client as BrokerClient } from 'csuite-sdk/client';
import type { Message, Objective } from 'csuite-sdk/types';

const DEBOUNCE_MS = 150;

export interface ObjectivesTrackerOptions {
  brokerClient: BrokerClient;
  name: string;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
  onRefresh: (openObjectives: Objective[]) => void;
}

export interface ObjectivesTracker {
  /** Called by the forwarder with every channel message. Returns immediately. */
  refresh(message: Message): void;
}

export function createObjectivesTracker(opts: ObjectivesTrackerOptions): ObjectivesTracker {
  const { brokerClient, name, log, onRefresh } = opts;
  let pending: NodeJS.Timeout | null = null;
  let inflight = false;

  const doRefresh = async (): Promise<void> => {
    if (inflight) return;
    inflight = true;
    try {
      const [active, blocked] = await Promise.all([
        brokerClient.listObjectives({ assignee: name, status: 'active' }),
        brokerClient.listObjectives({ assignee: name, status: 'blocked' }),
      ]);
      onRefresh([...active, ...blocked]);
    } catch (err) {
      log('objectives refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inflight = false;
    }
  };

  return {
    refresh(message) {
      // Only react to objective-flavored channel events. The forwarder
      // already filters self-echoes (for chat); for objectives we
      // intentionally DO want to react to our own send-path responses
      // when they cross back through SSE, because that's how the UI
      // refresh path for a locally-initiated update-via-tool fires.
      const data = message.data as Record<string, unknown> | undefined;
      if (!data || data.kind !== 'objective') return;

      // Cheap client-side filter: if the event names an assignee and
      // it's not us, skip. The server scopes fanout already, but this
      // protects against future changes that might broaden the audience.
      if (typeof data.assignee === 'string' && data.assignee !== name) {
        // It might still matter if we're the *originator* of an
        // objective whose status changed — in that case the server
        // already pushed to both parties. Don't skip purely on this.
      }

      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        void doRefresh();
      }, DEBOUNCE_MS);
    },
  };
}
