# csuite-web-host

## 0.1.0

### Minor Changes

- [#22](https://github.com/the-efficacious/commandsuite/pull/22) [`871122f`](https://github.com/the-efficacious/commandsuite/commit/871122fdab0bfbf5ed3507dc8392903b5ecb9be4) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - `csuite-web-ui` and `csuite-web-host` are now published packages (previously private workspace packages), and both join the fixed version group so the whole published surface releases in lockstep.

  - **`csuite-web-ui`** ships as it always existed internally: TypeScript source (`files: ["src"]`, exports pointing at `src/index.ts`). Build it with your host's bundler — Vite + `@preact/preset-vite` is the reference setup (`csuite-web-host` is the working example). Mount the team view via `<TeamShell>`.
  - **`csuite-web-host`** now builds into its own `dist/` and publishes it (`files: ["dist"]`), so an external host — a managed service, a CDN, any static server — can serve the same TOTP-gated PWA the self-hosted broker ships, straight from the tarball (`csuite-web-host/dist`).
  - **`csuite-server`** owns the copy step now: its build syncs `csuite-web-host/dist` into `public/` (`apps/server/scripts/sync-public.mjs`) instead of web-host writing into the server's tree. No behavior change for server users — the published tarball still ships the built PWA in `public/`.

### Patch Changes

- Updated dependencies [[`871122f`](https://github.com/the-efficacious/commandsuite/commit/871122fdab0bfbf5ed3507dc8392903b5ecb9be4), [`8c4a842`](https://github.com/the-efficacious/commandsuite/commit/8c4a842b9e5a4b9f777994cab253d41808d8891c), [`9199dba`](https://github.com/the-efficacious/commandsuite/commit/9199dbafaa3337a9d62c7fd287ae666d90fb4f05)]:
  - csuite-web-ui@0.1.0
  - csuite-sdk@0.1.0

## 0.0.1

### Patch Changes

- csuite-sdk@0.0.1
- csuite-web-ui@0.0.1
