/**
 * Shell-internal SDK client handle.
 *
 * `csuite-web-ui` doesn't know how the host has authenticated —
 * the typical paths are session cookies (single-team web UI) or a
 * bearer token (federated / multi-team hosts). The host constructs
 * its own csuite-sdk Client, passes it as the `client` prop to
 * <TeamShell>, and the shell wires it into this module-level signal
 * so every internal call to `getClient()` from panels, lib modules,
 * and hooks reaches the same instance.
 *
 * Reading `getClient()` outside a mounted shell is a programming
 * error — we throw rather than silently swallow so misuse surfaces
 * loudly in dev.
 */

import { signal } from '@preact/signals';
import type { Client } from 'csuite-sdk/client';

const clientRef = signal<Client | null>(null);

export function setClient(c: Client): void {
  clientRef.value = c;
}

export function getClient(): Client {
  const c = clientRef.value;
  if (c === null) {
    throw new Error(
      'csuite-web-ui: getClient() called before <TeamShell> mounted. ' +
        'Shell internals must not be invoked outside the mounted shell tree.',
    );
  }
  return c;
}

/**
 * Test helper — clears the stored client so a unit test can build a
 * fresh one against a stubbed fetch. Mirrors the `__resetForTests`
 * convention used across the shell's signal modules.
 */
export function __resetClientForTests(): void {
  clientRef.value = null;
}
