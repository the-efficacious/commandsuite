---
'csuite-server': minor
'csuite-cli': minor
'csuite-sdk': minor
---

The spine's curator: what enters whose album, and when. Leases,
receipts, four injection classes, and the recovery injection the runner
fires when a member's context falls off.

The annex is where the spine's correctness lives; this is where it is
felt. "It re-orients me" versus "it spams me" is entirely curator
policy, so the policy is **data** — subscription levels per member per
contract and cadence bounds, held as rows with an updated-by/at trail
and changed at runtime over `GET`/`PUT /spine/curator` or the new
`subscribe` tool. Tuning attention allocation never means shipping.

- **Four injection classes, enforced.** Class 0 is the Guaranteed Pack,
  and it reaches an album because a member (or their runner) *called*
  `orient` — the server never pushes a pack. Class 1 is an act that
  named you: an ask to you, a verdict on your contract, a ruling on
  your ask, a redirect. Neither consults a subscription level, so a
  member who set every contract to `none` still gets the ask that named
  them. Class 2 is reader-side and batched per sweep tick, so a busy
  contract cannot spam a subscriber. Class 3 is silence — a parked or
  waiting-for contract generates nothing, and there is a test proving
  four hours of it produces zero pushes.
- **No full re-sends.** A class-1 or class-2 line carries an id, a
  title, what changed, and a cursor. Never the criteria, the question,
  the reasoning or the outcome. Issue #155 measured what re-sending a
  whole objective on every event costs; the answer is that a pointer
  and the cheapest call in the system suffice.
- **Leases age out by time AND by acts.** A member's own append proves
  they hold what it names, so the write path renews their lease for
  free — no round trip, no signal, no runner cooperation. An expired
  lease buys at most one cheap line pointing at `orient`, and only when
  there is authoritative movement they have never read.
- **Receipts advance on reads and on nothing else.** `orient`,
  `annex_read`, a by-id read, an explicit ack. A curator push cannot
  move one, and the type is where that is enforced rather than a
  comment: there is no `push` member of the union and no second entry
  point. Visiting is not handling, structurally.
- **Class 1 also carries the transitions that end an obligation.** A
  `lifecycle` event moving a contract to `done`, `cancelled`,
  `superseded` or `parked` addresses that contract's assignee and its
  named verifier, and nobody else. Four states, two recipients, and it
  is what makes `none` genuinely safe rather than nearly safe for the
  people carrying the work: without it, the argument for defaulting an
  assignee to silence had a hole exactly the size of "your contract
  was cancelled underneath you". `active` and the waiting states stay
  class 2 — they are progress reports, they recur, and they are what a
  `lifecycle` subscription is for.
- **Floor signals are new substrate, and they buy latency only.** The
  bridge bracket existed as runner-local log lines and reached nothing;
  the session bracket went to the capture host, which is off under
  `--no-trace`. Both now post to `POST /members/:name/spine-signals`
  (runner-auth, self-only) along with Claude's compact/clear hook as a
  declared dump, and each invalidates the member's leases immediately.
  **The entire curator correctness suite runs with zero signals
  reported** — enforced behaviourally, by asserting after every test
  that no lease was ever invalidated, not by a name check a rename can
  defeat.

  Stated precisely, because the slogan version is overstated: *no
  correctness property depends on a signal; a signal may spend at most
  one additional nudge; the owed end state is identical.* The middle
  clause is a real divergence — a member who was going to read on
  their own in five minutes, whose runner declares a dump at one
  minute, gets a line they would otherwise never have got. That costs
  one pointer at `orient`, it is bounded at one however many signals
  arrive, and it is a named accepted-divergence test rather than
  something argued away.
- **Recovery is gated on the annex, never on the curator.** The runner
  tracks the two endpoints' availability separately: a 404 from the
  floor-signals route disables only signal reporting, and only an
  `orient` 404 disables recovery. A single shared flag made a broker
  with an annex and no curator — a configuration this repo's own test
  suite constructs — silently stop recovering after the first bridge
  attach, and made it a race besides.
- **Recovery is one code path.** The runner calls `orient` on the two
  triggers it already had and injects what comes back through
  `renderOrientPack` — the same renderer the `orient` tool uses, so a
  member recovering after a compaction reads exactly what they would
  have read had they called the tool. It also reaches a member with an
  empty plate, which the old re-brief skipped: "you are bound to
  nothing right now" is a real answer, and silence is
  indistinguishable from a broken runner. The objectives re-brief is
  untouched and both fire independently until the cut-over.
