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
- **The write path is structural now.** `AnnexStore`, the type every
  consumer receives, no longer has `append`; the write-capable
  `AnnexWriter` is named by exactly one module, which wraps it in a
  path that dispatches a registered hook list post-commit. The curator
  and the probe engine both register there. Phase 3 held "one append
  caller" with a regex over receiver names, which could not have seen
  a new module holding the store under a new name — precisely what the
  probe engine is.

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
