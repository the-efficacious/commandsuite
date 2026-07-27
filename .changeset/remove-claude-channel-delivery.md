---
"csuite-cli": minor
"csuite-sdk": minor
---

Remove the `claude/channel` MCP-notification delivery path.

Broker events used to reach Claude Code as `notifications/claude/channel` MCP notifications pushed through the bridge — a surface gated behind Claude Code's `--dangerously-load-development-channels` development flag. With the claude runner on Agent SDK streaming input and codex on turn dispatches, nothing consumed it.

- The forwarder → sink seam is now a typed `ChannelEvent` (`{content, meta}`) delivered to a `ChannelEventSink`; the MCP method envelope, the `forwarderShim` bridge default, and the bridge's `claude/channel` experimental capability are gone.
- `RunnerOptions.notificationSink` is renamed to `channelSink`. Every real adapter must supply one; without it the runner drops live events with a log line (history remains readable via `recent`).
- The IPC `mcp_notification` frame survives for exactly one method: a genuine `tools/list_changed`.
- `csuite-sdk` no longer exports `MCP_CHANNEL_CAPABILITY` / `MCP_CHANNEL_NOTIFICATION`.
