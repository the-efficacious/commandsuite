/**
 * Push subscription store — Web Push capability records.
 *
 * A push subscription is a capability URL + crypto keys the browser
 * hands the server after `pushManager.subscribe()`. Treat the endpoint
 * like a session token: anyone holding it can push to the device. The
 * store holds one row per (memberName, endpoint) pair — the same
 * member can have many devices enrolled.
 *
 * Dead-subscription lifecycle: when the web-push dispatch layer
 * observes a 404 or 410 from the push service, it calls
 * `deleteByEndpoint` so the next fanout doesn't spend CPU on a lost
 * device. `lastErrorCode` is kept for ops debugging on the happy path.
 *
 * Core depends only on this interface; the concrete implementation is
 * injected by the runtime adapter (Node server uses SQLite; Workers
 * platform uses D1 or Durable Object storage). IO is async in the
 * interface so async-only runtimes aren't forced to lie.
 */

export interface PushSubscriptionRow {
  id: number;
  memberName: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: number;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastErrorCode: number | null;
}

export interface PushSubscriptionInput {
  memberName: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}

export interface PushSubscriptionStore {
  /**
   * Register (or refresh) a push subscription for a member. Returns
   * the persisted row. Idempotent on `endpoint` — calling twice with
   * the same endpoint replaces the row's crypto keys and clears
   * error state, rather than duplicating.
   */
  upsert(input: PushSubscriptionInput): Promise<PushSubscriptionRow>;

  /** List every subscription owned by `memberName`. */
  listForMember(memberName: string): Promise<PushSubscriptionRow[]>;

  /** Look up a row by the unique `endpoint` URL. */
  findByEndpoint(endpoint: string): Promise<PushSubscriptionRow | null>;

  /**
   * Delete a subscription the given member owns. Scoped by name so a
   * session can't delete other members' subscriptions even with a
   * guessed id. No-op if the row doesn't exist or belongs to another
   * member.
   */
  deleteForMember(id: number, memberName: string): Promise<void>;

  /**
   * Delete by endpoint — used by the dispatch path when a push attempt
   * returns 404/410 Gone and the dead row must be purged atomically
   * (the caller often doesn't know the `id` at that point).
   */
  deleteByEndpoint(endpoint: string): Promise<void>;

  /**
   * Mark a subscription as successfully delivered-to at `now()`.
   * Clears any pending error state.
   */
  markSuccess(id: number): Promise<void>;

  /**
   * Record a delivery failure for a subscription — `statusCode` is the
   * HTTP status returned by the push service. The dispatch layer
   * decides separately whether the error is terminal (call
   * `deleteByEndpoint`) or transient (just `markError`).
   */
  markError(id: number, statusCode: number): Promise<void>;

  /** Close any underlying resources. No-op for in-memory impl. */
  close?(): Promise<void>;
}

/** In-memory push subscription store. Useful for tests. */
export interface InMemoryPushSubscriptionStoreOptions {
  /** Inject a deterministic clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export class InMemoryPushSubscriptionStore implements PushSubscriptionStore {
  private readonly rows: PushSubscriptionRow[] = [];
  private readonly now: () => number;
  private nextId = 1;

  constructor(options: InMemoryPushSubscriptionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async upsert(input: PushSubscriptionInput): Promise<PushSubscriptionRow> {
    const now = this.now();
    const existingIdx = this.rows.findIndex((r) => r.endpoint === input.endpoint);
    const current = existingIdx >= 0 ? this.rows[existingIdx] : undefined;
    if (current !== undefined) {
      const replaced: PushSubscriptionRow = {
        ...current,
        memberName: input.memberName,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent,
        createdAt: now,
        lastErrorAt: null,
        lastErrorCode: null,
      };
      this.rows[existingIdx] = replaced;
      return replaced;
    }
    const row: PushSubscriptionRow = {
      id: this.nextId++,
      memberName: input.memberName,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent,
      createdAt: now,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
    };
    this.rows.push(row);
    return row;
  }

  async listForMember(memberName: string): Promise<PushSubscriptionRow[]> {
    return this.rows.filter((r) => r.memberName === memberName);
  }

  async findByEndpoint(endpoint: string): Promise<PushSubscriptionRow | null> {
    return this.rows.find((r) => r.endpoint === endpoint) ?? null;
  }

  async deleteForMember(id: number, memberName: string): Promise<void> {
    const idx = this.rows.findIndex((r) => r.id === id && r.memberName === memberName);
    if (idx >= 0) this.rows.splice(idx, 1);
  }

  async deleteByEndpoint(endpoint: string): Promise<void> {
    const idx = this.rows.findIndex((r) => r.endpoint === endpoint);
    if (idx >= 0) this.rows.splice(idx, 1);
  }

  async markSuccess(id: number): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.lastSuccessAt = this.now();
    row.lastErrorAt = null;
    row.lastErrorCode = null;
  }

  async markError(id: number, statusCode: number): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.lastErrorAt = this.now();
    row.lastErrorCode = statusCode;
  }

  /** Test-only: number of rows currently in the store. */
  size(): number {
    return this.rows.length;
  }
}
