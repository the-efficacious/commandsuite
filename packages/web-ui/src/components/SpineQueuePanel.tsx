/**
 * The Queue — the human seat's action surface. §9.
 *
 * Asks awaiting my ruling and contracts stuck on me, each an item I can
 * act on with one of the four typed acts: dictate a ruling, defer,
 * decline, redirect. Question, context and unblocks render VERBATIM from
 * the ask's required fields.
 *
 * Two properties, both visible in the code:
 *
 *   VISITING IS NOT HANDLING. The panel loads through `loadSpineQueue`,
 *   the receipt-neutral read. Opening the panel, or an item, advances
 *   nothing on the server; there is no "mark read". Only an act moves an
 *   item.
 *
 *   THE ANNEX IS THE TRUTH. An item leaves when its resolving event
 *   lands — every act reloads the queue from the server rather than
 *   splicing the row out locally. A redirect does not delete the item;
 *   it moves to the new authority's queue, and it simply stops coming
 *   back in mine on the reload.
 */

import { signal } from '@preact/signals';
import type { SpineContract, SpineQueueAskItem } from 'csuite-sdk/types';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { roster } from '../lib/roster.js';
import {
  declineAsk,
  deferAsk,
  dictateRuling,
  loadSpineQueue,
  redirectAsk,
  spineQueue,
  spineQueueLoaded,
} from '../lib/spine.js';
import { selectSpineBoard } from '../lib/view.js';
import { SpineWhitelistControl } from './SpineWhitelistControl.js';
import { EmptyState, ErrorCallout, PageHeader } from './ui/index.js';

export interface SpineQueuePanelProps {
  viewer: string;
}

const panelError = signal<string | null>(null);

