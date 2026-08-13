---
'csuite-server': minor
'csuite-sdk': minor
'csuite-cli': minor
'csuite-web-ui': minor
'csuite-web-host': minor
---

One objective permission and one mutation surface. `objectives.manage`
replaces the four-way `objectives.create` / `.cancel` / `.reassign` /
`.watch` split — no deployment ever granted those separately — and
existing configs and stored presets written under the old vocabulary
load unchanged through a legacy-alias map. `objectives_reassign` and
`objectives_watchers` fold into `objectives_update` (and their routes
into `PATCH /objectives/:id`, gated per field group): agents see seven
objective tools instead of nine. `blockReason` is now optional when
blocking — field data showed real blocks carried in prose because the
ceremony was heavier than the signal.
