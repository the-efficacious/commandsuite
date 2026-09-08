---
'csuite-sdk': minor
'csuite-core': minor
'csuite-server': minor
'csuite-cli': minor
'csuite-web-ui': minor
---

**Breaking.** The work-state rename now reaches the wire. `POST /presence/activity`
becomes `POST /presence/work-state`, `Presence.activity` becomes
`Presence.workState`, `RosterResponse.activityWindowMs` becomes
`workStateWindowMs`, and `ActivityReport` becomes `WorkStateReport`. PR #194
renamed these in the TypeScript layer and deliberately left the wire alone; that
half-rename is what kept `activity` naming four things at once, so **activity**
now means the durable per-member stream (`GET /members/:name/activity`,
`activity.read`, `ActivityStore` — all unchanged) and **work state** means the
live `idle`/`working`/`blocked` signal.

**Nothing breaks in this release.** For one release the broker serves both paths
from the same handler and the roster emits both spellings of every renamed field
with the same value, so a client on either side of the rename reads the same
member. The old path answers `Deprecation: true` and
`Link: </presence/work-state>; rel="successor-version"`, and logs one
`deprecated route` line naming the member, so a runner still on the old spelling
is findable before it stops working. `Client.setActivity`, `ActivityReport` and
`ActivityReportSchema` remain as deprecated aliases of `setWorkState`,
`WorkStateReport` and `WorkStateReportSchema`.

**The compat shims are removed in the next minor** — the deprecated route, the
`Presence.activity` and `RosterResponse.activityWindowMs` fields, and the four
SDK aliases. Move to the new spellings now; `Presence.busy` stays, as the
explicitly-labelled lossy boolean mirror it always was.
