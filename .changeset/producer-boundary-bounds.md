---
'csuite-server': patch
---

The server no longer writes `mime`, `sourceUa`, or `sourceIp` values that its own published schemas refuse to read back.

Two endpoints produced values their consumer schema rejected, so a successful request could store a row the SDK then threw on. `POST /fs/write` checked that `mime` was present but never bounded it, while `FsEntrySchema.mimeType` caps it at 255; `POST /enroll` recorded the raw `User-Agent` header and the raw `ipKey()` result, while `PendingEnrollmentSchema` caps them at 512 and 64. Both were live in 0.3.1: a 300-character `mime` returned `200`, persisted, and came back out of `/fs/stat` as an entry `FsEntrySchema.safeParse` rejected; a 600-character `User-Agent` produced an `/enroll/pending` row failing with `too_big maximum:512`.

**The two are fixed in opposite directions, deliberately.** Reject when the value is a **claim about content**; truncate when it is a **label the user did not choose**.

`mime` is now **refused** with `400` before anything is persisted, and is never trimmed to fit. A truncated MIME type is not a shorter version of the caller's claim — it is a different, still well-formed claim they never made, silently attached to their bytes. A refused upload is recoverable; mislabeled stored content is not.

`sourceUa` and `sourceIp` are now **truncated** to their schema bounds and the enrollment proceeds. These are audit context the enrolling user never authored — one derived from proxy headers, the other from whatever their client sends. Refusing would deny a legitimate device a login over a field its operator cannot see, cannot edit, and did not write.

Truncation is **recorded**, because a silently-cut value is indistinguishable from a genuine one sitting at the limit: the stored value ends in `…` so the record itself says it was cut, and a warning names the field and the original length. The `…` lives inside the bound, so the marker cannot produce the oversize value it exists to prevent.

Both limits are read off the published schemas rather than restated as literals — a second copy of the number is how the producer and consumer drifted apart originally.

The bound applies only to the **stored** `sourceIp`, never to the rate-limit key, which keeps the full `ipKey()` string. Truncating the bucket key would merge every client sharing a long forwarded prefix into one bucket, letting a single client exhaust the enrollment mint limit for everyone behind the same proxy chain.

Verified by mutation rather than by review: collapsing either policy into the other fails both cross-referencing tests, a `400` that still persists the row fails the absence check, dropping the `…` or the warning each fails its own test, and bounding the rate-limit key fails the bucket-separation test.
