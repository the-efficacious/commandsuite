/**
 * ActivityInspector — right-rail chrome around the shared
 * `TimelineBody`. Where `<AgentTimeline />` is the per-member-profile
 * card view, this is the persistent inspector mounted alongside a
 * thread. The body (chip bar, scope picker, threaded feed) is the
 * same component; only the header differs.
 *
 *   ┌──────────────────────────────┐
 *   │ scout-analyst       ● live   │  ← feed-header (this file)
 *   ├──────────────────────────────┤
 *   │ [● LLM] [● HTTP] [○ obj…]    │  ← TimelineBody
 *   │ scope: all activity ▾        │
 *   │  ─────────────────────       │
 *   │  ▶ 14:02  2 tools · 4.6k tok │
 *   │  ▶ 14:03  ...                │
 *   └──────────────────────────────┘
 *
 * Owns the activity-stream subscription for the agent in focus —
 * `startMemberActivitySubscribe` is a single-active-subscription API,
 * so mounting this with a new `agentName` automatically tears down
 * any previous stream.
 *
 * Responsive behavior is driven by `theme.css` `.activity-inspector`
 * media queries: 380px above 1280, 320px between 1100 and 1280, and
 * a right-side overlay drawer below 1100. The `data-inspector-open`
 * attribute toggles the open/closed state of the overlay.
 */

import { useCallback, useEffect, useState } from 'preact/hooks';
import { closeInspector, isInspectorOpen } from '../lib/inspector.js';
import {
  memberActivityConnected,
  memberActivityRows,
  startMemberActivitySubscribe,
} from '../lib/member-activity.js';
import { useResizableWidth } from '../lib/use-resizable-width.js';
import { useStickyBottom } from '../lib/use-sticky-bottom.js';
import { TimelineBody, TimelineFilters, timelineFilterSummary } from './AgentTimeline.js';
import { ChevronDown, ChevronsDown, X } from './icons/index.js';

const RESIZE_STORAGE_KEY = 'csuite:activity-inspector-width';
const RESIZE_DEFAULT_PX = 380;
const RESIZE_MIN_PX = 280;
const RESIZE_MAX_PX = 720;
/** Always leave at least this much for the chat pane to its left. */
const CHAT_MIN_RESERVE_PX = 480;

const FILTERS_OPEN_STORAGE_KEY = 'csuite:activity-filters-open';

