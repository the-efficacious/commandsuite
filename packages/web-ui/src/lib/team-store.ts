/**
 * Team-scoped store — structural extension point for multi-team hosts.
 *
 * Today the app uses module-level singletons (`briefing`, `roster`,
 * `messagesByThread`, `objectives`, `lastReadByThread`) because each
 * shell instance serves one team. That works fine for N=1 but leaks
 * state if a host ever mounts two teams in the same tab.
 *
 * The intended swap when a host wants N teams per user is:
 *
 *   const store = useTeamStore(activeTeamId);
 *   const b = store.briefing.value;
 *
 * Each `createTeamStore(teamId)` returns a fresh bundle of signals
 * and a dispose() that tears down subscriptions / clears caches. A
 * host can keep an LRU of recent stores so switching back to a team
 * doesn't refetch from scratch.
 *
 * This file is intentionally a contract, not an implementation. The
 * singletons are the live store; wiring a factory is a separate
 * migration that lands alongside server-side team scoping.
 *
 * When you touch this file: update `lib/briefing.ts`, `lib/roster.ts`,
 * `lib/messages.ts`, `lib/objectives.ts`, and `lib/unread.ts` to
 * accept a teamId and return scoped instances. The live stream URL
 * also gains a team segment so reconnects don't cross-subscribe.
 */

export interface TeamStore {
  /** The team this store is scoped to. */
  readonly teamId: string;
  /** Tear down subscriptions and clear caches. */
  dispose(): void;
}

/**
 * Placeholder factory. Calling it today throws — the module graph
 * hasn't been split yet. Left as an exported symbol so downstream
 * code can reference the shape in TypeScript without importing it
 * at runtime.
 */
export function createTeamStore(_teamId: string): TeamStore {
  throw new Error(
    'createTeamStore is a placeholder. Multi-team store scoping is unimplemented — see lib/team-store.ts for the migration notes.',
  );
}
