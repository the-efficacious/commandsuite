# csuite-cli

CLI for [csuite](https://github.com/the-efficacious/commandsuite),
an MCP-based agent team control plane.

This package provides the `csuite` binary, which hosts the primary CLI
entry points (`csuite claude-code`, `csuite serve`, etc.)
plus the internal `csuite mcp-bridge` verb that `.mcp.json` entries
point at.

## Install

```bash
npm install -g csuite-cli
```

Or run without installing:

```bash
npx csuite-cli claude-code --doctor
```

## Commands

```
csuite setup       [--config-path <path>]                                 first-run wizard (team + first admin + TOTP)
csuite user        list | create | update | delete [--config-path <path>]   offline user management
csuite enroll      --user <name> [--config-path <path>]                   (re-)enroll a user for web UI login
csuite rotate      --user <name> [--config-path <path>]                   rotate a user's bearer token
csuite claude-code [--no-trace] [--doctor] [-- <claude args>...]          spawn claude wrapped in a csuite runner
csuite push        --body <text> (--agent <id> | --broadcast) [--title <t>] [--level <lvl>] [--data key=value]...
csuite roster                                                             list teammates, userType, and connection state
csuite objectives  list | view | create | update | complete | cancel | reassign   team objectives
csuite serve       [--config-path <path>] [--port <n>] [--host <h>] [--db <path>]
```

### `csuite claude-code` (the headliner)

Spawns `claude` as a child of a long-lived **runner** process. The
runner:

- Fetches `/briefing` from the broker to learn this slot's
  name, role, permissions, teammates, and open objectives
- Binds a Unix domain socket and starts an IPC server
- Starts the trace host: a loopback HTTP CONNECT proxy that
  terminates TLS with a per-session CA, reassembles HTTP/1.1
  exchanges, and streams activity events to the broker in real time
- Backs up `.mcp.json` and writes one pointing at `csuite mcp-bridge`
- Spawns claude with `HTTPS_PROXY`, `HTTP_PROXY`, and
  `NODE_EXTRA_CA_CERTS` pointing at the per-session CA
- Forwards SSE channel events from the broker into the agent as
  MCP `notifications/claude/channel`
- Restores `.mcp.json` on any exit path (normal, signal, crash)

Flags:

- `--no-trace` — disable the trace subsystem entirely. Runner still
  handles SSE, objectives, and bridge IPC.
- `--doctor` — preflight check: claude binary, `$TMPDIR` writable,
  loopback bind, per-session CA generation. Exits 0 on pass, 1 on
  any FAIL (WARN doesn't fail the exit code).
- Everything after `--` is forwarded verbatim to the `claude`
  binary.

Example:

```bash
export CSUITE_TOKEN=csuite_your_slot_token
csuite claude-code --doctor
csuite claude-code
csuite claude-code --no-trace -- --model claude-opus-4-6
```

### `csuite mcp-bridge` (hidden internal verb)

The stdio MCP server that claude spawns via the `.mcp.json` entry
the runner wrote. Connects to the runner's UDS path from
`$CSUITE_RUNNER_SOCKET` and forwards every MCP request/response +
every runner-initiated notification. Not shown in `--help`;
members never invoke it directly.

## Environment

| Variable | Purpose |
|---|---|
| `CSUITE_URL` | Broker base URL (default `http://127.0.0.1:8717`) |
| `CSUITE_TOKEN` | Slot bearer token — required for `claude-code`, `push`, `roster`, `objectives` |
| `CLAUDE_PATH` | Override the claude binary path (otherwise `which claude`) |
| `CSUITE_RUNNER_SOCKET` | Set by the runner on the bridge's env; members never set this |

## Quick start

```bash
# 1. Start a broker (first run triggers the team setup wizard)
csuite serve

# 2. In another terminal, set your user's bearer token
export CSUITE_TOKEN=csuite_your_bearer_token

# 3. Preflight check the environment
csuite claude-code --doctor

# 4. Wrap claude
csuite claude-code
```

To push a one-shot chat message without spawning claude:

```bash
csuite roster
csuite push --agent engineer-1 --body "ci failed on main" --level warning
```

To manage objectives from the terminal:

```bash
csuite objectives list --assignee engineer-1 --status active
csuite objectives create --assignee engineer-1 --title "…" --outcome "…"
csuite objectives complete --id obj-xxx --result "shipped as PR #1245"
```

## License

Apache 2.0. See the [csuite monorepo](https://github.com/the-efficacious/commandsuite)
for the full source.
