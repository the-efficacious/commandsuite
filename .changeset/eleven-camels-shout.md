---
'csuite-server': minor
---

One push per objective creation. Initial watchers ride the `assigned`
event's payload instead of emitting a `watcher_added` event each — on
a live team, a 4-watcher objective pushed four near-identical copies
of its full contract into every thread member's context before any
work had happened. Post-creation watcher changes still emit
individually, and their push now carries the title and the name rather
than re-broadcasting the whole outcome text.
