/**
 * Package version, injected at build time by tsup's `define` from the
 * package's own package.json. Falls back to a dev sentinel when run
 * directly via tsx/vitest (no define in the module loader).
 */

declare const __PKG_VERSION__: string | undefined;

export const CORE_VERSION: string =
  typeof __PKG_VERSION__ === 'string' ? __PKG_VERSION__ : '0.0.0-dev';
