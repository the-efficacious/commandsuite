import { defineConfig } from 'vitest/config';

/**
 * Root project — covers `scripts/`, which is repo infrastructure and
 * belongs to no package.
 *
 * Before this existed, a bare `npx vitest` at the repo root discovered
 * no tests and exited zero. That is a null result that reads as a pass,
 * which is precisely the failure mode `scripts/assert-fresh-dist.mjs`
 * exists to prevent, so it should not have been the root's behaviour.
 *
 * The freshness guard is referenced here as well as from the six package
 * configs, so the property is "every vitest config in the workspace"
 * with no exceptions to remember.
 *
 * Be precise about what that buys here, though: the guard checks the
 * *transitive workspace dependencies of the project being run*, and the
 * repo root declares none. So this reference is a no-op today. It is
 * kept so the rule has no exceptions to remember, and so that a future
 * root-level test which does import a workspace package is covered
 * without anyone having to notice that it needs to be.
 */
export default defineConfig({
  test: {
    globalSetup: ['./scripts/assert-fresh-dist.mjs'],
    environment: 'node',
    include: ['scripts/test/**/*.test.mjs'],
    passWithNoTests: false,
  },
});
