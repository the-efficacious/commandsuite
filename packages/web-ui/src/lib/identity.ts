/**
 * Identity signal — who the viewer is inside this team, as the host
 * has already resolved it. Set by <TeamShell identity={…}> on mount.
 *
 * Unlike the previous OSS `session` module (which owned a 3-state
 * ADT driving login/loading/authenticated routing), this signal is
 * a simple nullable record: shell components treat `null` as "not
 * yet mounted," which the outer TeamShell guard makes unreachable
 * in practice. Auth state transitions (login, logout, expiry) are
 * the HOST's responsibility — the shell only reads the resolved
 * identity for the current, authenticated team view.
 */

import { signal } from '@preact/signals';
import type { Permission, Role } from 'csuite-sdk/types';

export interface Identity {
  member: string;
  role: Role;
  permissions: Permission[];
  /**
   * When the current authentication expires, as unix ms. Optional —
   * federated tokens may be transparently rotated by the host before
   * expiry, in which case this field is not meaningful. Cookie-based
   * sessions set it from the server's `SessionResponse`.
   */
  expiresAt?: number;
}

export const identity = signal<Identity | null>(null);

export function setIdentity(i: Identity | null): void {
  identity.value = i;
}

/** Test helper — clears the identity signal between test cases. */
export function __resetIdentityForTests(): void {
  identity.value = null;
}
