/**
 * ConfirmDialog — the bench `.dialog`: alarm-edged panel, chamfered
 * top-left, one destructive verb and a belay. Mounted once by
 * TeamShell; driven by the `pendingConfirm` signal (see lib/confirm).
 *
 * Focus lands on Belay — the safe answer is the resting one. Esc
 * belays. The verb button is the only destructive control.
 */

import { useEffect, useRef } from 'preact/hooks';
import { pendingConfirm, resolveConfirm } from '../../lib/confirm.js';

export function ConfirmDialog() {
  const req = pendingConfirm.value;
  const belayRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!req) return;
    belayRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolveConfirm(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req]);

  if (!req) return null;

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center"
      style="background:var(--ef-shade);padding:24px"
    >
      <div class="dialog" role="alertdialog" aria-modal="true" aria-label={req.title}>
        <div class="dialog-title">{req.title}</div>
        {req.body && <div class="dialog-body">{req.body}</div>}
        <div class="flex justify-end" style="gap:8px">
          <button
            ref={belayRef}
            type="button"
            class="btn btn-ghost"
            onClick={() => resolveConfirm(false)}
          >
            Belay
          </button>
          <button type="button" class="btn btn-destructive" onClick={() => resolveConfirm(true)}>
            {req.verb}
          </button>
        </div>
      </div>
    </div>
  );
}
