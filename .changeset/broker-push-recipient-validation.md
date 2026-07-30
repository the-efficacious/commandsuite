---
'csuite': minor
'csuite-cli': minor
'csuite-core': minor
'csuite-sdk': minor
'csuite-server': minor
'csuite-web-host': minor
'csuite-web-ui': minor
---

Validate `Broker.push`'s `to` so the broker cannot emit a `Message` its own schema rejects.

`push` copied `payload.to` into `message.to` unchecked, so a `csuite-core` caller could
make the broker produce a message that `csuite-sdk`'s `MessageSchema` refuses to parse —
one published artifact disagreeing with another. Confirmed by execution against the
fetched `0.2.0` tarballs: `push({to: 'chan:general'})` emitted `to: 'chan:general'` and
`MessageSchema.safeParse` returned `invalid_format` at path `to`. `push` now rejects with
`InvalidRecipientError` (exported from `csuite-core`) before the message is constructed or
appended to the event log.

The schema is the correct artifact here and `push` is the wrong one, which is the opposite
of the `FsEntry.owner` call. `chan:` is a *thread* prefix carried in `data.thread`, never a
recipient: channel sends leave `to` unset and pass the member list in
`PushContext.recipients`. The live broker log agreed — 959 events, eight distinct `to`
values, all member names or null, none the schema would reject.

Fixing it surfaced a second and more serious defect on the same line. `to: ''` is falsy, so
`payload.to ?? null` sent it down the `registry.allStates()` branch: a message addressed to
one recipient was delivered to **every registered member**. Measured on the pre-change
broker with three members registered — all three received it, `targets: 3`. That is why
this rejects rather than coercing an unparseable name to null; the lenient repair *is* the
empty-string path, generalised.

**This prevents the condition; it does not repair a log that already has one.** The
validation stops new rows being written and there is no migration — a `Message` with an
invalid `to` already in an event log stays there. That matters more than it sounds,
because `HistoryResponseSchema` is `z.array(MessageSchema)` and a single invalid element
fails the whole array: one bad row breaks every `/history` response whose window includes
it, taking the valid messages in that window with it, for as long as the row exists. So a
consumer who already has one upgrades and sees `/history` still failing, and the fix looks
like it did not work. Measured on our own broker: 959 events, zero rows the schema would
reject, so nothing here needs repairing — but that is a statement about this deployment,
not about anyone else's.

**This is breaking for direct `csuite-core` consumers.** `PushPayload.to` is typed
`string | null | undefined`, and some strings that type admits are now rejected at runtime.
Two things bound it. Anyone this breaks was already producing invalid messages — a caller
passing `to: 'chan:general'` today gets a `Message` that no schema-validating consumer can
parse. And the HTTP plane is unaffected: `/push` already validates the body with
`PushPayloadSchema`, whose `to` is `NameSchema.nullable().optional()`, so a bad recipient
was rejected with a 400 before it ever reached the broker. The empty-string broadcast was
never reachable over the wire.

Released as a minor under the repository's pre-1.0 convention. **The same change becomes
major the day we ship 1.0.** No protocol bump — the wire format is unchanged, and
`protocol.ts`'s rule is about what crosses the wire.

Not covered: whether other `Broker` entry points emit values their schemas reject. This
fixes one instance and the enumeration is not part of it.
