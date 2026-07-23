/**
 * AgentTimeline — turn-as-the-unit view of an agent's activity stream.
 *
 * Everything here is natively captured by the runner (Claude Code's
 * OTEL export via the broker OTLP ingest, the codex app-server event
 * stream, tool hooks) — there is no network interception. The stream
 * carries five event kinds: `user_prompt` (the prompt that woke a
 * turn), `llm_exchange` (one model turn), `tool_action` (one
 * natively-captured tool run), and the `objective_open` /
 * `objective_close` lifecycle markers.
 *
 * THE TURN IS THE SPINE. Each `llm_exchange` renders exactly ONE
 * block — its own response (thinking, text, tool calls) — never
 * re-rendering prior history. The conversation is reconstructed by
 * the sequence of blocks rather than by replaying each turn's
 * request prefix, so `request.messages` is ignored for rendering.
 *
 * Under each turn hang the things that belong to it:
 *   - its TOOL CALLS as call cards — the model's `tool_use` block
 *     carries the intent, the matching `tool_action` (paired by
 *     `toolUseId`) folds its ✓/✗ result underneath. A `tool_action`
 *     with no matching `tool_use` renders standalone.
 *   - its API CALL(S) from the genai ledger (lib/genai-feed.ts),
 *     joined deterministically (lib/trace-join.ts): exact
 *     `responseId` for Claude, interval containment for codex —
 *     whose turns genuinely aggregate several Responses-API calls.
 *     Each call's full request context lazy-loads by record id on
 *     expand (lib/genai-lazy.ts). A turn with no joined call shows
 *     an honest "not captured".
 *
 * Model calls with NO turn marker at all — subagent work, server-tool
 * sidecars (web search), away summaries — interleave into the feed as
 * ghost rows attributed by `querySource`, so everything the member's
 * model did shows up in one place instead of living invisibly in the
 * genai store.
 *
 * A `user_prompt` event renders as a muted opener block — the text
 * that woke the turn (often an injected ambient broker event).
 *
 * Filters:
 *   - `kindFilters` — per-event-kind toggles. Hidden kinds are dropped
 *     before threading.
 *   - `showApiCalls` — toggles the unmatched model-call ghost rows.
 *   - `objectiveFilter` — clip to rows that occurred while a chosen
 *     objective was open (model-call rows clip by the objective's
 *     open→close windows). `null` means "show everything."
 */

import { signal } from '@preact/signals';
import type {
  ActivityEvent,
  ActivityLlmExchange,
  ActivityRow,
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicUsage,
  GenAiInferenceSummary,
  GenAiUsage,
} from 'csuite-sdk/types';
import { useMemo, useRef } from 'preact/hooks';
import { highlightXmlTags } from '../lib/channel-highlight.js';
import { memberGenAiCalls, memberGenAiCallsReady } from '../lib/genai-feed.js';
import { genAiRecordState, loadGenAiRecord } from '../lib/genai-lazy.js';
import { highlightJson } from '../lib/json-highlight.js';
import {
  loadOlderMemberActivity,
  memberActivityConnected,
  memberActivityExhausted,
  memberActivityLoading,
  memberActivityName,
  memberActivityRows,
} from '../lib/member-activity.js';
import { joinTurns } from '../lib/trace-join.js';
import { useWindowedList } from '../lib/use-windowed-list.js';
import { selectObjectiveDetail } from '../lib/view.js';
import { GenAiMessageBlock, GenAiRequestDetails } from './GenAiBlocks.js';

type KindFilter = Record<ActivityEvent['kind'], boolean>;

const DEFAULT_FILTERS: KindFilter = {
  // Run brackets (session_start/session_end) pass the filter but have
  // no thread renderer yet — buildThread skips kinds it doesn't know.
  // Rendering them as timeline boundary markers (mirroring the
  // objective markers) is a follow-up; no chip until then.
  session_start: true,
  session_end: true,
  objective_open: true,
  objective_close: true,
  llm_exchange: true,
  tool_action: true,
  user_prompt: true,
};

const kindFilters = signal<KindFilter>({ ...DEFAULT_FILTERS });

/**
 * Toggle for the unmatched model-call ghost rows (subagent /
 * sidecar calls with no turn marker). Calls joined INTO a turn are
 * part of the turn block and unaffected.
 */
const showApiCalls = signal(true);

/** null = all activity; otherwise clip to windows where this objective was open. */
const objectiveFilter = signal<string | null>(null);

// ── Model + tool-name helpers ─────────────────────────────────────
//
// Moved to lib/model-format.ts so the shared GenAI block renderers
// can use them without an import cycle; re-exported here because
// TracePanel (and tests) import them from this module.

export { parseToolName, prettyModel } from '../lib/model-format.js';

import { describeQuerySource, parseToolName, prettyModel } from '../lib/model-format.js';

// ── Thread model ─────────────────────────────────────────────────

/** A tool's captured outcome, folded into its `tool_use` call card. */
interface FoldedResult {
  isError: boolean;
  result: unknown;
  durationMs: number | null;
}

