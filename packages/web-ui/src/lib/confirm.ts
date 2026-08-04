/**
 * Confirm signal — promise-backed replacement for `window.confirm()`.
 *
 * The bench dialog doctrine: "the only modal on the ship is the one
 * that stops the fleet." Destructive actions raise ONE question at a
 * time through this signal; `<ConfirmDialog/>` (mounted once by
 * TeamShell) renders it as the alarm-edged dialog, and the caller
 * awaits the answer exactly like the native API:
 *
 *   if (!(await confirmDialog({ title: 'Archive #general?', verb: 'Archive' }))) return;
 *
 * Reversible work should get an undo flow instead — reach for this
 * only when the action genuinely cannot be walked back.
 */

import { signal } from '@preact/signals';

export interface ConfirmRequest {
  /** Display-font question, e.g. "Delete engineer-2?" */
  title: string;
  /** Consequence prose — what happens if you proceed. */
  body?: string;
  /** The destructive verb on the commit button, e.g. "Delete". */
  verb: string;
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

export const pendingConfirm = signal<PendingConfirm | null>(null);

/** Raise the question. Resolves true on the verb, false on belay/Esc. */
export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    // One question at a time — a second request belays the first.
    pendingConfirm.value?.resolve(false);
    pendingConfirm.value = { ...req, resolve };
  });
}

/** Answer the open question. No-op when none is open. */
export function resolveConfirm(ok: boolean): void {
  const p = pendingConfirm.value;
  pendingConfirm.value = null;
  p?.resolve(ok);
}

/** Test-only: belay anything open and clear the signal. */
export function __resetConfirmForTests(): void {
  resolveConfirm(false);
}
