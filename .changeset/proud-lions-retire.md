---
'csuite-server': minor
'csuite-sdk': minor
'csuite-cli': minor
'csuite-web-ui': minor
---

Remove the objective contract-versioning layer: `objectives_amend`,
`objectives_correct_event`, their routes and SDK methods, contract
version stamping, and the amendments record on the objective. Built in
response to a single run's incidents, never used since — and that run
itself served the same need with a reasoned cancel plus a fresh
objective, which is now the documented remedy. Old databases keep
reading cleanly: `amended` / `event_corrected` stay in the event-kind
schema as legacy read-only kinds, and `objectives_view` renders such
historical rows as ordinary log lines.
