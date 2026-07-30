---
'csuite-core': patch
'csuite-server': patch
'csuite-cli': patch
'csuite-sdk': patch
---

Refuse to run tests against a build that no longer matches its source. Tests that import a workspace package by name resolve through its `exports` map into `dist/`, and nothing in module resolution checks that `dist/` was built from the `src/` on disk — so a stale build produced a green suite that proved nothing. Turbo's `dependsOn: ["^build"]` covered the root `pnpm test` and nothing else; a filtered `pnpm --filter <pkg> exec vitest run` bypassed it entirely.
