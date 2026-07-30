/**
 * Vitest config lives in its own file so `vite.config.ts` stays a
 * pure `UserConfigExport` that `tsc --noEmit` accepts without the
 * vitest triple-slash reference. The two configs share the plugin
 * set via Vite's merge machinery.
 */

import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [preact()],
  test: {
    // Refuses if any workspace dist/ no longer matches its src/.
    // Lives here, not in a launcher, so no way of starting vitest skips it.
    globalSetup: ['../../scripts/assert-fresh-dist.mjs'],
    environment: 'happy-dom',
    globals: false,
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
