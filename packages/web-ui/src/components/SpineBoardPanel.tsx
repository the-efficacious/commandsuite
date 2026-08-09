/**
 * The Board — the allocator's plate. §9, and #155 finding 8 at the
 * granularity the data supports today.
 *
 * STATUS IS PULLED FROM STATE. There is no status-text input anywhere in
 * this component — the lanes and the roles are folded out of
 * `GET /spine/contracts` and presence, never typed by anyone. Two views:
 *
 *   Lanes         active / waiting / parked. Done and cancelled are
 *                 filtered out by default — a finished plate is not a
 *                 plate — behind a toggle.
 *   Relationships the same contracts grouped by how they bind ME:
 *                 assignee, verifier, authority, originator. A contract
 *                 binds me more than one way when it does, so it can
 *                 appear in more than one group, exactly as orient's
 *                 bindings do.
 *
 * The focus set (D9) is phase 6 — the lanes are lifecycle-based until it
 * lands, and that is stated rather than pretended around.
 */

import { signal } from '@preact/signals';
import type { SpineContract, SpineContractState } from 'csuite-sdk/types';
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { roster } from '../lib/roster.js';
import { loadSpineBoard, spineBoard, spineBoardLoaded } from '../lib/spine.js';
import { selectSpineQueue } from '../lib/view.js';
import { EmptyState, ErrorCallout, PageHeader } from './ui/index.js';

export interface SpineBoardPanelProps {
  viewer: string;
}

const panelError = signal<string | null>(null);
/** Board view: lifecycle lanes or my relationships. */
const boardView = signal<'lanes' | 'relationships'>('lanes');
/** Whether terminal contracts (done/cancelled/superseded) are shown. Off by default. */
const showDone = signal(false);

const TERMINAL: ReadonlySet<SpineContractState> = new Set(['done', 'cancelled', 'superseded']);

export function SpineBoardPanel({ viewer }: SpineBoardPanelProps) {
  const contracts = spineBoard.value;
  const loaded = spineBoardLoaded.value;
  const err = panelError.value;

  useEffect(() => {
    if (!loaded) {
      panelError.value = null;
      void loadSpineBoard(viewer).catch((e) => {
        panelError.value = e instanceof Error ? e.message : String(e);
      });
    }
  }, [loaded, viewer]);

  if (!loaded && err === null) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:24px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left))"
        aria-busy="true"
      >
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            class="ef-skeleton"
            style="height:56px;margin-bottom:8px;border-radius:10px"
          />
        ))}
      </div>
    );
  }

  const retry = () => {
    panelError.value = null;
    void loadSpineBoard(viewer).catch((e) => {
      panelError.value = e instanceof Error ? e.message : String(e);
    });
  };

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left))"
    >
      <PageHeader
        eyebrow="Board"
        title={`${contracts.length} on your plate`}
        actions={
          <button type="button" onClick={selectSpineQueue} class="btn">
            Queue
          </button>
        }
      />

      {err !== null && (
        <ErrorCallout
          title="Couldn't load the board"
          message={err}
          onRetry={retry}
          style="margin-bottom:16px"
        />
      )}

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;align-items:center">
        <button
          type="button"
          class={boardView.value === 'lanes' ? 'btn btn-primary' : 'btn'}
          onClick={() => {
            boardView.value = 'lanes';
          }}
        >
          Lanes
        </button>
        <button
          type="button"
          class={boardView.value === 'relationships' ? 'btn btn-primary' : 'btn'}
          onClick={() => {
            boardView.value = 'relationships';
          }}
        >
          Relationships
        </button>
        <label style="margin-left:auto;display:flex;align-items:center;gap:6px;font-family:var(--ef-font-body);font-size:12px;color:var(--ef-text-faint);cursor:pointer">
          <input
            type="checkbox"
            checked={showDone.value}
            onChange={(e) => {
              showDone.value = (e.target as HTMLInputElement).checked;
            }}
          />
          show done &amp; cancelled
        </label>
      </div>

      {contracts.length === 0 ? (
        <EmptyState title="Nothing on your plate" message="Contracts you own show up here." />
      ) : boardView.value === 'lanes' ? (
        <Lanes contracts={contracts} showDone={showDone.value} />
      ) : (
        <Relationships contracts={contracts} viewer={viewer} showDone={showDone.value} />
      )}
    </div>
  );
}

export function __resetSpineBoardPanelForTests(): void {
  panelError.value = null;
  boardView.value = 'lanes';
  showDone.value = false;
}

