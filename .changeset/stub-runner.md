---
"csuite-cli": minor
---

New `csuite stub` runner verb: a test/CI instrument (never a deployable member) that proves the runner lifecycle with no model credential — presence to `connected=1`, the MCP bridge attach, the `session_start`/`session_end` capture bracket, restart/`clear`/`reload` respawns, and a clean exit. When addressed in a DM it answers one canned, self-identifying line through the real bridge path. Visibly a stub everywhere: `runner: "stub"` in every session_start trace event, an instrument line in the doctor, and a self-identifying reply. Bounded runs for tests via `CSUITE_STUB_EXIT_AFTER_MS`/`CSUITE_STUB_EXIT_CODE`.
