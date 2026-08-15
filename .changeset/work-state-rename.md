---
'csuite-core': minor
'csuite-sdk': minor
---

**Breaking.** Rename the live idle/working/blocked signal to work state (`WorkStateTracker`, `WorkState`), so "activity" unambiguously means the durable per-member record. Wire paths and JSON field names are unchanged.

`ActivityTracker`, `createActivityTracker`, `ACTIVITY_TTL_MS` and the `ActivityState` type become `WorkStateTracker`, `createWorkStateTracker`, `WORK_STATE_TTL_MS` and `WorkState`.
