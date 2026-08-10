/**
 * The human seat's state — the Queue, the Board, and the interrupt
 * whitelist — as signals over the spine SDK client. §9.
 *
 * Signals as the single source of truth, thin fetch wrappers that
 * refresh them, synchronous selectors components read. The live stream (`live.ts`) triggers a reload whenever a spine
 * event crosses the wire.
 *
 * TWO PROPERTIES THIS MODULE EXISTS TO HONOUR, both from §9:
 *
 *   VISITING IS NOT HANDLING. Loading the queue calls `spineQueue`, the
 *   receipt-neutral read — never `orient`, which would advance a
 *   receipt. Opening an item changes nothing on the server; only the
 *   four acts do.
 *
 *   THE ANNEX IS THE TRUTH. An item leaves the queue when its resolving
 *   event lands, not when the human dismisses it. There is no local
 *   dismissed-set: every act reloads the queue from the server, so what
 *   the human sees is what the annex holds.
 */

import { signal } from '@preact/signals';
import type {
  DeclineAskRequest,
  DeferAskRequest,
  DictateRulingRequest,
  RedirectAskRequest,
  SpineContract,
  SpineCuratorConfigResponse,
  SpineEventKind,
  SpineQueue,
} from 'csuite-sdk/types';
import { getClient } from './client.js';

/** The caller's queue. `null` until first load. */
export const spineQueue = signal<SpineQueue | null>(null);
export const spineQueueLoaded = signal(false);

/** The caller's contracts, for the Board. */
export const spineBoard = signal<SpineContract[]>([]);
export const spineBoardLoaded = signal(false);

/**
 * The team's focus set — every lit contract, across the whole team, not
 * only the caller's own bindings. The allocator's whole-plate view (#155
 * finding 8), loaded only for members who hold `spine.focus`. Reading it
 * is a baseline annex read; only lighting is permissioned.
 */
export const spineFocusSet = signal<SpineContract[]>([]);
export const spineFocusSetLoaded = signal(false);

/** The caller's curator config, which carries the interrupt whitelist. */
export const spineCurator = signal<SpineCuratorConfigResponse | null>(null);
export const spineCuratorLoaded = signal(false);

/**
 * Load the caller's queue through the RECEIPT-NEUTRAL read. Never
 * `orient`: the queue is a look, and a look must not advance a receipt.
 */
export async function loadSpineQueue(): Promise<void> {
  spineQueue.value = await getClient().spineQueue();
  spineQueueLoaded.value = true;
}

/** Load the caller's contracts for the Board (assignee, verifier, or authority). */
export async function loadSpineBoard(viewer: string): Promise<void> {
  spineBoard.value = await getClient().spineContracts({ member: viewer });
  spineBoardLoaded.value = true;
}

/**
 * Load the team's focus set — the whole lit plate. For `spine.focus`
 * holders; the caller gates the call on the leaf, and the read itself is
 * open (a member without the leaf can see it too, they just cannot
 * change it).
 */
export async function loadSpineFocusSet(): Promise<void> {
  spineFocusSet.value = await getClient().spineContracts({ focus: true });
  spineFocusSetLoaded.value = true;
}

/** Load the caller's curator config, for the interrupt-whitelist control. */
export async function loadSpineCurator(): Promise<void> {
  spineCurator.value = await getClient().spineCuratorConfig();
  spineCuratorLoaded.value = true;
}

// ─── The four acts ───────────────────────────────────────────────────
//
// Each is one append, and each reloads the queue from the server after —
// the item leaves (or, for a redirect, moves) because its resolving
// event landed in the annex, not because we hid it locally.

export async function dictateRuling(req: DictateRulingRequest): Promise<void> {
  await getClient().spineDictateRuling(req);
  await loadSpineQueue();
}

export async function deferAsk(req: DeferAskRequest): Promise<void> {
  await getClient().spineDefer(req);
  await loadSpineQueue();
}

export async function declineAsk(req: DeclineAskRequest): Promise<void> {
  await getClient().spineDecline(req);
  await loadSpineQueue();
}

export async function redirectAsk(req: RedirectAskRequest): Promise<void> {
  await getClient().spineRedirect(req);
  await loadSpineQueue();
}

/**
 * Replace the interrupt whitelist wholesale — the class-1 kinds that may
 * buzz a phone. The empty set ("never buzz me") is a real choice, so
 * this is a set and not a patch.
 */
export async function setInterruptWhitelist(kinds: SpineEventKind[]): Promise<void> {
  spineCurator.value = await getClient().setSpineCuratorConfig({
    policy: { interruptWhitelist: kinds },
  });
  spineCuratorLoaded.value = true;
}

export function __resetSpineForTests(): void {
  spineQueue.value = null;
  spineQueueLoaded.value = false;
  spineBoard.value = [];
  spineBoardLoaded.value = false;
  spineFocusSet.value = [];
  spineFocusSetLoaded.value = false;
  spineCurator.value = null;
  spineCuratorLoaded.value = false;
}
