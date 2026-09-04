---
'csuite-core': minor
---

`GET /members/:name/activity` now validates its query against `ListActivityQuerySchema` — the contract the SDK had always shipped and the route had never read — so `from`, `to` and `cursor_ts` must be whole non-negative millisecond values, `cursor_id` a whole non-negative row id, and `limit` an integer in 1–1000. A value outside those bounds now comes back as a `400` (`invalid query`, with `details` naming the offending field) instead of being coerced at the edge and clamped in the store.
