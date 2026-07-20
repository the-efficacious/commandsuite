/**
 * Streaming agent-activity uploader.
 *
 * Batches `ActivityEvent`s and ships them to the broker via
 * `POST /agents/:name/activity`. Fire-and-forget from the
 * caller's point of view: `enqueue(event)` returns immediately,
 * the uploader flushes on its own schedule.
 *
 * Flush triggers:
 *   - event count ≥ `maxBatchEvents` (default 50)
 *   - payload bytes ≥ `maxBatchBytes` (default 64 KB)
 *   - time since oldest queued event ≥ `maxBatchAgeMs` (default 500 ms)
 *   - explicit `flush()` / `close()` call
 *
 * Failure handling:
 *   - On HTTP error or network failure, the in-flight batch is
 *     RE-queued at the head and a backoff timer gates the next
 *     flush attempt (starts at 200 ms, doubles up to 30 s).
 *   - The queue has a hard cap (default 1000 events / 1 MB). If a
 *     new event would exceed either, the OLDEST queued event is
 *     dropped with a warning — we prefer losing history over
 *     stalling the uploader indefinitely when the broker is
 *     unreachable.
 *
 * Concurrency: one in-flight upload at a time per uploader. The
 * runner spawns exactly one uploader, so we don't need cross-
 * instance coordination.
 */

import type { Client as BrokerClient } from 'csuite-sdk/client';
import type { ActivityEvent } from 'csuite-sdk/types';

export interface ActivityUploaderOptions {
  brokerClient: BrokerClient;
  name: string;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Max events per POST. Default 50. */
  maxBatchEvents?: number;
  /** Max payload size per POST, in bytes. Default 64 KB. */
  maxBatchBytes?: number;
  /** Max time an event sits in the queue before a forced flush. Default 500 ms. */
  maxBatchAgeMs?: number;
  /** Hard cap on queued events. Default 1000. */
  maxQueueEvents?: number;
  /** Hard cap on queued bytes. Default 64 MB. */
  maxQueueBytes?: number;
  /** Max cumulative bytes per POST. Default 8 MB. */
  maxPostBytes?: number;
}

const DEFAULT_MAX_BATCH_EVENTS = 50;
const DEFAULT_MAX_BATCH_BYTES = 64 * 1024;
const DEFAULT_MAX_BATCH_AGE_MS = 500;
const DEFAULT_MAX_QUEUE_EVENTS = 1000;
// Large tool_action results (multi-MB command output / file blobs) and
// large llm_exchange entries can each be multiple MB. A 1 MB queue cap
// used to evict other queued events just to fit one big event; 64 MB
// holds real bursts so nothing is dropped for size under normal
// operation. This is an in-RAM backpressure ceiling, only approached
// when the broker is unreachable and events pile up.
const DEFAULT_MAX_QUEUE_BYTES = 64 * 1024 * 1024;
// Bound a single POST so one flush can't balloon into a giant request
// (50 multi-MB events at once). A batch always carries at least one
// event, so an oversized single event still ships — just alone.
const DEFAULT_MAX_POST_BYTES = 8 * 1024 * 1024;
const BACKOFF_START_MS = 200;
const BACKOFF_MAX_MS = 30_000;

interface QueuedEvent {
  event: ActivityEvent;
  bytes: number;
}

export class ActivityUploader {
  private readonly brokerClient: BrokerClient;
  private readonly name: string;
  private readonly log: (msg: string, ctx?: Record<string, unknown>) => void;
  private readonly maxBatchEvents: number;
  private readonly maxBatchBytes: number;
  private readonly maxBatchAgeMs: number;
  private readonly maxQueueEvents: number;
  private readonly maxQueueBytes: number;
  private readonly maxPostBytes: number;

  private queue: QueuedEvent[] = [];
  private queueBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private closed = false;
  private backoffMs = 0;
  private backoffTimer: NodeJS.Timeout | null = null;

  constructor(options: ActivityUploaderOptions) {
    this.brokerClient = options.brokerClient;
    this.name = options.name;
    this.log = options.log ?? (() => {});
    this.maxBatchEvents = options.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS;
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.maxBatchAgeMs = options.maxBatchAgeMs ?? DEFAULT_MAX_BATCH_AGE_MS;
    this.maxQueueEvents = options.maxQueueEvents ?? DEFAULT_MAX_QUEUE_EVENTS;
    this.maxQueueBytes = options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    this.maxPostBytes = options.maxPostBytes ?? DEFAULT_MAX_POST_BYTES;
  }

