/**
 * Server-side member ACTIVITY tracker — the broker's hold of each
 * member's live 3-state activity (idle / working / blocked). This is
 * orthogonal to CONNECTION presence (online/connecting/offline), which
 * the broker's SSE registry owns; here we only track "what is the agent
 * doing right now on that link".
 *
 * The runner POSTs `{state}` to `POST /presence/activity` on each
 * activity transition (idle ↔ working ↔ blocked), plus a heartbeat
 * while still working/blocked. We hold the latest non-idle report per
 * member with an absolute expiry timestamp; `getActivity(name)` past
 * the expiry resolves to `idle` even if the runner never told us to
 * flip — the safety net for a runner that crashes mid-turn (so a
 * member never stays stuck "working"/"blocked" forever).
 *
 * `idle` is represented by the ABSENCE of an entry, so a member the
 * tracker has never heard from (or whose report has lapsed) reads
 * `idle` for free. Only `working`/`blocked` occupy the map.
 *
 * In-memory only. Multi-process deployments aren't supported (the
 * broker is single-process today), and persisting activity across
 * restarts has no value: a non-idle member that survives a restart is
 * almost certainly stale.
 *
 * The clock is injectable so tests can advance time without sleeping.
 */

import type { ActivityState } from 'csuite-sdk/types';

/** How long a non-idle report stays "valid" without a refresh. */
export const ACTIVITY_TTL_MS = 30_000;

interface ActivityEntry {
  /** Last reported non-idle state (`working` | `blocked`). */
  state: Exclude<ActivityState, 'idle'>;
  /** Wall-clock at which this report was filed. */
  reportedAt: number;
  /** Wall-clock past which a non-idle report auto-expires to `idle`. */
  expiresAt: number;
}

export interface ActivityTracker {
  /**
   * Record a runner's report. A non-idle state (`working`/`blocked`)
   * extends the expiry window; `idle` clears the entry immediately.
   */
  report(name: string, state: ActivityState): void;
  /**
   * Resolve the current activity for a member. Returns `idle` for
   * unknown members and for stale non-idle entries past their TTL.
   */
  getActivity(name: string): ActivityState;
  /**
   * Back-compat convenience: `true` iff the member's activity is
   * `working`. `blocked` is NOT busy — it means an operator should look.
   */
  isBusy(name: string): boolean;
  /**
   * Forget any state for `name`. Called when a member is deleted so a
   * stale entry can't surface a deleted name on the roster.
   */
  forget(name: string): void;
  /** Drop every entry whose TTL has lapsed. Idempotent. */
  purgeStale(): void;
}

export function createActivityTracker(now: () => number = Date.now): ActivityTracker {
  const reports = new Map<string, ActivityEntry>();

  // Resolve-with-eviction: a lapsed entry is deleted on read so the
  // map self-cleans even without an explicit purge pass.
  const resolve = (name: string): ActivityState => {
    const entry = reports.get(name);
    if (!entry) return 'idle';
    if (entry.expiresAt <= now()) {
      reports.delete(name);
      return 'idle';
    }
    return entry.state;
  };

  return {
    report(name, state) {
      if (state === 'idle') {
        reports.delete(name);
        return;
      }
      const ts = now();
      reports.set(name, {
        state,
        reportedAt: ts,
        expiresAt: ts + ACTIVITY_TTL_MS,
      });
    },
    getActivity: resolve,
    isBusy(name) {
      return resolve(name) === 'working';
    },
    forget(name) {
      reports.delete(name);
    },
    purgeStale() {
      const ts = now();
      for (const [name, entry] of reports) {
        if (entry.expiresAt <= ts) reports.delete(name);
      }
    },
  };
}
