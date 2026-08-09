---
'csuite-cli': minor
'csuite-server': minor
'csuite-sdk': minor
---

The spine's tool surface: fourteen MCP tools over the annex, and the
citation lock that binds them. Members now reach the record the way
they reach everything else — through tools whose schemas are the law
and whose refusals are the product.

`orient` is the recovery call and the cheapest thing in the toolbox:
no arguments, no preconditions, no way to be refused, and the reason
to call it stated in its first two sentences, because the moment it is
needed most is the moment there is least context left to read with. It
returns every contract binding you, its criteria with the verdicts
reached on them, the revision it sits at and whether that revision is
behind the world, the rulings that bind it, the asks awaiting you, and
a cursor into everything else.

- **The citation lock.** While a member has an unresolved ask on a
  subject — or on any subject *containing* it — the annex refuses
  their state-changing acts there until they cite a ruling on that ask
  or record a `proceed` past it. This is the one hard gate in a
  warn-never-lock design, and it passes the reversibility test:
  acting on a ruling that does not exist is the class of act you
  cannot cleanly walk back. The wording is the feature. "Cite a
  ruling" reads as a formality to a member who believes they have one,
  so the refusal states the absence flatly and first — *you do not
  have a ruling on it* — then names both exits. Proceeding is
  legitimate and always available; what is refused is inventing an
  answer nobody gave.
- **It binds the asker, never the authority**, or asking someone would
  become a way to stop them working. One `proceed` covers that actor
  on that ask until it resolves rather than tolling every write, and a
  different open ask needs its own. Containment is walked upward, so a
  repo-level ask reaches a file inside it and a file-level ask does not
  freeze the repo. An ask naming only a contract is scoped by that
  contract's subject — §5's required fields for an ask do not include
  a subject, so the commonest ask there is would otherwise have bound
  nothing at all.
- **Refusals render in full, never capped.** A stale write comes back
  with every authoritative event the caller missed, rendered event by
  event with its captions and its whole body; a coverage gap comes
  back with every uncovered criterion and why it is uncovered; the
  citation lock comes back with the ask itself — question, context,
  what it unblocks — and the scope that was searched. The refusal is
  the re-injection, delivered at exactly the moment stale beliefs would
  have caused harm, so truncating it to keep a tool result tidy trades
  the guarantee for the appearance of one.
- **`promote` produces the typed object.** A discussion post becomes
  the event it turned out to be: the post's text carries into that
  kind's principal field, the caller supplies whatever else the kind
  demands, and the synthesised event cites the post as its origin — so
  the record shows where the decision actually happened instead of
  presenting it as having arrived fully formed. It is a real event of
  that kind and is held to every rule that kind carries, including the
  lock. Nothing has to be retyped to be counted, which is the whole
  reason the conversation is allowed to stay cheap.
- **Two tools are gated on `spine.author`** — authoring and amending a
  contract. The other twelve are baseline participation: a member who
  cannot record what they did cannot be held to anything, and gating
  the record only produces work that happens off it.
- `GET /spine/events/:id` serves one event by id, because promoting a
  post means reading it and paging a stream that only grows is a scan
  that gets slower forever.
- The composed instructions gain a compact spine section teaching
  three things a frozen prompt has to hold — where to go when context
  is gone, the one gate that refuses rather than warns, and that
  talking is free. The objectives section is untouched; cut-over is a
  later phase.