type ThreadItem =
  | {
      key: string;
      variant: 'prompt';
      ts: number;
      text: string;
      agent: string | null;
    }
  | {
      key: string;
      variant: 'turn';
      ts: number;
      model: string | null;
      duration: number;
      usage: AnthropicUsage | null;
      stopReason: string | null;
      /** The response messages — the turn's own contribution. */
      messages: AnthropicMessage[];
      /** tool_action results indexed by toolUseId, for call-card folding. */
      folds: Map<string, FoldedResult>;
      /**
       * The turn's API call(s) from the genai ledger, joined by
       * `joinTurns` — usually one for Claude, several for a codex
       * turn, empty when the body export missed the call. Each call's
       * full context lazy-loads by record id on expand.
       */
      calls: GenAiInferenceSummary[];
    }
  | {
      /**
       * A model call with NO turn marker — subagent work, a
       * server-tool sidecar (web search), an away summary, or a call
       * whose activity capture was missed. Rendered as a ghost row so
       * the feed shows everything the member's model did.
       */
      key: string;
      variant: 'model-call';
      ts: number;
      recordId: number;
      provider: string;
      model: string | null;
      querySource: string | null;
      agentName: string | null;
      usage: GenAiUsage | null;
    }
  | {
      key: string;
      variant: 'objective-open';
      ts: number;
      objectiveId: string;
    }
  | {
      key: string;
      variant: 'objective-close';
      ts: number;
      objectiveId: string;
      result: 'done' | 'cancelled' | 'reassigned' | 'runner_shutdown';
    }
  | {
      key: string;
      variant: 'tool-action';
      ts: number;
      toolName: string;
      agent: string | null;
      source: string | null;
      durationMs: number | null;
      isError: boolean;
      input: unknown;
      result: unknown;
    };

/**
 * Collapse a chronological row stream + the genai call ledger into
 * the turn spine. Pure for testability. Input may be in any order —
 * sorted by ts ascending internally.
 *
 * Each `llm_exchange` becomes ONE `turn` item carrying only its own
 * response; `request.messages` is not rendered. Tool actions are
 * pre-indexed by `toolUseId` and folded into the matching turn's
 * `tool_use` call card — a tool_action that matches a captured
 * `tool_use` is skipped as a standalone row; an unmatched one (codex,
 * or a hook whose exchange wasn't captured) renders as a fallback
 * `tool-action` row.
 *
 * The ledger joins in via `joinTurns`: each turn carries its API
 * call summaries (the identity handles for lazy full-context
 * loading), and calls that belong to NO turn — subagent / sidecar
 * work — interleave chronologically as `model-call` items. Nothing
 * about the full context is loaded here; the stream stays a clean
 * sequence of turn blocks.
 */
export function buildThread(
  rows: ActivityRow[],
  calls: GenAiInferenceSummary[] = [],
): ThreadItem[] {
  const chron = [...rows].sort((a, b) => a.event.ts - b.event.ts);

  // Join the call ledger onto the exchanges (turn-centric: exact
  // responseId, else interval containment gated by source class).
  const exchanges: ActivityLlmExchange[] = [];
  for (const row of chron) {
    if (row.event.kind === 'llm_exchange') exchanges.push(row.event);
  }
  const joined = joinTurns(exchanges, calls);
  const callsByExchange = new Map<ActivityLlmExchange, GenAiInferenceSummary[]>();
  for (const t of joined.turns) callsByExchange.set(t.exchange, t.calls);

  // Index tool_action results by toolUseId (for folding), and collect
  // the set of tool_use block ids that appear across captured
  // exchanges (to decide which tool_actions are folded vs standalone).
  const folds = new Map<string, FoldedResult>();
  const toolUseIds = new Set<string>();
  for (const row of chron) {
    const ev = row.event;
    if (ev.kind === 'tool_action' && ev.toolUseId !== undefined) {
      folds.set(ev.toolUseId, {
        isError: ev.isError ?? false,
        result: ev.result,
        durationMs: ev.durationMs ?? null,
      });
    } else if (ev.kind === 'llm_exchange') {
      for (const m of ev.entry.response?.messages ?? []) {
        for (const b of m.content) {
          if (b.type === 'tool_use') toolUseIds.add(b.id);
        }
      }
    }
  }

  const thread: ThreadItem[] = [];
  for (const row of chron) {
    const ev = row.event;
    switch (ev.kind) {
      case 'user_prompt':
        thread.push({
          key: `r${row.id}-prompt`,
          variant: 'prompt',
          ts: ev.ts,
          text: ev.text,
          agent: ev.agent ?? null,
        });
        break;
      case 'objective_open':
        thread.push({
          key: `r${row.id}-oo`,
          variant: 'objective-open',
          ts: ev.ts,
          objectiveId: ev.objectiveId,
        });
        break;
      case 'objective_close':
        thread.push({
          key: `r${row.id}-oc`,
          variant: 'objective-close',
          ts: ev.ts,
          objectiveId: ev.objectiveId,
          result: ev.result,
        });
        break;
      case 'tool_action': {
        // Folded into a turn's tool_use call card — don't double-draw.
        if (ev.toolUseId !== undefined && toolUseIds.has(ev.toolUseId)) break;
        thread.push({
          key: `r${row.id}-tool`,
          variant: 'tool-action',
          ts: ev.ts,
          toolName: ev.toolName,
          agent: ev.agent ?? null,
          source: ev.source ?? null,
          durationMs: ev.durationMs ?? null,
          isError: ev.isError ?? false,
          input: ev.input,
          result: ev.result,
        });
        break;
      }
      case 'llm_exchange': {
        const entry = ev.entry;
        thread.push({
          key: `r${row.id}-turn`,
          variant: 'turn',
          ts: ev.ts,
          model: entry.request.model,
          duration: ev.duration,
          usage: entry.response?.usage ?? null,
          stopReason: entry.response?.stopReason ?? null,
          messages: entry.response?.messages ?? [],
          folds,
          calls: callsByExchange.get(ev) ?? [],
        });
        break;
      }
    }
  }

  // Interleave the turnless calls chronologically (stable sort keeps
  // same-ts activity items in stream order).
  for (const call of joined.orphans) {
    thread.push({
      key: `g${call.id}`,
      variant: 'model-call',
      ts: call.ts,
      recordId: call.id,
      provider: call.provider,
      model: call.model,
      querySource: call.querySource,
      agentName: call.agentName,
      usage: call.usage,
    });
  }
  thread.sort((a, b) => a.ts - b.ts);

  return thread;
}

