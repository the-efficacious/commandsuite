/**
 * ToastContainer — fixed-position stack of in-app toasts.
 *
 * Reads from the `toasts` signal in `lib/toast.ts`. One instance
 * should be rendered near the root of the app (TeamShell already
 * mounts one). Each toast auto-dismisses after its `duration`; the
 * timer is cancelled if the user closes it manually, hovers (pause),
 * or if a tagged replacement pushes it out of the queue.
 *
 * Positioning: bottom-right on desktop, bottom-center on mobile —
 * controlled from `theme.css` via `.toast-stack`. The container uses
 * `pointer-events:none` so the stack doesn't block clicks over empty
 * regions of the viewport; individual toasts re-enable pointer events
 * on themselves.
 *
 * Hover-to-pause: when the cursor is over a toast, both the visual
 * progress bar AND the JS dismiss timer pause, so the viewer can
 * finish reading without racing the timeout.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { dismissToast, type Toast, type ToastKind, toasts } from '../../lib/toast.js';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from '../icons/index.js';

export function ToastContainer() {
  const queue = toasts.value;
  if (queue.length === 0) return null;
  return (
    <section class="toast-stack" aria-label="Notifications">
      {queue.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </section>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  // Hover state pauses both the JS dismiss timer and the CSS progress
  // animation. Pure visual pause was already free via :hover; this hook
  // ensures the underlying timeout doesn't fire mid-pause.
  const [paused, setPaused] = useState(false);
  // Track time remaining when paused so a 5s toast doesn't reset to a
  // fresh 5s every time the user enters/leaves.
  const remainingRef = useRef<number>(toast.duration ?? 0);
  const startedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    if (toast.duration === null) return;
    if (paused) {
      // Capture how much time was left when the pause started.
      const elapsed = Date.now() - startedAtRef.current;
      remainingRef.current = Math.max(0, remainingRef.current - elapsed);
      return;
    }
    // Resuming (or first run) — schedule for whatever's left.
    startedAtRef.current = Date.now();
    const timer = window.setTimeout(() => dismissToast(toast.id), remainingRef.current);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.duration, paused]);

  const role = toast.kind === 'warn' || toast.kind === 'error' ? 'alert' : 'status';
  const variantClass = variantClassFor(toast.kind);
  // Surface the duration to CSS so the progress bar's keyframe runs
  // for the same period as the dismiss timer.
  const styleVar = toast.duration === null ? '' : `--toast-duration:${toast.duration}ms`;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: role is set dynamically based on toast.kind (alert / status); the linter can't see through the variable
    <div
      class={`toast ${variantClass}`}
      role={role}
      aria-live="polite"
      style={styleVar}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span class="icon" aria-hidden="true">
        <KindIcon kind={toast.kind} />
      </span>
      <div class="body">
        {toast.title !== undefined && <div class="title">{toast.title}</div>}
        <div class="msg">{toast.body}</div>
        {toast.action !== undefined && (
          <button
            type="button"
            class="action"
            onClick={() => {
              toast.action?.onClick();
              dismissToast(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button type="button" class="x" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
        <X size={14} aria-hidden="true" />
      </button>
      {toast.duration !== null && <div class="progress" aria-hidden="true" />}
    </div>
  );
}

function variantClassFor(kind: ToastKind): string {
  switch (kind) {
    case 'success':
      return 'success';
    case 'warn':
      return 'warn';
    case 'error':
      return 'err';
    default:
      return '';
  }
}

function KindIcon({ kind }: { kind: ToastKind }) {
  switch (kind) {
    case 'success':
      return <CheckCircle2 size={16} />;
    case 'warn':
      return <AlertTriangle size={16} />;
    case 'error':
      return <AlertCircle size={16} />;
    default:
      return <Info size={16} />;
  }
}
