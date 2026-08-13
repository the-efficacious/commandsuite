/**
 * Web Push delivery seam. The dispatch layer decides WHO gets a push
 * and what happens to the subscription afterwards; the sender only
 * moves one payload to one endpoint and reports what the push service
 * said. Reference implementation: `csuite-server`'s web-push-backed
 * sender. Tests inject a capturing fake.
 */

export interface PushSenderSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSendOutcome =
  /** Accepted by the push service. */
  | { kind: 'ok' }
  /** 404/410 — the subscription is dead and should be dropped. */
  | { kind: 'gone'; status: number }
  /** Any other push-service rejection. */
  | { kind: 'failed'; status: number };

export interface PushSender {
  /**
   * Deliver `payload` (already-serialized JSON) to one subscription.
   * Never throws for push-service outcomes — those come back as
   * `gone`/`failed`. Only infrastructure errors (network stack,
   * crypto) may throw, and the dispatcher records those as status -1.
   */
  send(
    subscription: PushSenderSubscription,
    payload: string,
    options: { ttlSeconds: number },
  ): Promise<PushSendOutcome>;
}
