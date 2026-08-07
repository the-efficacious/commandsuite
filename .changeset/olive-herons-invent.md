---
'csuite-server': minor
'csuite-sdk': minor
'csuite-cli': minor
'csuite-web-ui': minor
---

Let the broker compact or clear a member's agent context without
restarting it, and report what actually happened.

The broker could already see a member's context drift — the context
watchdog distinguishes present from missing from stale — but every
mechanism it had was additive. It could make a context larger and
measure that it had gone wrong; it had no verb for making it smaller.
A degraded member had two remedies: the agent deciding to compact on
its own, or a full restart that drops the runner's MCP wiring and
takes the member off the net.

- **`POST /members/:name/context`** with `verb: 'compact' | 'clear'`,
  delivered on the member stream the same way instruction edits are.
  Neither verb ends the session: the broker subscription, the IPC
  socket the MCP bridge reconnects to, the objectives tracker and the
  capture host all outlive both.
- **`clear` re-uses the drain-and-restart path** — wait for the turn
  to finish, detach ambient input so events buffer for the successor,
  refetch instructions, respawn — and differs in exactly one input:
  the successor does not resume. Adapters previously treated a null
  session id as "resume the most recent session anyway", so respawn
  now takes an explicit `RespawnPosture` and starting cold is no
  longer expressible by accident.
- **`compact` is cooperative and says so.** The agent does the
  summarising, so the request can be declined. Every request produces
  exactly one `context_control` activity event: `applied` (with the
  measured before/after token counts), `declined` (with the
  framework's own reason, verbatim), `unsupported` (codex has no
  compaction operation), or `failed`. A request that produces no
  outcome stays visibly outstanding rather than aging into a success
  nobody observed.
- **New `members.context` permission**, separate from
  `members.manage`: interrupting a teammate's live work is a
  different power from administering the roster. Controlling your own
  context needs no permission at all.
