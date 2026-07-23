/**
 * Team — derived identity + scoping helpers.
 *
 * Today the app is single-team: the server returns one team via
 * /briefing and that's what `currentTeam` tracks. The signal is
 * shaped to accommodate multi-team without a data-model change:
 * when a host needs to expose N teams per user, the session payload
 * grows a `teams: Team[]` field and `activeTeamId` becomes a signal
 * of its own. Consumers of `currentTeam` don't need to change.
 */

import { computed } from '@preact/signals';
import { briefing } from './briefing.js';

export interface TeamIdentity {
  /** Stable slug derived from the team name. Used for URL prefixes. */
  slug: string;
  /** Display name. */
  name: string;
  /** Team-level standing context every member inherits. */
  context: string;
}

export const currentTeam = computed<TeamIdentity | null>(() => {
  const b = briefing.value;
  if (!b) return null;
  return {
    slug: slugify(b.team.name),
    name: b.team.name,
    context: b.team.context,
  };
});

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
