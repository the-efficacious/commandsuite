# csuite-sdk

## 0.1.0

### Minor Changes

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

## 0.0.1
