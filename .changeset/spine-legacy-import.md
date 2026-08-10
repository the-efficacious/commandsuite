---
'csuite-server': minor
---

`csuite-import-objectives` — a one-shot, idempotent import of the legacy
objectives record into the spine's annex as `provenance:
legacy_projection`, permanently. Run it explicitly against a database;
it prints what it imported and, in the same breath, what it deliberately
did not.

#155 names the migration as the highest-risk step in the whole design,
and names why: backfilling a **typed** field from an **untyped** source
manufactures exactly the claim class the annex exists to remove.
`revision: abc123` reads identically whether it was observed from a
review event or scraped out of a sentence somebody typed at 3am, and
once it is a field nobody can tell which it was ever again. So the
mapping is deliberately lossy in the direction of honesty: only what was
typed becomes typed, everything else that was recorded is carried as the
prose it always was, and where the spine's schema would require a field
the legacy record does not contain, the fact is left unimported and said
so. An empty field is a true statement; a derived one is not.

**Never imported, each a rule rather than an omission.** No revision of
any kind — no SHA is scraped from a title, an outcome or a thread, and
the spine having no revision for legacy work *is* the honest state. No
verdict — a legacy completion had none, and the imported specification
names no verifier, which is both true (nobody held the role) and why the
store's completion-coverage gate asks for none. No criteria
decomposition: the outcome becomes **one** criterion carrying the
outcome text verbatim. No watchers, because subscription is reader-side
and a watcher list cannot be turned into one without recreating the
fanout finding 1 is about. No focus, curator state, receipts or leases —
nobody chose any of it, because the old system had no such concept.

**DECISIONS.**

- **One synthetic subject, `legacy:objectives` (type `doc`),** registered
  once per import, with every imported specification bound to it.
  Per-objective subjects are not invented and repo/PR names are not
  parsed out of prose: a subject is registered, not guessed.
- **The 7-second race is preserved as a race.** Legacy discussion posts
  are broker messages on thread `obj:<id>`, in a different table from
  the typed lifecycle rows, so an importer walking the tables in turn
  would give every post a higher `seq` — and `seq` is the order a reader
  pages in. The one instance #155 names by hand is a verdict-bearing
  post that arrived **seven seconds before** the cancellation that talks
  past it; in table order the record would read as though its author was
  answering a decision already taken. Every mapped row is sorted on its
  recorded instant instead. The cancellation's false reason and the
  finding it missed are both imported whole, and a member reads the
  contradiction — a migration that resolved it would be deciding which
  of two recorded facts is true.
- **Legacy `blocked` does not become `waiting_on`.** That state requires
  the member being waited on; the legacy record names none, and reading
  a name out of a free-text block reason is exactly the sentence-scrape
  the design refuses. `waiting_for` needs an event and a check nobody
  authored, and `parked` needs a preemption nobody named. So an open
  objective imports `active` and the block reason is carried whole as
  prose.
- **Legacy `reassigned` does not become a typed act,** because the spine
  has none: `assignee` is written by the specification fold and no event
  moves it. The contract carries the **current** binding (it decides
  whose `orient` the work lands in) and every assignment and
  reassignment is carried beside it in the thread. Both readings are
  available; neither is invented.
- **Amendments are unrolled, not guessed.** A legacy `amended` event
  records the text as it was *before* it and never after, so the chain
  is walked backwards from the row as it stands today. The specification
  is authored at the original text and each amendment carries it
  forward, landing on exactly the title and outcome the row holds. It is
  a fold over recorded values: every string it produces was written down
  by somebody, either in the row or in a `previous` map. What CONSTRAINS
  it is the assertion on the reconstructed ORIGINAL text — the round
  trip alone does not, because the unroll and the replay are inverses
  and an error in one is cancelled by the same error in the other.
  Measured, after an earlier draft of this line claimed otherwise. The
  prior text rides along in `disclosure`, which is what §10 means by
  *contamination is disclosed, never erased*.
- **A required prose field the record never carried gets a marked
  sentinel,** not a manufactured claim: a cancellation with no recorded
  reason imports as `[legacy objectives import] the cancellation
  recorded no reason`. That is a statement about the record, verifiable
  against it, and unmistakably the importer's rather than the
  canceller's. Dropping the event was the alternative and it is worse —
  it would render an ended objective as live work.
- **Two idempotency mechanisms, because one cannot cover everything.**
  Authoritative events carry an `op_id` derived from the legacy row
  identity; `discussion` is ambient and the schema gives ambient kinds
  no `op_id` at all, so the importer keeps its own ledger of every
  legacy row it consumed. Rows predating the legacy `event_id` column
  fall back to a rowid, so idempotency across a `VACUUM` is not
  guaranteed for those — the summary counts them rather than leaving the
  bound unstated.
- **A separate binary rather than a boot flag,** taking a database path
  and nothing else. An import wired into startup runs on a schedule
  nobody chose, possibly mid-incident, with nobody reading the summary.
  Taking a path directly is also what makes the command drivable — and
  therefore its exit status and its streams assertable.
- **The write path is constructed bare, with no curator hooks.** Running
  the curator's post-commit hook over a year of history would spend
  every member's album re-delivering events that already happened.
- **A store refusal is recorded, never fatal.** Legacy data was written
  under different rules — nothing stopped an objective being amended
  after it was cancelled — and a migration that dies on the first row it
  cannot place imports nothing. Every refusal lands in the summary with
  the store's own message.

Legacy projections never acquire native status; a correction to a legacy
fact is a new native event citing it, never an edit of it.

**The provenance rule is now a constraint, not a claim.** A SQLite
trigger refuses any update to `spine_events.provenance`, in both
directions — a legacy projection never acquires native status, and a
native event is never relabelled as history. The events table's header
already said nothing updates a truth row and no code path can; that was
true, and it was a claim about *that module*, which is the wrong scope
for this rule. The caller it has to survive is a migration holding a raw
handle, written by someone who has read neither the comment nor §13 —
and the whole point of the import is that such code exists and will be
written again. The compile-time half sits beside it: there is no
`promoteToNative`, no update taking a `provenance`, and no
"finish-the-migration" sweep on the surface, each asserted with
`@ts-expect-error` so the absence cannot rot into a comment. Correcting
a legacy fact is untouched and is the only honest form the fix can take:
a new native event that cites or staples to the legacy one, leaving it
exactly where it is.
