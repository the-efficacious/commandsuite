/**
 * Roster signal — full teammate list + runtime connection state.
 *
 * Refreshed on shell mount and every 10 seconds while the tab is
 * visible. Visibility-gating prevents background tabs from pounding
 * the server when nothing's happening on-screen.
 *
 * The 10s cadence is a compromise: shorter than the original 30s
 * because presence changes (test-agent-1 came online / went offline)
 * read as "buggy" at 30s latency, but not sub-second because real
 * live presence needs server-pushed events over SSE — this is a
 * polling fallback. Shell also refetches immediately whenever the
 * user's own SSE stream reconnects (e.g. after server restart or a
 * brief network drop), so the 10s ceiling only applies to "nobody
 * is disconnecting-then-reconnecting" situations.
 */

import { signal } from '@preact/signals';
import type { ActivityState, Presence, RosterResponse } from 'csuite-sdk/types';
import { getClient } from './client.js';

export const roster = signal<RosterResponse | null>(null);

/**
 * Normalize a member's live activity from a roster presence entry into
 * the 3-state model. The server-authoritative field is `activity`;
 * older servers (and members with no recent report) omit it, so we
 * fall back to the back-compat `busy` boolean (`busy === working`).
 * Absent/undefined presence — the member isn't in `connected` at all —
 * is treated as `idle`. This is the single place the web-shell decides
 * how to read activity so the roster surfaces (NavColumn DM rows,
 * TeamHome roster) stay in lockstep.
 *
 * Note: this is orthogonal to connection state (online/connecting/
 * offline), which callers derive from `Presence.connected` separately.
 * A `blocked` or `working` member is, by definition, online.
 */
export function presenceActivity(p: Presence | undefined): ActivityState {
  if (!p) return 'idle';
  if (p.activity) return p.activity;
  return p.busy === true ? 'working' : 'idle';
}

const REFRESH_MS = 10_000;

export async function loadRoster(): Promise<RosterResponse> {
  const resp = await getClient().roster();
  roster.value = resp;
  return resp;
}

/**
 * Start a periodic refresh. Returns a teardown function; callers
 * invoke it on unmount. Visibility-gated: when the tab is hidden we
 * stop polling and resume on the next `visibilitychange` event.
 */
export function startRosterPolling(): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (cancelled) return;
    if (typeof document !== 'undefined' && document.hidden) {
      // Skip this tick; the visibility listener will restart us.
      return;
    }
    try {
      await loadRoster();
    } catch {
      // Swallow — next tick retries. Network blips shouldn't spam
      // console.error on every poll.
    }
    if (cancelled) return;
    timer = setTimeout(tick, REFRESH_MS);
  };

  const onVisible = () => {
    if (cancelled) return;
    if (typeof document !== 'undefined' && !document.hidden) {
      if (timer !== null) clearTimeout(timer);
      void tick();
    }
  };

  // Kick off immediately so the UI has fresh data on mount, then loop.
  void tick();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisible);
  }

  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

export function __resetRosterForTests(): void {
  roster.value = null;
}
