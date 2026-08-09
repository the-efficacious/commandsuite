---
'csuite-server': minor
'csuite-cli': minor
'csuite-sdk': minor
---

The spine's probe engine: the system pressing a button a member
composed. Checks born from the events that carry them, webhook and
poll recipes, and two discharge shapes that close work nobody had to
notice.

The system cannot take photographs — it has no judgement about what
matters. What a member can do is author a **recipe**, and the system
can press the button on schedule. Results land as `observation` events
with `actor: probe:<check-id>` and `authored_by: <the member>`: the
member composed the shot, the system held the camera, and the caption
says both, permanently.

- **A check is authored inside the thing it discharges.** There is no
  `check_author` tool and no `POST /spine/checks`, and that is the
  design rather than a gap: a check that could be authored on its own
  could outlive its reason, and withdrawing the reason would leave it
  armed. The carriers are an `ask` carrying `check`/`trigger`, an
  `ask_action{defer}` carrying a `trigger` (the ask comes back armed),
  and a `lifecycle` moving a contract to `waiting_for(event, check)` —
  all fields that already existed and were stored for exactly this.
  Withdrawing the ask, ruling on it, or moving the contract off
  `waiting_for` disarms the check with it.
- **The recipe is JSON in the field that already carried prose, and the
  predicate is the inbox's.** A field whose first non-space character
  is `{` is read as a recipe and validated; anything else is prose,
  arms nothing, and is refused by nothing — a member writing "when CI
  goes green" gets exactly what they got before. `when` is
  `NotificationFilterRule[]`, evaluated by the same `applyFilters` the
  webhook inbox has used since it shipped, over exactly these
  payloads. A second predicate dialect would have doubled the edge
  cases around `exists`, empty arrays and coercion, and made a member
  guess which one they were writing.
- **Two recipe kinds.** `webhook` arms on the existing inbound
  endpoint registry, tapping deliveries the inbox has already verified
  and de-duplicated. `http_poll` is an outbound GET on an interval,
  with pins refused **at authoring** rather than at fire time —
  `https://` only, no redirects followed, a response size cap, no
  request body, a 60s minimum interval, and an auth secret named by
  **slug** and resolved server-side *as the check's author*. Arming a
  probe cannot borrow access its author does not have, and no token is
  ever written into a permanent event. A pin checked later would fail
  silently, hours on, into a log — and a check that quietly never
  fires cannot be told apart from a world that never did the thing.
- **A poll cannot be pointed at the deployment's own network.** A probe
  fetches from the SERVER, attaches the author's secret, and writes the
  response into a permanent observation every member can read — so
  `https://169.254.169.254/…`, `https://10.0.0.5` or
  `https://vault.internal:8200` would be a server-side request forgery
  with a durable, team-readable exfiltration channel attached, reached
  by an ordinary act of authorship. Three layers, because each alone is
  bypassable: an IP literal in a private, loopback, link-local, CGNAT,
  multicast or reserved range is refused **at authoring**; a NAME is
  resolved at fire time and **every** address it answers with is
  checked (a name that does not resolve is refused, not attempted); and
  the connection is **pinned** to the addresses that were checked,
  because resolve-then-fetch is a time-of-check/time-of-use bug and DNS
  rebinding is its standard defeat. TLS is untouched — SNI and
  certificate validation stay bound to the authored hostname. The
  escape hatch is `CSUITE_SPINE_PROBE_ALLOW_HOSTS` on the **server**,
  empty by default; an allowlisted host is still resolved and still
  pinned.
- **Discharge, two shapes.** A check firing on a `waiting_for`
  contract appends the lifecycle back to `active` **citing the
  observation** — nobody nagged, nobody had to notice, and no human was
  in the loop at any point. A check firing on an ask closes it as
  `discharged` with the observation **stapled** to it, and the asker
  gets one class-1 line naming the observation; the authority's queue
  item goes away without the authority typing. That is the armed-
  setting class of ask: the human does the thing and types nothing,
  because the probe is the confirmation.