/**
 * Clip the call ledger to the open→close windows of one objective —
 * the model-call analogue of `clipToObjective`. Windows are derived
 * from the FULL row stream (markers must not be pre-filtered away).
 */
export function clipCallsToObjective(
  calls: GenAiInferenceSummary[],
  rows: ActivityRow[],
  objectiveId: string | null,
): GenAiInferenceSummary[] {
  if (objectiveId === null) return calls;
  const chron = [...rows].sort((a, b) => a.event.ts - b.event.ts);
  const windows: Array<{ from: number; to: number | null }> = [];
  let open: number | null = null;
  for (const row of chron) {
    const ev = row.event;
    if (ev.kind === 'objective_open' && ev.objectiveId === objectiveId) {
      if (open === null) open = ev.ts;
    } else if (ev.kind === 'objective_close' && ev.objectiveId === objectiveId && open !== null) {
      windows.push({ from: open, to: ev.ts });
      open = null;
    }
  }
  if (open !== null) windows.push({ from: open, to: null });
  return calls.filter((c) =>
    windows.some((w) => c.ts >= w.from && (w.to === null || c.ts <= w.to)),
  );
}

export interface ObjectiveSeen {
  id: string;
  result: string | null;
}

/** Objectives that appeared in the row stream, first-seen order. */
export function objectivesSeen(rows: ActivityRow[]): ObjectiveSeen[] {
  const chron = [...rows].sort((a, b) => a.event.ts - b.event.ts);
  const out = new Map<string, ObjectiveSeen>();
  for (const row of chron) {
    const ev = row.event;
    if (ev.kind === 'objective_open' && !out.has(ev.objectiveId)) {
      out.set(ev.objectiveId, { id: ev.objectiveId, result: null });
    } else if (ev.kind === 'objective_close') {
      const entry = out.get(ev.objectiveId);
      if (entry) entry.result = ev.result;
      else out.set(ev.objectiveId, { id: ev.objectiveId, result: ev.result });
    }
  }
  return [...out.values()];
}

/**
 * Clip rows to windows where `objectiveId` was open. Open and close
 * markers for the target objective are always included; anything
 * strictly between a matching open and its close (non-inclusive on
 * the far side of interleaved opens for other objectives) is kept.
 * Input and output are oldest-first.
 */
export function clipToObjective(rows: ActivityRow[], objectiveId: string | null): ActivityRow[] {
  if (objectiveId === null) return rows;
  const chron = [...rows].sort((a, b) => a.event.ts - b.event.ts);
  const out: ActivityRow[] = [];
  let active = false;
  for (const row of chron) {
    const ev = row.event;
    if (ev.kind === 'objective_open' && ev.objectiveId === objectiveId) {
      active = true;
      out.push(row);
    } else if (ev.kind === 'objective_close' && ev.objectiveId === objectiveId) {
      active = false;
      out.push(row);
    } else if (active) {
      out.push(row);
    }
  }
  return out;
}

// ── Rendering ────────────────────────────────────────────────────

export function AgentTimeline() {
  const rows = memberActivityRows.value;
  const connected = memberActivityConnected.value;
  const filters = kindFilters.value;
  const objFilter = objectiveFilter.value;

  // Mirror TimelineBody's filter pipeline so the eyebrow count
  // reflects what the user actually sees rendered. Memoized — the
  // clip walks + sorts the whole row list, and this component
  // re-renders on every arriving row.
  const filteredCount = useMemo(
    () => clipToObjective(rows, objFilter).filter((row) => filters[row.event.kind]).length,
    [rows, objFilter, filters],
  );

  return (
    <section class="card" style="display:flex;flex-direction:column;gap:14px">
      <div class="eyebrow" style="display:flex;align-items:center;gap:10px">
        <span>Activity ({filteredCount})</span>
        {!connected && (
          <span class="badge ember" style="font-size:10px">
            ◆ OFFLINE
          </span>
        )}
      </div>
      <TimelineFilters />
      <TimelineBody />
    </section>
  );
}

/**
 * Active-filter summary for the collapsed tray. Returns null when
 * everything is on (the "all activity" baseline) so the tray header
 * stays clean; otherwise returns a short string suitable for display
 * next to the "Filters" label.
 */
