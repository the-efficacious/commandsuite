---
'csuite-server': minor
---

Reassigning an objective no longer strips the previous assignee from its discussion thread.

Thread membership is **computed**, not stored — `objectiveThreadMembers` derives it from the current assignee, the originator, the explicit watchers, and every admin. So reassignment never revoked anything: the assignee term simply stopped matching, and the outgoing assignee fell out of their own objective's thread at exactly the moment they needed to hand over. Posting a handover returned `403: user '<name>' is not a member of objective <id>'s thread`, which pushes the most valuable context of the whole transition into a private DM instead of the objective's append-only record.

`reassign` now promotes the outgoing assignee to **watcher** in the same transaction, emitting a `watcher_added` event carrying `reason: 'reassigned-from'` so the audit log explains why they are on the list.

**Why a watcher rather than "retaining them as a thread member":** there is no membership record to retain. Membership is a union of derived grants, and `watchers` is the only durable one the model can already express — it persists, it grants posting rights, and it receives future pushes. The alternative would have required a new concept.

The grant is deliberately **visible**: a former assignee appears in the watcher list, which is true — they worked on it — and an accountable watcher beats an invisible one. The accepted cost is that repeated reassignment grows the list.

No-ops are skipped: the outgoing assignee is not promoted when they are the originator (membership already derives from that) or already a watcher, so no duplicate entries.

Confirmed by test rather than assumed: a former assignee who was *independently* a watcher retained access **before** this change, which is what establishes that nothing was being revoked. Reassignment also strips neither the incoming assignee, the originator, nor pre-existing watchers.
