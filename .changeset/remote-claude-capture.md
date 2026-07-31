---
"csuite-cli": patch
"csuite-sdk": patch
"csuite-server": patch
---

Capture Claude request and response bodies when the runner and broker use different filesystems. The runner now resolves FILE-mode body references locally, forwards byte-exact inline bodies over OTLP, and retains unacknowledged spool files across restarts instead of deleting them based on process liveness.
