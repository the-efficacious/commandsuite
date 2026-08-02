---
"csuite-cli": minor
"csuite-server": minor
---

feat(cli): drain-and-restart — on a `kind: 'instructions'` event the runner waits for the agent's next idle boundary, re-points ambient input at a buffer for the successor, gracefully stops the agent, refetches instructions, and respawns resuming the same conversation under the new system prompt (Claude session resume / codex thread resume). The watchdog's `stale` state no longer re-sends content — restart is the remediation; the resend is reserved for blocks that fell out entirely.
