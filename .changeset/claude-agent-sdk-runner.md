---
"csuite-cli": minor
---

`csuite claude` now runs Claude Code headlessly via the Claude Agent SDK, superseding the interactive TUI wrapper.

The runner is a full agent member like `csuite codex`: the runner owns the terminal (Ctrl-C tears down gracefully), broker events arrive as SDK streaming-input messages, and the operator sees an activity feed + HUD instead of the claude TUI. Someone who wants the interactive TUI can still run `claude` directly — csuite no longer wraps it.

What this changes:

- **No working-tree writes.** The csuite MCP entry travels inline on the SDK-composed invocation and hooks are in-process callbacks — the `.mcp.json` / `.claude/settings.json` backup-restore machinery (and `CSUITE_CLAUDE_MCP_MODE`) is gone.
- **No system `claude` install required.** The SDK ships its own Claude Code; `CLAUDE_PATH` still overrides. Anthropic auth is the machine's own `claude login` (subscription works) or `ANTHROPIC_API_KEY`.
- **Sessions are first-class.** The run summary carries a real session id and `--resume [<sessionId>]` picks a session back up (bare `--resume` continues the most recent in the cwd).
- **Ambient events no longer depend on `--dangerously-load-development-channels`.** The dev-flag MCP notification surface is replaced by supported SDK streaming input.
- **Flags changed.** New: `--model`, `--resume`, `--cwd`. Removed: the pass-through arg tail (`-- <claude args>`) — the posture (`bypassPermissions`, briefing pinned to the system prompt) is applied via typed SDK options.
- Capture is unchanged at tier 3 (transcript-primary content, in-process hook presence, OTEL operational + FILE-mode raw bodies).
