/**
 * Theme — light / dark / auto preference, persisted in localStorage.
 *
 * The shell defines two palettes in `styles/theme.css`:
 *   - `:root`                       → light (default)
 *   - `:root[data-theme="dark"]`    → dusk dark
 *
 * This module owns the `data-theme` attribute on `<html>`. The viewer
 * picks one of three modes:
 *
 *   "light"   force light palette regardless of OS preference
 *   "dark"    force dark palette regardless of OS preference
 *   "auto"    follow `prefers-color-scheme` and update live as the OS
 *             setting flips
 *
 * `themeMode` is the persisted user choice; `effectiveTheme` is the
 * resolved palette currently in effect (always `'light' | 'dark'`).
 *
 * Hosts call `initTheme()` once at startup BEFORE the first paint so
 * the attribute is set on `<html>` ahead of any styled render —
 * otherwise the page flashes the default palette on load. The function
 * is idempotent and returns a disposer for tests.
 */

import { computed, signal } from '@preact/signals';

export type ThemeMode = 'light' | 'dark' | 'auto';
export type EffectiveTheme = 'light' | 'dark';

const STORAGE_KEY = 'csuite:theme';

/** The viewer's chosen mode — `auto` follows the OS. */
export const themeMode = signal<ThemeMode>(readPersisted());

/** Live OS preference signal — only meaningful when `themeMode === 'auto'`. */
const systemPrefersDark = signal<boolean>(readSystemPref());

/** The resolved palette currently in effect. */
export const effectiveTheme = computed<EffectiveTheme>(() => {
  const mode = themeMode.value;
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return systemPrefersDark.value ? 'dark' : 'light';
});

/** Set the viewer's chosen mode. Persists to localStorage. */
export function setThemeMode(mode: ThemeMode): void {
  themeMode.value = mode;
  try {
    if (mode === 'auto') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, mode);
    }
  } catch {
    // localStorage may be disabled (private mode, sandboxed iframe).
    // The signal still drives the in-memory state for this session.
  }
}

/** Cycle light → dark → auto → light. Useful for a single-tap toggle. */
export function cycleThemeMode(): void {
  const order: ThemeMode[] = ['light', 'dark', 'auto'];
  const idx = order.indexOf(themeMode.value);
  setThemeMode(order[(idx + 1) % order.length] ?? 'auto');
}

/**
 * Wire the theme system into `<html>`. Call once at app startup,
 * before the first render. Returns a disposer for tests.
 */
export function initTheme(): () => void {
  // Apply the resolved theme attribute synchronously on the very first
  // call so the document is correct before paint.
  applyAttribute(effectiveTheme.value);

  // Subscribe to changes — every time the resolved theme flips,
  // reflect it onto `<html>`.
  const disposeEffect = effectiveTheme.subscribe((t) => {
    applyAttribute(t);
  });

  // Live-track the OS preference so `auto` mode reacts without a
  // reload when the viewer flips their system theme.
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    systemPrefersDark.value = mq.matches;
  };
  mq.addEventListener('change', onChange);

  return () => {
    disposeEffect();
    mq.removeEventListener('change', onChange);
  };
}

/** Test-only: reset to defaults + clear persistence. */
export function __resetThemeForTests(): void {
  themeMode.value = 'auto';
  systemPrefersDark.value = false;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function readPersisted(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch {
    /* ignore */
  }
  return 'auto';
}

function readSystemPref(): boolean {
  try {
    return matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

function applyAttribute(t: EffectiveTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (t === 'dark') {
    root.setAttribute('data-theme', 'dark');
  } else {
    root.removeAttribute('data-theme');
  }
}
