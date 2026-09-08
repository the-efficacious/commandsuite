---
'csuite-core': minor
'csuite-server': minor
---

`GET /history?channel=general` stopped republishing other members' system
notices. Instruction-change, context-control and runner-environment pushes fan
out to a named recipient list but persist with `to: null` and no thread tag —
the same shape as an untagged broadcast — and the general query matched on that
shape alone, with no reference to the audience the broker had recorded. Live
delivery and the default feed were both correctly scoped, so the leak appeared
only on scrollback: any authenticated member could read every other member's
instruction notices, the free-text reason on a context-control command, and the
name of a runner-environment binding, and the web UI rendered them inline when
someone opened `#general`. The general read now applies `feedVisibleTo`, the
same audience rule the feed uses, in both event logs — a recipient and the
sender still get every notice they were part of, and general's broadcasts still
reach the whole team. Named channels are untouched: membership stays the gate
there, so joining one still reads its history back.
