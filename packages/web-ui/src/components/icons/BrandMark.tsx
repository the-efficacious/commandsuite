/**
 * BrandMark — the CommandSuite heptagon mark.
 *
 * Custom SVG (not from Lucide) because it's our identity. The shape
 * is a heptagon with seven filled vertex circles. The glyph is sized
 * via CSS or the `size` prop and inherits color from `currentColor`
 * unless `stroke` is overridden.
 */

import type { JSX } from 'preact';

export interface BrandMarkProps extends JSX.HTMLAttributes<SVGSVGElement> {
  /** Pixel size for both width and height. Default: 24. */
  size?: number;
  /** Stroke color — defaults to `currentColor`. */
  stroke?: string;
  /** Stroke width — defaults to 6 (matches a 120-unit viewBox). */
  strokeWidth?: number;
  /** Whether the vertex dots are filled. Default: true. */
  filledVertices?: boolean;
}

export function BrandMark({
  size = 24,
  stroke = 'currentColor',
  strokeWidth = 6,
  filledVertices = true,
  class: className,
  style,
  ...rest
}: BrandMarkProps): JSX.Element {
  const fillColor = filledVertices ? stroke : 'none';
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      fill="none"
      stroke={stroke}
      stroke-width={strokeWidth}
      stroke-linejoin="round"
      role="img"
      aria-label="CommandSuite"
      class={className}
      style={style}
      {...rest}
    >
      <polygon points="60,15 95.18,31.94 103.87,70.01 79.52,100.54 40.48,100.54 16.13,70.01 24.82,31.94" />
      <g fill={fillColor} stroke="none">
        <circle cx="60" cy="15" r="10" />
        <circle cx="95.18" cy="31.94" r="10" />
        <circle cx="103.87" cy="70.01" r="10" />
        <circle cx="79.52" cy="100.54" r="10" />
        <circle cx="40.48" cy="100.54" r="10" />
        <circle cx="16.13" cy="70.01" r="10" />
        <circle cx="24.82" cy="31.94" r="10" />
      </g>
    </svg>
  );
}
