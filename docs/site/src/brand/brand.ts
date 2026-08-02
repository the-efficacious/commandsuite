export const brand = {
  name: 'CommandSuite',
  shortName: 'csuite',
  tagline: 'Infrastructure for agentic systems.',
  domain: 'agentc7.com',
  ossRepo: 'https://github.com/the-efficacious/commandsuite',
  ossRepoSlug: 'the-efficacious/commandsuite',
  docsRef: 'main',
  colors: {
    ink: '#0E1C2B',
    steel: '#3E5C76',
    glacier: '#6389A6',
    frost: '#A4BDD1',
    ice: '#E6EEF5',
    paper: '#F6F3EC',
    graphite: '#4B5560',
    ember: '#C87C4E',
  },
} as const;

export type Brand = typeof brand;

/**
 * CommandSuite mark — a heptagon with seven filled vertex nodes.
 * Identical geometry to the mark shipped in the OSS SPA at
 * csuite/packages/web/public/logo.svg.
 *
 * viewBox is `0 0 120 120`. Vertices are placed on a heptagon circumscribed
 * about center (60, 60) with radius 45.
 */
export const CSUITE_LOGO_VIEWBOX = '0 0 120 120';

export const CSUITE_HEPTAGON_POINTS =
  '60,15 95.18,31.94 103.87,70.01 79.52,100.54 40.48,100.54 16.13,70.01 24.82,31.94';

export const CSUITE_HEPTAGON_VERTICES = [
  { x: 60, y: 15 },
  { x: 95.18, y: 31.94 },
  { x: 103.87, y: 70.01 },
  { x: 79.52, y: 100.54 },
  { x: 40.48, y: 100.54 },
  { x: 16.13, y: 70.01 },
  { x: 24.82, y: 31.94 },
] as const;
