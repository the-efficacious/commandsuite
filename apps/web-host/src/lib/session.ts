/**
 * Session signal — the SPA's single source of truth for "who am I."
 *
 * Three states:
 *   - `loading`                                 — initial mount, haven't asked the server yet
 *   - `anonymous`                               — confirmed no valid session; show login
 *   - `{member, role, permissions, …}`          — authenticated; show the shell
 *
 * Components read the signal via Preact's `.value`; writes always go
 * through `bootstrap`, `loginWithTotp`, or `logout` so the state
 * transitions stay auditable in one place.
 */

import { signal } from '@preact/signals';
import { ClientError } from 'csuite-sdk/client';
import type { Permission, Role, SessionResponse } from 'csuite-sdk/types';
import { getClient } from './client.js';

export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | {
      status: 'authenticated';
      member: string;
      role: Role;
      permissions: Permission[];
      expiresAt: number;
    };

export const session = signal<SessionState>({ status: 'loading' });

/**
 * Optional message surfaced on the Login screen — set by `logout()`
 * when the sign-out was triggered by an expired session, a 401 in a
 * background call, or any other involuntary flow so the user isn't
 * dumped back to Login with no explanation. Cleared on successful
 * login or on explicit dismiss.
 */
export const sessionNotice = signal<string | null>(null);

/**
 * Ask the server for the current session. Called once on SPA mount
 * to rehydrate. A 401 (session expired / never existed) resolves the
 * signal to `anonymous` — it's a first-class state, not an error.
 */
export async function bootstrap(): Promise<void> {
  try {
    const current = await getClient().currentSession();
    if (current === null) {
      session.value = { status: 'anonymous' };
      return;
    }
    session.value = authenticatedFrom(current);
  } catch {
    // Network error, server down, corrupted response — treat as
    // anonymous so the SPA shows the login screen and the user
    // can retry. Surfaces cleanly rather than stranding them on
    // a loading spinner.
    session.value = { status: 'anonymous' };
  }
}

/**
 * Submit a TOTP login. The SPA starts with the codeless flow; when the
 * server-wide codeless ceiling is reached, Login retries with the optional
 * member name so one caller's failures cannot lock the UI for everyone.
 * On success the server sets the session cookie and we update the signal
 * to authenticated. On failure we preserve the broker's machine-readable
 * code so the Login component can expose that fallback.
 */
export async function loginWithTotp(code: string, member?: string): Promise<void> {
  try {
    const result = await getClient().loginWithTotp({ code, ...(member ? { member } : {}) });
    session.value = authenticatedFrom(result);
    sessionNotice.value = null;
  } catch (err) {
    if (err instanceof ClientError) {
      let detail: { error?: unknown; code?: unknown } = {};
      try {
        detail = JSON.parse(err.body) as { error?: unknown; code?: unknown };
      } catch {
        // A non-JSON error still carries the HTTP status below.
      }
      const message = typeof detail.error === 'string' ? detail.error : err.message;
      const errorCode = typeof detail.code === 'string' ? detail.code : null;
      throw new LoginError(message, errorCode);
    }
    throw new LoginError(err instanceof Error && err.message ? err.message : 'login failed', null);
  }
}

/**
 * Drop the server-side session and clear local state. Always resets
 * the signal to `anonymous` — even if the server call fails, the
 * user's intent was "sign out" and leaving them in an authenticated
 * state would be confusing. An optional `notice` is surfaced on the
 * Login screen so involuntary sign-outs (session expiry, 401 on a
 * background call) explain themselves instead of dumping the user at
 * a blank login.
 */
export async function logout(notice?: string): Promise<void> {
  try {
    await getClient().logout();
  } catch {
    // Best-effort; the cookie will be cleared on the next cookie-auth
    // request (server returns 401) even if this POST didn't reach it.
  }
  sessionNotice.value = notice ?? null;
  session.value = { status: 'anonymous' };
}

export class LoginError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.name = 'LoginError';
    this.code = code;
  }
}

function authenticatedFrom(resp: SessionResponse): SessionState {
  return {
    status: 'authenticated',
    member: resp.member,
    role: resp.role,
    permissions: resp.permissions,
    expiresAt: resp.expiresAt,
  };
}
