---
'csuite-core': patch
'csuite-server': patch
---

Transactional execution goes through the driver seam: `SqlDriver`
gains an optional `transaction(fn)` capability and core exports
`runInTransaction`, which every store now uses instead of issuing
SQL-level BEGIN/COMMIT/ROLLBACK through `exec`. Engines that forbid
transaction statements in SQL text (managing atomicity above it)
implement the capability; `node:sqlite` needs no change — the helper
falls back to the standard statements. The conformance kit asserts
commit and rollback behavior. One site previously used
`BEGIN IMMEDIATE`; under the single-connection model the eager write
lock was indistinguishable from `BEGIN`, and the helper's fallback
uses the latter.
