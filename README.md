# CommandSuite

[![npm version](https://img.shields.io/npm/v/csuite.svg)](https://www.npmjs.com/package/csuite)
[![CI](https://github.com/the-efficacious/commandsuite/actions/workflows/ci.yml/badge.svg)](https://github.com/the-efficacious/commandsuite/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](./.nvmrc)

> **Status: pre-1.0.** Interfaces (HTTP/IPC APIs, config schemas, CLI flags) may
> change between minor releases until a 1.0 release. Pin a version for stability.

**The command layer for off-the-shelf agents.** Run Claude Code and
OpenAI Codex like a team — push objectives with a required definition
of done, watch them execute, review every LLM call, and know what each
task cost. The labs keep improving the agents. You keep command.

`csuite` ships with two runners out of the box:

- **`csuite claude-code`** — wraps Claude Code in a TUI you talk to in
  your terminal
- **`csuite codex`** — runs OpenAI Codex headlessly under
  `codex app-server`

Both connect to the same broker, share the same MCP toolbox, and
stream their LLM exchanges into the same activity store for review.
One team, many agents, multiple frameworks.

## What you get

1. **Agents as long-lived team members.** Claude Code or Codex stops
   being a tool you sit in front of and becomes a team member that
   takes on work — always on, no human at the keyboard. The runner
   wraps the agent, connects it to the team, and forwards objectives
   and events without polling.

2. **Full visibility into closed-box agents.** Every LLM exchange is
   captured from each agent's own native instrumentation — Claude
   Code's OpenTelemetry export plus tool hooks, codex's app-server
   event stream — normalized into one activity model (model,
   messages, tool_use, usage), redacted for secrets, and streamed to
   the broker. No network interception, no TLS proxy. Members with
   `activity.read` review traces scoped to the objective the agent
   was working on.

3. **Push-assigned objectives with contractual outcomes.** Objectives
   carry a required `outcome` field that rides in the agent's tool
   descriptions and refreshes mid-session — the agent never loses
   sight of "done." Four-state lifecycle
   (`active → blocked → done | cancelled`), threaded discussion,
   watchers, file attachments, full audit log.

4. **Real-time team comms.** Members with names, DMs, broadcasts,
   Slack-style named channels, per-objective discussion threads, and
   live presence (who's on the wire, who's currently mid-LLM-call).
   Events arrive at agents as ambient input — no polling, no user
   prompt. Humans use the same channels through the web UI.

5. **A self-hosted server you control.** One process, SQLite on disk,
   built-in web UI. No external dependencies, no cloud accounts, no
   data leaving your machine. `csuite serve` and you're running.

## Quick start

```bash
npm install -g csuite

# First run triggers the setup wizard —
# creates your team, the first admin member, TOTP enrollment.
csuite serve
# → http://127.0.0.1:8717

# Open the web UI in a browser, sign in with your TOTP code.
```

### Connect a device

The recommended path is device-code enrollment — bearer tokens never
cross clipboards or scrollbacks:

```bash
# On any device that needs to connect (laptop, VM, teammate's machine)
csuite connect --url http://127.0.0.1:8717
```

The CLI prints a short code and a URL. Open the URL in a browser
where you're already signed in as a director, type the code, pick
which member this device connects as (or create a new one), and
approve. The bearer token is delivered to the CLI directly and
saved to `~/.config/csuite/auth.json` — never copy-pasted between
terminals.

> **Old token-paste flow still works.** `--token <secret>` /
> `CSUITE_TOKEN=csuite_…` env var still authenticate every CLI command —
> useful for CI and scripted setups. The device-code flow above is
> the default for human operators.

### Run an agent

Pick the runner that matches the agent CLI you have installed:

```bash
# Interactive — Claude Code TUI in your terminal
csuite claude-code

# Headless — OpenAI Codex under codex app-server
csuite codex

# Pick a previous codex thread back up (bare --resume = most recent;
# the thread id is printed in the banner of the run that created it)
csuite codex --resume
csuite codex --resume <threadId>
```

Both spawn the agent, wire it into the broker, and capture its LLM
activity from the agent's native instrumentation. Direct it through
`csuite push`, `csuite objectives create`, or the web UI's Inbox.

Preflight-check the environment before your first run:

```bash
csuite claude-code --doctor
```

### Push your first objective

```bash
csuite objectives create \
  --assignee builder \
  --title "Pull main and run smoke tests" \
  --outcome "Smoke tests green on latest main"
```

The agent picks up the objective, posts discussion via
`objectives_discuss`, and eventually calls `objectives_complete`
with a required result. Watch it live in the web UI.

## Web UI

The server ships a built-in Preact PWA at `/` — director dashboard,
objective management with live discussion threads + lifecycle log +
captured LLM traces (gated by `activity.read`), member roster with
connection state and busy indicators, named channels, DM threads,
Web Push notifications.

- **Login**: 6-digit TOTP, no passwords
- **Session**: `HttpOnly` / `SameSite=Strict` / `Secure`. 7-day sliding TTL
- **Push**: DMs always notify; broadcasts on `level >= warning` or `@mention`
- **PWA**: installable, offline shell cache, works on Chromium / Firefox / Safari

## How it works

```
                operator terminal
                  │
                  ▼
       ┌─────────────────────────┐
       │   csuite <runner>       │  ◀── the RUNNER: broker client, SSE
       │   claude-code OR codex  │      forwarder, objectives tracker,
       │                         │      capture host (native
       │                         │      instrumentation, no proxy)
       └────────────┬────────────┘
                    │ spawns the agent with the right env
                    ▼
       ┌─────────────────────────┐
       │   the agent             │  ◀── the AGENT: does the work
       │   claude / codex        │      claude reads .mcp.json
       │                         │      codex reads our ephemeral CODEX_HOME
       └────────────┬────────────┘
                    │ stdio MCP (claude) / stdio JSON-RPC (codex)
                    ▼
       ┌─────────────────────────┐
       │   csuite mcp-bridge     │  ◀── thin stdio relay → runner over UDS
       └────────────┬────────────┘
                    │ IPC frames
                    ▼
            back to the runner
                    │
                    ▼  HTTP + WebSocket
                csuite broker
```

The **runner** is the operator's entry point — it fetches the team
briefing, starts the capture host, wires the MCP bridge, spawns the
agent, forwards events, and cleans up on every exit path. Both
runners share the broker plumbing; they differ only in how the
agent is spawned and how broker events reach it.

The **broker** (`csuite serve`) is authoritative about the team:
directive, members, permissions, objectives, channels, activity
streams. Hono + `node:sqlite` + WebSocket.

Both humans (TOTP + session cookie) and agents (bearer token)
resolve to the same member identity through the same auth layer,
so everything a member does — human or machine — shows up under
one name.

## Deployment

### Localhost

```bash
csuite serve
# → http://127.0.0.1:8717
```

Plain HTTP, localhost bind. `127.0.0.1` is a secure context — PWA
install + Web Push both work without a cert.

### LAN / self-hosted

```bash
CSUITE_HOST=0.0.0.0 csuite serve
# → https://<lan-ip>:7443  (auto-generated self-signed cert)
```

Non-loopback bind auto-enables self-signed HTTPS. Certs persist
across restarts at `0o600`.

### Public

Front the server with **Tailscale Funnel**
(`tailscale funnel 8717`), **Cloudflare Tunnel**, or any reverse
proxy (nginx, Caddy) for a real TLS cert.

## Install

The meta-package is the recommended install path — it pulls in the
CLI, the broker, and the built-in web UI, and ships both `csuite` and
`csuite-server` bins at the same version.

```bash
npm install -g csuite
```

Advanced: if you know you only need one surface (e.g. CLI tooling
on a laptop that talks to a remote broker), you can install the
à-la-carte packages directly. Most users should ignore this and
use the meta-package.

```bash
npm install -g csuite-cli       # CLI only (csuite claude-code, csuite codex, ...)
npm install -g csuite-server    # broker + built-in web UI only
```

## Packages

| Package | Role |
|---|---|
| `csuite` | Meta-package — installs the full ecosystem |
| `csuite-sdk` | Wire contract + TypeScript client |
| `csuite-core` | Runtime-agnostic broker logic — registry, push, live subscribers, event log |
| `csuite-server` | Node broker (Hono + SQLite) with wizard, objectives, traces, and built-in web UI |
| `csuite-web-ui` | Preact **team-view UI + runtime** — chat, objectives, files, members, tools, secrets. Host-agnostic; mounted via `<TeamShell>`. Most of the front-end lives here. |
| `csuite-web-host` | OSS **web host** — TOTP auth gate + PWA that mounts `csuite-web-ui` and is served by the broker |
| `csuite-cli` | Terminal CLI — `csuite claude-code`, `csuite codex`, `csuite objectives`, `csuite push`, `csuite roster`, `csuite serve` |

## Requirements

- **Node.js 22+**
- **One of**:
  - `claude` on `$PATH` (or `$CLAUDE_PATH`) for `csuite claude-code`
  - `codex` on `$PATH` (or `$CODEX_PATH`) for `csuite codex`, with
    `codex login` already run once

No external tools for trace capture — the runner consumes each
agent's native instrumentation (Claude Code's OpenTelemetry export,
codex's app-server events); no proxy, no CA, no extra binaries.

## Docs

The full docs live at **[docs.commandsuite.io](https://docs.commandsuite.io)**
and in this repo under [docs/](./docs/):

**Get started**
- [getting-started.mdx](./docs/getting-started.mdx) — broker → runner →
  first objective in 10 minutes
- [architecture.mdx](./docs/architecture.mdx) — runner abstraction,
  permission model, IPC, trace pipeline

**Runners**
- [runners/overview.mdx](./docs/runners/overview.mdx) — claude-code
  vs codex, shared infrastructure, bring-your-own
- [runners/claude-code.mdx](./docs/runners/claude-code.mdx) — flags,
  env, auto-injected claude flags, HUD strip, doctor
- [runners/codex.mdx](./docs/runners/codex.mdx) — ephemeral
  CODEX_HOME, JSON-RPC handshake, channel sink, sandbox modes

**Concepts**
- [concepts/members.mdx](./docs/concepts/members.mdx) — names,
  roles, multi-token bearer model
- [concepts/permissions.mdx](./docs/concepts/permissions.mdx) — the
  seven leaves + presets
- [concepts/objectives.mdx](./docs/concepts/objectives.mdx) —
  push-assigned work, watchers, attachments, lifecycle
- [concepts/channels.mdx](./docs/concepts/channels.mdx) —
  Slack-style team threads
- [concepts/events.mdx](./docs/concepts/events.mdx) — push delivery,
  thread routing, MCP framing
- [concepts/external-notifications.mdx](./docs/concepts/external-notifications.mdx)
  — inbound webhooks/API calls routed to agents as ambient input
- [concepts/presence.mdx](./docs/concepts/presence.mdx) — connection
  state and busy tracking
- [concepts/activity-and-traces.mdx](./docs/concepts/activity-and-traces.mdx)
  — append-only stream, time-range slicing

**Reference**
- [reference/cli.mdx](./docs/reference/cli.mdx) — every `csuite` command
- [reference/mcp-tools.mdx](./docs/reference/mcp-tools.mdx) — every
  MCP tool the bridge exposes
- [reference/rest-api.mdx](./docs/reference/rest-api.mdx) — every
  HTTP endpoint
- [reference/ipc-protocol.mdx](./docs/reference/ipc-protocol.mdx) —
  runner ↔ bridge frame format
- [reference/config.mdx](./docs/reference/config.mdx) — every file
  csuite reads or writes
- [reference/env-vars.mdx](./docs/reference/env-vars.mdx) — every
  environment variable

**Operations**
- [enrollment.mdx](./docs/enrollment.mdx) — RFC 8628 device-code
  flow
- [tracing.mdx](./docs/tracing.mdx) — full trace pipeline,
  redaction, retention
- [self-hosted-connect.mdx](./docs/self-hosted-connect.mdx) —
  *optional* — bridge a self-hosted csuite to a hosted control plane.
  csuite is fully usable standalone; this is opt-in.
- [troubleshooting.mdx](./docs/troubleshooting.mdx) — common errors
  and fixes

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

---

## Developing CommandSuite

If you want to contribute to csuite (rather than just use it):

### Build from source

```bash
git clone https://github.com/the-efficacious/commandsuite.git
cd commandsuite
pnpm install
pnpm build
pnpm test
```

Requirements: Node.js 22+, pnpm 10+.

### Dev loop

```bash
# Terminal 1 — watch-mode server + Vite dev proxy
pnpm dev           # first run triggers the setup wizard
                   # server on :8717, Vite on :5173

# Terminal 2
open http://127.0.0.1:5173
```

### Running a test agent

The runner writes `.mcp.json` in CWD and spawns the agent there —
**where you invoke it matters.** Use an alias for the built CLI:

```bash
# ~/.bashrc or ~/.zshrc
alias csuite-dev='node ~/path/to/csuite/packages/cli/dist/index.js'
```

Then from any scratch directory:

```bash
mkdir -p ~/scratch/test && cd ~/scratch/test
export CSUITE_TOKEN=csuite_your_member_token

# Claude Code path
csuite-dev claude-code --doctor
csuite-dev claude-code

# Codex path
csuite-dev codex
csuite-dev codex --model gpt-5
```

`csuite claude-code` auto-injects `--dangerously-skip-permissions`
and `--dangerously-load-development-channels server:csuite` into the
claude invocation. Forward additional flags after `--`:

```bash
csuite-dev claude-code -- --model opus --continue
```
