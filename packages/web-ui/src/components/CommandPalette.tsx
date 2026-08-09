/**
 * CommandPalette — ⌘K fuzzy launcher, drawn as the Helm JUMP.
 *
 *   ┌─────────────────────────────────────┐
 *   │ ⌕ jump to…                    [esc] │
 *   ├─────────────────────────────────────┤
 *   │ MEMBERS                             │
 *   │ @alice                 profile      │
 *   │ OBJECTIVES                          │
 *   │ Ship the feature    active · alice  │
 *   │ ACTIONS                             │
 *   │ + New objective        create       │
 *   ├─────────────────────────────────────┤
 *   │ ↑↓ MOVE · ↵ OPEN · ESC CLOSE        │
 *   └─────────────────────────────────────┘
 *
 * Results group by item kind (mono headers); within a group the
 * ranker's order is preserved, and groups appear in the order of
 * their best-ranked item. Keyboard:
 *   - ⌘K / Ctrl-K       toggle
 *   - Esc               close
 *   - ↑ / ↓             move selection
 *   - Enter             activate
 *
 * Mounted at the Shell level so the listener is only active while
 * the user is inside the authenticated app.
 */

import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  closePalette,
  type PaletteItem,
  paletteOpen,
  paletteQuery,
  paletteSource,
  type RankedItem,
  rankItems,
} from '../lib/palette.js';
import {
  selectChannel,
  selectDmWith,
  selectMemberProfile,
  selectObjectiveCreate,
  selectObjectiveDetail,
  selectSpineBoard,
  selectSpineQueue,
} from '../lib/view.js';
import { AtSign, Hash, MessageCircle, Plus, Search, Target } from './icons/index.js';

const KIND_GROUP_LABELS: Record<PaletteItem['kind'], string> = {
  member: 'MEMBERS',
  'thread-channel': 'CHANNELS',
  'thread-dm': 'DIRECT MESSAGES',
  objective: 'OBJECTIVES',
  action: 'ACTIONS',
};

interface JumpGroup {
  kind: PaletteItem['kind'];
  label: string;
  /** Rank-ordered items with their index into the flattened display list. */
  items: Array<{ ranked: RankedItem; index: number }>;
}

/**
 * Regroup the flat ranked list by kind for display. Group order is
 * the order of each kind's best-ranked item; within a group the rank
 * order is untouched. Each item carries its flattened display index
 * so keyboard navigation walks exactly what's on screen.
 */
function groupRanked(ranked: RankedItem[]): JumpGroup[] {
  const groups: JumpGroup[] = [];
  const byKind = new Map<PaletteItem['kind'], JumpGroup>();
  for (const r of ranked) {
    let group = byKind.get(r.item.kind);
    if (!group) {
      group = { kind: r.item.kind, label: KIND_GROUP_LABELS[r.item.kind], items: [] };
      byKind.set(r.item.kind, group);
      groups.push(group);
    }
    group.items.push({ ranked: r, index: 0 });
  }
  let index = 0;
  for (const group of groups) {
    for (const entry of group.items) {
      entry.index = index;
      index += 1;
    }
  }
  return groups;
}

export function CommandPalette() {
  const open = paletteOpen.value;
  const query = paletteQuery.value;
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Actions come from the host context (create objective, etc.) so
  // they can be permission-gated and always up-to-date with the
  // router. Kept local to the component instead of in the palette
  // source because they have side effects that need the viewer.
  const actions: PaletteItem[] = [
    {
      kind: 'action',
      id: 'action:new-objective',
      label: '+ New objective',
      sub: 'create',
      run: () => selectObjectiveCreate(),
    },
    {
      kind: 'action',
      id: 'action:spine-queue',
      label: 'Open queue',
      sub: 'the human seat',
      run: () => selectSpineQueue(),
    },
    {
      kind: 'action',
      id: 'action:spine-board',
      label: 'Open board',
      sub: 'the plate',
      run: () => selectSpineBoard(),
    },
  ];
  const ranked = rankItems(query, [...paletteSource.value, ...actions]);
  const groups = groupRanked(ranked);
  const flat = groups.flatMap((g) => g.items.map((entry) => entry.ranked));

  useEffect(() => {
    if (open) {
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    setCursor(0);
  }, []);

  if (!open) return null;

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, flat.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = flat[cursor];
      if (pick) activate(pick.item);
      return;
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop; the nested <input> owns focus + keyboard
    // biome-ignore lint/a11y/useKeyWithClickEvents: escape via document listener + input onKeyDown
    <div
      class="fixed inset-0 z-50 flex items-start justify-center"
      style="background:var(--ef-shade);padding-top:12vh"
      onClick={(e) => {
        if (e.target === e.currentTarget) closePalette();
      }}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        class="jump w-full max-w-xl"
        style="margin:0 16px"
      >
        <div class="jump-field">
          <span
            aria-hidden="true"
            class="flex items-center justify-center flex-shrink-0"
            style="color:var(--ef-text-muted)"
          >
            <Search size={16} />
          </span>
          <input
            ref={inputRef}
            type="text"
            class="jump-input"
            placeholder="Jump to member, objective, thread…"
            value={query}
            onInput={(e) => {
              paletteQuery.value = (e.currentTarget as HTMLInputElement).value;
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            aria-label="Command palette search"
          />
          <span class="kbd">esc</span>
        </div>
        <div role="listbox" aria-label="Results" style="max-height:50vh;overflow-y:auto">
          {flat.length === 0 && (
            <div style="padding:18px;text-align:center;color:var(--ef-text-muted);font-family:var(--ef-font-body);font-size:var(--ef-text-small)">
              No matches.
            </div>
          )}
          {groups.map((group) => (
            <div key={group.kind}>
              <div class="jump-group">{group.label}</div>
              {group.items.map(({ ranked: r, index }) => (
                <button
                  key={r.item.id}
                  type="button"
                  role="option"
                  class="jump-item"
                  aria-selected={index === cursor}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => activate(r.item)}
                >
                  <span class="flex items-center gap-2 min-w-0">
                    <span
                      aria-hidden="true"
                      class="flex items-center justify-center flex-shrink-0"
                      style="color:var(--ef-text-muted)"
                    >
                      {kindIcon(r.item.kind)}
                    </span>
                    <span class="truncate">{r.item.label}</span>
                  </span>
                  <span class="jump-meta flex-shrink-0 truncate" style="max-width:50%">
                    {r.item.sub}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div class="jump-foot">
          <span>↑↓ MOVE · ↵ OPEN · ESC CLOSE</span>
        </div>
      </div>
    </div>
  );
}

function activate(item: PaletteItem): void {
  closePalette();
  switch (item.kind) {
    case 'member':
      selectMemberProfile(item.name);
      return;
    case 'thread-channel':
      selectChannel(item.slug);
      return;
    case 'thread-dm':
      selectDmWith(item.name);
      return;
    case 'objective':
      selectObjectiveDetail(item.objective.id);
      return;
    case 'action':
      item.run();
      return;
  }
}

function kindIcon(kind: PaletteItem['kind']): ComponentChildren {
  switch (kind) {
    case 'member':
      return <AtSign size={13} />;
    case 'thread-channel':
      return <Hash size={13} />;
    case 'thread-dm':
      return <MessageCircle size={13} />;
    case 'objective':
      return <Target size={13} />;
    case 'action':
      return <Plus size={13} />;
  }
}
