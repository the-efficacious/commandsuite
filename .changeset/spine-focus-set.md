---
'csuite-server': minor
'csuite-sdk': minor
'csuite-cli': minor
'csuite-web-ui': minor
---

The spine's focus set (D9): the team's shared boundary of what is lit
for travel now — a curation rule made of permissioned annex events, not
a UI filter. Agents plan against it because the curator and the
permission make it true.

- **Membership is an annex event.** A new authoritative kind `focus`
  (`{contract, lit, reason}`) lights or unlights a contract, authored on
  the record with a reason. It carries op_id idempotency and the
  state_rev precondition like any authoritative act. A `spine_focus`
  projection is folded from it and rebuilds identically from the stream.
- **A single leaf, `spine.focus`,** distinct from `spine.author`:
  authoring states what the world must become, curating the focus set
  decides which contracts are the ones to travel to now. Reading the set
  is baseline — `orient` marks each binding in or out of focus, and
  `GET /spine/contracts?focus=true` returns the whole lit plate (finding
  8's allocation view) — so only lighting is gated.
- **The curator honours it.** Class-3 silence is now
  `parked ∪ waiting_for ∪ out-of-focus`: a contract outside the focus set
  generates no class-2 subscription deltas and earns no recovery nudge,
  while staying fully in the annex, in the listing, and in its owner's
  queue. Focus gates class 2 (ambient) and **never** class 1 (addressed)
  — an ask naming you, a verdict on your contract, a contract ending
  under you all reach you out of focus. The gate is inert while nothing
  is lit, so a team that has not adopted focus is unaffected.
- **The focus-set-running-dry interrupt.** When the last lit contract
  leaves the set — by an unlight or by going terminal — a class-1 line
  reaches the allocators (the `spine.focus` holders), gated on the phone
  by `focus` in the interrupt whitelist, which joins the team default.
- **A `focus` tool** for agents (gated on `spine.focus`), a Board focus
  view (the team plate for holders, the in-focus filter over their own
  bindings for everyone else), and an in-focus marker wherever a
  contract is drawn.

DECISIONS:

- **One kind with a `lit` boolean, not two kinds.** Entering and leaving
  the set are the same act in opposite directions; the projection is a
  set, so a direction flag is the smallest surface and keeps the fold
  trivial.
- **`focus` is authoritative and bumps the contract's state_rev.** The
  brief called for an authoritative kind, and it buys op_id idempotency
  (which ambient kinds cannot carry) and a class-2 "entered/left focus"
  delta. It follows the uniform authoritative path — precondition +
  counter advance — rather than a special case, because the invariant
  "authoritative ⟺ carries a precondition and advances the counter" is
  load-bearing. The cost is that lighting a contract can make a
  concurrent in-flight write stale; that write reads the focus event in
  the refusal delta and retries, and curation is rare.
- **The focus filter is mode-based, not per-contract-unlit.** A contract
  is out-of-focus when the focus set is non-empty and it is not lit —
  lighting a subset dims everything else, which is what "sprints agents
  obey" and "the team's boundary" require. When the set is empty the
  filter is off and everything flows, which is also what preserves every
  phase-3 curator guarantee (those scenarios never light anything).
- **The effective focus set is `lit ∧ non-terminal`.** A lit contract
  that reaches `done`/`cancelled`/`superseded` leaves the effective set
  (it is no longer travel) even though its membership row stays lit —
  which is what lets running-dry fire on a completion, not only an
  unlight. Parked counts as still in the set (on the plate, resumable).
- **Re-lighting the lit, or unlighting the unlit, is refused** rather
  than recorded as a no-op event. The projection is a set; a focus event
  that would not flip membership changes nothing a reader could act on,
  and refusing keeps the row and the stream from ever disagreeing. (A
  lost write still replays for free through the op_id ledger — a replay
  resolves before any structural check runs.)
- **Running-dry recipients are the `spine.focus` holders, not "members
  whose whitelist includes it".** The whitelist gates the phone (§9), not
  recipient selection; addressing by permission avoids injecting the
  line into every agent's session on the team default. The whitelist
  still gates the phone for those holders.
- **Running-dry is edge-triggered from in-memory state**, like the
  sweep cursor: a restart re-reads current emptiness rather than
  re-firing, and an already-empty set says nothing.

Settled during independent verification, and recorded here because a
decision that lives only in a review comment is the thing this whole
subsystem exists to stop:

- **One definition of "in focus", applied everywhere.** The listing, the
  `inFocus` flag and the curator's gate all read `lit ∧ non-terminal`.
  `inFocus` was raw membership and is now the effective set — a
  behaviour change on the wire, and the right one: a lit contract that
  completes can never be unlit (every authoritative act on a terminal
  contract is refused, `focus` included), so raw membership welded
  finished work onto the allocator's plate with no act able to clear it,
  on the path the design calls normal.
- **Membership is judged AT ARRIVAL, not as of the sweep tick**, exactly
  as contract state already was. A set read once per tick answers a
  question about the END of the tick that the events in it were never
  asked: an event that landed while nothing was lit was retroactively
  silenced by a later lighting, and the event taking a contract OUT of
  the set was silenced by its own effect — so the "left focus" delta
  mostly never fired. A focus event is never silenced by the membership
  it changes; entering and leaving the push are both news.
- **The membership read is a function of the sweep window, not of the
  team's history.** It is read off the `spine_focus` projection and
  UNDONE back to the window's start: every focus event flips membership
  (one that would not is refused), so inverting the events at or after
  the window's first seq is exact, and the store's own row supplies
  everything older. A contract that ended inside that region is put back
  into the seed by name — it left the effective set with no event to
  mark it — and `focusMembership()` answers that one question, asked
  about the few contracts that ended rather than listing every lit row,
  because the lit rows accumulate one per contract the team ever
  completed while lit.

  This replaces a read that reconstructed membership by walking the
  focus stream from seq 0 on every tick, with a ceiling of 20 pages ×
  500. Past 10,000 focus events it froze the team's membership
  mid-history — silently, in the OVER-silencing direction, and with no
  recovery, because every tick restarted from the same cursor and hit
  the same wall ten seconds later. An earlier version of this note
  claimed that read "pages to exhaustion"; it did not, and the code
  comment saying so was wrong in the same way. **A read with a bound has
  to say what the bound is**, and if the answer is "it truncates", that
  is the defect and not the documentation.
- **Reading the set is baseline; changing it takes the leaf.** The new
  `focus_set` tool exists because D9 claims agents plan against the set,
  and an agent that can only be silenced by a boundary it cannot read is
  not planning against it.
- **`focusSet()` and `focusMembership()` are one concept each.** The
  effective set is `lit ∧ non-terminal` and is what every wire surface
  and the curator's gate serve; raw membership is the lit row and is
  asked about BY NAME, never listed, so no caller can accidentally take
  a set the size of the team's history and do per-row work on it.
- **The arms of the at-arrival rule each got their own fixture.** Three
  of the four were unguarded: nearly every fixture swept after each act,
  so the window was one event and the roll-forward never ran, and the
  focus-event exemption only bites when a DARK contract is lit while
  another is lit, which nothing drove. Where two events share a tick
  they share an injection, so the new fixtures assert the RENDERED line
  (`1 event(s): lifecycle`) — a row count cannot tell "the ending was
  delivered" from "the ending and everything behind it were".