const LANES: { key: string; label: string; states: SpineContractState[] }[] = [
  { key: 'active', label: 'Active', states: ['active'] },
  { key: 'waiting', label: 'Waiting', states: ['waiting_on', 'waiting_for'] },
  { key: 'parked', label: 'Parked', states: ['parked'] },
];

function Lanes({ contracts, showDone }: { contracts: SpineContract[]; showDone: boolean }) {
  const terminal = contracts.filter((c) => TERMINAL.has(c.state));
  return (
    <div style="display:flex;flex-direction:column;gap:24px">
      {LANES.map((lane) => {
        const inLane = contracts.filter((c) => lane.states.includes(c.state));
        return (
          <Lane key={lane.key} label={lane.label} count={inLane.length}>
            {inLane.map((c) => (
              <ContractRow key={c.id} contract={c} />
            ))}
          </Lane>
        );
      })}
      {showDone && (
        <Lane label="Done &amp; cancelled" count={terminal.length}>
          {terminal.map((c) => (
            <ContractRow key={c.id} contract={c} />
          ))}
        </Lane>
      )}
    </div>
  );
}

function Relationships({
  contracts,
  viewer,
  showDone,
}: {
  contracts: SpineContract[];
  viewer: string;
  showDone: boolean;
}) {
  const visible = showDone ? contracts : contracts.filter((c) => !TERMINAL.has(c.state));
  const groups: { key: string; label: string; rows: SpineContract[] }[] = [
    {
      key: 'assignee',
      label: 'Mine to do (assignee)',
      rows: visible.filter((c) => c.assignee === viewer),
    },
    {
      key: 'verifier',
      label: 'Mine to verify',
      rows: visible.filter((c) => c.verifier === viewer),
    },
    {
      key: 'authority',
      label: 'Mine to rule on (authority)',
      rows: visible.filter((c) => c.authority === viewer),
    },
    {
      key: 'originator',
      label: 'I authored',
      rows: visible.filter((c) => c.createdBy === viewer),
    },
  ];
  return (
    <div style="display:flex;flex-direction:column;gap:24px">
      {groups.map((g) => (
        <Lane key={g.key} label={g.label} count={g.rows.length}>
          {g.rows.map((c) => (
            <ContractRow key={c.id} contract={c} />
          ))}
        </Lane>
      ))}
    </div>
  );
}

function Lane({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ComponentChildren;
}) {
  return (
    <section>
      <div style="font-family:var(--ef-font-mono);font-size:11px;letter-spacing:.08em;color:var(--ef-text-muted);text-transform:uppercase;margin-bottom:10px">
        {label} · {count}
      </div>
      {count === 0 ? (
        <div style="font-family:var(--ef-font-body);font-size:13px;color:var(--ef-text-faint)">
          —
        </div>
      ) : (
        <ul style="display:flex;flex-direction:column;gap:8px;list-style:none;padding:0;margin:0">
          {children}
        </ul>
      )}
    </section>
  );
}

const STATE_BADGE: Record<SpineContractState, string> = {
  active: 'badge solid',
  waiting_on: 'badge caution solid',
  waiting_for: 'badge caution soft',
  parked: 'badge muted',
  done: 'badge soft',
  cancelled: 'badge muted',
  superseded: 'badge muted',
};

function ContractRow({ contract }: { contract: SpineContract }) {
  const online = (roster.value?.connected ?? []).some(
    (p) => p.name === contract.assignee && p.connected > 0,
  );
  return (
    <li class="card" style="padding:12px 16px">
      <div class="flex items-center gap-3 min-w-0 flex-wrap">
        <span class={STATE_BADGE[contract.state]}>{contract.state}</span>
        <span
          class={`truncate${TERMINAL.has(contract.state) ? ' struck' : ''}`}
          style="font-family:var(--ef-font-display);font-weight:700;letter-spacing:-0.01em;font-size:14px"
        >
          {contract.title}
        </span>
        {contract.stale && <span class="badge caution soft">stale</span>}
      </div>
      <div style="font-family:var(--ef-font-mono);font-size:11px;letter-spacing:.06em;color:var(--ef-text-muted);margin-top:6px;display:flex;align-items:center;gap:6px">
        <span
          aria-hidden="true"
          style={`display:inline-block;width:7px;height:7px;border-radius:50%;background:${
            online ? 'var(--ef-lamp-ok, #3fb950)' : 'var(--ef-text-muted)'
          }`}
        />
        {contract.assignee}
        {contract.waitingOn !== null && <> · waiting on {contract.waitingOn}</>}
      </div>
    </li>
  );
}
