/**
 * CommandPalette — ⌘K fuzzy launcher.
 *
 *   ┌─────────────────────────────────────┐
 *   │ ⌕ jump to…                          │
 *   ├─────────────────────────────────────┤
 *   │ @alice                 profile       │
 *   │ DM @alice              direct message│
 *   │ Ship the feature       active · alice│
 *   │ + New objective        create        │
 *   └─────────────────────────────────────┘
 *
 * Keyboard:
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
  rankItems,
} from '../lib/palette.js';
import {
  selectChannel,
  selectDmWith,
  selectMemberProfile,
  selectObjectiveCreate,
  selectObjectiveDetail,
} from '../lib/view.js';
import { AtSign, Hash, MessageCircle, Plus, Search, Target } from './icons/index.js';

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
  ];
  const ranked = rankItems(query, [...paletteSource.value, ...actions]);

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
      setCursor((c) => Math.min(c + 1, ranked.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = ranked[cursor];
      if (pick) activate(pick.item);
      return;
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop; the nested <input> owns focus + keyboard
    // biome-ignore lint/a11y/useKeyWithClickEvents: escape via document listener + input onKeyDown
    <div
      class="fixed inset-0 z-50 flex items-start justify-center"
      style="background:rgba(14,28,43,0.45);padding-top:12vh"
      onClick={(e) => {
        if (e.target === e.currentTarget) closePalette();
      }}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        class="w-full max-w-xl"
        style="background:var(--paper);border:1px solid var(--rule);border-radius:10px;box-shadow:0 20px 50px rgba(14,28,43,0.25);overflow:hidden;margin:0 16px"
      >
        <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--rule)">
          <span
            aria-hidden="true"
            class="flex items-center justify-center flex-shrink-0"
            style="color:var(--muted)"
          >
            <Search size={16} />
          </span>
          <input
            ref={inputRef}
            type="text"
            placeholder="Jump to member, objective, thread…"
            value={query}
            onInput={(e) => {
              paletteQuery.value = (e.currentTarget as HTMLInputElement).value;
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            aria-label="Command palette search"
            style="flex:1;border:none;outline:none;background:transparent;font-family:var(--f-sans);font-size:15px;color:var(--ink);padding:4px 0"
          />
          <span style="font-family:var(--f-mono);font-size:10px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase">
            esc
          </span>
        </div>
        <ul style="list-style:none;padding:6px;margin:0;max-height:50vh;overflow-y:auto">
          {ranked.length === 0 && (
            <li style="padding:18px;text-align:center;color:var(--muted);font-family:var(--f-sans);font-size:13px">
              No matches.
            </li>
          )}
          {ranked.map((r, idx) => (
            <li
              key={r.item.id}
              style={`border-radius:6px;background:${idx === cursor ? 'var(--bg-alt, var(--ice))' : 'transparent'}`}
            >
              <button
                type="button"
                aria-current={idx === cursor ? 'true' : undefined}
                onMouseEnter={() => setCursor(idx)}
                onClick={() => activate(r.item)}
                class="w-full flex items-center justify-between gap-3"
                style="padding:8px 10px;background:transparent;border:none;text-align:left;cursor:pointer"
              >
                <span class="flex items-center gap-2 min-w-0">
                  <span
                    aria-hidden="true"
                    class="flex items-center justify-center flex-shrink-0"
                    style="color:var(--muted);width:18px;height:18px"
                  >
                    {kindIcon(r.item.kind)}
                  </span>
                  <span
                    class="truncate"
                    style="font-family:var(--f-sans);font-size:14px;color:var(--ink);font-weight:500"
                  >
                    {r.item.label}
                  </span>
                </span>
                <span
                  class="flex-shrink-0 truncate"
                  style="font-family:var(--f-mono);font-size:11px;color:var(--muted);letter-spacing:.04em;max-width:50%"
                >
                  {r.item.sub}
                </span>
              </button>
            </li>
          ))}
        </ul>
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