export function timelineFilterSummary(): string | null {
  const filters = kindFilters.value;
  const obj = objectiveFilter.value;
  const calls = showApiCalls.value;
  const onCount = (Object.values(filters) as boolean[]).filter(Boolean).length + (calls ? 1 : 0);
  const total = Object.keys(filters).length + 1;
  const parts: string[] = [];
  if (onCount < total) parts.push(`${onCount} of ${total} kinds`);
  if (obj !== null) parts.push(`scope: ${obj}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Filter chip bar + scope picker. Pure presentation around the
 * `kindFilters` and `objectiveFilter` signals; either consumer
 * (member-profile card or right-rail inspector) renders this where
 * makes sense in their layout.
 */
export function TimelineFilters() {
  const filters = kindFilters.value;
  const objFilter = objectiveFilter.value;
  const rows = memberActivityRows.value;
  const objectives = useMemo(() => objectivesSeen(rows), [rows]);
  return (
    <div class="flex items-center gap-2 flex-wrap">
      {objectives.length > 0 && <ObjectiveSelect objectives={objectives} current={objFilter} />}
      <FilterBar filters={filters} />
    </div>
  );
}

/**
 * The threaded feed + paging affordances. Extracted so `<AgentTimeline
 * />` (member-profile card) and `<ActivityInspector />` (TeamShell
 * right rail) share rendering while owning their own header chrome
 * and filter placement.
 */
export function TimelineBody() {
  const rows = memberActivityRows.value;
  const calls = memberGenAiCalls.value;
  const loading = memberActivityLoading.value;
  const exhausted = memberActivityExhausted.value;
  const filters = kindFilters.value;
  const withApiCalls = showApiCalls.value;
  const objFilter = objectiveFilter.value;

  // The clip → filter → join → build pipeline is the activity feed's
  // heavy lifting: each stage sorts the full row list. This component
  // re-renders on every arriving row, so without memoizing the whole
  // pipeline runs from scratch many times per second on a busy stream.
  // Deps are all signal values with stable identity between unrelated
  // renders.
  const thread = useMemo(() => {
    const clipped = clipToObjective(rows, objFilter);
    const filteredRows = clipped.filter((row) => filters[row.event.kind]);
    // The full ledger always joins — turns keep their calls even with
    // ghost rows toggled off; `showApiCalls` only gates whether the
    // unmatched remainder renders.
    const built = buildThread(filteredRows, clipCallsToObjective(calls, rows, objFilter));
    return withApiCalls ? built : built.filter((item) => item.variant !== 'model-call');
  }, [rows, calls, objFilter, filters, withApiCalls]);

  // Trailing render window — a long stream expands into many turn
  // blocks (each re-serializing tool payloads). Paint only the tail;
  // `resetKey` collapses the window when the inspected agent changes.
  const win = useWindowedList(thread.length, {
    pageSize: 60,
    resetKey: memberActivityName.value,
  });
  const windowStart = thread.length - win.visibleCount;
  const visibleThread = thread.slice(windowStart);

  // Scroll-anchor preservation: revealing older items (from the
  // window or from the server) shifts the visible content down by
  // their height. Capture the scroll position before, restore the
  // same relative position after render. Falls back to no-op when the
  // body isn't inside a scroll container (member-profile page, where
  // the browser handles anchoring natively via overflow-anchor).
  const loadOlderBtnRef = useRef<HTMLButtonElement | null>(null);
  const onLoadOlder = async (): Promise<void> => {
    const btn = loadOlderBtnRef.current;
    const scroller = btn?.closest<HTMLElement>('[data-scroll-anchor]') ?? null;
    const before = scroller ? { height: scroller.scrollHeight, top: scroller.scrollTop } : null;
    // Reveal in-memory items first; only hit the network once the
    // window has caught up to everything already loaded.
    if (win.hasHidden) {
      win.showMore();
    } else {
      await loadOlderMemberActivity();
    }
    if (scroller && before) {
      requestAnimationFrame(() => {
        scroller.scrollTop = before.top + (scroller.scrollHeight - before.height);
      });
    }
  };

  const canLoadOlder = rows.length > 0 && (win.hasHidden || !exhausted);

  return (
    <>
      {rows.length === 0 && loading && <div class="eyebrow">Loading activity…</div>}
      {rows.length === 0 && !loading && (
        <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted);font-style:italic">
          No activity yet — the runner hasn't observed any traffic for this slot.
        </div>
      )}

      {canLoadOlder && (
        <div>
          <button
            ref={loadOlderBtnRef}
            type="button"
            onClick={() => void onLoadOlder()}
            disabled={loading}
            class="btn btn-ghost btn-sm"
          >
            {loading ? 'Loading…' : '↑ Load older'}
          </button>
        </div>
      )}

      <ol style="display:flex;flex-direction:column;gap:4px;list-style:none;padding:0;margin:0">
        {visibleThread.map((item) => (
          <li key={item.key}>
            <ThreadItemView item={item} />
          </li>
        ))}
      </ol>
    </>
  );
}

function ObjectiveSelect({
  objectives,
  current,
}: {
  objectives: ObjectiveSeen[];
  current: string | null;
}) {
  return (
    <select
      aria-label="Objective filter"
      value={current ?? ''}
      onChange={(e) => {
        const v = (e.currentTarget as HTMLSelectElement).value;
        objectiveFilter.value = v === '' ? null : v;
      }}
      style="font-family:var(--f-mono);font-size:12px;padding:2px 6px;border:1px solid var(--rule);background:var(--ice);color:var(--ink);border-radius:var(--r-sm)"
    >
      <option value="">all activity</option>
      {objectives.map((o) => (
        <option key={o.id} value={o.id}>
          {o.id} · {o.result ?? 'open'}
        </option>
      ))}
    </select>
  );
}

function FilterBar({ filters }: { filters: KindFilter }) {
  const kinds: Array<{ key: ActivityEvent['kind']; label: string }> = [
    { key: 'user_prompt', label: 'prompts' },
    { key: 'llm_exchange', label: 'LLM' },
    { key: 'tool_action', label: 'tools' },
    { key: 'objective_open', label: 'obj open' },
    { key: 'objective_close', label: 'obj close' },
  ];
  const callsOn = showApiCalls.value;
  return (
    <div class="flex items-center gap-2 flex-wrap">
      {kinds.map(({ key, label }) => {
        const on = filters[key];
        return (
          <button
            key={key}
            type="button"
            onClick={() => {
              kindFilters.value = { ...filters, [key]: !on };
            }}
            class={`badge ${on ? 'solid' : 'soft'}`}
            style="cursor:pointer"
          >
            {on ? '●' : '○'} {label}
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => {
          showApiCalls.value = !callsOn;
        }}
        class={`badge ${callsOn ? 'solid' : 'soft'}`}
        style="cursor:pointer"
        title="Model calls with no turn marker — subagents, web search, away summaries"
      >
        {callsOn ? '●' : '○'} api calls
      </button>
    </div>
  );
}

function ThreadItemView({ item }: { item: ThreadItem }) {
  switch (item.variant) {
    case 'objective-open':
      return (
        <div
          class="flex items-center gap-3"
          style="font-family:var(--f-mono);font-size:12px;color:var(--steel);border-left:2px solid var(--steel);padding:6px 12px"
        >
          <span>{formatTs(item.ts)}</span>
          <span>▼</span>
          <button
            type="button"
            onClick={() => selectObjectiveDetail(item.objectiveId)}
            style="background:transparent;color:var(--steel);font-family:inherit;font-size:inherit;padding:0"
          >
            {item.objectiveId}
          </button>
          <span style="color:var(--muted)">opened</span>
        </div>
      );
    case 'objective-close':
      return (
        <div
          class="flex items-center gap-3"
          style="font-family:var(--f-mono);font-size:12px;color:var(--muted);border-left:2px solid var(--rule);padding:6px 12px"
        >
          <span>{formatTs(item.ts)}</span>
          <span>▲</span>
          <button
            type="button"
            onClick={() => selectObjectiveDetail(item.objectiveId)}
            style="background:transparent;color:var(--ink);font-family:inherit;font-size:inherit;padding:0"
          >
            {item.objectiveId}
          </button>
          <span>closed ({item.result})</span>
        </div>
      );
    case 'prompt':
      return <PromptBlock item={item} />;
    case 'turn':
      return <TurnBlock item={item} />;
    case 'tool-action':
      return <ToolActionMarker item={item} />;
    case 'model-call':
      return <ModelCallRow item={item} />;
  }
}

/**
 * The prompt that woke a turn — a muted opener block. In csuite this
 * is often an injected ambient broker event rather than a human
 * keystroke; either way it's the real opener for the turns below it.
 */
function PromptBlock({ item }: { item: Extract<ThreadItem, { variant: 'prompt' }> }) {
  // The opener is usually a `<channel …>` broadcast (the ambient event
  // that woke the turn) — run it through the same channel-tag highlighter
  // the transcript uses so it reads as structured markup, not raw XML.
  const highlighted = highlightXmlTags(item.text);
  return (
    <div style="border-left:2px solid var(--rule-strong);background:color-mix(in srgb, var(--steel) 5%, transparent);padding:7px 10px;border-radius:0 5px 5px 0">
      <div class="eyebrow" style="margin-bottom:4px">
        prompt · {formatTs(item.ts)}
      </div>
      {highlighted !== null ? (
        <pre
          style="margin:0;font-family:var(--f-mono);font-size:11.5px;color:var(--ink);white-space:pre-wrap;line-height:1.5"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <pre style="margin:0;font-family:var(--f-mono);font-size:11.5px;color:var(--muted);white-space:pre-wrap;line-height:1.5">
          {item.text}
        </pre>
      )}
    </div>
  );
}

/**
 * One agent turn, told once — a header (time · model · duration ·
 * tokens · cached · stop), the assistant's reasoning + text, then its
 * tool calls as expanded call cards with the tool result folded in.
 */
function TurnBlock({ item }: { item: Extract<ThreadItem, { variant: 'turn' }> }) {
  const body: AnthropicContentBlock[] = [];
  const toolUses: Array<Extract<AnthropicContentBlock, { type: 'tool_use' }>> = [];
  for (const m of item.messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use') toolUses.push(b);
      else body.push(b);
    }
  }
  const accent = toolUses.length > 0 ? 'var(--steel)' : 'var(--ember)';

  // Header segments after the model — omit any that are null/zero.
  const segments: string[] = [`${(item.duration / 1000).toFixed(1)}s`];
  const u = item.usage;
  if (u && ((u.inputTokens ?? 0) > 0 || (u.outputTokens ?? 0) > 0)) {
    segments.push(`${u.inputTokens ?? 0}→${u.outputTokens ?? 0} tok`);
  }
  if (u?.cacheReadInputTokens && u.cacheReadInputTokens > 0) {
    segments.push(`${(u.cacheReadInputTokens / 1000).toFixed(1)}k cached`);
  }
  // stop=tool_use is redundant with the visible call cards below, so
  // only surface a non-tool_use terminal reason.
  if (item.stopReason && item.stopReason !== 'tool_use') segments.push(item.stopReason);

  return (
    <div style={`border-left:2px solid ${accent};padding:7px 10px;border-radius:0 5px 5px 0`}>
      <div style="font-family:var(--f-mono);font-size:11px;color:var(--muted);display:flex;gap:8px;flex-wrap:wrap;align-items:baseline">
        <span style="font-variant-numeric:tabular-nums">{formatTs(item.ts)}</span>
        <span style="color:var(--ink);font-weight:700">{prettyModel(item.model ?? '?')}</span>
        {segments.map((s, i) => (
          <span key={i} style="font-variant-numeric:tabular-nums">
            · {s}
          </span>
        ))}
      </div>
      {/* The turn's API call(s) — the request-side layer. Sits
          BETWEEN the header and the response so expanding it reads
          as the turn unfolding into the full thread the model saw,
          with the response continuing below it. */}
      <TurnCalls calls={item.calls} />
      {body.map((block, i) => (
        <TurnContentBlock key={i} block={block} />
      ))}
      {toolUses.map((block) => (
        <CallCard key={block.id} block={block} fold={item.folds.get(block.id) ?? null} />
      ))}
    </div>
  );
}

/**
 * The expanded-context container: a bounded, independently
 * scrollable inset so a 100-message request prefix reads as a
 * DOCUMENT the viewer peers into rather than dissolving seamlessly
 * into the feed. `overscroll-behavior:contain` keeps its wheel
 * scrolling from dragging the page along at the edges.
 */
const CONTEXT_SCROLL_BOX =
  'margin-top:4px;max-height:340px;overflow-y:auto;overscroll-behavior:contain;' +
  'border:1px solid var(--rule);border-radius:5px;padding:8px 10px;' +
  'background:color-mix(in srgb, var(--steel) 4%, transparent)';

/**
 * The per-turn API-call affordance.
 *
 * One call (the Claude shape): a collapsed "full context ↓" — expand
 * fetches the record body by id and shows the system prompt + the
 * complete input the model saw on this call.
 *
 * Several calls (the codex shape — one turn aggregates N
 * Responses-API calls): a collapsed "api calls (N)" listing each
 * call with its own lazy context.
 *
 * No calls: an honest "not captured" once the ledger has hydrated
 * (loading before that) — the genai layer is best-effort.
 */
function TurnCalls({ calls }: { calls: GenAiInferenceSummary[] }) {
  const ready = memberGenAiCallsReady.value;
  if (calls.length === 0) {
    return (
      <details style="margin-top:6px">
        <summary style="font-family:var(--f-mono);font-size:11px;color:var(--muted);cursor:pointer">
          full context ↓
        </summary>
        <div style="margin-top:4px">
          {ready ? (
            <div style="font-family:var(--f-sans);font-size:12px;color:var(--muted);font-style:italic">
              The request body for this call wasn't captured — no full context available.
            </div>
          ) : (
            <div style="font-family:var(--f-mono);font-size:11px;color:var(--muted)">loading…</div>
          )}
        </div>
      </details>
    );
  }
  const single = calls.length === 1 ? calls[0] : undefined;
  if (single !== undefined) {
    return (
      <details
        style="margin-top:6px"
        onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open) {
            void loadGenAiRecord(single.id);
          }
        }}
      >
        <summary style="font-family:var(--f-mono);font-size:11px;color:var(--muted);cursor:pointer">
          full context ↓
        </summary>
        <div style={CONTEXT_SCROLL_BOX}>
          <LazyRecordBody recordId={single.id} defaultOpen />
        </div>
      </details>
    );
  }
  return (
    <details style="margin-top:6px">
      <summary style="font-family:var(--f-mono);font-size:11px;color:var(--muted);cursor:pointer">
        api calls ({calls.length}) ↓
      </summary>
      <div style="margin-top:4px;display:flex;flex-direction:column;gap:4px">
        {calls.map((call) => (
          <CallSubRow key={call.id} call={call} />
        ))}
      </div>
    </details>
  );
}

/** One API call inside a multi-call (codex) turn. */
function CallSubRow({ call }: { call: GenAiInferenceSummary }) {
  const u = call.usage;
  return (
    <details
      style="border-left:1px solid var(--rule);padding-left:10px"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) {
          void loadGenAiRecord(call.id);
        }
      }}
    >
      <summary
        class="flex items-center gap-2 flex-wrap"
        style="font-family:var(--f-mono);font-size:11px;color:var(--muted);cursor:pointer;padding:2px 0"
      >
        <span style="font-variant-numeric:tabular-nums">{formatTs(call.ts)}</span>
        <span style="color:var(--ink);font-weight:600">
          {call.model !== null ? prettyModel(call.model) : '?'}
        </span>
        {u && ((u.inputTokens ?? 0) > 0 || (u.outputTokens ?? 0) > 0) && (
          <span style="font-variant-numeric:tabular-nums">
            · {u.inputTokens ?? 0}→{u.outputTokens ?? 0} tok
          </span>
        )}
        {call.finishReasons[0] !== undefined && <span>· {call.finishReasons[0]}</span>}
      </summary>
      <div style={CONTEXT_SCROLL_BOX}>
        <LazyRecordBody recordId={call.id} />
      </div>
    </details>
  );
}

/**
 * The lazy-loaded body of one genai record: loading/error states,
 * then the request layers (and, when `showOutput`, the response
 * messages — used by ghost rows whose output appears nowhere else in
 * the feed; a turn's own block already shows its response).
 */
function LazyRecordBody({
  recordId,
  defaultOpen = false,
  showOutput = false,
}: {
  recordId: number;
  defaultOpen?: boolean;
  showOutput?: boolean;
}) {
  const state = genAiRecordState(recordId);
  if (state.status === 'idle' || state.status === 'loading') {
    return <div style="font-family:var(--f-mono);font-size:11px;color:var(--muted)">loading…</div>;
  }
  if (state.status === 'error') {
    return (
      <div style="font-family:var(--f-sans);font-size:12px;color:var(--err)">
        Failed to load context: {state.message}
      </div>
    );
  }
  return (
    <>
      {showOutput && state.record.outputMessages.length > 0 && (
        <details style="margin-top:4px" open>
          <summary style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);cursor:pointer">
            output ({state.record.outputMessages.length}{' '}
            {state.record.outputMessages.length === 1 ? 'message' : 'messages'})
          </summary>
          <div style="margin-top:4px;display:flex;flex-direction:column;gap:4px">
            {state.record.outputMessages.map((m, i) => (
              <GenAiMessageBlock key={i} message={m} />
            ))}
          </div>
        </details>
      )}
      <GenAiRequestDetails
        systemInstructions={state.record.systemInstructions}
        inputMessages={state.record.inputMessages}
        defaultOpen={defaultOpen}
      />
    </>
  );
}

/**
 * A model call with no turn marker — subagent work, a server-tool
 * sidecar (web search), an away summary. Drawn as an indented ghost
 * row (dashed rule, `↳`) so the feed shows the call happened without
 * pretending it was a first-class turn; expand for its output and
 * full request context.
 */
function ModelCallRow({ item }: { item: Extract<ThreadItem, { variant: 'model-call' }> }) {
  const u = item.usage;
  return (
    <details
      style="margin:2px 0 2px 18px;border-left:2px dashed var(--rule-strong);padding:2px 12px"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) {
          void loadGenAiRecord(item.recordId);
        }
      }}
    >
      <summary
        class="flex items-center gap-2 flex-wrap"
        style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);cursor:pointer;padding:3px 0"
      >
        <span aria-hidden="true">↳</span>
        <span style="font-variant-numeric:tabular-nums">{formatTs(item.ts)}</span>
        <span style="color:var(--steel)">
          {describeQuerySource(item.querySource, item.agentName)}
        </span>
        <span style="color:var(--ink);font-weight:600">
          {item.model !== null ? prettyModel(item.model) : '?'}
        </span>
        {u && ((u.inputTokens ?? 0) > 0 || (u.outputTokens ?? 0) > 0) && (
          <span style="font-variant-numeric:tabular-nums">
            {u.inputTokens ?? 0}→{u.outputTokens ?? 0} tok
          </span>
        )}
      </summary>
      <div style={CONTEXT_SCROLL_BOX}>
        <LazyRecordBody recordId={item.recordId} showOutput />
      </div>
    </details>
  );
}

/** A `tool_use` block drawn as an expanded call card with its folded result. */
function CallCard({
  block,
  fold,
}: {
  block: Extract<AnthropicContentBlock, { type: 'tool_use' }>;
  fold: FoldedResult | null;
}) {
  const { server, tool } = parseToolName(block.name);
  return (
    <div style="margin-top:6px;border:1px solid var(--rule);border-radius:5px;overflow:hidden">
      <div style="display:flex;align-items:center;gap:7px;padding:4px 8px;background:color-mix(in srgb, var(--steel) 8%, transparent);font-family:var(--f-mono);font-size:11.5px">
        <span style="color:var(--steel)">◆</span>
        {server && (
          <>
            <span style="color:var(--muted)">{server}</span>
            <span style="color:var(--rule-strong)">·</span>
          </>
        )}
        <span style="color:var(--ink);font-weight:700">{tool}</span>
      </div>
      <JsonPre
        text={stringifyToolPayload(block.input)}
        style="margin:0;padding:5px 8px;white-space:pre-wrap;font-family:var(--f-mono);font-size:11px;color:var(--graphite);line-height:1.45;border-top:1px solid var(--rule)"
      />
      {fold && (
        <div style="display:flex;gap:7px;align-items:flex-start;padding:4px 8px;font-family:var(--f-mono);font-size:11px;border-top:1px solid var(--rule);color:var(--ink)">
          <span style={`color:${fold.isError ? 'var(--err)' : 'var(--steel)'};font-weight:700`}>
            {fold.isError ? '✗' : '✓'}
          </span>
          {fold.result !== undefined && fold.result !== null && (
            <JsonPre
              text={stringifyToolPayload(simplifyToolResult(fold.result))}
              style="margin:0;flex:1;min-width:0;white-space:pre-wrap;font-family:var(--f-mono);font-size:11px;color:var(--ink);line-height:1.45"
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Reasoning / text / image blocks inside a turn (tool_use is drawn separately). */
function TurnContentBlock({ block }: { block: AnthropicContentBlock }) {
  if (block.type === 'text') {
    const highlighted = highlightXmlTags(block.text);
    if (highlighted !== null) {
      return (
        <pre
          style="font-family:var(--f-mono);font-size:12px;color:var(--ink);white-space:pre-wrap;margin-top:5px"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      );
    }
    return (
      <pre style="font-family:var(--f-mono);font-size:12px;color:var(--ink);white-space:pre-wrap;margin-top:5px">
        {block.text}
      </pre>
    );
  }
  if (block.type === 'thinking') {
    // Claude persists thinking blocks as an opaque signature with NO
    // readable text (in the transcript and the OTEL export alike), so in
    // practice this text is empty — render nothing rather than a hollow
    // `thinking` label. If a readable summary ever appears we show it.
    if (!block.text || block.text.trim() === '') return null;
    // Reasoning, not the answer. Kept deliberately quiet — a small muted
    // `thinking` eyebrow over a subtle left rule, the text itself muted +
    // italic — so a reader can tell the model's private reasoning apart
    // from its spoken text (rendered in `--ink`) without it dominating.
    return (
      <div style="margin-top:5px;border-left:2px solid var(--rule);padding-left:9px">
        <div class="eyebrow" style="margin-bottom:2px;opacity:0.75">
          thinking
        </div>
        <pre style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);font-style:italic;white-space:pre-wrap;margin:0">
          {block.text}
        </pre>
      </div>
    );
  }
  if (block.type === 'tool_result') {
    return (
      <div style="font-size:12px;margin-top:5px">
        <span style={`color:var(${block.isError ? '--err' : '--steel'})`}>tool_result</span>{' '}
        <span style="color:var(--muted)">({block.toolUseId})</span>
        <JsonPre
          text={
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content, null, 2)
          }
          style="font-family:var(--f-mono);font-size:11.5px;color:var(--graphite);white-space:pre-wrap;margin-top:2px"
        />
      </div>
    );
  }
  if (block.type === 'image') {
    return (
      <div style="font-size:12px;color:var(--muted);font-style:italic;margin-top:5px">
        [image{block.mediaType ? ` ${block.mediaType}` : ''}]
      </div>
    );
  }
  if (block.type === 'unknown') {
    return (
      <div style="font-size:12px;color:var(--muted);font-style:italic;margin-top:5px">
        [unknown block: {JSON.stringify(block.raw).slice(0, 60)}…]
      </div>
    );
  }
  // A `tool_use` block is drawn as a call card by the parent, not here.
  return null;
}

/**
 * A native tool-execution event with NO matching `tool_use` in a
 * captured exchange — a codex tool, or a hook tool whose model turn
 * wasn't captured. Rendered as a standalone row (the fallback); tool
 * runs that DO match a turn's `tool_use` are folded into that call
 * card by `buildThread` and never reach here.
 */
function ToolActionMarker({ item }: { item: Extract<ThreadItem, { variant: 'tool-action' }> }) {
  const accent = item.isError ? 'var(--err)' : 'var(--steel)';
  const { server, tool } = parseToolName(item.toolName);
  const hasInput = item.input !== undefined && item.input !== null;
  const hasResult = item.result !== undefined && item.result !== null;
  return (
    <details style={`margin:2px 0;border-left:2px solid ${accent};padding:2px 12px`}>
      <summary
        class="flex items-center gap-3 flex-wrap"
        style="font-family:var(--f-mono);font-size:12px;color:var(--muted);cursor:pointer;padding:4px 0"
      >
        <span>{formatTs(item.ts)}</span>
        <span style="color:var(--steel)">tool</span>
        <span>
          {server && <span style="color:var(--muted)">{server} · </span>}
          <span style={`color:${item.isError ? 'var(--err)' : 'var(--ink)'};font-weight:600`}>
            {tool}
          </span>
        </span>
        {item.agent && <span>{item.agent}</span>}
        {item.durationMs !== null && <span>{item.durationMs}ms</span>}
        {item.isError && <span style="color:var(--err)">error</span>}
      </summary>
      <div style="margin-top:4px;padding:4px 0;display:flex;flex-direction:column;gap:4px">
        {hasInput && (
          <div>
            <div class="eyebrow" style="margin-bottom:2px">
              input
            </div>
            <JsonPre
              text={stringifyToolPayload(item.input)}
              style="font-family:var(--f-mono);font-size:11.5px;color:var(--graphite);white-space:pre-wrap"
            />
          </div>
        )}
        {hasResult && (
          <div>
            <div class="eyebrow" style="margin-bottom:2px">
              result
            </div>
            <JsonPre
              text={stringifyToolPayload(simplifyToolResult(item.result))}
              style="font-family:var(--f-mono);font-size:11.5px;color:var(--graphite);white-space:pre-wrap"
            />
          </div>
        )}
      </div>
    </details>
  );
}

/** Render a tool input/result payload for display — strings pass through, everything else is JSON. */
function stringifyToolPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * MCP tool results arrive wrapped as a content array —
 * `[{ type: 'text', text: '…' }]`. Unwrap a pure-text result to its
 * text so a call reads `✓ delivered to AndrewJon…` instead of a JSON
 * envelope. Anything else (structured results, plain strings) passes
 * through untouched for `stringifyToolPayload` / `highlightJson`.
 */
export function simplifyToolResult(value: unknown): unknown {
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (b): b is { type: 'text'; text: string } =>
        !!b &&
        typeof b === 'object' &&
        (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    )
  ) {
    return value.map((b) => b.text).join('\n');
  }
  return value;
}

/**
 * A <pre> that syntax-highlights JSON payloads (tool inputs/results,
 * block bodies) and falls back to plain preformatted text for non-JSON
 * content — command output, a diff, prose. The highlighted markup is
 * HTML-escaped inside `highlightJson`.
 */
function JsonPre({ text, style }: { text: string; style: string }) {
  const html = highlightJson(text);
  if (html !== null) {
    return <pre style={style} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <pre style={style}>{text}</pre>;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(11, 19);
}

/** Test-only reset so unit tests start clean. */
export function __resetAgentTimelineForTests(): void {
  kindFilters.value = { ...DEFAULT_FILTERS };
  showApiCalls.value = true;
  objectiveFilter.value = null;
}
