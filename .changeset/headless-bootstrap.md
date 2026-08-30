---
"csuite-cli": patch
---

`csuite member` help no longer claims to run offline — it manages members through the running broker, and `create` prints the new member's token once. The repository also gains `scripts/bootstrap.sh`, a scriptable no-TTY bring-up of broker, team, web UI and an enrolled runner, documented at docs/headless-setup and run by CI (#198).
