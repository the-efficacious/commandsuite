---
'csuite-core': minor
'csuite-server': minor
---

The objective read gate admits the thread audience. A member holding
`members.manage` and not `objectives.create` was already an implicit participant
on every objective's thread — the lifecycle fan-out pushed them every event,
`/discuss` accepted their posts, and `GET /team/status` listed every open
objective by id and title for them — and then `GET /objectives/:id` answered
`403 not a thread participant; viewing requires objectives.create` for an id the
broker had just handed them. `GET /objectives/:id` and `GET /objectives` now
test the same audience the push fan-out and the post gate test, computed from
one `onObjectiveThread` predicate that `objectiveThreadMembers` expands, so read,
post and push cannot drift apart again. The 403 body names the predicate the gate
actually tests instead of a leaf that authors objectives; nobody loses access.
