---
'csuite-server': minor
'csuite-sdk': minor
'csuite-cli': minor
---

The team's process is held as one authored document, injected into
every member's fixed context, with an append-only record of who
changed it, why, and what the text was before.

Four process rules were adopted on 2026-07-31/08-01 and all four lived
only in a director-to-lead DM and in broadcasts. No member other than
the lead knew any of them, and a member whose context had cleared knew
none. Broadcast is the first thing compaction discards; fixed context
survives it.

- **One document, not N rules.** A list of rulings is a changelog
  wearing the costume of a specification — it says what decisions were
  made and leaves the reader to compose "how we work" from the pieces.
  It also only ever accumulates, so the injected block grows without
  bound. A document gets *edited*: superseded content leaves.
- **`process.manage`, a dedicated leaf, granted to nobody on ship.**
  Under this shape the permission *is* the authority — whoever holds
  it rewrites what binds the team — and "can create an objective" is
  not a comparable power, so reusing `objectives.create` would have
  been a quiet escalation. Who holds it is a deliberate decision.
- **One write path for create and edit.** The first authorised write
  produces version 1 with a real author and reason, so history begins
  at a real edit rather than at a migration inventing the text — and
  the invariant validator is exercised through the real endpoint.
- **The validator takes the constructed document and cannot see the
  delta.** A delta cannot express an invariant about a whole record.
- **One derived field list** drives what the edit API accepts, what the
  history record holds, and what the field enum names.
- **One transaction** around the document move and the history append.
- **`disposition` is #79's field with #79's meaning**, so *does work
  started under the old process finish under it* has one answer across
  contracts and process.
- **Absence renders as an explicit line, never as nothing.** Rendering
  nothing collapses "no document exists", "runner too old to read the
  field" and "broker without the feature" into one state a member
  cannot decompose — it makes the healthy case wear the costume of the
  broken one.
- **A real ceiling**: `PROCESS_DOCUMENT_MAX` is 16384, on the basis
  that the document is resident in every member's context in every
  session, so its length is a recurring cost paid by everyone.

Agent surface as well as HTTP — `process_document_get` and
`process_document_history` ungated, `process_document_write` gated. The
member holding this permission on a team like ours is an agent, so an
HTTP-only capability would satisfy the requirement for humans and for
nobody who actually holds the authority.

The document rides in its own briefing field. The durable reason is
authority separation, not the instruction cap: a member authors their
own `instructions`, this is authored by whoever holds `process.manage`,
and one string collapses two authorities into one field. The cap
argument that also motivated it has already expired — #122 landed in
#129 — and the decision is unchanged.
