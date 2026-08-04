/**
 * BrandMark — the CommandSuite symbol: three diamond pairs converging
 * on a bright center. Geometry is the canonical artwork from
 * `@the-efficacious/brand` (logo-pack `commandsuite-symbol`); fills
 * resolve through the gold primitives so the mark renders identically
 * on every surface that loads the tokens.
 *
 * Two tones:
 *   - `brand` (default) — the canonical tri-gold mark. Identity is a
 *     deliberate carve-out from the gold budget, like agent tiles.
 *   - `mono` — single-color rendering for quiet contexts (boot
 *     screens, embedded chrome). Uses `stroke` if given, else
 *     `currentColor`. The legacy `stroke` prop implies mono, so
 *     existing call sites keep their subdued rendering.
 */

import type { JSX } from 'preact';

export interface BrandMarkProps extends JSX.HTMLAttributes<SVGSVGElement> {
  /** Pixel size for both width and height. Default: 24. */
  size?: number;
  /** `brand` = canonical tri-gold; `mono` = single color. */
  tone?: 'brand' | 'mono';
  /** Mono color override — providing it implies `tone="mono"`. */
  stroke?: string;
}

/**
 * The pack file draws the diamonds inside a 100×100 viewBox but only
 * inks x 10–90 · y 21.5–78.5 — a 1.4:1 mark with phantom margins that
 * made it render small in square slots. The viewBox here is cropped
 * to the ink (plus a 2-unit optical pad) and the element keeps the
 * TRUE aspect: `size` is the width; height follows at 61/84 of it, so
 * flex/grid centering works from real ink bounds, not baked-in air.
 */
const VIEWBOX = '8 19.5 84 61';
const ASPECT = 61 / 84;

export function BrandMark({
  size = 24,
  tone,
  stroke,
  class: className,
  style,
  ...rest
}: BrandMarkProps): JSX.Element {
  const mono = tone === 'mono' || (tone === undefined && stroke !== undefined);
  // Brand fills route through the --mark-* indirection (theme.css):
  // helm renders the tri-gold drawing, helm-light the neutral-outer
  // drawing from the pack. Fallbacks keep the mark drawable if a host
  // loads the component without the shell stylesheet.
  const outer = mono ? (stroke ?? 'currentColor') : 'var(--mark-outer, var(--ef-gold-deep))';
  const mid = mono ? (stroke ?? 'currentColor') : 'var(--mark-mid, var(--ef-gold-base))';
  const center = mono ? (stroke ?? 'currentColor') : 'var(--mark-core, var(--ef-gold-bright))';
  return (
    <svg
      viewBox={VIEWBOX}
      width={size}
      height={Math.round(size * ASPECT)}
      fill="none"
      role="img"
      aria-label="CommandSuite"
      class={className}
      style={style}
      {...rest}
    >
      <path d="M16.22 21.5 L22.44 29.16 L16.22 36.83 L10 29.16 Z" fill={outer} />
      <path d="M83.78 21.5 L90 29.16 L83.78 36.83 L77.56 29.16 Z" fill={outer} />
      <path d="M30.61 29.93 L40.6 42.25 L30.61 54.57 L20.61 42.25 Z" fill={mid} />
      <path d="M69.39 29.93 L79.39 42.25 L69.39 54.57 L59.4 42.25 Z" fill={mid} />
      <path d="M50 41.7 L64.91 60.1 L50 78.5 L35.09 60.1 Z" fill={center} />
    </svg>
  );
}
