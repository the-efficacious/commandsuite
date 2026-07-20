/**
 * UnoCSS config — atomic utilities (Tailwind-compat names) layered on
 * top of the canonical theme.css component classes. Use case split:
 *
 *   - **theme.css classes** (.btn, .btn-primary, .card, .panel, .badge,
 *     .tabs, .callout, etc.) for everything the brand system already
 *     defines. These are imported via brand.css.
 *
 *   - **UnoCSS atomics** (`flex`, `gap-3`, `px-4`, `sm:flex-row`, etc.)
 *     for layout, spacing, responsive helpers, and one-off color
 *     overrides where a full component class would be overkill.
 *
 *   - **`brand-*` color tokens** below mirror the canonical palette so
 *     `bg-brand-paper`, `text-brand-ink`, `border-brand-rule` etc. work
 *     alongside `var(--paper)` etc. in inline styles.
 *
 * Namespace note: `brand-*` (no digits) sidesteps presetWind4's
 * letter→digit splitter that would otherwise mangle `bg-csuite-*` into
 * the path `["a", "c7", *]`.
 */

import { defineConfig, presetWind4 } from 'unocss';

export default defineConfig({
  presets: [presetWind4()],

  rules: [
    // Font-family utilities. Defined as rules rather than via
    // `theme.fontFamily` because presetWind4's Theme type doesn't
    // expose a fontFamily slot.
    [
      'font-display',
      {
        'font-family': "'Manrope', 'Helvetica Neue', Arial, sans-serif",
      },
    ],
    [
      'font-body',
      {
        'font-family': "'Atkinson Hyperlegible', system-ui, -apple-system, 'Segoe UI', sans-serif",
      },
    ],
    [
      'font-mono',
      {
        'font-family':
          "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
      },
    ],
  ],

  // Safelist the sender color tokens. Referenced via a ternary inside
  // `src/lib/theme.ts` — extractor sometimes misses these after tsc
  // narrowing, so pinning them guarantees both ship.
  safelist: [
    'text-brand-steel',
    'text-brand-ember',
    'text-brand-ink',
    'text-brand-graphite',
    'text-brand-glacier',
    'text-brand-ok',
    'text-brand-warn',
    'text-brand-err',
    'font-display',
    'font-body',
    'font-mono',
  ],
  // Mockup-aligned breakpoints (override Wind4 defaults so the
  // existing `sm:`/`md:`/`lg:` markers across components match the
  // brand mockup's five-step compression: 700 / 900 / 1100 / 1280).
  // preset-wind4 reads from `theme.breakpoint` (singular).
  theme: {
    breakpoint: {
      sm: '700px',
      md: '900px',
      lg: '1100px',
      xl: '1280px',
    },
    colors: {
      brand: {
        // ─── Canonical palette anchors (match theme.css :root) ─────
        ink: '#0E1C2B',
        steel: '#3E5C76',
        glacier: '#6389A6',
        frost: '#A4BDD1',
        ice: '#E6EEF5',
        paper: '#F6F3EC',
        graphite: '#4B5560',
        ember: '#C87C4E',

        // ─── Functional aliases ──────────────────────────────────
        bg: '#F6F3EC', // paper — body default
        fg: '#0E1C2B', // ink   — body text
        muted: '#4B5560', // graphite
        rule: 'rgba(14, 28, 43, 0.14)',
        'rule-strong': 'rgba(14, 28, 43, 0.42)',
        ring: 'rgba(62, 92, 118, 0.32)',

        // ─── Semantic ────────────────────────────────────────────
        ok: '#3E5C76', // steel
        warn: '#C87C4E', // ember
        err: '#B04A34',
        info: '#6389A6', // glacier
      },
    },
  },
});
