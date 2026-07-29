# csuite-cli

## 0.2.0

### Minor Changes

- [#27](https://github.com/the-efficacious/commandsuite/pull/27) [`585b331`](https://github.com/the-efficacious/commandsuite/commit/585b331df11f9a927adcddadd16d1055cb89b924) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - `csuite claude` now runs Claude Code headlessly via the Claude Agent SDK, superseding the interactive TUI wrapper.

  The runner is a full agent member like `csuite codex`: the runner owns the terminal (Ctrl-C tears down gracefully), broker events arrive as SDK streaming-input messages, and the operator sees an activity feed + HUD instead of the claude TUI. Someone who wants the interactive TUI can still run `claude` directly — csuite no longer wraps it.

  What this changes:

  - **No working-tree writes.** The csuite MCP entry travels inline on the SDK-composed invocation and hooks are in-process callbacks — the `.mcp.json` / `.claude/settings.json` backup-restore machinery (and `CSUITE_CLAUDE_MCP_MODE`) is gone.
  - **No system `claude` install required.** The SDK ships its own Claude Code; `CLAUDE_PATH` still overrides. Anthropic auth is the machine's own `claude login` (subscription works) or `ANTHROPIC_API_KEY`.
  - **Sessions are first-class.** The run summary carries a real session id and `--resume [<sessionId>]` picks a session back up (bare `--resume` continues the most recent in the cwd).
  - **Ambient events no longer depend on `--dangerously-load-development-channels`.** The dev-flag MCP notification surface is replaced by supported SDK streaming input.
  - **Flags changed.** New: `--model`, `--resume`, `--cwd`. Removed: the pass-through arg tail (`-- <claude args>`) — the posture (`bypassPermissions`, briefing pinned to the system prompt) is applied via typed SDK options.
  - Capture is unchanged at tier 3 (transcript-primary content, in-process hook presence, OTEL operational + FILE-mode raw bodies).

- [#27](https://github.com/the-efficacious/commandsuite/pull/27) [`9d22ed2`](https://github.com/the-efficacious/commandsuite/commit/9d22ed2179f5ab81852705485d2692107c7330bb) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Remove the `claude/channel` MCP-notification delivery path.

  Broker events used to reach Claude Code as `notifications/claude/channel` MCP notifications pushed through the bridge — a surface gated behind Claude Code's `--dangerously-load-development-channels` development flag. With the claude runner on Agent SDK streaming input and codex on turn dispatches, nothing consumed it.

  - The forwarder → sink seam is now a typed `ChannelEvent` (`{content, meta}`) delivered to a `ChannelEventSink`; the MCP method envelope, the `forwarderShim` bridge default, and the bridge's `claude/channel` experimental capability are gone.
  - `RunnerOptions.notificationSink` is renamed to `channelSink`. Every real adapter must supply one; without it the runner drops live events with a log line (history remains readable via `recent`).
  - The IPC `mcp_notification` frame survives for exactly one method: a genuine `tools/list_changed`.
  - `csuite-sdk` no longer exports `MCP_CHANNEL_CAPABILITY` / `MCP_CHANNEL_NOTIFICATION`.

### Patch Changes

- Updated dependencies [[`9d22ed2`](https://github.com/the-efficacious/commandsuite/commit/9d22ed2179f5ab81852705485d2692107c7330bb)]:
  - csuite-sdk@0.2.0
  - csuite-core@0.2.0

## 0.1.2

### Patch Changes

- [#25](https://github.com/the-efficacious/commandsuite/pull/25) [`5954ce2`](https://github.com/the-efficacious/commandsuite/commit/5954ce240f6e94bf3b6f76e463487acd072b6fa7) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Fix the activity uploader abandoning its last upload at shutdown. `close()` (and `flush()`) returned as soon as the queue looked empty, even with a POST still on the wire — so a run's final `session_end` could reach the broker after the run that produced it had already exited, and any event queued behind that in-flight POST was dropped instead of drained. Both now wait for the upload in flight and then drain what is left, so a closed uploader means every event it will ever send has landed and the `uploaded`/`dropped` counts in the run summary are accurate.

- Updated dependencies []:
  - csuite-core@0.1.2
  - csuite-sdk@0.1.2

## 0.1.1

### Patch Changes

- [#23](https://github.com/the-efficacious/commandsuite/pull/23) [`bbed9d8`](https://github.com/the-efficacious/commandsuite/commit/bbed9d880aabd3e49b1657bca198f560f16768b5) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Move the CLI auth store out of your project tree: `csuite connect` now saves to the user-global `~/.config/csuite/auth.json` (per-OS: `~/Library/Application Support` on macOS, `%APPDATA%` on Windows) and records which directory each enrollment serves, so one machine still holds a distinct member identity per workspace. Previously the bearer token was written to `<cwd>/.csuite/auth.json` — inside your project, and one `git add -A` from being committed. Scope with `--workspace <dir>` or `--global`; inspect with the new `csuite auth list`. Legacy project-scoped stores are still read, and `csuite auth migrate` (or the next `csuite connect`) folds them in — if one was inside a git working tree the CLI now tells you to rotate the token, since it may already be in your history.

- Updated dependencies []:
  - csuite-core@0.1.1
  - csuite-sdk@0.1.1

## 0.1.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [[`8c4a842`](https://github.com/the-efficacious/commandsuite/commit/8c4a842b9e5a4b9f777994cab253d41808d8891c), [`9199dba`](https://github.com/the-efficacious/commandsuite/commit/9199dbafaa3337a9d62c7fd287ae666d90fb4f05)]:
  - csuite-sdk@0.1.0
  - csuite-core@0.1.0

## 0.0.1

### Patch Changes

- f760db7: Fix a transcript-reader race where a drain already in flight when `close()`
  landed could still emit activity events for lines appended after close.
  - csuite-core@0.0.1
  - csuite-sdk@0.0.1
  - csuite-server@0.0.1
