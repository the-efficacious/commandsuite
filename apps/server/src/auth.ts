/**
 * Tri-auth middleware: bearer token, session cookie, OR JWT, all
 * resolving to the same `LoadedMember`.
 *
 * csuite has three auth planes:
 *   - machine (MCP link): `Authorization: Bearer csuite_...` — opaque,
 *     long-lived tokens in the config file, resolved via
 *     `members.resolve(raw)`.
 *   - human (web SPA):    `Cookie: csuite_session=...` — minted after TOTP
 *     verification, resolved via `sessions.get(id)` → `members.findByName`.
 *   - federated JWT:      `Authorization: Bearer <jwt>` — RS256 token
 *     minted by a trusted issuer and verified against the configured
 *     JWKS. The `member` claim names a roster entry; unknown names are
 *     hard-rejected (memberships are managed via the invite flow, never
 *     by JWT side channels).
 *
 * The JWT and opaque-bearer planes share the `Authorization: Bearer`
 * header — we disambiguate by shape. Opaque tokens never contain dots;
 * JWTs are always three dot-separated base64url segments. When a JWT
 * verifier is configured AND the header matches JWT structure we take
 * the JWT branch; otherwise we fall through to the opaque lookup. If
 * the JWT branch runs and verification fails we 401 — we do not fall
 * through, because a structurally-valid JWT that fails verify is an
 * auth error, not an "unknown opaque token".
 *
 * All three paths attach the same `LoadedMember` to `c.var.member`.
 * Downstream handlers (/briefing, /push, /subscribe, /history) don't
 * care which plane authenticated the request — the identity surface
 * is the member.
 */

import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { type JwtVerifier, looksLikeJwt } from './jwt.js';
import type { Logger } from './logger.js';
import type { LoadedMember, MemberStore } from './members.js';
import { SESSION_COOKIE_NAME, type SessionStore } from './sessions.js';
import type { TokenStore } from './tokens.js';

export interface AuthDependencies {
  members: MemberStore;
  /**
   * Bearer-token store. Multi-token-per-member SQLite-backed lookup
   * replaces the legacy `MemberStore.resolve`. Plumbed through here
   * because the resolver needs to translate `Authorization: Bearer
   * csuite_…` → token row → member, and update `last_used_at` on hit.
   */
  tokens: TokenStore;
  sessions: SessionStore;
  logger: Logger;
  /**
   * Optional JWKS-backed JWT verifier. When present, bearer tokens
   * that look structurally like JWTs are verified against this
   * issuer; when omitted, the JWT path is dormant and every bearer
   * token follows the opaque lookup. Wiring is config-gated in
   * `runServer`.
   */
  jwt?: JwtVerifier;
}

export type AuthBindings = {
  Variables: {
    member: LoadedMember;
    /** Id of the session that authenticated, if any. Null on bearer auth. */
    sessionId: string | null;
    /**
     * Id of the token row that authenticated, if any. Null on session
     * or JWT auth. Used by token-revoke endpoints so a member can
     * "sign off this device" by revoking the token they're currently
     * authenticating with.
     */
    tokenId: string | null;
  };
};

/**
 * Build the auth middleware. Returns a 401 with a specific error
 * string for each failure mode so the SPA can distinguish "no
 * credentials" from "stale session" and redirect accordingly.
 */
