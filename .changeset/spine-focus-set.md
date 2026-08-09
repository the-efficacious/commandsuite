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
