/**
 * Site identity — resolved from `@the-efficacious/brand` so the docs
 * carry the same name, tagline, and mark geometry as every other
 * surface. Only the site-specific link targets are authored here.
 */
import { brands } from '@the-efficacious/brand';

export const brand = {
  ...brands.commandsuite,
  homeUrl: 'https://commandsuite.io',
  ossRepo: 'https://github.com/the-efficacious/commandsuite',
  ossRepoSlug: 'the-efficacious/commandsuite',
  docsRef: 'main',
} as const;

export type Brand = typeof brand;

/**
 * The pack draws the Echelon inside a 100×100 box but only inks
 * x 10–90 · y 21.5–78.5 — a 1.4:1 mark with phantom margins that
 * renders small in square slots. Crop to the ink plus a 2-unit optical
 * pad and keep the true aspect, mirroring the product's BrandMark.
 */
export const MARK_VIEWBOX = '8 19.5 84 61';
export const MARK_ASPECT = 61 / 84;

/**
 * Gold-primitive fill names → the `--mark-*` indirection defined in
 * docs.css. Helm renders the tri-gold drawing; helm-light re-resolves
 * the outer pair to neutrals — the light surface spends less gold.
 * Fallbacks keep the mark drawable if the stylesheet is absent.
 */
const MARK_FILLS = {
  bright: 'var(--mark-core, var(--ef-gold-bright))',
  base: 'var(--mark-mid, var(--ef-gold-base))',
  deep: 'var(--mark-outer, var(--ef-gold-deep))',
} as const;

export function markFill(name: string): string {
  return MARK_FILLS[name as keyof typeof MARK_FILLS] ?? 'currentColor';
}
