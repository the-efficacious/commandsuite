---
"csuite-sdk": patch
"csuite-server": patch
---

Report on the roster when a member's verbatim capture has stopped
arriving. A member can produce activity all day while none of their
request/response bodies reach the broker, and until now nothing said
so — the trace view renders systematic absence and ordinary per-turn
absence identically. `roster` now carries `captureHealth` per member:
`gap` when completed exchange markers in the current session have no
stored bodies, `unevaluated` when this broker cannot assess the member
(Codex, whose containment join is not built), and `ok` otherwise.
Field absence means an older broker with no opinion, never "healthy".
