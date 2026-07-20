/**
 * Vitest config for csuite-web-ui.
 *
 * Mirrors csuite-web-host's test env: happy-dom for the DOM APIs the
 * shell components touch (fetch is mocked, window events, etc.).
 * Preact is set up via @preact/preset-vite so JSX transforms in
 * tests the same way it does in the consumer app's build.
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
