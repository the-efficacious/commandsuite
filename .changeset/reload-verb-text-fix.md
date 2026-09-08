---
'csuite-core': patch
'csuite-cli': patch
---

`reload` no longer tells the agent its conversation is resumed. The runner has always respawned cold for that verb — refetching instructions *and* the environment, stamping `resumed: false` with `resumeReason: 'environment reloaded'` — and the broker's notices and the `context_control` enum description now define the three verbs on one axis: `compact` in place, `clear` cold with refreshed instructions, `reload` cold with refreshed instructions and environment.
