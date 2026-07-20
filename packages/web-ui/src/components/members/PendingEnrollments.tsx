/**
 * PendingEnrollments — admin view of every device-code enrollment
 * currently waiting for approval.
 *
 * Designed to live under the Members admin panel so directors see
 * "two operators are waiting for approval right now" the same place
 * they manage memberships. Each row links to `/enroll?code=…` for
 * the full approval flow (including bind-vs-create choice and
 * permission set), with an inline Reject button for the easy case
 * where a director recognizes the request as bogus.
 *
 * Auto-refreshes every 5s while mounted — pending rows have a 5min
 * TTL, so directors notice expirations within one tick. Manual
 * refresh on the eyebrow's reload affordance.
 */

import { signal } from '@preact/signals';
import type { PendingEnrollment } from 'csuite-sdk/types';
import { useEffect } from 'preact/hooks';
import { getClient } from '../../lib/client.js';

const enrollments = signal<PendingEnrollment[] | null>(null);
const error = signal<string | null>(null);
const busyCode = signal<string | null>(null);

const REFRESH_INTERVAL_MS = 5000;

async function refresh(): Promise<void> {
  error.value = null;
  try {
    enrollments.value = await getClient().listPendingEnrollments();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function reject(userCode: string): Promise<void> {
  if (!confirm(`Reject pending enrollment ${userCode}?`)) return;
  busyCode.value = userCode;
  try {
    await getClient().rejectEnrollment({ userCode, reason: 'rejected from members panel' });
    await refresh();
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  } finally {
    busyCode.value = null;
  }
}

function fmtCountdown(expiresAt: number): string {
  const seconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtAge(createdAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function PendingEnrollments({ style }: { style?: string }) {
  // Background refresh loop — disposes on unmount.
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  const list = enrollments.value;
  const err = error.value;

  // Don't render the section at all when there's nothing pending —
  // a director shouldn't see an empty card for a feature they don't
  // currently need. Manual reload on the panel's main eyebrow row
  // refreshes the membership list, which calls this too.
  if (list !== null && list.length === 0 && err === null) {
    return null;
  }

  return (
    <section class="card elev" style={`padding:16px;${style ?? ''}`}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          <div class="eyebrow">Pending enrollments</div>
          <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted);margin-top:4px">
            Operators running <code>csuite connect</code> are waiting for your approval.
          </div>
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={() => void refresh()}
          title="Refresh"
        >
          ↻
        </button>
      </div>

      {err !== null && (
        <div
          role="alert"
          style="font-family:var(--f-sans);font-size:12.5px;color:var(--err);background:rgba(211,47,47,0.08);border:1px solid var(--err);border-radius:var(--r-sm);padding:8px 10px;margin-bottom:10px"
        >
          {err}
        </div>
      )}

      {list !== null && list.length > 0 && (
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px">
          {list.map((e) => (
            <li
              key={e.userCode}
              style="display:grid;grid-template-columns:1fr auto;gap:8px 16px;padding:10px 12px;background:var(--bg-alt);border:1px solid var(--rule);border-radius:var(--r-sm)"
            >
              <div>
                <div style="display:flex;align-items:center;gap:10px;font-family:var(--f-mono);font-size:14px;letter-spacing:.12em;color:var(--ink)">
                  {e.userCode}
                  <span style="font-family:var(--f-mono);font-size:10px;letter-spacing:.06em;color:var(--muted);text-transform:uppercase;padding:2px 6px;border:1px solid var(--rule);border-radius:3px">
                    expires in {fmtCountdown(e.expiresAt)}
                  </span>
                </div>
                <div style="font-family:var(--f-mono);font-size:11px;color:var(--muted);margin-top:6px;display:flex;flex-wrap:wrap;gap:14px">
                  <span>requested {fmtAge(e.createdAt)}</span>
                  {e.sourceIp && <span>ip {e.sourceIp}</span>}
                  {e.labelHint && <span>label: {e.labelHint}</span>}
                </div>
                {e.sourceUa !== null && (
                  <div style="font-family:var(--f-mono);font-size:11px;color:var(--muted);margin-top:4px;overflow-wrap:anywhere">
                    {e.sourceUa}
                  </div>
                )}
              </div>
              <div style="display:flex;flex-direction:column;gap:6px;align-items:end">
                <a
                  class="btn btn-primary btn-sm"
                  href={`/enroll?code=${encodeURIComponent(e.userCode)}`}
                >
                  Approve…
                </a>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  onClick={() => void reject(e.userCode)}
                  disabled={busyCode.value !== null}
                  style="color:var(--err)"
                >
                  {busyCode.value === e.userCode ? '…' : 'Reject'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function __resetPendingEnrollmentsForTests(): void {
  enrollments.value = null;
  error.value = null;
  busyCode.value = null;
}