function readFiltersOpen(): boolean {
  try {
    return localStorage.getItem(FILTERS_OPEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeFiltersOpen(open: boolean): void {
  try {
    localStorage.setItem(FILTERS_OPEN_STORAGE_KEY, open ? 'true' : 'false');
  } catch {
    /* quota / privacy mode — silent */
  }
}

interface ActivityInspectorProps {
  /** Display name shown in the feed-header. */
  agentName: string;
}

export function ActivityInspector({ agentName }: ActivityInspectorProps) {
  const connected = memberActivityConnected.value;
  const open = isInspectorOpen.value;
  // Subscribe to row mutations at *this* level so the sticky-bottom
  // hook below re-runs on every arrival. Signals subscribe at the
  // component where `.value` is read; without this line the parent
  // wouldn't re-render when new rows land in `TimelineBody`, and the
  // hook's pin-scroll layout effect would miss every update.
  const _rows = memberActivityRows.value;
  void _rows;
  const { containerRef, onScroll, isPinned, jumpToBottom } = useStickyBottom();

  // Resize: only meaningful at the persistent-flow widths (≥1100px)
  // where the inspector shares the row with the chat pane. The CSS
  // hides the handle below that breakpoint; the hook still runs but
  // its width is ignored by the overlay-state media query (which sets
  // a fixed width without consuming `--activity-inspector-width`).
  const maxWidth = useCallback(
    () => Math.min(RESIZE_MAX_PX, Math.max(RESIZE_MIN_PX, window.innerWidth - CHAT_MIN_RESERVE_PX)),
    [],
  );
  const { width, isResizing, startResize, nudge, maxResolved } = useResizableWidth({
    storageKey: RESIZE_STORAGE_KEY,
    defaultWidth: RESIZE_DEFAULT_PX,
    minWidth: RESIZE_MIN_PX,
    maxWidth,
    edge: 'left',
  });

  // Filter tray: collapsed by default to keep the live tail visually
  // dominant. Persists open/closed across reloads.
  const [filtersOpen, setFiltersOpen] = useState<boolean>(() => readFiltersOpen());
  const toggleFilters = () => {
    const next = !filtersOpen;
    setFiltersOpen(next);
    writeFiltersOpen(next);
  };
  const filterSummary = timelineFilterSummary();

  // Keyboard splitter affordance: arrow keys nudge the width when the
  // handle has focus. Shift = larger step. Home/End jump to bounds.
  // Direction: left/up arrow = wider (panel grows leftward), right/down = narrower.
  const onResizeKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 32 : 8;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        nudge(step);
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        nudge(-step);
        break;
      case 'Home':
        event.preventDefault();
        nudge(maxResolved - width);
        break;
      case 'End':
        event.preventDefault();
        nudge(RESIZE_MIN_PX - width);
        break;
    }
  };

  useEffect(() => {
    return startMemberActivitySubscribe({ name: agentName });
  }, [agentName]);

  return (
    <aside
      class="activity-inspector flex flex-col flex-shrink-0"
      aria-label={`Activity for ${agentName}`}
      data-inspector-open={open ? 'true' : 'false'}
      style={`--activity-inspector-width:${width}px`}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: <hr> is a thematic
          break, not a draggable splitter — `role="separator"` with
          `aria-orientation="vertical"` and aria-value* is the WAI-ARIA
          window-splitter pattern, which can't be expressed with `<hr>`. */}
      <div
        class="activity-resize-handle"
        data-resizing={isResizing ? 'true' : 'false'}
        onPointerDown={startResize}
        onKeyDown={onResizeKeyDown}
        tabIndex={0}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize activity panel"
        aria-valuenow={width}
        aria-valuemin={RESIZE_MIN_PX}
        aria-valuemax={maxResolved}
      />
      <header style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid var(--rule);flex-shrink:0">
        <div style="min-width:0">
          <div style="font-family:var(--f-mono);font-weight:600;font-size:13px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            {agentName}
          </div>
          <div style="font-family:var(--f-sans);font-size:11px;color:var(--muted)">
            activity stream
          </div>
        </div>
        <span
          title={connected ? 'Activity stream connected' : 'Activity stream offline'}
          style={`font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:${connected ? 'var(--steel)' : 'var(--muted)'};white-space:nowrap`}
        >
          ● {connected ? 'live' : 'offline'}
        </span>
        <button
          type="button"
          onClick={closeInspector}
          class="inspector-close items-center justify-center"
          aria-label="Close activity panel"
          title="Close (Esc)"
          style="width:28px;height:28px;background:var(--ice);border:1px solid var(--rule);color:var(--graphite);border-radius:var(--r-xs);cursor:pointer;flex-shrink:0;margin-left:4px"
        >
          <X size={12} aria-hidden="true" />
        </button>
      </header>

      {/* Filter tray — collapsed by default. Tucks the kind chips +
          objective scope picker behind a single-row button so the live
          tail dominates vertical space. The summary text on the right
          flags any active filter even when collapsed so the operator
          sees the feed isn't showing everything. */}
      <div class="activity-filter-tray" data-open={filtersOpen ? 'true' : 'false'}>
        <button
          type="button"
          onClick={toggleFilters}
          class="activity-filter-tray-toggle"
          aria-expanded={filtersOpen}
          aria-controls="activity-filter-tray-body"
        >
          <ChevronDown
            size={14}
            aria-hidden="true"
            style={`transform:rotate(${filtersOpen ? 0 : -90}deg);transition:transform 0.15s var(--ease)`}
          />
          <span style="flex:1;text-align:left">Filters</span>
          {filterSummary !== null && (
            <span style="color:var(--steel);font-size:11px;font-family:var(--f-mono)">
              {filterSummary}
            </span>
          )}
        </button>
        {filtersOpen && (
          <div id="activity-filter-tray-body" class="activity-filter-tray-body">
            <TimelineFilters />
          </div>
        )}
      </div>

      <div style="flex:1;min-height:0;position:relative">
        <div
          ref={containerRef}
          onScroll={onScroll}
          data-scroll-anchor="activity"
          class="activity-inspector-scroll"
          style="position:absolute;inset:0;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px"
        >
          <TimelineBody />
        </div>
        {!isPinned && (
          <button
            type="button"
            onClick={jumpToBottom}
            aria-label="Jump to newest activity"
            title="Jump to newest"
            style="position:absolute;right:14px;bottom:14px;width:36px;height:36px;border-radius:9999px;background:var(--paper);border:1px solid var(--rule);color:var(--ink);box-shadow:0 4px 12px rgba(0,0,0,0.12);cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:2"
          >
            <ChevronsDown size={18} aria-hidden="true" />
          </button>
        )}
      </div>
    </aside>
  );
}