- **The ledger.** `GET /spine/injections` answers "what did the system
  spend of my album this week" — member, class, kind, refs, cursor,
  instant, byte size, and whether the sink accepted it. No body column:
  the ledger accounts for spend and does not archive it, because
  keeping the text would make the audit trail a second place a
  member's traffic can leak from. Self-or-`members.manage`, unlike the
  annex's open reads, because a member's ledger is the closest thing
  here to a description of their working day.
- **Curator state is not annex events.** Five operational tables that
  could be dropped whole without falsifying a single fact about the
  team. A lost lease costs one redundant re-orientation; a lost annex
  event is history falsified.

## Decisions, on the record

The design is explicit that the record should be settled and attention
negotiated. Leaving the load-bearing choices in a report would be the
wrong direction on a phase about exactly that, so they are here.

1. **A nudge takes both counters, and they are deliberately different
   counters.** The lease says "we have stopped assuming you hold
   this"; the receipt says "here is how far you have demonstrably
   read". A nudge is owed where those disagree with the annex. Driving
   it off the lease's own seq instead would mean a member who is
   pushed a class-1 line and then loses their context is never nudged
   — the push moved the lease, and pushes are precisely what must not
   count as reading.
2. **A receipt is a watermark, so only a watermark-establishing read
   moves it.** `orient` (composed at a cursor) and a page read
   (through its *last returned* seq, never `headSeq`). A by-id read
   moves nothing: it proves one event was seen and nothing about the
   events below it, and it is the natural response to a class-1 line,
   which hands the member an event id. `ReceiptVia` has no
   `event_read` member, so this is not a decision a future caller can
   re-make by accident.
3. **A nudge is one per lease EPOCH, and a member's return starts a new
   one.** Proven liveness — a read, an append, or a session bracket —
   re-arms. Without it a nudge attempted at an offline member was
   spent forever, because the flag clears only on a lease grant and a
   grant needs a confirmed delivery: the member who could not be
   reached was exactly the member never reached again, which is
   permanent dark for the opaque-runner population this design is for.
4. **Silence is evaluated at the state a contract was in when an event
   ARRIVED**, not the state it ended in. The lifecycle event that
   parks a contract reaches its subscribers; everything after it does
   not.
5. **A restarting curator starts its sweep cursor at the annex head.**
   It must not replay every delta since the team began. The cost is
   stated rather than hidden: a crash between the annex COMMIT and the
   class-1 push loses that line permanently. That is acceptable only
   because class 1 is *scheduling, not delivery* — "never yields"
   means it is never suppressed by a subscription, not that it is a
   delivery guarantee — and the member's next `orient` carries the
   event regardless. Nothing in the annex is lost either way.
6. **A lease is recorded on confirmed delivery** (`delivery.live > 0`),
   never on "the member exists". A lease on the latter would claim an
   offline member holds something nothing ever handed them.
7. **Class-2 defaults**: `lifecycle` for the contract's originator,
   `none` for everyone else — assignee, verifier and authority
   included, because what binds them arrives as class 1.
8. **The append hook has one call site and that is an invariant**, held
   from outside by a scanner. A second annex write path would be a
   write whose addressees are never told, and it would be invisible:
   the annex would be perfectly correct and the member would simply
   never hear. Phase 4's probe engine must route through the same
   hook.
9. **The curator's ledger is system state.** Auditable, never truth
   about the room — the annex records member acts, the curator records
   what it spent of whose album.
- **A codex dump-signal spike, log-only.** Codex has been emitting
  `thread/tokenUsage/updated` all along and the adapter never
  subscribed. It does now, edge-triggered, and logs `spine: possible
  codex dump detected` on three shapes: a total reset, a collapsing
  `last`, and a saturated window. Only the first is ever reported, and
  only behind `CSUITE_SPINE_CODEX_DUMP_SIGNAL=1` (default off) —
  reporting a saturated window would be reporting a forecast as an
  event, since by the spike's own account nothing has been discarded
  yet. Codex still declares `dumpSignal: false`: declaring a
  capability a runner does not reliably have is worse than declaring
  none.

  The open question is written down rather than assumed. `total` reads
  like a cumulative *billing* counter, in which case a reset there is
  a thread restart and not a compaction, and the shape that should
  track a compaction is `last` collapsing while `total` keeps
  climbing. That shape is measured — logged, never acted on — because
  a spike that only records the shape it already believed in returns
  its own assumption.
