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
    environment: 'happy-dom',
    globals: false,
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