export function SpineQueuePanel({ viewer }: SpineQueuePanelProps) {
  const queue = spineQueue.value;
  const loaded = spineQueueLoaded.value;
  const err = panelError.value;

  useEffect(() => {
    if (!loaded) {
      panelError.value = null;
      void loadSpineQueue().catch((e) => {
        panelError.value = e instanceof Error ? e.message : String(e);
      });
    }
  }, [loaded]);

  if (!loaded && err === null) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:24px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left))"
        aria-busy="true"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            class="ef-skeleton"
            style="height:96px;margin-bottom:10px;border-radius:10px"
          />
        ))}
      </div>
    );
  }

  const retry = () => {
    panelError.value = null;
    void loadSpineQueue().catch((e) => {
      panelError.value = e instanceof Error ? e.message : String(e);
    });
  };

  const asks = queue?.asks ?? [];
  const waiting = queue?.waitingOn ?? [];
  const total = asks.length + waiting.length;

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left))"
    >
      <PageHeader
        eyebrow="Queue"
        title={total === 0 ? 'Nothing waiting on you' : `${total} waiting on you`}
        actions={
          <button type="button" onClick={selectSpineBoard} class="btn">
            Board
          </button>
        }
      />

      {err !== null && (
        <ErrorCallout
          title="Couldn't load your queue"
          message={err}
          onRetry={retry}
          style="margin-bottom:16px"
        />
      )}

      <SpineWhitelistControl />

      {total === 0 ? (
        <EmptyState
          title="Your queue is empty"
          message="Asks awaiting your ruling and contracts stuck on you show up here."
        />
      ) : (
        <>
          {asks.length > 0 && (
            <section style="margin-bottom:24px">
              <SectionLabel>Asks awaiting your ruling</SectionLabel>
              <ul style="display:flex;flex-direction:column;gap:12px;list-style:none;padding:0;margin:0">
                {asks.map((item) => (
                  <AskCard key={item.ask.id} item={item} viewer={viewer} />
                ))}
              </ul>
            </section>
          )}
          {waiting.length > 0 && (
            <section>
              <SectionLabel>Contracts waiting on you</SectionLabel>
              <ul style="display:flex;flex-direction:column;gap:10px;list-style:none;padding:0;margin:0">
                {waiting.map((c) => (
                  <WaitingRow key={c.id} contract={c} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

export function __resetSpineQueuePanelForTests(): void {
  panelError.value = null;
}

function SectionLabel({ children }: { children: ComponentChildren }) {
  return (
    <div style="font-family:var(--ef-font-mono);font-size:11px;letter-spacing:.08em;color:var(--ef-text-muted);text-transform:uppercase;margin-bottom:10px">
      {children}
    </div>
  );
}

type ActKind = 'rule' | 'defer' | 'decline' | 'redirect' | null;

function AskCard({ item, viewer }: { item: SpineQueueAskItem; viewer: string }) {
  const { ask, contract } = item;
  const [open, setOpen] = useState<ActKind>(null);
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);

  // Advisory only — the server is the boundary. The queue only ever
  // returns asks where the caller IS the authority, so this is belt to
  // the store's braces: a ruling from anyone else is not a weaker
  // ruling, it is not a ruling, and the store refuses it.
  const canAct = ask.authority === viewer;

  // Every act on a CONTRACT-BOUND ask is an authoritative write on that
  // contract, so it carries the contract's current stateRev as the
  // precondition — which the queue handed us whole, no second call.
  const expectedStateRev = contract === null ? undefined : contract.stateRev;

  async function run(fn: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setActErr(null);
    try {
      await fn();
      // No local splice — the reload inside the act reflects the annex.
    } catch (e) {
      setActErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li class="card" style="padding:16px">
      <div style="font-family:var(--ef-font-display);font-weight:700;letter-spacing:-0.01em;font-size:15px;line-height:1.35">
        {ask.question}
      </div>
      <Field label="context">{ask.context}</Field>
      <Field label="unblocks">{ask.unblocks}</Field>
      <div style="font-family:var(--ef-font-mono);font-size:11px;letter-spacing:.06em;color:var(--ef-text-muted);margin-top:8px">
        from {ask.asker}
        {contract !== null && (
          <>
            {' · '}
            {contract.title} [{contract.state}, state_rev {contract.stateRev}]
          </>
        )}
      </div>

      {canAct && (
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
          <ActButton
            active={open === 'rule'}
            onClick={() => setOpen(open === 'rule' ? null : 'rule')}
          >
            Rule
          </ActButton>
          <ActButton
            active={open === 'defer'}
            onClick={() => setOpen(open === 'defer' ? null : 'defer')}
          >
            Defer
          </ActButton>
          <ActButton
            active={open === 'decline'}
            onClick={() => setOpen(open === 'decline' ? null : 'decline')}
          >
            Decline
          </ActButton>
          <ActButton
            active={open === 'redirect'}
            onClick={() => setOpen(open === 'redirect' ? null : 'redirect')}
          >
            Redirect
          </ActButton>
        </div>
      )}

      {actErr !== null && (
        <ErrorCallout title="That act was refused" message={actErr} style="margin-top:12px" />
      )}

      {open === 'rule' && (
        <RuleForm
          busy={busy}
          onCancel={() => setOpen(null)}
          onSubmit={(decision, reasoning) =>
            run(() => dictateRuling({ ask: ask.id, decision, reasoning }))
          }
        />
      )}
      {open === 'defer' && (
        <ReasonForm
          busy={busy}
          submitLabel="Confirm defer"
          withTrigger
          onCancel={() => setOpen(null)}
          onSubmit={(reason, trigger) =>
            run(() =>
              deferAsk({
                ask: ask.id,
                reason,
                ...(trigger ? { trigger } : {}),
                ...(expectedStateRev !== undefined ? { expectedStateRev } : {}),
              }),
            )
          }
        />
      )}
      {open === 'decline' && (
        <ReasonForm
          busy={busy}
          submitLabel="Confirm decline"
          onCancel={() => setOpen(null)}
          onSubmit={(reason) =>
            run(() =>
              declineAsk({
                ask: ask.id,
                reason,
                ...(expectedStateRev !== undefined ? { expectedStateRev } : {}),
              }),
            )
          }
        />
      )}
      {open === 'redirect' && (
        <RedirectForm
          busy={busy}
          viewer={viewer}
          onCancel={() => setOpen(null)}
          onSubmit={(redirectTo, reason) =>
            run(() =>
              redirectAsk({
                ask: ask.id,
                redirectTo,
                reason,
                ...(expectedStateRev !== undefined ? { expectedStateRev } : {}),
              }),
            )
          }
        />
      )}
    </li>
  );
}

function Field({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div style="margin-top:8px;font-family:var(--ef-font-body);font-size:13px;line-height:1.45">
      <span style="font-family:var(--ef-font-mono);font-size:11px;letter-spacing:.06em;color:var(--ef-text-muted);text-transform:uppercase;margin-right:6px">
        {label}:
      </span>
      <span style="color:var(--ef-text-faint)">{children}</span>
    </div>
  );
}

function ActButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ComponentChildren;
}) {
  return (
    <button type="button" onClick={onClick} class={active ? 'btn btn-primary' : 'btn'}>
      {children}
    </button>
  );
}

const FORM_STYLE =
  'margin-top:12px;display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--ef-border);border-radius:8px';
const INPUT_STYLE =
  'width:100%;padding:8px;font-family:var(--ef-font-body);font-size:13px;border:1px solid var(--ef-border);border-radius:6px;background:var(--ef-surface)';

function RuleForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (decision: string, reasoning: string) => void;
  onCancel: () => void;
}) {
  const [decision, setDecision] = useState('');
  const [reasoning, setReasoning] = useState('');
  const ready = decision.trim().length > 0 && reasoning.trim().length > 0;
  return (
    <div style={FORM_STYLE}>
      <input
        style={INPUT_STYLE}
        placeholder="Decision"
        value={decision}
        disabled={busy}
        onInput={(e) => setDecision((e.target as HTMLInputElement).value)}
      />
      <textarea
        style={`${INPUT_STYLE};min-height:60px;resize:vertical`}
        placeholder="Reasoning"
        value={reasoning}
        disabled={busy}
        onInput={(e) => setReasoning((e.target as HTMLTextAreaElement).value)}
      />
      <FormButtons
        busy={busy}
        ready={ready}
        submitLabel="Dictate ruling"
        onSubmit={() => onSubmit(decision, reasoning)}
        onCancel={onCancel}
      />
    </div>
  );
}

function ReasonForm({
  busy,
  submitLabel,
  withTrigger,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  submitLabel: string;
  withTrigger?: boolean;
  onSubmit: (reason: string, trigger?: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [trigger, setTrigger] = useState('');
  const ready = reason.trim().length > 0;
  return (
    <div style={FORM_STYLE}>
      <textarea
        style={`${INPUT_STYLE};min-height:60px;resize:vertical`}
        placeholder="Reason"
        value={reason}
        disabled={busy}
        onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)}
      />
      {withTrigger && (
        <input
          style={INPUT_STYLE}
          placeholder="Trigger (optional) — what re-arms this ask"
          value={trigger}
          disabled={busy}
          onInput={(e) => setTrigger((e.target as HTMLInputElement).value)}
        />
      )}
      <FormButtons
        busy={busy}
        ready={ready}
        submitLabel={submitLabel}
        onSubmit={() => onSubmit(reason, trigger.trim() || undefined)}
        onCancel={onCancel}
      />
    </div>
  );
}

function RedirectForm({
  busy,
  viewer,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  viewer: string;
  onSubmit: (redirectTo: string, reason: string) => void;
  onCancel: () => void;
}) {
  const [redirectTo, setRedirectTo] = useState('');
  const [reason, setReason] = useState('');
  // A redirect moves the question to somebody else — never back to the
  // asker, and never to me (that would be a no-op). The server refuses
  // the asker case; the picker just omits myself.
  const teammates = (roster.value?.teammates ?? []).filter((t) => t.name !== viewer);
  const ready = redirectTo.length > 0 && reason.trim().length > 0;
  return (
    <div style={FORM_STYLE}>
      <select
        style={INPUT_STYLE}
        value={redirectTo}
        disabled={busy}
        onChange={(e) => setRedirectTo((e.target as HTMLSelectElement).value)}
      >
        <option value="">Redirect to…</option>
        {teammates.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name}
          </option>
        ))}
      </select>
      <textarea
        style={`${INPUT_STYLE};min-height:60px;resize:vertical`}
        placeholder="Reason"
        value={reason}
        disabled={busy}
        onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)}
      />
      <FormButtons
        busy={busy}
        ready={ready}
        submitLabel="Confirm redirect"
        onSubmit={() => onSubmit(redirectTo, reason)}
        onCancel={onCancel}
      />
    </div>
  );
}

function FormButtons({
  busy,
  ready,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  ready: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button type="button" class="btn" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
      <button type="button" class="btn btn-primary" onClick={onSubmit} disabled={busy || !ready}>
        {busy ? 'Working…' : submitLabel}
      </button>
    </div>
  );
}

function WaitingRow({ contract }: { contract: SpineContract }) {
  return (
    <li class="card" style="padding:14px 16px">
      <div class="flex items-center gap-3 min-w-0 flex-wrap">
        <span class="badge caution solid">waiting on you</span>
        <span
          class="truncate"
          style="font-family:var(--ef-font-display);font-weight:700;letter-spacing:-0.01em;font-size:15px"
        >
          {contract.title}
        </span>
      </div>
      {contract.reason !== null && (
        <div style="font-family:var(--ef-font-body);font-size:13px;color:var(--ef-text-faint);margin-top:6px;line-height:1.4">
          {contract.reason}
        </div>
      )}
    </li>
  );
}
