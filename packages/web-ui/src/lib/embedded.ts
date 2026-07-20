/**
 * Embedded-shell signals.
 *
 * When the host (e.g. the multi-team platform) provides outer chrome
 * around `<TeamShell>` — its own top-level rail and account anchor —
 * the shell flips into "embedded" mode and drops the chrome it would
 * otherwise own (Header's profile button, NavColumn's user chip), so
 * the viewer sees one identity affordance instead of three.
 *
 * In OSS (single-team, no outer rail) the shell stays standalone:
 * Header carries the profile button and NavColumn footer carries the
 * user chip, because there's nowhere else for either to live.
 */

import { signal } from '@preact/signals';

/**
 * True when the host provides outer chrome (rail + identity anchor).
 * Set by `<TeamShell>` from prop presence.
 */
export const embeddedShell = signal(false);

/**
 * Handler invoked when the viewer clicks "Team settings" in the
 * NavColumn footer (only rendered in embedded mode). The host owns
 * the destination — typically the team's billing/settings page — so
 * this is wired through as a callback rather than a route literal.
 */
export const teamSettingsHandler = signal<(() => void) | null>(null);

export function setEmbeddedShell(embedded: boolean): void {
  if (embeddedShell.peek() !== embedded) embeddedShell.value = embedded;
}

export function setTeamSettingsHandler(handler: (() => void) | null): void {
  if (teamSettingsHandler.peek() !== handler) teamSettingsHandler.value = handler;
}
