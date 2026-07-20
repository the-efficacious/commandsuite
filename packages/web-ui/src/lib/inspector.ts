/**
 * Inspector open/closed signal.
 *
 * At wide widths (≥1100px) the activity inspector is a fixed-width
 * member of the layout row — always visible. Below 1100 it becomes
 * a right-side overlay that opens on demand: the user toggles it from
 * a button in the thread head, the panel slides in from the right, a
 * shared backdrop covers the main content. This signal is the source
 * of truth for that overlay state.
 *
 * The signal stays meaningful at wide widths too — opening the
 * inspector at ≥1100 is a no-op visually (it's already visible), and
 * the value just persists. So toggle/open/close calls don't need
 * to know the breakpoint.
 *
 * The inspector also auto-closes on view changes that take you off a
 * thread (e.g. clicking into the channels-browse page) — handled by
 * a route effect in `view.ts` rather than here, so this module stays
 * a pure signal store.
 */

import { signal } from '@preact/signals';

export const isInspectorOpen = signal(false);

export function openInspector(): void {
  isInspectorOpen.value = true;
}

export function closeInspector(): void {
  isInspectorOpen.value = false;
}

export function toggleInspector(): void {
  isInspectorOpen.value = !isInspectorOpen.value;
}

/** Test-only reset. */
export function __resetInspectorForTests(): void {
  isInspectorOpen.value = false;
}
