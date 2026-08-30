---
"csuite-cli": minor
---

`csuite <runner> install-service` writes a systemd unit and a sudoers rule scoped to exactly that unit for the current user's runner (claude, codex, or stub), refusing up front — with the exact lookup key — when no saved auth resolves headlessly from the workspace, and confirming liveness at the broker (member connected with a fresh lastSeen, never a pid) after `enable --now`. Without root nothing outside `$HOME` is written; the files print with the operator's install commands (`--print` forces that mode). `csuite <runner> cycle` restarts the unit from inside the runner via a detached worker and confirms the same broker-side liveness. `--exec` overrides the ExecStart binary for main-build deploy trees.
