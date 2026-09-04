---
'csuite-core': minor
'csuite-server': minor
---

**Breaking.** `AddMemberInput.permissions` is removed. Its doc comment called it
derived, but it was an input, and the two stores did different things with it:
the SQLite store discarded it and re-resolved `rawPermissions` on every read,
while the in-memory store kept the caller's list verbatim. The same `addMember`
call therefore produced two members with different authority depending on which
store was behind it. `rawPermissions` is now the only authority a caller
supplies, and both stores derive `permissions` through `resolvePermissions` — so
there is no second list left to disagree with what was persisted.
