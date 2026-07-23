# CommandSuite changelog

All notable changes to the suite, aggregated across its packages.
CommandSuite versions in lockstep — one version per release train —
so each section below is one release. Per-package `CHANGELOG.md`
files still ship inside every npm tarball.

## 0.1.0 (2026-07-23)

### csuite-cli

#### Minor Changes

- [#19](https://github.com/the-efficacious/commandsuite/pull/19) [`385ffef`](https://github.com/the-efficacious/commandsuite/commit/385ffef84df773e09c8c6a736bfceccb1fa3fbf2) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Fresh bootstraps now seed into a dedicated `./csuite/` server directory instead of scattering files across the cwd.

  `csuite setup` and the `csuite serve` first-run wizard create `./csuite/` (mode `0o700` — the containing-directory permission the KEK docs always recommended) and place `csuite.json`, `csuite.db`, and `csuite-kek.bin` inside it. Resolution never nests and stays backward compatible: an explicit `--config-path`/`$CSUITE_CONFIG_PATH` wins, a flat `./csuite.json` in the cwd marks it as the server directory (existing deployments and running from inside `./csuite/` both keep working unchanged), and `csuite serve` from the parent auto-discovers `./csuite/csuite.json`.

  Also fixed: a boot that bails before the wizard can run (non-TTY stdin, already-populated team) no longer leaves a freshly-minted `csuite-kek.bin` — or anything else — behind in the directory.

- [#21](https://github.com/the-efficacious/commandsuite/pull/21) [`8c4a842`](https://github.com/the-efficacious/commandsuite/commit/8c4a842b9e5a4b9f777994cab253d41808d8891c) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Formal runner standard: the `AgentAdapter` contract, a shared session driver, run summaries, and a conformance suite for new agent runners.

  The two runners (`csuite claude`, `csuite codex`) are now thin wrappers over one shared lifecycle. A new `AgentAdapter` interface (`runtime/agents/adapter.ts`) captures everything framework-specific — binary location, config prepare/restore, spawn, notification sink, second-bridge policy — and the new `runAgentSession` driver (`runtime/agent-session.ts`) owns everything else: auth, runner startup, signal handling per declared mode (`forward` for terminal-owning TUIs, `teardown` for headless agents), and idempotent teardown on every exit path with a fixed ordering (agent capture flush → operator-file restore → uploader drain). Adding a third runner no longer re-implements exit-path correctness.

  Every session now ends with a machine-readable account of itself, identical across runners:

  - New `session_start` / `session_end` activity kinds bracket each run in the member's activity stream (mirroring `objective_open`/`objective_close`), with `session_end` carrying exit code, reason, duration, agent-native session id, and capture accounting (`enqueued`/`uploaded`/`dropped` — so an incomplete trace says so instead of being silently short on the broker).
  - A structured `run summary` log line and a human-readable closing line report the same facts locally.

  `csuite codex` gains `--doctor` / `--skip-doctor`, and the doctor is now adapter-generic (`runAgentDoctor`): shared checks (binary, $TMPDIR, loopback bind) plus an advisory agent-version probe against the adapter's declared tested range (WARN outside, never FAIL). Both runners also run the silent preflight before spawn.

  New runners are validated by a shared conformance suite (`packages/cli/test/runtime/conformance/`) that runs five lifecycle scenarios against a fake broker + fake agent binary; both shipped runners pass it. The written standard — adapter contract, capture capability tiers (0 operable … 3 full fidelity), run summary spec, fixture rule — lives at `docs/runners/conformance.mdx`.

  The Claude Code runner verb is renamed: **`csuite claude`** (was `csuite claude-code`; the old verb is kept as a silent alias so existing scripts keep working). The runner id in banners, session logs, and `session_start`/`session_end` events is now `claude`.

  Breaking-ish notes (pre-1.0): the runner startup banner is now uniform (`csuite <runner>: …` prefix, plus an agent/team line for the claude runner), and brokers older than this release will reject activity batches containing the new session events — upgrade the server and CLI together.

- [#19](https://github.com/the-efficacious/commandsuite/pull/19) [`9199dba`](https://github.com/the-efficacious/commandsuite/commit/9199dbafaa3337a9d62c7fd287ae666d90fb4f05) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Retire the team `directive` field and slim the first-run wizard to identity + auth.

  The wizard now collects only the team name, your name, a bearer token, and TOTP enrollment — no more forced directive/context/role prose before you've even seen the product. Standing context lives in exactly three editable places: `team.context` (team-level, now up to 8192 chars, editable from TeamHome in the web UI, `csuite team set`, or the `team_update` MCP tool), role title + description (public per-member), and member `instructions` (private per-member).

  Existing databases migrate automatically on boot: a non-empty legacy `directive` is folded into the head of `context` and the column is dropped. `PATCH /team`, `csuite team set`, and `team_update` no longer accept `directive`.

### csuite-server

#### Minor Changes

- [#19](https://github.com/the-efficacious/commandsuite/pull/19) [`385ffef`](https://github.com/the-efficacious/commandsuite/commit/385ffef84df773e09c8c6a736bfceccb1fa3fbf2) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Fresh bootstraps now seed into a dedicated `./csuite/` server directory instead of scattering files across the cwd.

  `csuite setup` and the `csuite serve` first-run wizard create `./csuite/` (mode `0o700` — the containing-directory permission the KEK docs always recommended) and place `csuite.json`, `csuite.db`, and `csuite-kek.bin` inside it. Resolution never nests and stays backward compatible: an explicit `--config-path`/`$CSUITE_CONFIG_PATH` wins, a flat `./csuite.json` in the cwd marks it as the server directory (existing deployments and running from inside `./csuite/` both keep working unchanged), and `csuite serve` from the parent auto-discovers `./csuite/csuite.json`.

  Also fixed: a boot that bails before the wizard can run (non-TTY stdin, already-populated team) no longer leaves a freshly-minted `csuite-kek.bin` — or anything else — behind in the directory.

- [#19](https://github.com/the-efficacious/commandsuite/pull/19) [`9199dba`](https://github.com/the-efficacious/commandsuite/commit/9199dbafaa3337a9d62c7fd287ae666d90fb4f05) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Retire the team `directive` field and slim the first-run wizard to identity + auth.

  The wizard now collects only the team name, your name, a bearer token, and TOTP enrollment — no more forced directive/context/role prose before you've even seen the product. Standing context lives in exactly three editable places: `team.context` (team-level, now up to 8192 chars, editable from TeamHome in the web UI, `csuite team set`, or the `team_update` MCP tool), role title + description (public per-member), and member `instructions` (private per-member).

  Existing databases migrate automatically on boot: a non-empty legacy `directive` is folded into the head of `context` and the column is dropped. `PATCH /team`, `csuite team set`, and `team_update` no longer accept `directive`.

#### Patch Changes

- [#22](https://github.com/the-efficacious/commandsuite/pull/22) [`871122f`](https://github.com/the-efficacious/commandsuite/commit/871122fdab0bfbf5ed3507dc8392903b5ecb9be4) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - `csuite-web-ui` and `csuite-web-host` are now published packages (previously private workspace packages), and both join the fixed version group so the whole published surface releases in lockstep.

  - **`csuite-web-ui`** ships as it always existed internally: TypeScript source (`files: ["src"]`, exports pointing at `src/index.ts`). Build it with your host's bundler — Vite + `@preact/preset-vite` is the reference setup (`csuite-web-host` is the working example). Mount the team view via `<TeamShell>`.
  - **`csuite-web-host`** now builds into its own `dist/` and publishes it (`files: ["dist"]`), so an external host — a managed service, a CDN, any static server — can serve the same TOTP-gated PWA the self-hosted broker ships, straight from the tarball (`csuite-web-host/dist`).
  - **`csuite-server`** owns the copy step now: its build syncs `csuite-web-host/dist` into `public/` (`apps/server/scripts/sync-public.mjs`) instead of web-host writing into the server's tree. No behavior change for server users — the published tarball still ships the built PWA in `public/`.

### csuite-sdk

#### Minor Changes

- [#21](https://github.com/the-efficacious/commandsuite/pull/21) [`8c4a842`](https://github.com/the-efficacious/commandsuite/commit/8c4a842b9e5a4b9f777994cab253d41808d8891c) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Formal runner standard: the `AgentAdapter` contract, a shared session driver, run summaries, and a conformance suite for new agent runners.

  The two runners (`csuite claude`, `csuite codex`) are now thin wrappers over one shared lifecycle. A new `AgentAdapter` interface (`runtime/agents/adapter.ts`) captures everything framework-specific — binary location, config prepare/restore, spawn, notification sink, second-bridge policy — and the new `runAgentSession` driver (`runtime/agent-session.ts`) owns everything else: auth, runner startup, signal handling per declared mode (`forward` for terminal-owning TUIs, `teardown` for headless agents), and idempotent teardown on every exit path with a fixed ordering (agent capture flush → operator-file restore → uploader drain). Adding a third runner no longer re-implements exit-path correctness.

  Every session now ends with a machine-readable account of itself, identical across runners:

  - New `session_start` / `session_end` activity kinds bracket each run in the member's activity stream (mirroring `objective_open`/`objective_close`), with `session_end` carrying exit code, reason, duration, agent-native session id, and capture accounting (`enqueued`/`uploaded`/`dropped` — so an incomplete trace says so instead of being silently short on the broker).
  - A structured `run summary` log line and a human-readable closing line report the same facts locally.

  `csuite codex` gains `--doctor` / `--skip-doctor`, and the doctor is now adapter-generic (`runAgentDoctor`): shared checks (binary, $TMPDIR, loopback bind) plus an advisory agent-version probe against the adapter's declared tested range (WARN outside, never FAIL). Both runners also run the silent preflight before spawn.

  New runners are validated by a shared conformance suite (`packages/cli/test/runtime/conformance/`) that runs five lifecycle scenarios against a fake broker + fake agent binary; both shipped runners pass it. The written standard — adapter contract, capture capability tiers (0 operable … 3 full fidelity), run summary spec, fixture rule — lives at `docs/runners/conformance.mdx`.

  The Claude Code runner verb is renamed: **`csuite claude`** (was `csuite claude-code`; the old verb is kept as a silent alias so existing scripts keep working). The runner id in banners, session logs, and `session_start`/`session_end` events is now `claude`.

  Breaking-ish notes (pre-1.0): the runner startup banner is now uniform (`csuite <runner>: …` prefix, plus an agent/team line for the claude runner), and brokers older than this release will reject activity batches containing the new session events — upgrade the server and CLI together.

- [#19](https://github.com/the-efficacious/commandsuite/pull/19) [`9199dba`](https://github.com/the-efficacious/commandsuite/commit/9199dbafaa3337a9d62c7fd287ae666d90fb4f05) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Retire the team `directive` field and slim the first-run wizard to identity + auth.

  The wizard now collects only the team name, your name, a bearer token, and TOTP enrollment — no more forced directive/context/role prose before you've even seen the product. Standing context lives in exactly three editable places: `team.context` (team-level, now up to 8192 chars, editable from TeamHome in the web UI, `csuite team set`, or the `team_update` MCP tool), role title + description (public per-member), and member `instructions` (private per-member).

  Existing databases migrate automatically on boot: a non-empty legacy `directive` is folded into the head of `context` and the column is dropped. `PATCH /team`, `csuite team set`, and `team_update` no longer accept `directive`.

### csuite-web-ui

#### Minor Changes

- [#22](https://github.com/the-efficacious/commandsuite/pull/22) [`871122f`](https://github.com/the-efficacious/commandsuite/commit/871122fdab0bfbf5ed3507dc8392903b5ecb9be4) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - `csuite-web-ui` and `csuite-web-host` are now published packages (previously private workspace packages), and both join the fixed version group so the whole published surface releases in lockstep.

  - **`csuite-web-ui`** ships as it always existed internally: TypeScript source (`files: ["src"]`, exports pointing at `src/index.ts`). Build it with your host's bundler — Vite + `@preact/preset-vite` is the reference setup (`csuite-web-host` is the working example). Mount the team view via `<TeamShell>`.
  - **`csuite-web-host`** now builds into its own `dist/` and publishes it (`files: ["dist"]`), so an external host — a managed service, a CDN, any static server — can serve the same TOTP-gated PWA the self-hosted broker ships, straight from the tarball (`csuite-web-host/dist`).
  - **`csuite-server`** owns the copy step now: its build syncs `csuite-web-host/dist` into `public/` (`apps/server/scripts/sync-public.mjs`) instead of web-host writing into the server's tree. No behavior change for server users — the published tarball still ships the built PWA in `public/`.

### csuite-web-host

#### Minor Changes

- [#22](https://github.com/the-efficacious/commandsuite/pull/22) [`871122f`](https://github.com/the-efficacious/commandsuite/commit/871122fdab0bfbf5ed3507dc8392903b5ecb9be4) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - `csuite-web-ui` and `csuite-web-host` are now published packages (previously private workspace packages), and both join the fixed version group so the whole published surface releases in lockstep.

  - **`csuite-web-ui`** ships as it always existed internally: TypeScript source (`files: ["src"]`, exports pointing at `src/index.ts`). Build it with your host's bundler — Vite + `@preact/preset-vite` is the reference setup (`csuite-web-host` is the working example). Mount the team view via `<TeamShell>`.
  - **`csuite-web-host`** now builds into its own `dist/` and publishes it (`files: ["dist"]`), so an external host — a managed service, a CDN, any static server — can serve the same TOTP-gated PWA the self-hosted broker ships, straight from the tarball (`csuite-web-host/dist`).
  - **`csuite-server`** owns the copy step now: its build syncs `csuite-web-host/dist` into `public/` (`apps/server/scripts/sync-public.mjs`) instead of web-host writing into the server's tree. No behavior change for server users — the published tarball still ships the built PWA in `public/`.
