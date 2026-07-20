/**
 * Boot screen — rendered while the session signal is in `loading`
 * state on initial mount. Deliberately tiny; no spinner animation
 * dependency, no layout shift when it disappears.
 *
 * Failsafe: if `bootstrap()` hangs (server unreachable, DNS stall,
 * proxy misconfigured) we'd normally leave the user staring at the
 * pulse forever. After 8s the component surfaces a retry affordance
 * that reloads the page.
 */

import { AlertTriangle, BrandMark } from 'csuite-web-ui';
import { useEffect, useState } from 'preact/hooks';

const STUCK_AFTER_MS = 8000;

export function Boot() {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <main
      class="min-h-screen flex flex-col items-center justify-center text-center"
      style="padding:24px;gap:18px"
    >
      <BrandMark size={56} stroke="var(--ink)" strokeWidth={3} style="opacity:.85" />
      <div style="font-family:var(--f-mono);font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);display:inline-flex;align-items:center;gap:10px">
        <span
          class="dot pulse"
          style="background:var(--steel);box-shadow:0 0 0 0 rgba(62,92,118,0.5)"
        />
        CommandSuite · standing up
      </div>
      {stuck && (
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:10px;max-width:24rem">
          <div
            class="flex items-center justify-center"
            style="font-family:var(--f-mono);font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ember);gap:6px"
          >
            <AlertTriangle size={12} aria-hidden="true" />
            Taking longer than expected
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            class="btn btn-ghost btn-sm"
          >
            ↻ Reload
          </button>
        </div>
      )}
    </main>
  );
}
