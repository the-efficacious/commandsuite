---
'csuite-server': minor
'csuite-sdk': minor
---

The team's spine: an append-only annex of captioned events, the
subjects they are about, and the contracts folded out of them —
reachable at `/spine/*`, with `orient` as the one call a member makes
when their context is gone.

The premise is that agents ship with professionally engineered context
handling and lose all of it without warning. What only a live
application can hold is the in-action process state — who owns what,
under which contract, what was ruled, what changed while you were
away — and the defining property is not storage but the guarantee of
re-orientation.

- **Two counters.** `seq` is the global stream cursor, gapless because
  nothing ever deletes, so a reader that has seen seq N has seen
  everything up to N. `state_rev` is per contract, advanced only by
  authoritative events on it, and required as a precondition on every
  state-changing write. A busy thread can never veto a lifecycle act
  and a lifecycle act can never sneak past a verdict it did not see.
- **The refusal is the recovery channel.** A stale precondition comes
  back with the intervening authoritative events *in full*, not a
  count and not a hint. Staleness is never detected; it is discovered
  by the member at the first act where it matters, and the refusal is
  delivered at exactly that moment on any runner.
- **Idempotency on `op_id`.** Same id and same payload replays the
  original event and appends nothing; a different payload is refused.
  `expected_state_rev` is deliberately excluded from payload identity —
  it is a precondition, not content, so a caller retrying after reading
  the delta still means the same write.
- **No bare derived values.** A revision is `{value, how, source, at}`
  or it is not a revision: *"verified at abc123"* cannot be serialized
  without *"observed at 03:19 from the GitHub review event"* riding
  along. Only `observed` revisions move a subject's head, so one
  member's assertion cannot rewrite everyone else's staleness.
- **Legitimacy is structural, not granted.** A verdict from the
  assignee is refused — arrival cannot be declared from the traveller's
  own album — and a ruling from anyone but the ask's named authority is
  refused. Neither is a weakly-authorised act; neither is the act.
- **Completion cannot outrun its evidence.** With a verifier named,
  `done` must cite verdicts, or rulings waiving a `cannot_verify`,
  covering every criterion at one revision, and the refusal names each
  gap. With no verifier, the result stands alone and says so.
- **Nothing is removed and nothing is retargeted.** Corrections staple
  to any event including a terminal one; amendments version; the room
  moving under a contract is answered by supersession, which links a
  successor and leaves the old journey terminal at its own revision
  with its verdicts intact.
- **No cap that punishes precision.** Durable prose carries a single
  1 MiB sanity bound, documented as a bound and not a budget; the
  largest real cap in the system belongs to `discussion`, the cheapest
  event, because conversation that is expensive gets routed around.
- **Projections are folds and nothing else writes them**, including
  the `state_rev` bump. `rebuildProjections()` drops every projection
  and refolds the stream, and a test asserts a rebuilt projection
  equals the incrementally maintained one — which only means something
  because no projection state is maintained outside the fold.
- **One permission leaf, `spine.author`,** gating contract authoring
  and amendment. Reading the annex, posting an attempt, returning a
  verdict, raising an ask and discussing are baseline participation and
  need no grant.

Correctness rests only on the floor — delivered messages, tool calls,
session lifecycle — never on a runner choosing to reveal its context.
A CI fixture holds that from day one: the spine imports no trace,
capture, telemetry or gen-ai module, and the scanner that checks it is
tested in both directions.

Phase 1 is the store, the routes and the SDK. The MCP tool surface,
the curator, probes, the human queue and citation-lock enforcement at
the tool layer come next; the store already records what they need.