- **A predicate that says no produces nothing.** Not an observation
  with a negative result, not a note in the stream: nothing. A
  photograph is taken when the shot the member composed comes out, not
  on every shutter test, and an annex full of "still not green" would
  be the status-text wall the design forbids, generated automatically.
  The only trace is a last-evaluated stamp in the registry.
- **One fire per arming.** A fired check is terminal and points at its
  observation, so "did the thing I armed actually happen" is a lookup
  with exactly one answer rather than a history to interpret. The
  claim is a single conditional UPDATE taken before the engine's first
  `await`, so two deliveries in one tick cannot both take it.
- **A probe can author nothing but observations.** The store's
  structural checks now bind the actor as well as the act:
  `probe:`-actored writes are `observation` plus exactly one lifecycle
  shape — to `active`, from `waiting_for`, citing that probe's own
  firing observation — and nothing else, because everything else in
  the registry is a judgement and the system has none. The other half
  of the same rule: a **member** may not set `authoredBy`, which is
  the caption that says a photograph was composed by someone other
  than whoever took it. Both are refused at the store, so a future
  caller that never passes a route inherits them; the narrow list is
  also a type, so inside the engine a probe-authored verdict does not
  compile.
- **And a probe observes rather than asserts.** A `probe:`-actored
  event may only caption itself with an `observed` revision. `asserted`
  is a member naming a value by hand — authored intent, which §10
  forbids the system to produce — and it is not cosmetic: only observed
  revisions move a subject's head, so an asserted one from a probe
  would be the system claiming the world is at a state nobody looked
  at, with every contract bound to the real head rendering stale
  against a fiction. Refused at the store and unrepresentable in the
  engine's own request type.
- **The discharge tells the authority too, when the asker armed the
  check.** The asker always hears — the thing that unblocked them
  happened in the world, so nothing else would tell them. The authority
  hears when they did not arm it themselves: their queue item vanished,
  resolved, by a mechanism they never saw and did not choose. When the
  authority armed it by deferring with a trigger, the asker alone
  hears, because the queue item going away is the thing the authority
  asked for.
- **The write path is structural now, at runtime and not only in the
  types.** `AnnexStore`, the type every consumer receives, no longer
  has `append`; the write-capable `AnnexWriter` is named by exactly one
  module, which wraps it in a path that dispatches a registered hook
  list post-commit. The curator and the probe engine both register
  there. Phase 3 held "one append caller" with a regex over receiver
  names, which could not have seen a new module holding the store under
  a new name — precisely what the probe engine is.

  A type-level claim about an object is defeated by one cast, so the
  object handed out is a genuine frozen facade carrying only the read
  methods: `(path.store as unknown as { append }).append(…)` now
  returns `undefined` and throws, rather than reaching the annex and
  bypassing every hook. The scanner was widened to match: a namespace
  import of the store module and a dynamic import of it are grants on
  their own, since neither names a symbol.

## Decisions, on the record

1. **The recipe is JSON, not a grammar.** The carrier fields are prose
   in permanent events, so a recipe has to be a string. A surface
   syntax of our own would have been a second predicate language with
   its own quoting rules, escaping bugs and `exists` semantics, for a
   member population that writes JSON fluently. Evaluation is
   `applyFilters` verbatim; the only new vocabulary is the recipe
   envelope.
2. **`{` means "recipe", and everything else means prose.** A member
   who writes JSON has asked the system to press a button and is
   refused at the keyboard if the instruction cannot be carried out; a
   member who writes a sentence is describing a trigger to their
   colleagues and is refused by nothing. Both halves are the same rule
   and neither works alone.
3. **The webhook tap sits after verify and dedupe, before filters and
   debounce.** Not after the endpoint's filters, because those belong
   to its notification targets — an endpoint whose filter dropped a
   payload would otherwise silently disarm every check armed on it, and
   a member's check would depend on somebody else's routing config.
   Not after the debounce, because debounce is an attention device and
   a check is evidence; holding evidence for a coalescing window would
   put the wrong instant on a permanent observation.
