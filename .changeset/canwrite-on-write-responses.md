---
'csuite-core': minor
'csuite-sdk': patch
---

`FsEntry.canWrite` now rides on write responses too. `POST /fs/write`,
`POST /fs/mkdir` and `POST /fs/mv` return an entry carrying the server's
`canWrite()` answer for the requesting viewer, the same field `GET /fs/stat`,
`GET /fs/ls`, `GET /fs/shared` and `GET /fs/all` have always carried. The
in-process `copyByBlobRef` (objective attachment mirroring) does the same.

This is additive: a response gains a key. Nothing that parsed before stops
parsing — the field is `optional` in `FsEntrySchema` for version skew — and no
client has to change. What changes is that a client rendering the entry it just
got back no longer sees `undefined`, which the SDK tells it to treat as
"unknown", indistinguishable from an older server. That mattered most exactly
where the answer is least derivable: an entry created under `/objectives/<id>/`
is owned by `obj:<id>` and writable by every member of that objective, which no
client can work out from the fields it holds.

The store's own header has always claimed "every entry returned to a caller
carries `canWrite`". It is now true as written, and the SDK type says the field
is a property of the entry rather than of the verb that produced it.
