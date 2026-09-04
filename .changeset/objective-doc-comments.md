---
'csuite-sdk': patch
---

`Objective` and `ObjectiveEvent.id` now document what the code does: an objective is assigned work with a definition of done rather than "the apex task primitive", and event ids are needed because a watcher batch shares a millisecond, not because creation emits two events — it emits one.
