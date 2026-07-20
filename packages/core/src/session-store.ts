/**
 * Session store — cookie-backed human web-UI sessions.
 *
 * A session is a server-issued capability: after TOTP verification,
 * the caller mints a session row binding a random `id` to a member
 * name. Every subsequent request presenting the cookie resolves back
 * to the member via the dual-auth middleware, same as a bearer-token
 * request.
 *
 * Lifetime: sliding 7-day TTL. Every `touch()` extends `expiresAt`.
 * Expired rows are treated as nonexistent on read and purged by
 * `purgeExpired()` (run periodically, not on every request — don't put
 * a DELETE in the auth hot path).
 *
 * Core depends only on this interface; the concrete implementation is
 * injected by the runtime adapter (Node server uses SQLite, tests use
 * the in-memory variant below, Cloudflare platform uses DO storage).
 * IO is async in the interface even when an impl could be sync, so
 * async-only runtimes aren't forced to lie.
 */
export const SESSION_COOKIE_NAME = 'csuite_session';

/** 7 days. Sliding — every API call resets the window. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionRow {
  id: string;
  memberName: string;
  createdAt: number;
  expiresAt: number;
  lastSeen: number;
  userAgent: string | null;
}

export interface SessionStore {
  /**
   * Mint a fresh session for `memberName`. Returns the row so the
   * caller can put the `id` in a `Set-Cookie` header and return the
   * `expiresAt` to the SPA. The implementation is responsible for
   * generating a cryptographically random `id` of at least 128 bits of
   * entropy — the interface does not take one as input because the
   * choice of random source is runtime-specific (`node:crypto` for the
   * Node server, Web Crypto for Workers).
   */
  create(memberName: string, userAgent: string | null): Promise<SessionRow>;

  /**
   * Look up a session by id. Returns null if the row doesn't exist or
   * is expired. Expired rows are not eagerly deleted here; that's
   * `purgeExpired()`'s responsibility.
   */
  get(id: string): Promise<SessionRow | null>;

  /**
   * Bump `lastSeen` and extend `expiresAt` for an existing session.
   * Called on every authenticated request the session carries, so the
   * TTL slides as long as the member stays active. No-op if the id
   * doesn't exist.
   */
  touch(id: string): Promise<void>;

  /** Delete a specific session (logout). No-op if the id doesn't exist. */
  delete(id: string): Promise<void>;

  /**
   * Best-effort cleanup of expired rows. Returns the count removed.
   * Safe to call periodically and on shutdown.
   */
  purgeExpired(): Promise<number>;

  /** Close any underlying resources. No-op for in-memory impl. */
  close?(): Promise<void>;
}

/**
 * In-memory session store. Useful for tests and ephemeral dev runs.
 *
 * ID generation uses `Math.random()` + a timestamp suffix — **not**
 * cryptographically suitable for production; in-memory is a test
 * fixture. Real impls should generate from `node:crypto.randomBytes`
 * (server) or `crypto.getRandomValues` (Workers).
 */
export interface InMemorySessionStoreOptions {
  /** Inject a deterministic clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Inject a deterministic id generator for tests. */
  idGenerator?: () => string;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRow>();
  private readonly now: () => number;
  private readonly idGenerator: () => string;

  constructor(options: InMemorySessionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
  }

  async create(memberName: string, userAgent: string | null): Promise<SessionRow> {
    const now = this.now();
    const row: SessionRow = {
      id: this.idGenerator(),
      memberName,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      lastSeen: now,
      userAgent,
    };
    this.sessions.set(row.id, row);
    return row;
  }

  async get(id: string): Promise<SessionRow | null> {
    const row = this.sessions.get(id);
    if (!row) return null;
    if (row.expiresAt < this.now()) return null;
    return row;
  }

  async touch(id: string): Promise<void> {
    const row = this.sessions.get(id);
    if (!row) return;
    const now = this.now();
    row.lastSeen = now;
    row.expiresAt = now + SESSION_TTL_MS;
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async purgeExpired(): Promise<number> {
    const cutoff = this.now();
    let removed = 0;
    for (const [id, row] of this.sessions) {
      if (row.expiresAt < cutoff) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Test-only: number of sessions currently in the store. */
  size(): number {
    return this.sessions.size;
  }
}

function defaultIdGenerator(): string {
  // NOT cryptographically secure — in-memory is a test fixture. See
  // the class doc for why production impls must not use this.
  return `imss_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
