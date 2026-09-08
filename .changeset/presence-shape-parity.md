---
'csuite-core': minor
---

`GET /team/status` now carries the same `Presence` as `GET /roster`. Both routes
published a value typed `Presence` and populated it differently: the roster
enriched each registry record with live state, capture health and the
completeness-diagnostics counts inline in its handler, and `composeTeamStatus`
forwarded the registry record untouched — so five axes were absent on every
team-status member, always. Two of those five make absence load-bearing:
`captureHealth` absent means "this broker has no opinion", never "healthy", and
`diagnosticsUnresolved` absent means "this broker retains no diagnostics", never
"this member is clean". A broker answering `gap` on the roster was reporting
itself too old to know on the report an operator opens when something is wrong.
The enrichment is now one exported function, `enrichPresence`, and both routes
call it; `ComposeTeamStatusOptions` gains `workState` (required, so a caller
cannot compose a report whose presence is quietly a different shape),
`captureHealth` and `diagnostics`.
