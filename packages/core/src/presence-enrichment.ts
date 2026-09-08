/**
 * The one broker-side definition of the enriched `Presence` shape.
 *
 * `Presence` is one wire type, so it owes one population. Before this
 * function existed the enrichment lived inline in the `GET /roster`
 * handler and `composeTeamStatus` forwarded the registry record
 * untouched, so `GET /team/status` carried a `Presence` with five axes
 * missing on every member, always — and two of those five have an
 * absence rule that makes the omission a false statement rather than a
 * gap. `captureHealth` absent means "this broker has no opinion", not
 * "healthy"; `diagnosticsUnresolved` absent means "this broker retains
 * no diagnostics", not "this member is clean". A broker computing both
 * for the same member on the same tick was saying neither on one of its
 * two projections of the same type.
 *
 * So the enrichment is a function, and both routes call it. The registry
 * supplies the connection axes (`packages/core/src/registry.ts`); this
 * adds the four the broker composes per request:
 *
 *   - live state — `workState` (and, for one release, its previous mirror
 *     `activity`) / `busy`, derived over the work-state
 *     tracker and proven action, omitted when idle
 *   - capture health — `captureHealth`, omitted only when unwired
 *   - completeness diagnostics — `diagnosticsUnresolved` /
 *     `diagnosticsRetention`, omitted only when unwired
 *   - team role — re-read from the member store, because the registry's
 *     copy is first-register-wins and goes stale on a role edit
 *
 * Runtime-neutral: no IO of its own, and the clock arrives as an
 * instant rather than a function so both routes evaluate one tick.
 */

import type { Presence, Role } from 'csuite-sdk/types';
import type { CaptureHealthStore } from './capture-health.js';
import type { DiagnosticStore } from './diagnostics.js';
import type { MemberStore } from './members-domain.js';
import { WORK_STATE_TTL_MS, type WorkStateTracker } from './work-state.js';

/**
 * Everything the enrichment reads. `captureHealth` and `diagnostics`
 * are optional because a broker may not have them wired at all — which
 * is the only case in which their fields are legitimately absent.
 */
export interface PresenceEnrichmentOptions {
  /** Per-member work-state reports; only `getWorkState` is read. */
  workState: Pick<WorkStateTracker, 'getWorkState'>;
  /** Authoritative role source. The registry's copy is stale after an edit. */
  members: MemberStore;
  /** Omit and no member carries `captureHealth` — "no opinion", not "healthy". */
  captureHealth?: CaptureHealthStore;
  /** Omit and no member carries the diagnostics fields — same absence rule. */
  diagnostics?: DiagnosticStore;
  /** The instant the response is composed at. */
  now: number;
}

/**
 * Enrich one registry `Presence` into the shape every route publishes.
 *
 * Pure over its inputs: call it once per presence per response and the
 * two routes agree field for field.
 */
export function enrichPresence(presence: Presence, options: PresenceEnrichmentOptions): Presence {
  // Compatibility activity projection. `working` is derived ONLY from
  // recent broker-recorded tool/outbound evidence. Turn lifecycle and
  // message consumption remain scheduling telemetry and can never make
  // a member look capable. `blocked` stays runner telemetry.
  const schedulingState = options.workState.getWorkState(presence.name);
  const actedRecently =
    presence.executor?.lastActedAt !== null &&
    presence.executor?.lastActedAt !== undefined &&
    options.now - presence.executor.lastActedAt <= WORK_STATE_TTL_MS;
  const activity =
    schedulingState === 'blocked'
      ? ('blocked' as const)
      : actedRecently
        ? ('working' as const)
        : ('idle' as const);

  // `captureHealth` follows a DIFFERENT absence rule from `activity`,
  // deliberately. `activity` omits the field for idle members and a
  // reader treats absence as idle — safe, because idle is the benign
  // default. Capture health has no benign default: absence has to mean
  // "this broker has no opinion," so a broker that CAN evaluate it
  // emits `ok` explicitly rather than omitting. Reading an absent field
  // as healthy is exactly the conflation this exists to remove, and it
  // is only absent when the store isn't wired at all.
  //
  // `pending` is internal — an aged-out marker hasn't earned a claim
  // yet, and healthy lag means every turn is briefly unsatisfied.
  // Surfacing it would flicker on healthy traffic, so it maps to `ok`:
  // no gap has been established.
  //
  // `unevaluated` is NOT collapsed into `ok`. A Codex member is not
  // assessed by the exact-match join at all, and reporting them healthy
  // would be this broker claiming a property it never evaluated — the
  // same conflation the whole signal exists to remove. It stays
  // distinct from an absent field, which means a broker too old to have
  // an opinion at all.
  const health = options.captureHealth?.forMember(presence.name);
  const captureField =
    health === undefined
      ? {}
      : {
          captureHealth:
            health.state === 'gap'
              ? ('gap' as const)
              : health.state === 'unevaluated'
                ? ('unevaluated' as const)
                : ('ok' as const),
        };

  // Retained completeness failures for this member that have not been
  // observed to recover. Same absence rule as `captureHealth` and NOT
  // `activity`'s: absent means this broker retains no diagnostics and
  // has no opinion — never "this member is clean". `0` is the positive
  // statement that it looked and found none.
  //
  // This is the field an agent reads about ITSELF. Every failure it
  // counts is one the product already detected and, until now, wrote to
  // a terminal nobody kept — so the agent could not find out that its
  // own capture had failed.
  const diagField =
    options.diagnostics === undefined
      ? {}
      : {
          diagnosticsUnresolved: options.diagnostics.unresolved(presence.name).length,
          diagnosticsRetention: options.diagnostics.health(),
        };

  // The registry's role is first-register-wins, so it is stale the
  // moment a role is edited under a live connection. The member store
  // is authoritative; re-read it here rather than let one response
  // carry two answers (`teammates[].role` and this one).
  const role: Role | null = options.members.findByName(presence.name)?.role ?? presence.role;

  if (activity === 'idle') return { ...presence, role, ...captureField, ...diagField };
  // The work-state compat window: `workState` is canonical and
  // `activity` is the previous spelling, emitted with the SAME value for
  // one release so a client written against either keeps reading the
  // same member. `busy` is the older, lossy boolean mirror and outlives
  // both. The two deprecated fields are removed in the next minor.
  return {
    ...presence,
    role,
    workState: activity,
    activity,
    busy: activity === 'working',
    ...captureField,
    ...diagField,
  };
}
