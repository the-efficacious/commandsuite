/**
 * UnoCSS config — atomic utilities (Tailwind-compat names) layered on
 * top of the theme.css component classes. Use case split:
 *
 *   - **theme.css classes** (.btn, .btn-primary, .card, .panel, .badge,
 *     .tabs, .callout, etc.) for everything the component vocabulary
 *     already defines. Imported via csuite-web-ui/styles.css.
 *
 *   - **UnoCSS atomics** (`flex`, `gap-3`, `px-4`, `sm:flex-row`, etc.)
 *     for layout, spacing, responsive helpers, and one-off color
 *     overrides where a full component class would be overkill.
 *
 * The `efficacious()` preset composes AFTER presetWind4 and owns every
 * design decision the build used to carry: the shared breakpoints
 * (700/900/1100/1280 — the same numbers theme.css hardcodes), `ef-*`
 * color utilities generated from the theme (values are `var(--ef-*)`
 * refs, so utilities track `data-ef-theme` swaps), the brand font
 * rules, and the lamp-utility safelist.
 */

import { efficacious } from '@the-efficacious/brand/uno';
import { defineConfig, type Preset, presetWind4 } from 'unocss';

export default defineConfig({
  presets: [
    presetWind4(),
    // Cast: the brand package is deliberately unocss-free, so its
    // preset is typed structurally and its rule tuples infer as plain
    // arrays. Shape verified against Preset by the build.
    efficacious({
      // Identity utilities are chosen at runtime by senderTextClass —
      // the extractor never sees them assembled in source.
      safelist: ['text-ef-identity-person', 'text-ef-identity-agent'],
    }) as Preset,
  ],
});
