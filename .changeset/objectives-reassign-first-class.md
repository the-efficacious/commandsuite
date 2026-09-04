---
'csuite-core': minor
'csuite-sdk': minor
'csuite-cli': minor
---

Reassignment is one verb all the way down. `POST /objectives/:id/reassign` joins
the wire, with `Client.reassignObjective`, the `objectives_reassign` MCP tool
and `csuite objectives reassign` pointed at it. The act already had a permission
leaf (`objectives.reassign`), an audit event (`reassigned`), a store method and
a CLI verb, and no route: a handover went out as a generic update carrying
`assignee`, so four layers named an operation the wire did not have. The route's
semantics are deliberately identical to that field group — same gate, same
unknown-assignee 400, same no-op when the target is already the assignee — and
`PATCH` still accepts `assignee`, so the two spellings of one act cannot
disagree.