  /**
   * Add an event to the outbound queue. Non-blocking. If the queue
   * is at its hard cap, the oldest event is dropped first.
   */
  enqueue(event: ActivityEvent): void {
    if (this.closed) {
      this.log('activity-uploader: dropping event on closed uploader', { kind: event.kind });
      return;
    }
    const bytes = JSON.stringify(event).length;

    // Cap check: drop oldest until we have room.
    while (
      this.queue.length > 0 &&
      (this.queue.length + 1 > this.maxQueueEvents || this.queueBytes + bytes > this.maxQueueBytes)
    ) {
      const dropped = this.queue.shift();
      if (dropped) {
        this.queueBytes -= dropped.bytes;
        this.log('activity-uploader: queue full, dropping oldest', {
          queued: this.queue.length,
          bytes: this.queueBytes,
        });
      } else break;
    }

    this.queue.push({ event, bytes });
    this.queueBytes += bytes;

    // Immediate flush triggers.
    if (this.queue.length >= this.maxBatchEvents || this.queueBytes >= this.maxBatchBytes) {
      this.scheduleFlush(0);
    } else {
      this.scheduleFlush(this.maxBatchAgeMs);
    }
  }

  /**
   * Force a flush attempt now. Returns a promise that resolves when
   * the uploader is idle (queue empty or backoff waiting).
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.doFlush();
  }

  /**
   * Drain the queue and stop accepting new events. Best-effort —
   * exactly one final flush attempt per remaining batch; any
   * events that fail that attempt are dropped rather than
   * retried. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // One shot at draining. `doFlush` catches upload errors and
    // re-queues + backs off internally; we strip the re-queue by
    // clearing the queue after the call. Anything still in-flight
    // is lost on process exit, which matches best-effort semantics.
    const hadEvents = this.queue.length > 0;
    if (hadEvents) {
      try {
        await this.doFlush();
      } catch {
        /* doFlush catches internally; this is defensive */
      }
    }
    // Drop any re-queued events + cancel any backoff retry.
    const dropped = this.queue.length;
    if (dropped > 0) {
      this.log('activity-uploader: close dropping events after final flush', {
        dropped,
      });
    }
    this.queue = [];
    this.queueBytes = 0;
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  // ─── Internal ────────────────────────────────────────────────

  /**
   * Pull the next batch off the queue, bounded by BOTH the event count
   * (`maxBatchEvents`) and cumulative bytes (`maxPostBytes`). Always
   * returns at least one event so a single oversized event still ships
   * (alone) rather than wedging the queue forever.
   */
  private takeBatch(): QueuedEvent[] {
    const batch: QueuedEvent[] = [];
    let bytes = 0;
    while (this.queue.length > 0 && batch.length < this.maxBatchEvents) {
      const next = this.queue[0];
      if (!next) break;
      // Stop before exceeding the per-POST byte budget — unless this is
      // the first event, which always goes (it may be larger on its own).
      if (batch.length > 0 && bytes + next.bytes > this.maxPostBytes) break;
      this.queue.shift();
      batch.push(next);
      bytes += next.bytes;
    }
    return batch;
  }

  private scheduleFlush(delayMs: number): void {
    if (this.inFlight || this.closed || this.backoffTimer) return;
    // Already scheduled: only reschedule if the new delay is
    // strictly shorter. Upgrades the slow "maxBatchAgeMs" timer
    // to an immediate flush when a size threshold is hit.
    if (this.flushTimer) {
      if (delayMs >= this.maxBatchAgeMs) return;
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.doFlush();
    }, delayMs);
    // Don't keep the event loop alive just for this timer — runner
    // shutdown should be able to exit even if a flush is pending.
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  private async doFlush(): Promise<void> {
    if (this.inFlight) return;
    if (this.queue.length === 0) return;
    this.inFlight = true;
    const batch = this.takeBatch();
    const batchBytes = batch.reduce((n, q) => n + q.bytes, 0);
    this.queueBytes -= batchBytes;

    const events = batch.map((q) => q.event);
    try {
      const result = await this.brokerClient.uploadActivity(this.name, { events });
      this.log('activity-uploader: flushed', {
        accepted: result.accepted,
        remaining: this.queue.length,
      });
      this.backoffMs = 0;
    } catch (err) {
      // Re-queue the batch at the head so ordering is preserved.
      this.queue.unshift(...batch);
      this.queueBytes += batchBytes;
      this.backoffMs =
        this.backoffMs === 0 ? BACKOFF_START_MS : Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
      this.log('activity-uploader: upload failed, backing off', {
        error: err instanceof Error ? err.message : String(err),
        backoffMs: this.backoffMs,
        queued: this.queue.length,
      });
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = null;
        this.scheduleFlush(0);
      }, this.backoffMs);
      if (typeof this.backoffTimer.unref === 'function') this.backoffTimer.unref();
    } finally {
      this.inFlight = false;
    }

    // If more remained and we didn't back off, schedule the next flush.
    if (this.queue.length > 0 && this.backoffMs === 0) {
      this.scheduleFlush(0);
    }
  }

  /** Test-only: inspect queue state. */
  __debugQueueLength(): number {
    return this.queue.length;
  }
}
