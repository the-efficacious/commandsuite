/**
 * Toast queue — the canonical in-app transient notification primitive.
 *
 * Hosts render `<ToastContainer/>` once near the root of the tree —
 * single-team SPA hosts typically place it alongside `<TeamShell>`,
 * embedding hosts mount it inside their own dashboard chrome — and
 * emit messages via the `toast` helper from anywhere in the app:
 *
 *   toast.success({ title: 'Copied', body: 'Invite link on clipboard' });
 *   toast.error({ title: 'Send failed', body: 'Try again?',
 *                 action: { label: 'Retry', onClick: retry } });
 *
 * Queue semantics:
 *   - Signal-backed, so Preact re-renders the container on every change.
 *   - Bounded to MAX_TOASTS; oldest drops when full so a misbehaving
 *     producer can't flood the viewport.
 *   - `tag` dedupes: a new toast with the same tag replaces any
 *     pending one (useful for stream-status style repeating signals).
 *   - `duration === null` means sticky — the user must close it or
 *     the producer must call `dismissToast(id)`.
 *
 * Intentionally tiny. If we need richer states (progress, inline
 * input, grouped diagnostics) the toasts API stays the low-level
 * primitive and higher-level helpers wrap it.
 */

import { signal } from '@preact/signals';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  /** Optional bold prefix shown above the body. */
  title?: string;
  /** Main message. Plain text — keep it short. */
  body: string;
  /** Auto-dismiss after N ms. `null` = sticky. Default 5000 (info/success) / 7000 (warn/error). */
  duration: number | null;
  /** Inline button; fires and dismisses. */
  action?: ToastAction;
  /**
   * Dedupe key. A new toast whose `tag` matches an existing one
   * replaces the existing entry (instead of stacking a duplicate).
   */
  tag?: string;
  /** Optional callback fired when the toast leaves the queue (any reason). */
  onDismiss?: () => void;
}

export interface ToastOptions {
  title?: string;
  body: string;
  duration?: number | null;
  action?: ToastAction;
  tag?: string;
  onDismiss?: () => void;
}

const MAX_TOASTS = 5;

export const toasts = signal<readonly Toast[]>([]);

let counter = 0;
function nextId(): string {
  counter += 1;
  return `t${counter}-${Date.now().toString(36)}`;
}

function defaultDuration(kind: ToastKind): number {
  return kind === 'warn' || kind === 'error' ? 7000 : 5000;
}

function enqueue(kind: ToastKind, opts: ToastOptions): string {
  const id = nextId();
  const entry: Toast = {
    id,
    kind,
    body: opts.body,
    duration: opts.duration === undefined ? defaultDuration(kind) : opts.duration,
  };
  if (opts.title !== undefined) entry.title = opts.title;
  if (opts.action !== undefined) entry.action = opts.action;
  if (opts.tag !== undefined) entry.tag = opts.tag;
  if (opts.onDismiss !== undefined) entry.onDismiss = opts.onDismiss;
  const current = toasts.value;
  // Dedupe by tag: if one with the same tag is already queued, replace it.
  const withoutTag =
    opts.tag === undefined
      ? current
      : current.filter((t) => {
          if (t.tag !== opts.tag) return true;
          t.onDismiss?.();
          return false;
        });
  // Bound the queue — drop oldest when full.
  const trimmed =
    withoutTag.length >= MAX_TOASTS
      ? withoutTag.slice(withoutTag.length - MAX_TOASTS + 1)
      : withoutTag;
  toasts.value = [...trimmed, entry];
  return id;
}

/**
 * Remove a toast by id. Fires its `onDismiss` callback if present.
 * No-op if the id is unknown — safe to call from timers that race
 * with a manual close.
 */
export function dismissToast(id: string): void {
  const current = toasts.value;
  const next = current.filter((t) => t.id !== id);
  if (next.length === current.length) return;
  toasts.value = next;
  const removed = current.find((t) => t.id === id);
  removed?.onDismiss?.();
}

/**
 * Remove every toast carrying `tag`. Used by signal→toast bridges
 * (e.g. the stream-status bridge clears its sticky "Disconnected"
 * toast when the stream comes back). No-op if no toast matches.
 */
export function dismissToastsByTag(tag: string): void {
  const current = toasts.value;
  const removed = current.filter((t) => t.tag === tag);
  if (removed.length === 0) return;
  toasts.value = current.filter((t) => t.tag !== tag);
  for (const t of removed) t.onDismiss?.();
}

/** Flush the queue. Used in tests and on shell teardown. */
export function clearAllToasts(): void {
  const current = toasts.value;
  toasts.value = [];
  for (const t of current) t.onDismiss?.();
}

export const toast = {
  /** Neutral/informational toast (role=status, 5s default). */
  info: (opts: ToastOptions) => enqueue('info', opts),
  /** Success confirmation (role=status, 5s default). */
  success: (opts: ToastOptions) => enqueue('success', opts),
  /** Soft warning (role=alert, 7s default). */
  warn: (opts: ToastOptions) => enqueue('warn', opts),
  /** Hard error (role=alert, 7s default). */
  error: (opts: ToastOptions) => enqueue('error', opts),
};

/** Test-only reset. */
export function __resetToastsForTests(): void {
  toasts.value = [];
  counter = 0;
}
