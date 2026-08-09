---
'csuite-server': minor
'csuite-sdk': minor
'csuite-web-ui': minor
---

The spine's human seat: the director's Queue and Board in the web UI,
the four one-tap acts, and the interrupt whitelist over the existing
web push. Everything four phases recorded becomes, here, something a
human can see and act on.

Two properties govern the phase, both from §9/§6 of the design:

- **Visiting is not handling.** Opening a queue item advances no
  receipt and no lease — only the four typed acts change queue state.
  `GET /spine/queue` is a **separate, receipt-neutral read** rather than
  `orient` (which advances a receipt per phase-3 decision 13): the route
  never touches the curator. Proven with a byte-snapshot test (the
  reader's receipt/leases are unchanged after the read, with orient as
  the positive control) and mutation-checked.
- **The whitelist gates the phone, not the queue.** Every addressed
  item is always in the durable queue (a free read) and every class-1
  line still reaches a live session over the WS fanout; the interrupt
  whitelist only decides which class-1 kinds *also* buzz a phone — the
  rarest budget. Conflating the two would be #155's finding 1 in a new
  place.

What landed:

- **The four human acts (SDK):** `spineDictateRuling`, `spineDefer`,
  `spineDecline`, `spineRedirect` — client methods over the existing
  append route, each one event, each minting an `opId` so a tap is
  idempotent on retry. There is deliberately **no agent tool**: these
  are the human's surface, the tool schema's counterpart for a member
  whose runner is a browser.
- **The Queue read (server):** `GET /spine/queue?member=` — open asks
  where I am the authority (each carrying question, context and
  `unblocks` verbatim plus the whole contract it is about, so an act can
  send that contract's `state_rev` without a second call) and contracts
  in `waiting_on(me)`. Deferred asks are excluded: a defer re-arms an
  ask and it leaves the queue until its trigger fires.
- **The Queue UI (web-ui):** the read rendered, the four acts as inline
  forms, an item leaving only when its resolving event lands — every act
  reloads from the annex, there is no local dismissed-set — and the WS
  fanout re-reads the queue (receipt-neutrally) on a `spine_injection`.
- **The interrupt whitelist (server + web-ui):** a per-member curator
  policy field (`interruptWhitelist`), edited via `PUT /spine/curator`
  and a web-ui control, wired so a class-1 delivery whose kind is on the
  member's whitelist rides the existing `dispatchPush` / `shouldPush`
  path to a phone — no second push path, and the live-subscriber and
  sender rules still hold. `proceeding` gained a class-1 arm addressing
  the ask's authority, so the director default (`ask`, `proceeding`)
  reaches a phone for a proceed past their ask.
- **The Board (web-ui):** lifecycle lanes (active / waiting / parked,
  done and cancelled filtered by default) and a relationship view (mine
  as assignee / verifier / authority / originator), pulled from state
  and presence — no status-text entry anywhere. #155 finding 8 at the
  granularity the data supports today.

Also closed the two phase-4 carry-forwards: the annex writer is now a
real `#writer` private field (a type-only `private` was reachable by a
cast that bypassed the post-commit hooks), and the two egress guards
are exercised on the real path — E3 against `createPinnedFetch`'s
empty-pin refusal, E4 spying the secrets store to prove a refused
destination never resolves a credential.

DECISIONS (smallest-surface answers taken where the design left a gap):

- **Queue shape:** each ask item carries the whole `SpineContract` it is
  about (or `null`), not the id — because defer/decline/redirect are
  authoritative writes on that contract and must carry its `state_rev`,
  and handing the id alone would make the queue a screen a member cannot
  act from without a racy second call. The ruling act binds no contract
  by default (so it needs no precondition and simply resolves the ask).
- **Browser routes** are `/spine` (queue) and `/spine/board`, *not*
  `/spine/queue` — that path is the API's own read, registered ahead of
  the SPA fallback, so a browser navigation there would return JSON.
- **`proceeding` → the ask's authority** is a new class-1 arm. §9's
  director default names "a proceed on an irreversible subject", and a
  proceeding was addressed to nobody before; addressing the authority
  (the member asked to rule, released from a decision by a party who is
  not them) makes the default non-vacuous. The focus-set-running-dry
  trigger §9 also names stays out — the focus set is phase 6.
- **The interrupt whitelist lives on the policy row** (a JSON column,
  with a guarded `ALTER` for older dev DBs) rather than a sibling table:
  it is one more piece of the same per-member attention policy, tuned
  the same way and carrying the same updated-by/at trail. `NULL` is the
  team default; a stored array (empty included) is an authored choice.
- **The whitelist is a wholesale set, never a patch** — `[]` ("never
  buzz me") is a legitimate, meaningful choice, so `undefined` means
  leave it and `[]` means clear it.
- **The queue preload swallows a 404** in the shell boot: a deployment
  with no spine is a configuration, not a failure worth a banner.
