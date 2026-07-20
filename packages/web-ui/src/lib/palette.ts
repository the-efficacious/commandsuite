/**
 * Command palette — signal-driven open/close state and fuzzy matching
 * over members, objectives, and threads.
 *
 * Opens on ⌘K / Ctrl-K. The keydown listener lives in
 * `routes/Shell.tsx` so only the authenticated shell participates.
 */

import { computed, signal } from '@preact/signals';
import type { Objective, Teammate } from 'csuite-sdk/types';
import { briefing } from './briefing.js';
import { joinedChannels } from './channels.js';
import { objectives as objectivesSignal } from './objectives.js';
import { roster } from './roster.js';

export type PaletteItem =
  | { kind: 'member'; id: string; name: string; label: string; sub: string }
  | { kind: 'objective'; id: string; objective: Objective; label: string; sub: string }
  | { kind: 'thread-channel'; id: string; slug: string; label: string; sub: string }
  | { kind: 'thread-dm'; id: string; name: string; label: string; sub: string }
  | {
      kind: 'action';
      id: string;
      label: string;
      sub: string;
      run: () => void;
    };

export const paletteOpen = signal(false);
export const paletteQuery = signal('');

export function openPalette(): void {
  paletteOpen.value = true;
  paletteQuery.value = '';
}

export function closePalette(): void {
  paletteOpen.value = false;
}

export function togglePalette(): void {
  if (paletteOpen.value) closePalette();
  else openPalette();
}

/**
 * The canonical item list — everything the palette could jump to.
 * Actions with side-effects (create objective, etc.) live in the
 * component and get merged in at render time.
 */
export const paletteSource = computed<PaletteItem[]>(() => {
  const items: PaletteItem[] = [];
  const b = briefing.value;
  const r = roster.value;
  const teammates: Teammate[] = r?.teammates ?? b?.teammates ?? [];

  for (const c of joinedChannels()) {
    items.push({
      kind: 'thread-channel',
      id: `thread:chan:${c.slug}`,
      slug: c.slug,
      label: `#${c.slug}`,
      sub:
        c.id === 'general' ? 'team channel · everyone' : `team channel · ${c.memberCount} members`,
    });
  }
  for (const t of teammates) {
    items.push({
      kind: 'member',
      id: `member:${t.name}`,
      name: t.name,
      label: `@${t.name}`,
      sub: `${t.role.title} · profile`,
    });
    items.push({
      kind: 'thread-dm',
      id: `dm:${t.name}`,
      name: t.name,
      label: `DM @${t.name}`,
      sub: 'direct message',
    });
  }
  for (const o of objectivesSignal.value) {
    items.push({
      kind: 'objective',
      id: `obj:${o.id}`,
      objective: o,
      label: o.title,
      sub: `${o.status} · assigned to ${o.assignee}`,
    });
  }
  return items;
});

/**
 * Naive fuzzy match: lowercase subsequence match on label+sub, scored
 * by how early each query character lands. Returns match score (higher
 * = better) or null if the query doesn't match.
 *
 * Good enough for a small in-memory catalog; replace with a proper
 * matcher if scale demands it.
 */
export function scoreMatch(query: string, haystack: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const h = haystack.toLowerCase();
  let score = 0;
  let hi = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === undefined) return null;
    const idx = h.indexOf(ch, hi);
    if (idx === -1) return null;
    // Earlier matches score higher. First char of word = bonus.
    const bonus = idx === 0 || h[idx - 1] === ' ' || h[idx - 1] === '@' ? 10 : 0;
    score += 100 - (idx - hi) + bonus;
    hi = idx + 1;
  }
  return score;
}

export interface RankedItem {
  item: PaletteItem;
  score: number;
}

export function rankItems(query: string, items: PaletteItem[]): RankedItem[] {
  if (query.length === 0) {
    return items.slice(0, 20).map((item) => ({ item, score: 0 }));
  }
  const ranked: RankedItem[] = [];
  for (const item of items) {
    const s = scoreMatch(query, `${item.label} ${item.sub}`);
    if (s !== null) ranked.push({ item, score: s });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, 20);
}

export function __resetPaletteForTests(): void {
  paletteOpen.value = false;
  paletteQuery.value = '';
}
