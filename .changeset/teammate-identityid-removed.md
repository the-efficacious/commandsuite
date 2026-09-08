---
'csuite-sdk': minor
'csuite-core': minor
---

`Teammate.identityId` leaves the wire, and `GET /members` stops returning less
to the caller who has `members.manage`.

**Nothing observable changes for a client on the first half.** `identityId` was
declared on `Teammate`, validated as a UUID by `TeammateSchema`, and stored
`NOT NULL UNIQUE` with a backfill migration — and no producer ever populated it.
Not "populated by newer brokers": no response body in the product has ever
carried it, on any endpoint, from any broker. So a client keying on it collected
the entire team under one `undefined` key, silently, because the field was
optional and the doc comment blamed "brokers predating typed offboarding" — a
compatibility problem that cannot exist. The declaration is gone from the type
and the schema; the column, the migration and the server-side `LoadedMember`
field stay, because offboarding still keys on identity. It is not a published
fact, and `members-domain.ts` now says so where the next reader will look.

The second half is a behaviour change. `loadedToMember` did not project `kind`,
so a `members.manage` holder received rows a plain teammate's rows were not a
subset of — and since the consumer rule for an absent `kind` is "render the
neutral (agent) treatment", the management panel would have drawn every human on
the team as an agent had it trusted its own fetch. `GET /members` and
`PATCH /members/:name` now carry `kind` on both branches, from one derivation,
so `Member extends Teammate` is a wire promise rather than a type-layer
convenience.
