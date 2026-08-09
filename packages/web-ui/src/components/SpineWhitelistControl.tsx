/**
 * The interrupt whitelist — which class-1 events may buzz a phone. §9.
 *
 * The control that makes the rarest budget the member's own. Everything
 * addressed to them is always in the queue (a free read); this decides
 * only which of it ALSO reaches a phone when they are away from the
 * screen. Toggling a kind is a wholesale set of the whitelist — the
 * empty set is a legitimate "never buzz me" — so this component reads
 * the current set and writes the whole thing back on every change.
 */

import { signal } from '@preact/signals';
import type { SpineEventKind } from 'csuite-sdk/types';
import { useEffect } from 'preact/hooks';
import { loadSpineCurator, setInterruptWhitelist, spineCurator } from '../lib/spine.js';
import { ErrorCallout } from './ui/index.js';

/**
 * The class-1 kinds a member can be addressed by, with human labels.
 *
 * These are exactly the kinds `addressedMembers` routes as class 1;
 * every other kind never reaches a phone regardless of the whitelist,
 * so listing it here would be a switch that does nothing.
 */
const WHITELIST_KINDS: { kind: SpineEventKind; label: string }[] = [
  { kind: 'ask', label: 'A blocking ask names me as the authority' },
  { kind: 'proceeding', label: 'Someone proceeds past my ask without a ruling' },
  { kind: 'ruling', label: 'A ruling answers an ask I raised' },
  { kind: 'criterion_verdict', label: 'A verdict lands on a contract I own' },
  { kind: 'lifecycle', label: 'A contract I hold is ended or parked' },
  { kind: 'ask_action', label: 'An ask is redirected to me' },
  { kind: 'observation', label: 'A check I armed fires' },
  { kind: 'focus', label: 'The focus set runs dry' },
];

const busy = signal(false);
const err = signal<string | null>(null);

export function SpineWhitelistControl() {
  const config = spineCurator.value;

  useEffect(() => {
    if (config === null) {
      void loadSpineCurator().catch((e) => {
        err.value = e instanceof Error ? e.message : String(e);
      });
    }
  }, [config]);

  if (config === null) {
    return <div class="ef-skeleton" style="height:120px;border-radius:10px" aria-busy="true" />;
  }

  const current = new Set(config.policy.interruptWhitelist);

  const toggle = (kind: SpineEventKind, on: boolean) => {
    const next = new Set(current);
    if (on) next.add(kind);
    else next.delete(kind);
    busy.value = true;
    err.value = null;
    void setInterruptWhitelist([...next])
      .catch((e) => {
        err.value = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        busy.value = false;
      });
  };

  return (
    <section class="card" style="padding:16px;margin-bottom:20px" aria-label="Interrupt whitelist">
      <div style="font-family:var(--ef-font-display);font-weight:700;font-size:14px;letter-spacing:-0.01em;margin-bottom:4px">
        What buzzes my phone
      </div>
      <p style="font-family:var(--ef-font-body);font-size:12px;color:var(--ef-text-faint);margin:0 0 12px;line-height:1.4">
        Everything addressed to you is always in this queue. These are the only kinds that also
        reach a phone when you are away from the screen.
      </p>
      {err.value !== null && (
        <ErrorCallout
          title="Couldn't update the whitelist"
          message={err.value}
          style="margin-bottom:12px"
        />
      )}
      <ul style="display:flex;flex-direction:column;gap:8px;list-style:none;padding:0;margin:0">
        {WHITELIST_KINDS.map(({ kind, label }) => (
          <li key={kind}>
            <label style="display:flex;align-items:center;gap:10px;font-family:var(--ef-font-body);font-size:13px;cursor:pointer">
              <input
                type="checkbox"
                checked={current.has(kind)}
                disabled={busy.value}
                onChange={(e) => toggle(kind, (e.target as HTMLInputElement).checked)}
              />
              <span>{label}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function __resetSpineWhitelistControlForTests(): void {
  busy.value = false;
  err.value = null;
}
