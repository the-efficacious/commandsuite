// The signability predicate for scripts/release-prepare.mjs, isolated
// so the rule is unit-testable without a full gate run (obj-mtg8urof-p
// review round two: --allow-dirty must be non-signable on its own, not
// only when another flag happens to make the render incomplete).
//
// `incomplete` — facts are missing: a diagnostic flag suppressed
// collection, a gate could not run here, or collection itself failed.
// `signable` — everything ran, everything passed, nothing is held,
// and no diagnostic note applies. Only a signable render carries the
// signature block.

/**
 * @param {{ gateMode: string, skipBuild: boolean, skipImage: boolean,
 *           allowDirty: boolean, gateSkips: number, gateFails: number,
 *           problems: number, holds: number, notes: number }} state
 * @returns {{ incomplete: boolean, signable: boolean }}
 */
export function signability(state) {
  const incomplete =
    state.gateMode === 'none' ||
    state.skipBuild ||
    state.skipImage ||
    state.allowDirty ||
    state.gateSkips > 0 ||
    state.problems > 0;
  const signable = !incomplete && state.gateFails === 0 && state.holds === 0 && state.notes === 0;
  return { incomplete, signable };
}