export function createAuthMiddleware(deps: AuthDependencies): MiddlewareHandler<AuthBindings> {
  const { members, tokens, sessions, logger, jwt } = deps;

  return async (c, next) => {
    // Bearer token wins if present — keeps machine-path semantics
    // identical to the pre-TOTP era.
    // Accept both `Bearer <token>` and the percent-encoded
    // `Bearer%20<token>`: OTEL OTLP exporters (Claude Code's log export)
    // pass the OTEL_EXPORTER_OTLP_HEADERS value without URL-decoding, so
    // the space can arrive as `%20`.
    const header = c.req.header('Authorization')?.replace(/^Bearer%20/i, 'Bearer ');
    if (header?.startsWith('Bearer ')) {
      const raw = header.slice('Bearer '.length).trim();
      if (raw.length === 0) {
        return c.json({ error: 'missing bearer token' }, 401);
      }

      // JWT branch: structurally a JWT AND a verifier is configured.
      // A well-formed-but-unverifiable JWT is a hard 401 — we never
      // fall through to the opaque-token path from here, because that
      // would make any attacker's expired/forged JWT check twice
      // against unrelated credential stores.
      if (jwt && looksLikeJwt(raw)) {
        try {
          const claims = await jwt.verify(raw);
          const member = members.findByName(claims.member);
          if (!member) {
            // Hard reject unknown members. Adding a member is an
            // out-of-band invite flow; a JWT can't conjure one into
            // existence.
            logger.debug('jwt names unknown member', {
              member: claims.member,
              sub: claims.subject,
            });
            return c.json({ error: 'unknown member' }, 401);
          }
          c.set('member', member);
          c.set('sessionId', null);
          c.set('tokenId', null);
          await next();
          return;
        } catch (err) {
          // Decode (without verifying) to surface the actual claims
          // so log readers can compare against the configured
          // issuer/audience when a mismatch bites. The token already
          // failed verification by this point — we're only reading
          // bytes we already rejected.
          const actual = peekJwtClaims(raw);
          logger.debug('jwt verify failed', {
            error: err instanceof Error ? err.message : String(err),
            receivedIss: actual?.iss ?? null,
            receivedAud: actual?.aud ?? null,
            receivedMember: actual?.member ?? null,
          });
          return c.json({ error: 'invalid jwt' }, 401);
        }
      }

      // Opaque bearer path — multi-token store keyed on sha256(token).
      // Unknown / expired hashes both surface as `unknown token` to
      // avoid leaking which case applied. The token row binds to a
      // member name; the member must still exist in the loaded store
      // (the member could have been removed since this token was
      // issued — fail closed).
      const tokenRow = tokens.resolve(raw);
      if (!tokenRow) {
        return c.json({ error: 'unknown token' }, 401);
      }
      const member = members.findByName(tokenRow.memberName);
      if (!member) {
        logger.warn('token references unknown member', {
          tokenId: tokenRow.id,
          name: tokenRow.memberName,
        });
        // Auto-clean: a stale token whose member was deleted should
        // not silently keep authenticating until the next purge.
        tokens.revoke(tokenRow.id);
        return c.json({ error: 'token references unknown member' }, 401);
      }
      // Bump last_used_at (debounced internally — we don't write on
      // every request).
      tokens.touch(tokenRow.id);
      c.set('member', member);
      c.set('sessionId', null);
      c.set('tokenId', tokenRow.id);
      await next();
      return;
    }

    // Session cookie path — human web UI.
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        // Expired or revoked. Return a distinct error so the SPA knows
        // to drop its session signal and redirect to /login.
        return c.json({ error: 'session expired' }, 401);
      }
      const member = members.findByName(session.memberName);
      if (!member) {
        // Member was removed from config while a session was still live.
        // Nuke the session so subsequent requests don't keep hitting this.
        logger.warn('session references unknown member', {
          sessionId,
          name: session.memberName,
        });
        sessions.delete(sessionId);
        return c.json({ error: 'session member no longer exists' }, 401);
      }
      sessions.touch(sessionId);
      c.set('member', member);
      c.set('sessionId', sessionId);
      c.set('tokenId', null);
      await next();
      return;
    }

    return c.json({ error: 'missing credentials' }, 401);
  };
}

/**
 * Decode a JWT's payload *without* verifying the signature. Used only
 * to surface `iss` / `aud` / `member` values in the debug log when a
 * verify failure fires — the token has already been rejected by the
 * verifier, so we're never trusting these bytes. Returns null on any
 * structural issue so the caller just logs "unknown".
 */
function peekJwtClaims(token: string): {
  iss?: unknown;
  aud?: unknown;
  member?: unknown;
} | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
    const json = atob(padded);
    const payload = JSON.parse(json) as Record<string, unknown>;
    return {
      iss: payload.iss,
      aud: payload.aud,
      member: payload.member,
    };
  } catch {
    return null;
  }
}
