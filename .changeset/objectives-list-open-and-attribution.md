---
'csuite-cli': patch
---

`objectives_list` renders assignee and originator, and accepts `open` for the
active+blocked union plus `assignee` to narrow to one member's plate.

Four harness consumers independently followed the tool's own description into
the unfiltered call and had the result spilled or truncated. Two defects sat
behind that: the renderer dropped `assignee` and `originator` that the
description promised, so an agent could not tell work it owns from work it
merely watches; and `status` takes one lifecycle state while an open plate is
the union of `active` and `blocked`, so no single call established it. The
description now prescribes `status: "open"` for restart and context-compaction
recovery.

`assignee` is applied client-side. The server honours it on exactly one of
three branches — it is dropped whenever `related` is also present, and a
caller without `objectives.create` always receives the whole relationship
union — so forwarding it would return a superset with nothing saying so.
