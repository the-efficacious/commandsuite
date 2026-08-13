# csuite-web-ui

## 0.7.1

### Patch Changes

- Updated dependencies []:
  - csuite-sdk@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies []:
  - csuite-sdk@0.7.0

## 0.6.0

### Minor Changes

- [#185](https://github.com/the-efficacious/commandsuite/pull/185) [`c9e4a85`](https://github.com/the-efficacious/commandsuite/commit/c9e4a85707581d4325a24a17d4fbd880ea88136d) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - One objective permission and one mutation surface. `objectives.manage`
  replaces the four-way `objectives.create` / `.cancel` / `.reassign` /
  `.watch` split — no deployment ever granted those separately — and
  existing configs and stored presets written under the old vocabulary
  load unchanged through a legacy-alias map. `objectives_reassign` and
  `objectives_watchers` fold into `objectives_update` (and their routes
  into `PATCH /objectives/:id`, gated per field group): agents see seven
  objective tools instead of nine. `blockReason` is now optional when
  blocking — field data showed real blocks carried in prose because the
  ceremony was heavier than the signal.

- [#181](https://github.com/the-efficacious/commandsuite/pull/181) [`1dd4d23`](https://github.com/the-efficacious/commandsuite/commit/1dd4d23eb112f703d04ffcd985246145ded50f6b) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Let the broker compact or clear a member's agent context without
  restarting it, and report what actually happened.

  The broker could already see a member's context drift — the context
  watchdog distinguishes present from missing from stale — but every
  mechanism it had was additive. It could make a context larger and
  measure that it had gone wrong; it had no verb for making it smaller.
  A degraded member had two remedies: the agent deciding to compact on
  its own, or a full restart that drops the runner's MCP wiring and
  takes the member off the net.

  - **`POST /members/:name/context`** with `verb: 'compact' | 'clear'`,
    delivered on the member stream the same way instruction edits are.
    Neither verb ends the session: the broker subscription, the IPC
    socket the MCP bridge reconnects to, the objectives tracker and the
    capture host all outlive both.
  - **`clear` re-uses the drain-and-restart path** — wait for the turn
    to finish, detach ambient input so events buffer for the successor,
    refetch instructions, respawn — and differs in exactly one input:
    the successor does not resume. Adapters previously treated a null
    session id as "resume the most recent session anyway", so respawn
    now takes an explicit `RespawnPosture` and starting cold is no
    longer expressible by accident.
  - **`compact` is cooperative and says so.** The agent does the
    summarising, so the request can be declined. Every request produces
    exactly one `context_control` activity event: `applied`, `declined`
    (with the framework's own reason, verbatim), `unsupported`, or
    `failed`. A request that produces no outcome stays visibly
    outstanding rather than aging into a success nobody observed.
    Both runners implement both verbs — claude by injecting the slash
    command and reading the compaction status, codex via
    `thread/compact/start` acked by its `contextCompaction` item. Only
    claude reports token deltas; codex's completion item carries no
    accounting, so those are omitted rather than invented.
  - **New `members.context` permission**, separate from
    `members.manage`: interrupting a teammate's live work is a
    different power from administering the roster. Controlling your own
    context needs no permission at all.

- [#179](https://github.com/the-efficacious/commandsuite/pull/179) [`69c250a`](https://github.com/the-efficacious/commandsuite/commit/69c250adae48a280c6cc5f1c029e003f3155b1c6) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Give the web UI a runner-environment surface, so the identity rows that
  moved out of the secrets store stop being invisible to humans.

  Splitting variables from secrets fixed the trace-redaction defect and
  left the web UI showing only half the runner environment: `SecretsPanel`
  listed secrets, the migrated `GIT_AUTHOR_*` / `GIT_COMMITTER_*` rows
  were reachable on the API, CLI and MCP surfaces, and an operator opening
  the panel saw a shorter list with nothing to say where the rest went.

  - **Secrets nav → Environment**, one panel over both stores. They share
    one env-var namespace and the broker enforces it across both, so a
    collision raised while editing a secret names a _variable_ — an error
    a secrets-only panel could not display.
  - Separate labelled sections rather than one merged list, because which
    store a value lives in decides whether it is scrubbed from captured
    traces. Creating an entry requires picking a kind, with no default,
    and each choice states its trace consequence.
  - A variable's value is shown; a secret's is still write-only. "Set but
    not shown" renders differently from "not set", so a configured
    variable can never read as missing.
  - Every view lives under `/environment`, including the per-kind detail
    routes (`/environment/secrets/:slug`, `/environment/variables/:slug`).
    They stay per-kind because a slug is unique per store, not across the
    pair. The prefix is not cosmetic: the broker registers its REST routes
    before the SPA fallback, so the obvious `/secrets/:slug` is answered by
    the API and returns 401 JSON on a reload or a shared link. That was
    already true of the old secret detail route; it is fixed here.

  Classification is carried by the design system's lamp signals rather
  than by a badge — a secret reads `nominal` (contained), a variable reads
  `caution` (recorded verbatim) — on the section heading, the create form's
  kind choice, and the detail banner. Content is held to a readable
  measure, and controls are sized to the data they hold rather than to the
  window.

  There is no convert action between the stores, and the secret detail
  view says so: a secret's value is write-only, so a delete-and-recreate
  needs the original value to hand.

- [#185](https://github.com/the-efficacious/commandsuite/pull/185) [`c9e4a85`](https://github.com/the-efficacious/commandsuite/commit/c9e4a85707581d4325a24a17d4fbd880ea88136d) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Remove the objective contract-versioning layer: `objectives_amend`,
  `objectives_correct_event`, their routes and SDK methods, contract
  version stamping, and the amendments record on the objective. Built in
  response to a single run's incidents, never used since — and that run
  itself served the same need with a reasoned cancel plus a fresh
  objective, which is now the documented remedy. Old databases keep
  reading cleanly: `amended` / `event_corrected` stay in the event-kind
  schema as legacy read-only kinds, and `objectives_view` renders such
  historical rows as ordinary log lines.

### Patch Changes

- [#186](https://github.com/the-efficacious/commandsuite/pull/186) [`42aeb5f`](https://github.com/the-efficacious/commandsuite/commit/42aeb5f73c8033e8245bd5f4dba6e94ef4e768ef) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Redesign the objectives UI around how the work actually reads. The
  list is now a grouped ledger: live work on top (blocked first, sorted
  by last activity, with per-row age and unread-post badges), closed
  work collapsed behind a disclosure, an All/Mine filter, and a header
  that counts live work instead of the whole record. The detail page
  drops its five tabs for one page: the outcome leads, and once the
  objective is done it pairs side-by-side with the result — the result
  card carrying the view's one gold assert bar. Lifecycle events and
  discussion now merge into a single chronological thread with humanized
  event lines instead of a raw JSON audit log. Actions are verbs in the
  header: completing opens the result editor next to the outcome it
  answers, blocking no longer demands a reason (matching the server),
  and cancelling takes a second explicit press. Trace review stays
  admin-only behind a disclosure. All three objective views now sit on
  the same page measure as the rest of the product — the ledger at the
  panel measure, the detail and create form at the record measure.

- [#179](https://github.com/the-efficacious/commandsuite/pull/179) [`69c250a`](https://github.com/the-efficacious/commandsuite/commit/69c250adae48a280c6cc5f1c029e003f3155b1c6) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Hold Home, Inbox, Members, Tools and Notifications to a readable
  measure, so panel content stops stretching to the window on a wide
  display.

  The runner-environment views took a measure when they landed; every
  other panel still ran edge to edge, which on a wide monitor left stat
  tiles a third of a screen apart and help lines running past 1600px.

  The constraint lands on the scroll container's children rather than on
  a wrapper, because the scroller owns the scrollbar and the page
  background. It is opt-in per panel — the nav rail uses the same
  scroller and its items are meant to fill it.

  Two widths, chosen by what the view is: an INDEX (1080px) earns its
  width from rows that carry data to the right edge; a RECORD (780px) is
  one entity's fields, where the widest control is a name. Tool-source
  and notification detail take the record measure.

  `MemberProfile` is deliberately excluded. Its header sits outside the
  scroller and its tab content is a fit-content card, so centring the
  children strands the card mid-window instead of aligning it to a
  column. It needs a real wrapper element, which is a structural change
  rather than this one.

- Updated dependencies [[`c9e4a85`](https://github.com/the-efficacious/commandsuite/commit/c9e4a85707581d4325a24a17d4fbd880ea88136d), [`1dd4d23`](https://github.com/the-efficacious/commandsuite/commit/1dd4d23eb112f703d04ffcd985246145ded50f6b), [`c9e4a85`](https://github.com/the-efficacious/commandsuite/commit/c9e4a85707581d4325a24a17d4fbd880ea88136d)]:
  - csuite-sdk@0.6.0

## 0.5.1

### Patch Changes

- [#175](https://github.com/the-efficacious/commandsuite/pull/175) [`beb2a19`](https://github.com/the-efficacious/commandsuite/commit/beb2a1931c5dfd9e8d3d6bce1a97a803f2bb1633) Thanks [@keencaliper](https://github.com/keencaliper)! - Render chat messages with full GFM markdown.

  Chat previously used a hand-rolled renderer covering three constructs
  (`**bold**`, `*italic*`, `` `code` ``). Everything else agents emit
  natively — headings, lists, tables, blockquotes, fenced code, links —
  arrived as literal punctuation. The file-preview surface already
  rendered full GFM through `marked` + `DOMPurify`, so the same document
  looked different depending on which surface you opened it in.

  Chat now uses that same pair. Two properties of the old renderer are
  kept deliberately, because `marked`'s defaults break both: raw HTML
  stays escaped, and `<channel …>` envelopes get syntax colouring rather
  than markdown.

- [#174](https://github.com/the-efficacious/commandsuite/pull/174) [`2c772c8`](https://github.com/the-efficacious/commandsuite/commit/2c772c8a04b57c12463913c92a1d88186c1790b7) Thanks [@keencaliper](https://github.com/keencaliper)! - Fix a thread switch opening the new chat partway up rather than at its
  newest message.

  `Transcript` re-renders on a thread switch, it does not remount, so every
  ref inside `useStickyBottom` survived the switch — including the one
  recording that the viewer had scrolled up. Follow stayed disengaged into
  the next thread, and the browser preserves `scrollTop` across a children
  swap, so the new thread opened at the offset the previous one left
  behind: as far in as the previous chat was long.

  `useStickyBottom` now takes a `resetKey`, mirroring `useWindowedList`,
  and `Transcript` passes `threadKey`. "The user chose to read history" is
  a fact about the list they were reading and no longer outlives it.

- Updated dependencies []:
  - csuite-sdk@0.5.1

## 0.5.0

### Minor Changes

- [#145](https://github.com/the-efficacious/commandsuite/pull/145) [`6c35f83`](https://github.com/the-efficacious/commandsuite/commit/6c35f8346605bd9d0c939b5e93606dc3c1147ffa) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Adopt the Helm design system from `@the-efficacious/brand`.

  The web shell's entire visual layer now resolves through the brand
  package's `--ef-*` role tokens — the legacy token vocabulary (`--ink`,
  `--paper`, `--steel`, `--ember`, …) is gone, along with the local token
  block and the dusk-mode remap in `theme.css`. Breaking contract changes
  for hosts and integrators:

  - **Theme attribute**: the shell now drives `data-ef-theme` on `<html>`
    (`helm` dark is the `:root` default; `helm-light` is the light theme).
    `data-theme` is no longer set. The `csuite:theme` localStorage
    contract is unchanged, but `auto` is now stored explicitly and the
    unset default is **dark** — Helm is dark-native.
  - **Utilities**: hosts compiling atomic utilities must compose
    `@the-efficacious/brand/uno`'s `efficacious()` preset after
    `presetWind4()`. The hand-rolled `brand-*` colors and breakpoint
    overrides are gone; breakpoints come from the shared scale
    (700/900/1100/1280).
  - **Sender colors**: `senderTextClass(kind)` replaces
    `senderTextClass(sender, viewer)` — the axis is person vs agent
    (Helm plate 14), resolved from the roster. `Teammate.kind?: 'person'
| 'agent'` is new in the SDK; servers derive it from TOTP enrollment
    and omit it when unknown.
  - **Identity tiles**: `.avatar` is now the plate-14 square tile
    (`data-kind`, `data-size` 20/26/34/48/64, optional `.avatar-dot`
    presence lamp). The `sm/lg/xl/dark/ember` modifiers are gone.
  - **Badges**: `.badge.ember` → `.badge.caution`, `.badge.glacier` →
    `.badge.info`; `.btn-accent` is removed (use `.btn-destructive` for
    stop actions). Lamp components pick up the five-state grammar,
    including `working` and `stood-down`.
  - **CLI**: activity printers and the HUD paint Helm roles (lamp grammar
    for connection state; the gold mark on the `csuite` word).

  Brand tokens and fonts ship transitively via `csuite-web-ui/styles.css`;
  the served UI (`csuite-server`'s `public/`) also exposes them at
  `/brand/*.css` for server-rendered pages.

- [#136](https://github.com/the-efficacious/commandsuite/pull/136) [`294d857`](https://github.com/the-efficacious/commandsuite/commit/294d857242d3e3cd47d4cef594c5193c30d1c773) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - feat(web-ui): surface restart-pending live (roster badge, TeamHome banner, member admin card replacing the static restart warning), add a team-process panel with view/edit (reason + disposition, process.manage-gated), clamp long standing prose behind a Show all toggle, and refresh packet + roster on `kind: 'instructions'` events

### Patch Changes

- [#136](https://github.com/the-efficacious/commandsuite/pull/136) [`294d857`](https://github.com/the-efficacious/commandsuite/commit/294d857242d3e3cd47d4cef594c5193c30d1c773) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - chore: complete the instructions vocabulary across every surface — code identifiers, MCP tool descriptions (which now state the real edit mechanics: fanout + restart at next idle), web-ui store, READMEs, and docs. Persisted diagnostic cause ids and changelog history keep their original spellings.

- [#146](https://github.com/the-efficacious/commandsuite/pull/146) [`9593188`](https://github.com/the-efficacious/commandsuite/commit/959318883f411d42ef98bd5adcc9249807ded94e) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - feat: grant `process.manage` to the seeded admin and surface it in the permissions editor. The leaf shipped held by nobody — a deliberate control — which left the team-process section invisible on every fresh install; compounding it, the web UI's permission grid had no `PERMISSION_META` entry for the leaf, so it could not be granted from the UI at all. The wizard's withheld list is now empty (new teams seed the bootstrap admin with every leaf; existing teams are untouched — presets seed once, at genesis) and the permissions editor lists `process.manage`, with a parity test so a future leaf cannot ship checkbox-less again.

- Updated dependencies [[`6c35f83`](https://github.com/the-efficacious/commandsuite/commit/6c35f8346605bd9d0c939b5e93606dc3c1147ffa), [`294d857`](https://github.com/the-efficacious/commandsuite/commit/294d857242d3e3cd47d4cef594c5193c30d1c773), [`294d857`](https://github.com/the-efficacious/commandsuite/commit/294d857242d3e3cd47d4cef594c5193c30d1c773), [`9593188`](https://github.com/the-efficacious/commandsuite/commit/959318883f411d42ef98bd5adcc9249807ded94e)]:
  - csuite-sdk@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies []:
  - csuite-sdk@0.4.1

## 0.4.0

### Minor Changes

- [#115](https://github.com/the-efficacious/commandsuite/pull/115) [`94bee08`](https://github.com/the-efficacious/commandsuite/commit/94bee08d593c4aac56aaf563d7d1b2865bce405e) Thanks [@keencaliper](https://github.com/keencaliper)! - An objective's contract can be amended, and the correction lives in the
  record rather than in a message beside it.

  Measured motivation: `obj-ms9kcbqc-2` is `done` and its `outcome` field
  still contains a criterion struck on 2026-07-31 for asserting a
  security consequence that does not occur. The durable field makes a
  false claim and the retraction is a chat message.

  - `POST /objectives/:id/amend` changes `outcome`, `title` and/or `body`.
    Requires `objectives.create` — the gate is the permission, not the
    role, so an assignee holding it may amend their own contract.
  - Append-only: the superseded text is kept on an `amended` event and
    surfaced as `Objective.amendments`. An amendment that changes nothing
    is rejected rather than recorded as a version bump.
  - Every amendment states a `disposition`. `correction` binds
    retroactively — work was never validly held to the prior text;
    `scope_change` is forward-only. The amender states it because it
    cannot be inferred from the text.
  - `outcomeVersion` increments per amendment and is stamped on every
    subsequent lifecycle event, so "which contract was this built
    against" is a field on the completion rather than a reconstruction
    from timestamps.
  - `POST /objectives/:id/correct-event` corrects an earlier lifecycle
    event by superseding it; the original is never rewritten. Motivating
    case: a completion recorded at a PR head rather than a merge SHA.
  - Amendments render with the record on all three surfaces —
    `objectives_view`, the web UI objective detail, and the channel
    envelope agents read — including an inline marker on a corrected
    event so reading the log top-down cannot mislead.

### Patch Changes

- [#129](https://github.com/the-efficacious/commandsuite/pull/129) [`a00f59e`](https://github.com/the-efficacious/commandsuite/commit/a00f59e71c68ef7a9fef5ff16ecda709e0217066) Thanks [@sureforge](https://github.com/sureforge)! - Remove length caps from team context, role descriptions, personal instructions,
  and composed briefings. Show character counts and explicitly approximate token
  estimates on the web, CLI, and agent administration surfaces, and warn when an
  oversized briefing is requested by a runner that may still enforce the former
  8192-character client-side limit.
- Updated dependencies [[`c0e1b89`](https://github.com/the-efficacious/commandsuite/commit/c0e1b8974c795b91001fa45a8b5c4b2174af0ed9), [`94bee08`](https://github.com/the-efficacious/commandsuite/commit/94bee08d593c4aac56aaf563d7d1b2865bce405e), [`e5a9210`](https://github.com/the-efficacious/commandsuite/commit/e5a9210991b00871656e2cda6a0dd28722a6facf), [`d384bff`](https://github.com/the-efficacious/commandsuite/commit/d384bff9d97ac222fb2fcf022d84e26c6da18a00), [`a00f59e`](https://github.com/the-efficacious/commandsuite/commit/a00f59e71c68ef7a9fef5ff16ecda709e0217066)]:
  - csuite-sdk@0.4.0

## 0.3.5

### Patch Changes

- Updated dependencies []:
  - csuite-sdk@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies []:
  - csuite-sdk@0.3.4

## 0.3.3

### Patch Changes

- [#66](https://github.com/the-efficacious/commandsuite/pull/66) [`1d618e4`](https://github.com/the-efficacious/commandsuite/commit/1d618e491a9630662b3cdef8afdf9b4f7322d2a5) Thanks [@sureforge](https://github.com/sureforge)! - Keep id-bearing turns visibly unmatched when their exact inference record never arrives, instead of attaching a compatible neighbouring record by interval containment.

- Updated dependencies [[`5f638aa`](https://github.com/the-efficacious/commandsuite/commit/5f638aa670267c4cdc8472cf86b61ba0d0d38e51), [`676f315`](https://github.com/the-efficacious/commandsuite/commit/676f31504a4afd7dae0483a55e1d14a1c3ef934b), [`40e5513`](https://github.com/the-efficacious/commandsuite/commit/40e55138e45c4a610f111896f95ad3bed8052a23)]:
  - csuite-sdk@0.3.3

## 0.3.2

### Patch Changes

- [#58](https://github.com/the-efficacious/commandsuite/pull/58) [`6800958`](https://github.com/the-efficacious/commandsuite/commit/6800958da90dbe87e89a1a49f6976b18f6e4177f) Thanks [@sureforge](https://github.com/sureforge)! - Correct package authorship metadata to identify Efficacious, Inc.

- Updated dependencies [[`6800958`](https://github.com/the-efficacious/commandsuite/commit/6800958da90dbe87e89a1a49f6976b18f6e4177f)]:
  - csuite-sdk@0.3.2

## 0.3.1

### Patch Changes

- [#54](https://github.com/the-efficacious/commandsuite/pull/54) [`abd080f`](https://github.com/the-efficacious/commandsuite/commit/abd080fee68039e6afb9e19b4ace8264b97ee3fd) Thanks [@keencaliper](https://github.com/keencaliper)! - Make objective namespaces usable: fix `FsEntry.owner` and the `list()` authorization gate.

  Two defects, both live since objective namespaces shipped, and both needed for the feature
  to work at all.

  **1. `FsEntrySchema.owner` was `NameSchema`.** Objective-namespace entries carry
  `owner = 'obj:<id>'` (`OBJECTIVE_OWNER_PREFIX`, `files/paths.ts`), and `NameSchema`'s
  pattern excludes `:`. So every namespace entry failed the schema that ships alongside the
  code producing it.

  The failure mode is the part worth remembering: **validation runs on the response, after
  the write has committed.** `fs_write` and `fs_mkdir` reported an error for work that had
  already succeeded — an agent that retried hit a collision on a file it was told it never
  wrote, and one that gave up left a file it did not know existed. `fs_rm` alone appeared to
  work throughout, because it returns void and parses nothing. The only namespace operation
  an agent could complete and be told the truth about was the destructive one.

  `owner` is now `FsOwnerSchema` — a member name **or** `obj:<objective-id>`. Widened rather
  than changing the producer: `obj:<id>` is part of the shipped authorization model, not a
  malformed name. That is the opposite call from `Broker.push`, where nothing legitimate
  produced the rejected value and the producer moved instead.

  **2. `list()` gated on `members.manage || ownsPath` and never called `canRead()`.** A
  namespace is owned by `obj:<id>` and by no member, so an ownership test refused every
  member of the objective — including its assignee. `stat`, `read` and `listShared` all
  gated on `canRead`, which already resolves objective membership and grants; `list` was the
  one that did not. This is why `fs_ls /objectives/<id>` returned 403 to the person the
  namespace was created for, and why the whole thing read as a permissions problem rather
  than two unrelated bugs.

  Non-members are still refused. The fix widens who may list, not whether listing is gated.

  The contract test that pinned defect 1 as a KNOWN DIVERGENCE with an inverted assertion has
  been converted to an ordinary `expectMatchesContract()` case, which is exactly what that
  inversion existed to force. A source comment in `runtime/tools.ts` describing both defects
  as live has been rewritten to describe current behaviour — a comment that contradicts the
  code is a defect in its own right.

  Released as a patch: it removes restrictions rather than adding them, and no caller that
  previously succeeded now fails.

- Updated dependencies [[`abd080f`](https://github.com/the-efficacious/commandsuite/commit/abd080fee68039e6afb9e19b4ace8264b97ee3fd)]:
  - csuite-sdk@0.3.1

## 0.3.0

### Minor Changes

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - Validate `Broker.push`'s `to` so the broker cannot emit a `Message` its own schema rejects.

  `push` copied `payload.to` into `message.to` unchecked, so a `csuite-core` caller could
  make the broker produce a message that `csuite-sdk`'s `MessageSchema` refuses to parse —
  one published artifact disagreeing with another. Confirmed by execution against the
  fetched `0.2.0` tarballs: `push({to: 'chan:general'})` emitted `to: 'chan:general'` and
  `MessageSchema.safeParse` returned `invalid_format` at path `to`. `push` now rejects with
  `InvalidRecipientError` (exported from `csuite-core`) before the message is constructed or
  appended to the event log.

  The schema is the correct artifact here and `push` is the wrong one, which is the opposite
  of the `FsEntry.owner` call. `chan:` is a _thread_ prefix carried in `data.thread`, never a
  recipient: channel sends leave `to` unset and pass the member list in
  `PushContext.recipients`. The live broker log agreed — 959 events, eight distinct `to`
  values, all member names or null, none the schema would reject.

  Fixing it surfaced a second and more serious defect on the same line. `to: ''` is falsy, so
  `payload.to ?? null` sent it down the `registry.allStates()` branch: a message addressed to
  one recipient was delivered to **every registered member**. Measured on the pre-change
  broker with three members registered — all three received it, `targets: 3`. That is why
  this rejects rather than coercing an unparseable name to null; the lenient repair _is_ the
  empty-string path, generalised.

  **This prevents the condition; it does not repair a log that already has one.** The
  validation stops new rows being written and there is no migration — a `Message` with an
  invalid `to` already in an event log stays there. That matters more than it sounds,
  because `HistoryResponseSchema` is `z.array(MessageSchema)` and a single invalid element
  fails the whole array: one bad row breaks every `/history` response whose window includes
  it, taking the valid messages in that window with it, for as long as the row exists. So a
  consumer who already has one upgrades and sees `/history` still failing, and the fix looks
  like it did not work. Measured on our own broker: 959 events, zero rows the schema would
  reject, so nothing here needs repairing — but that is a statement about this deployment,
  not about anyone else's.

  **This is breaking for direct `csuite-core` consumers.** `PushPayload.to` is typed
  `string | null | undefined`, and some strings that type admits are now rejected at runtime.
  Two things bound it. Anyone this breaks was already producing invalid messages — a caller
  passing `to: 'chan:general'` today gets a `Message` that no schema-validating consumer can
  parse. And the HTTP plane is unaffected: `/push` already validates the body with
  `PushPayloadSchema`, whose `to` is `NameSchema.nullable().optional()`, so a bad recipient
  was rejected with a 400 before it ever reached the broker. The empty-string broadcast was
  never reachable over the wire.

  Released as a minor under the repository's pre-1.0 convention. **The same change becomes
  major the day we ship 1.0.** No protocol bump — the wire format is unchanged, and
  `protocol.ts`'s rule is about what crosses the wire.

  Not covered: whether other `Broker` entry points emit values their schemas reject. This
  fixes one instance and the enumeration is not part of it.

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - Stop secret lifecycle events leaking into every member's default history feed.

  Secret events are pushed to an explicit recipient set — the members bound to the secret
  plus every `secrets.manage` holder — and that part was already correct. But a fan-out push
  persists `to_name = NULL`, and the default feed returns _every_ `to_name IS NULL` row to
  _every_ viewer. So the live delivery was scoped and the durable readback was not.

  Measured on the live broker before the fix: **27 of 27 secret events were returned to a
  member who was neither bound to any of them nor held `secrets.manage`**, reachable with a
  single `recent` call. The leaked body carries the secret slug, the environment variable
  name, and which member it was bound to — not the value, which is never included.

  `csuite-core` gains `SECRET_THREAD_PREFIX` and `isSecretThread`, and `matchesViewer` now
  excludes `secret:`-tagged rows from the default feed. The SQLite feed query carries the
  same exclusion so the two implementations answer the same question; each has a test
  asserting it.

  Excluded for every viewer rather than only for non-recipients, because the event log has
  no access to secret bindings and should not grow one. Nothing is stranded: `GET /secrets`
  returns per-viewer summaries and `GET /secrets/resolve` returns the caller's own env delta,
  which is the surface built for this. The rows remain in the log for forensics; it is the
  _feed_ that stops carrying them. Live push behaviour is unchanged — the notification is
  still the only signal that a runner restart is needed to pick a secret up.

  Released as a minor under the repository's pre-1.0 convention: it removes rows a consumer
  could previously read, which is behaviour-breaking for anyone who was reading them — and
  anyone who was reading them was reading other members' secret metadata.

  **Not fixed here, and it is larger than this.** The same `to_name IS NULL` feed also
  returns objective discussion threads to members who are not the originator, assignee or a
  watcher. Measured on the same broker: one objective's 31 thread messages are returned to a
  member who is not on it. That is the same defect with a different tag, and it needs an
  entitlement-aware feed rather than a prefix exclusion, because — unlike secrets — objective
  threads have no alternative read surface today. Fixing it inside this change would have
  made a bounded repair unbounded.

  Also unaddressed: `EventLog.tail()` applies no viewer scoping at all. It currently has no
  callers, so it is a latent hazard rather than a live leak.

### Patch Changes

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - Make activity and GenAI range reads losslessly pageable with composite timestamp/id cursors.

  TracePanel now traverses every page before joining activity with GenAI records, member activity pagination preserves rows sharing a timestamp, and GenAI enrichment failures are surfaced while retaining the marker-only fallback. Consumer-side history caps that silently discarded rows have been removed.

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - `FsEntry` now carries `canWrite` — the server's own `canWrite()` answer for the requesting viewer. Clients no longer have to rebuild that rule, and for objective-namespace entries they could not: the owner is `obj:<id>` and the rule includes objective membership, which a client cannot determine for an arbitrary path. The field is optional, so an older server that omits it still parses. The web UI's Delete control now asks rather than inferring, which restores it for objective members who were entitled to it all along.

- [#32](https://github.com/the-efficacious/commandsuite/pull/32) [`ee34ac0`](https://github.com/the-efficacious/commandsuite/commit/ee34ac049fe54c734fac074c94aac13103cb2074) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Replace the ad-hoc Unicode arrows on shell buttons with Lucide icons.

  Directional glyphs (`←`, `→`, `↑`, `↓`, `▲`, `▼`, `›`) were typed straight into button labels and breadcrumbs, so they rendered in the text font rather than from the icon set every other affordance draws from. They now come from the icon registry.

  - `ArrowLeft` / `ArrowRight` / `ArrowUp` are added to `components/icons/index.ts` and re-exported from the package root, alongside the existing chevrons.
  - Back links (Tools, Notifications, Secrets, Objectives, Home), forward actions (`Manage`, `DM`, `Profile`, `View profile`, `Reassign`, `VIEW AGENT`, `Browse files`, `Open Files`), submit buttons (`Create + assign`, `Sign in`), and the `Load older` pagers all render an icon plus a plain-text label.
  - The objective discussion's `Send` button now uses the `Send` icon, matching the composer.
  - Breadcrumb separators and the audit-log / API-call disclosure toggles use `ChevronRight` / `ChevronUp` / `ChevronDown`.
  - `.crumbs` gains inline-flex alignment so a crumb's icon and label share a centre line.

  Non-button arrows are untouched: assignee and delivery meta text, the `in→out tok` usage separator, and the file-type glyph vocabulary (`▸`, `▶`, `◈`, `≡`, `⧉`, `◆`) keep their existing characters.

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - Refuse manual publication unless package payloads were prepared from clean, committed source.

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - Allow two secrets to target the same environment variable for different members.

  Registering a second secret with an env name already in use returned **409 Conflict**,
  because `env_name` carried a global unique index. The rationale in the source was correct —
  _"a member's resolved env map can never carry two values for one variable"_ — but the
  constraint enforcing it was far stronger than the invariant it protected.

  The result is that the per-agent pattern the product is built around was impossible:
  `cora-github-token` targeting `GITHUB_TOKEN` permanently blocked `rune-github-token`
  targeting `GITHUB_TOKEN`, even though no member is ever bound to both. Provisioning a
  second agent with its own credentials failed on the second secret.

  The invariant is now enforced where it can first be violated:

  - **`bind()`** refuses when the member already resolves that variable from another secret.
    This is the real check — binding is the first moment a targeted secret reaches anyone.
  - **`create()`/`update()`** additionally refuse for `allMembers` secrets, which reach
    everyone without a binding and so can collide before any bind happens.
  - **`update()`** re-checks against the audience the secret will have _after_ the patch, so
    widening to all-members or repointing at a new variable can't slip a collision through.

  The global unique index is dropped in the schema DDL (`DROP INDEX IF EXISTS`), which
  migrates existing databases and fresh ones by the same path. Without the drop, an existing
  deployment would keep rejecting the second binding with a raw SQLite constraint error
  instead of a mapped one.

  `POST /secrets/:slug/bindings` now maps `SecretsError` through `mapSecretsError`, so the
  new conflict surfaces as **409** rather than an unhandled **500**.

  **Behaviour that changed, deliberately:** two previously-passing tests asserted the old
  global uniqueness, and both were rewritten rather than deleted — one now asserts that a
  second secret on the same variable is _accepted_, and the update test asserts a conflict
  only once two secrets actually share a member. The store's header docblock stated the old
  rule and has been corrected; a comment that contradicts the code is a defect in its own
  right.

  Released as a patch: it removes a restriction rather than adding or breaking one, and no
  caller that previously succeeded now fails.

- Updated dependencies [[`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c)]:
  - csuite-sdk@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [[`9d22ed2`](https://github.com/the-efficacious/commandsuite/commit/9d22ed2179f5ab81852705485d2692107c7330bb)]:
  - csuite-sdk@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies []:
  - csuite-sdk@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies []:
  - csuite-sdk@0.1.1

## 0.1.0

### Minor Changes

- [#22](https://github.com/the-efficacious/commandsuite/pull/22) [`871122f`](https://github.com/the-efficacious/commandsuite/commit/871122fdab0bfbf5ed3507dc8392903b5ecb9be4) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - `csuite-web-ui` and `csuite-web-host` are now published packages (previously private workspace packages), and both join the fixed version group so the whole published surface releases in lockstep.

  - **`csuite-web-ui`** ships as it always existed internally: TypeScript source (`files: ["src"]`, exports pointing at `src/index.ts`). Build it with your host's bundler — Vite + `@preact/preset-vite` is the reference setup (`csuite-web-host` is the working example). Mount the team view via `<TeamShell>`.
  - **`csuite-web-host`** now builds into its own `dist/` and publishes it (`files: ["dist"]`), so an external host — a managed service, a CDN, any static server — can serve the same TOTP-gated PWA the self-hosted broker ships, straight from the tarball (`csuite-web-host/dist`).
  - **`csuite-server`** owns the copy step now: its build syncs `csuite-web-host/dist` into `public/` (`apps/server/scripts/sync-public.mjs`) instead of web-host writing into the server's tree. No behavior change for server users — the published tarball still ships the built PWA in `public/`.

### Patch Changes

- Updated dependencies [[`8c4a842`](https://github.com/the-efficacious/commandsuite/commit/8c4a842b9e5a4b9f777994cab253d41808d8891c), [`9199dba`](https://github.com/the-efficacious/commandsuite/commit/9199dbafaa3337a9d62c7fd287ae666d90fb4f05)]:
  - csuite-sdk@0.1.0

## 0.0.1

### Patch Changes

- csuite-sdk@0.0.1
