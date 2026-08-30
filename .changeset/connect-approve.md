---
"csuite-cli": minor
---

`csuite connect pending` lists device enrollments waiting for approval, and `csuite connect approve --code <XXXX-XXXX> --member <name>` (or `--create --member <name> --title <t> …`) approves one from the CLI — the same routes and `members.manage` check as the web UI's `/enroll` page, so a provisioning script or an agent can onboard a device with no browser. The token still travels only from broker to device.
