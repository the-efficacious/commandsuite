import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Refuses if any workspace dist/ no longer matches its src/.
    // Lives here, not in a launcher, so no way of starting vitest skips it.
    globalSetup: ['../../scripts/assert-fresh-dist.mjs'],
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 15_000,
    hookTimeout: 20_000,
  },
});