4. **The re-light produces no class-1 line.** §7 says nobody nagged.
   `active` is a report on progress, it recurs, and it is what a
   `lifecycle` subscription is for; the assignee discovers it at their
   next `orient` like every other movement of the room. The ask
   discharge does send one, because there the thing that unblocked the
   asker happened in the world and nothing else would ever tell them.
5. **A check id is derived from its carrier event, not minted fresh.**
   The id becomes an actor — `probe:<check-id>` on every observation it
   fires, in the annex forever — so a refolded registry that minted new
   ids would orphan every historical caption and silently lose every
   `fired` state.
6. **A fire that cannot record its evidence disarms rather than
   re-arms.** A check that claimed the shutter and could not write what
   it saw is a camera that failed, not one waiting for another chance;
   re-arming it would let the same failure produce a duplicate
   photograph the moment it stopped failing. Re-arming takes a new
   carrier event, which is the rule the whole registry runs on, and the
   reason is recorded on the row.
7. **The check registry is a projection.** Everything but
   `lastEvaluatedAt` is derivable from the event stream, and
   `rebuildChecks()` refolds it through the same function that arms it
   live — a second implementation would be a second set of rules that
   could disagree.
8. **The annex now stamps events with the app's injected clock.** Every
   other time-driven thing in the server already ran on it, and an
   annex stamping wall-clock instants beside them made two halves of
   one system disagree about what time it was. The probe engine's
   interval arithmetic compares a check's caption against that clock,
   so the disagreement was not cosmetic.
9. **A REDIRECT does not disarm a check.** Withdrawing the ask,
   declining it and ruling on it all do; a redirect does not, because
   it re-addresses the question rather than resolving it — the question
   is unchanged, unanswered, and now in front of somebody else, and the
   world doing the thing still answers it. Recorded because a reader
   assumes the opposite: "the ask moved, so the arming moved with it"
   is the natural reading, and it would silently drop the check at the
   one moment the asker is least likely to be watching.
10. **A poll's destination policy lives in server config, never in the
    recipe.** An exception carried in the request would be a member
    authorising their own exception in the same breath as making it. It
    is an env var rather than team config for the same reason one step
    further out: team config is editable over the wire by anyone
    holding `team.manage`, which would put the exception back within a
    member's reach. Exact hostnames, never suffixes — a suffix match on
    `internal.example.com` admits `evil.internal.example.com`, which an
    attacker can register.
11. **The transport carries the approved addresses rather than a
    hostname.** A transport that resolved the name itself would undo
    the egress check however carefully the check was written, so the
    pin is a parameter of the interface: any replacement — a
    deployment's egress proxy, a test's script — is handed the same
    addresses and is accountable for the same property. It is also why
    the seam is not `typeof fetch`: `fetch` has no supported hook for a
    custom lookup, so a fetch-based poll is rebindable by construction.
12. **The transport and the egress policy default to safe.** The first
    version made both options that `run.ts` never passed, so production
    ran on global `fetch` with no pin at all while the fixture header
    described an egress hook nobody had wired. A security control that
    is only present when a composition root remembers to wire it is a
    security control that is absent.
13. **A member's staple does not discharge, and does not spend an
    album.** Stapling an observation to an ask is a legitimate act and
    is what stapling is for — but only a `probe:` actor's staple
    resolves the ask, and only a probe's staple addresses anybody.
    Without the second half, a member could spend another member's
    never-yields class-1 budget with a line that says "discharged"
    about an ask that is not.

## Known gaps, recorded rather than fixed

- **A check killed by a transient annex failure is queryable but not
  surfaced.** Decision 6 disarms a check whose fire could not record
  its evidence, with the reason on the row and readable at `GET
  /spine/checks`. Nothing pushes it: the member who armed it finds out
  by looking. That is the right trade for phase 4 — the alternative is
  a class-1 line about the system's own plumbing — but "a check I armed
  quietly died" deserves a surface, and the human seat in phase 5 is
  where it belongs.
- **A check's recipe is served whole**, including `authSecret`. That is
  a slug and never a value, so nothing sensitive is disclosed today; if
  secret slugs ever become sensitive, this read needs a gate.
