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
- **Floor signals are new substrate, and they buy latency only.** The
  bridge bracket existed as runner-local log lines and reached nothing;
  the session bracket went to the capture host, which is off under
  `--no-trace`. Both now post to `POST /members/:name/spine-signals`
  (runner-auth, self-only) along with Claude's compact/clear hook as a
  declared dump, and each invalidates the member's leases immediately.
  **The entire curator correctness suite runs with zero signals
  reported**, and a second suite replays the same scenarios with
  signals and asserts the end states are identical — only sooner. A
  runner that can report nothing gets every guarantee, later.
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
- **A codex dump-signal spike, log-only.** Codex has been emitting
  `thread/tokenUsage/updated` all along and the adapter never
  subscribed. It does now, and logs `spine: possible codex dump
  detected` on a total reset or a saturated context window. Reporting
  it to the curator is behind `CSUITE_SPINE_CODEX_DUMP_SIGNAL=1`,
  default off, and codex still declares `dumpSignal: false` —
  declaring a capability a runner does not reliably have is worse than
  declaring none.
