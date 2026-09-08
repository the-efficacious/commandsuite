---
'csuite-core': minor
'csuite-sdk': minor
'csuite-web-ui': minor
---

**Breaking.** `GET /history` pages on the composite cursor `before_ts` + `before_id` instead of a scalar `before` timestamp, and the transcript's "load older" pager sends it.

This ends a data-loss defect, not a spelling. Message timestamps are `Date.now()` at post time, so two posts in one tick collide routinely — an agent burst, a scripted backfill, several teammates answering at once. When a page boundary fell inside such a tie, `ts < before` excluded **every** message sharing that millisecond, including ones the client had never seen. They were not delayed or reordered: they were unreachable, because any value of `before` that admitted them also re-returned rows the client already held, and there was no id to deduplicate against a page that never arrived. The web UI's thread pager used exactly that pattern, so a message lost at a boundary stayed lost for as long as the panel was open. The activity stream had solved this with a composite cursor and named the failure in its own comment; `/history` is now the same mechanism.

Both `EventLog` implementations move together: the SQL seeks `(ts < ?1 OR (ts = ?1 AND id < ?2))` and orders `ts DESC, id DESC` on widened `(…, ts, id)` indexes, and the in-memory log walks in that same order rather than in insertion order — a cursor and a traversal that disagree skip rows at every page boundary. Within one millisecond the order is by id, which is arbitrary but total and stable; that is the property a complete page walk needs. Existing databases have their three narrow `events_*_ts_idx` indexes dropped and recreated as `events_*_ts_id_idx` on first open, because `CREATE INDEX IF NOT EXISTS` cannot widen an index that already exists.

**Compatibility window — one release.** `?before=<ts>` is still accepted, is read as `before_ts`, and answers with `Deprecation: true` plus `X-CSuite-Deprecated-Query: before=before_ts`. `before_ts` alone — with no `before_id` — remains a valid scalar bound and remains lossy, which is now what its name says; `before_id` without `before_ts` is a `400`. `HistoryQuery.before` is deprecated in favour of `HistoryQuery.cursor` and the SDK sends the current wire spelling for both. **`before` is removed in the next minor.**
