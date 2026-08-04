import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetThemeForTests,
  cycleThemeMode,
  effectiveTheme,
  initTheme,
  setThemeMode,
  themeMode,
} from '../src/lib/theme.js';

const root = () => document.documentElement;

describe('theme', () => {
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    __resetThemeForTests();
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    __resetThemeForTests();
    root().removeAttribute('data-ef-theme');
  });

  it('defaults to dark — helm is the brand default, not auto', () => {
    expect(themeMode.value).toBe('dark');
    expect(effectiveTheme.value).toBe('dark');
  });

  it('dark leaves data-ef-theme absent (helm is the :root default)', () => {
    dispose = initTheme();
    expect(root().hasAttribute('data-ef-theme')).toBe(false);
  });

  it('light sets data-ef-theme="helm-light"', () => {
    dispose = initTheme();
    setThemeMode('light');
    expect(root().getAttribute('data-ef-theme')).toBe('helm-light');
  });

  it('flipping back to dark removes the attribute', () => {
    dispose = initTheme();
    setThemeMode('light');
    setThemeMode('dark');
    expect(root().hasAttribute('data-ef-theme')).toBe(false);
  });

  it('persists auto explicitly — absent key means dark, not auto', () => {
    setThemeMode('auto');
    expect(localStorage.getItem('csuite:theme')).toBe('auto');
  });

  it('persisted light survives a re-read', () => {
    setThemeMode('light');
    expect(localStorage.getItem('csuite:theme')).toBe('light');
  });

  it('cycle walks light → dark → auto → light', () => {
    setThemeMode('light');
    cycleThemeMode();
    expect(themeMode.value).toBe('dark');
    cycleThemeMode();
    expect(themeMode.value).toBe('auto');
    cycleThemeMode();
    expect(themeMode.value).toBe('light');
  });
});
