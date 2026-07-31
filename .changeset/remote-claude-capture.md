---
"csuite-cli": patch
"csuite-sdk": patch
"csuite-server": patch
---

Capture Claude request and response bodies when the runner and broker use different filesystems. The runner now resolves FILE-mode body references locally, forwards byte-exact inline bodies over OTLP, and retains unacknowledged spool files across restarts instead of deleting them based on process liveness.

**Known limitation.** A request or response body the runner cannot resolve—oversized, not a runner-owned regular file, or not valid UTF-8—is forwarded unresolved and skipped broker-side, so it is not captured. Existing unresolved entries inside the runner's spool directory, regular or not, remain there; referenced paths outside it are left untouched and create no spool residue. Any remaining in-spool entry prevents the spool from earning its completion marker, so automatic sweep will not remove the directory; it stays pinned until manually dispositioned. Missing or already-unlinked references leave no additional residue. Capture continues for other resolvable bodies. Quarantine is tracked separately and is not in this release.
