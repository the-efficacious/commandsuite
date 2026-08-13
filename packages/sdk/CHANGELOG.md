# csuite-sdk

## 0.7.1

## 0.7.0

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

- [#185](https://github.com/the-efficacious/commandsuite/pull/185) [`c9e4a85`](https://github.com/the-efficacious/commandsuite/commit/c9e4a85707581d4325a24a17d4fbd880ea88136d) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Remove the objective contract-versioning layer: `objectives_amend`,
  `objectives_correct_event`, their routes and SDK methods, contract
  version stamping, and the amendments record on the objective. Built in
  response to a single run's incidents, never used since — and that run
  itself served the same need with a reasoned cancel plus a fresh
  objective, which is now the documented remedy. Old databases keep
  reading cleanly: `amended` / `event_corrected` stay in the event-kind
  schema as legacy read-only kinds, and `objectives_view` renders such
  historical rows as ordinary log lines.

## 0.5.1

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

- [#136](https://github.com/the-efficacious/commandsuite/pull/136) [`294d857`](https://github.com/the-efficacious/commandsuite/commit/294d857242d3e3cd47d4cef594c5193c30d1c773) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - feat!: rename briefing to instruction blocks as a clean wire break (protocol v2) — GET /instructions replaces GET /briefing outright, `Client.instructions()` replaces `Client.briefing()`, responses carry named block descriptors plus a canonical composed-content hash, instruction edits fan out a `kind: 'instructions'` event to every member whose composed text changed, and the roster lists restart-pending members

### Patch Changes

- [#136](https://github.com/the-efficacious/commandsuite/pull/136) [`294d857`](https://github.com/the-efficacious/commandsuite/commit/294d857242d3e3cd47d4cef594c5193c30d1c773) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - chore: complete the instructions vocabulary across every surface — code identifiers, MCP tool descriptions (which now state the real edit mechanics: fanout + restart at next idle), web-ui store, READMEs, and docs. Persisted diagnostic cause ids and changelog history keep their original spellings.

- [#146](https://github.com/the-efficacious/commandsuite/pull/146) [`9593188`](https://github.com/the-efficacious/commandsuite/commit/959318883f411d42ef98bd5adcc9249807ded94e) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - feat: grant `process.manage` to the seeded admin and surface it in the permissions editor. The leaf shipped held by nobody — a deliberate control — which left the team-process section invisible on every fresh install; compounding it, the web UI's permission grid had no `PERMISSION_META` entry for the leaf, so it could not be granted from the UI at all. The wizard's withheld list is now empty (new teams seed the bootstrap admin with every leaf; existing teams are untouched — presets seed once, at genesis) and the permissions editor lists `process.manage`, with a parity test so a future leaf cannot ship checkbox-less again.

## 0.4.1

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

- [#130](https://github.com/the-efficacious/commandsuite/pull/130) [`e5a9210`](https://github.com/the-efficacious/commandsuite/commit/e5a9210991b00871656e2cda6a0dd28722a6facf) Thanks [@keencaliper](https://github.com/keencaliper)! - The team's process is held as one authored document, injected into
  every member's fixed context, with an append-only record of who
  changed it, why, and what the text was before.

  Four process rules were adopted on 2026-07-31/08-01 and all four lived
  only in a director-to-lead DM and in broadcasts. No member other than
  the lead knew any of them, and a member whose context had cleared knew
  none. Broadcast is the first thing compaction discards; fixed context
  survives it.

  - **One document, not N rules.** A list of rulings is a changelog
    wearing the costume of a specification — it says what decisions were
    made and leaves the reader to compose "how we work" from the pieces.
    It also only ever accumulates, so the injected block grows without
    bound. A document gets _edited_: superseded content leaves.
  - **`process.manage`, a dedicated leaf, granted to nobody on ship.**
    Under this shape the permission _is_ the authority — whoever holds
    it rewrites what binds the team — and "can create an objective" is
    not a comparable power, so reusing `objectives.create` would have
    been a quiet escalation. Who holds it is a deliberate decision.
  - **One write path for create and edit.** The first authorised write
    produces version 1 with a real author and reason, so history begins
    at a real edit rather than at a migration inventing the text — and
    the invariant validator is exercised through the real endpoint.
  - **The validator takes the constructed document and cannot see the
    delta.** A delta cannot express an invariant about a whole record.
  - **One derived field list** drives what the edit API accepts, what the
    history record holds, and what the field enum names.
  - **One transaction** around the document move and the history append.
  - **`disposition` is [#79](https://github.com/the-efficacious/commandsuite/issues/79)'s field with [#79](https://github.com/the-efficacious/commandsuite/issues/79)'s meaning**, so _does work
    started under the old process finish under it_ has one answer across
    contracts and process.
  - **Absence renders as an explicit line, never as nothing.** Rendering
    nothing collapses "no document exists", "runner too old to read the
    field" and "broker without the feature" into one state a member
    cannot decompose — it makes the healthy case wear the costume of the
    broken one.
  - **A real ceiling**: `PROCESS_DOCUMENT_MAX` is 16384, on the basis
    that the document is resident in every member's context in every
    session, so its length is a recurring cost paid by everyone.

  Agent surface as well as HTTP — `process_document_get` and
  `process_document_history` ungated, `process_document_write` gated. The
  member holding this permission on a team like ours is an agent, so an
  HTTP-only capability would satisfy the requirement for humans and for
  nobody who actually holds the authority.

  The document rides in its own briefing field. The durable reason is
  authority separation, not the instruction cap: a member authors their
  own `instructions`, this is authored by whoever holds `process.manage`,
  and one string collapses two authorities into one field. The cap
  argument that also motivated it has already expired — [#122](https://github.com/the-efficacious/commandsuite/issues/122) landed in
  [#129](https://github.com/the-efficacious/commandsuite/issues/129) — and the decision is unchanged.

- [#108](https://github.com/the-efficacious/commandsuite/pull/108) [`d384bff`](https://github.com/the-efficacious/commandsuite/commit/d384bff9d97ac222fb2fcf022d84e26c6da18a00) Thanks [@keencaliper](https://github.com/keencaliper)! - Separate runner environment **variables** from secrets, so a value the
  team publishes stops being scrubbed from the team's own traces.

  The secrets registry was the only path into a runner's environment and
  registered every value in it for redaction unconditionally. Git
  identity had to be stored as a secret and was then removed from every
  captured body — and which members it happened to was decided by a
  length threshold, so a six-character name vanished while a
  four-character one survived.

  - New `variables` store, `/variables/*` API, `csuite variables`
    command and `variables_*` MCP tools. Values are readable by a
    `secrets.manage` holder and are **never** passed to
    `registerSecretValues`.
  - `GET /secrets/resolve` returns secrets and variables merged, plus
    `secretEnvNames` marking which keys the runner may register. A
    runner talking to an older broker registers everything, as before.
  - `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and
    `GIT_COMMITTER_EMAIL` migrate from secrets to variables
    automatically at broker start, in one transaction, carrying values
    and bindings. No operator step.
  - The per-member `envName` uniqueness invariant now spans both stores.
    A secret and a variable targeting one name for one member is an
    error, never a precedence rule.

  `MIN_REGISTERED_VALUE_LENGTH` is unchanged: the repair is
  classification, and the threshold goes back to guarding short _secret_
  values.

  The web UI has no variables panel yet, so migrated rows leave
  `SecretsPanel` and are visible on the API, CLI and MCP surfaces only.
  Filed as [#111](https://github.com/the-efficacious/commandsuite/issues/111) rather than left implicit.

### Patch Changes

- [#124](https://github.com/the-efficacious/commandsuite/pull/124) [`c0e1b89`](https://github.com/the-efficacious/commandsuite/commit/c0e1b8974c795b91001fa45a8b5c4b2174af0ed9) Thanks [@sureforge](https://github.com/sureforge)! - Name CommandSuite and csuite in the briefing opening, with the broker and
  long-lived runner versions shown separately so a stale runner is visible from
  its own context. Older callers report `runner=unknown`; malformed version
  reports retain a warning without preventing briefing delivery. Long version
  tokens are visibly abbreviated so operational metadata cannot consume the
  headroom reserved for authored instructions.

- [#129](https://github.com/the-efficacious/commandsuite/pull/129) [`a00f59e`](https://github.com/the-efficacious/commandsuite/commit/a00f59e71c68ef7a9fef5ff16ecda709e0217066) Thanks [@sureforge](https://github.com/sureforge)! - Remove length caps from team context, role descriptions, personal instructions,
  and composed briefings. Show character counts and explicitly approximate token
  estimates on the web, CLI, and agent administration surfaces, and warn when an
  oversized briefing is requested by a runner that may still enforce the former
  8192-character client-side limit.

## 0.3.5

## 0.3.4

## 0.3.3

### Patch Changes

- [#64](https://github.com/the-efficacious/commandsuite/pull/64) [`5f638aa`](https://github.com/the-efficacious/commandsuite/commit/5f638aa670267c4cdc8472cf86b61ba0d0d38e51) Thanks [@keencaliper](https://github.com/keencaliper)! - Report on the roster when a member's verbatim capture has stopped
  arriving. A member can produce activity all day while none of their
  request/response bodies reach the broker, and until now nothing said
  so — the trace view renders systematic absence and ordinary per-turn
  absence identically. `roster` now carries `captureHealth` per member:
  `gap` when completed exchange markers in the current session have no
  stored bodies, `unevaluated` when this broker cannot assess the member
  (Codex, whose containment join is not built), and `ok` otherwise.
  Field absence means an older broker with no opinion, never "healthy".

- [#68](https://github.com/the-efficacious/commandsuite/pull/68) [`676f315`](https://github.com/the-efficacious/commandsuite/commit/676f31504a4afd7dae0483a55e1d14a1c3ef934b) Thanks [@keencaliper](https://github.com/keencaliper)! - Retain the completeness failures the broker already detects, instead of
  writing them to a terminal nobody keeps. Twenty-one log sites — an
  unreadable body reference, a blob that will not decompress, a record
  that will not serialize, an activity or audit append that failed — now
  also record a retained, attributable diagnostic. `roster` carries
  `diagnosticsUnresolved` and `diagnosticsRetention` per member, so an
  agent can learn from a surface it already reads that its own capture
  failed. Absence of those fields means the broker retains no diagnostics
  and has no opinion, never that the member is clean.

  Detail expires at a stated bound and folds into hourly then daily
  summaries; queries answer with the interval, resolution and coverage
  they can actually support, and report `indeterminate` rather than a
  confident zero once evidence has aged out. Retention reports its own
  health, including `unknown` when it cannot describe itself.

  Known limitation: diagnostics emitted on the runner — the OTLP relay's
  degraded-record path, and the activity queue's `dropped` counter, which
  is the only signal that the capture-health denominator shrank — are on
  the agent's machine and are not retained by this. A crash between a
  failed retention write and the next successful one is not observable
  after a restart.

- [#61](https://github.com/the-efficacious/commandsuite/pull/61) [`40e5513`](https://github.com/the-efficacious/commandsuite/commit/40e55138e45c4a610f111896f95ad3bed8052a23) Thanks [@sureforge](https://github.com/sureforge)! - Capture Claude request and response bodies when the runner and broker use different filesystems. The runner now resolves FILE-mode body references locally, forwards byte-exact inline bodies over OTLP, and retains unacknowledged spool files across restarts instead of deleting them based on process liveness.

  **Known limitation.** A request or response body the runner cannot resolve—oversized, not a runner-owned regular file, or not valid UTF-8—is forwarded unresolved and skipped broker-side, so it is not captured. Existing unresolved entries inside the runner's spool directory, regular or not, remain there; referenced paths outside it are left untouched and create no spool residue. Any remaining in-spool entry prevents the spool from earning its completion marker, so automatic sweep will not remove the directory; it stays pinned until manually dispositioned. Missing or already-unlinked references leave no additional residue. Capture continues for other resolvable bodies. Quarantine is tracked separately and is not in this release.

## 0.3.2

### Patch Changes

- [#58](https://github.com/the-efficacious/commandsuite/pull/58) [`6800958`](https://github.com/the-efficacious/commandsuite/commit/6800958da90dbe87e89a1a49f6976b18f6e4177f) Thanks [@sureforge](https://github.com/sureforge)! - Correct package authorship metadata to identify Efficacious, Inc.

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

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - Fix `objectives_list` returning only assigned work to any caller holding `objectives.create`.

  The tool describes itself as listing "objectives you have a relationship with — assigned to you, originated by you, or objectives you're watching," and the agent briefing tells agents to call it after a restart or context compaction _rather than trusting memory_. For a member who originates or watches without being assigned — the coordinating role — it returned an empty plate.

  The defect was not where it looked. The route already implemented the relationship union, and a member **without** `objectives.create` got exactly what the description promised. `handleObjectivesList` unconditionally sent `assignee: <self>`, which the route honours for privileged callers, bypassing the union entirely. So the permission granting more authority was what removed the capability, and the role that most needs to see what it originated and watches was the only one that could not.

  `ListObjectivesQuery` gains `related`, the explicit relationship scope — assigned OR originated OR watching — applied for every caller, with the same self-only restriction as `assignee` for members lacking `objectives.create`. The MCP tool now sends `related` instead of `assignee`.

  The union is deliberately **not** the default for a privileged caller with no filter: the director dashboard (`web-ui/src/lib/objectives.ts`) calls `listObjectives()` bare and relies on team-wide, and the runner's plate snapshot (`objectives-tracker.ts`) relies on `assignee` staying narrow — folding watched objectives into it would change what every agent is re-briefed with after compaction.

  The regression fixture is a **privileged** caller assigned nothing, against a team-wide total larger than their related set. Both properties matter: a plain-member fixture passes against the bug because the union already covers that path, and an equal-sized team total passes against a route that ignores `related` entirely.

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

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - Show recently reported working and blocked activity in the agent roster without presenting it as executor liveness. The broker now supplies the activity window it actually applied, so version-skewed clients do not reconstruct a server-owned value.

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - Make activity and GenAI range reads losslessly pageable with composite timestamp/id cursors.

  TracePanel now traverses every page before joining activity with GenAI records, member activity pagination preserves rows sharing a timestamp, and GenAI enrichment failures are surfaced while retaining the marker-only fallback. Consumer-side history caps that silently discarded rows have been removed.

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - `FsEntry` now carries `canWrite` — the server's own `canWrite()` answer for the requesting viewer. Clients no longer have to rebuild that rule, and for objective-namespace entries they could not: the owner is `obj:<id>` and the rule includes objective membership, which a client cannot determine for an arbitrary path. The field is optional, so an older server that omits it still parses. The web UI's Delete control now asks rather than inferring, which restores it for objective members who were entitled to it all along.

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - Refuse manual publication unless package payloads were prepared from clean, committed source.

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - Report peak activity-uploader queue occupancy in events and serialized UTF-8 bytes in
  `session_end.capture`, while continuing to accept older run summaries that omit the new fields.

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

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - Refuse to run tests against a build that no longer matches its source. Tests that import a workspace package by name resolve through its `exports` map into `dist/`, and nothing in module resolution checks that `dist/` was built from the `src/` on disk — so a stale build produced a green suite that proved nothing. Turbo's `dependsOn: ["^build"]` covered the root `pnpm test` and nothing else; a filtered `pnpm --filter <pkg> exec vitest run` bypassed it entirely.

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - Correct source comments and MCP tool descriptions that assert mechanisms, guarantees, or constants the code contradicts.

  **Security-relevant.** `core/src/trace/redact.ts` opened by describing "**decrypted** Anthropic API traffic" — MITM-proxy-era language in the redaction module, when there is no interception, no TLS decryption, and no CA on disk. Reading the code underneath the stale comment turned up a second thing: `redactHeaders` is a published export of `csuite-core` with **no in-tree caller**, and nothing in the repo captures raw HTTP headers any more. The header now states the real threat model — secrets surfacing inside _content_ rather than in intercepted headers — records that `redactHeaders` is retained as public API rather than because csuite inspects headers, and states what redaction does **not** cover: the raw-body store keeps bytes verbatim by design, which is what makes byte-exact reconstruction possible.

  **`dual-auth` → `tri-auth` on 18 lines across 5 source files**, not the 5 sites originally reported: eleven in `server/src/app.ts`, four in `sdk/src/protocol.ts`, one each in `core/src/session-store.ts`, `server/src/sessions.ts`, and a test header. Auth has three planes — opaque bearer, session cookie, optional RS256 JWT — and `server/src/auth.ts` already called itself "Tri-auth middleware", which is what made the rest identifiable as stale rather than as a naming choice.

  Three of those eleven `app.ts` lines were missed by the first pass and found in verification: the **defining paragraph** at the top of the file still read `Dual-auth = either bearer or cookie` directly above routes the same pass had relabelled tri-auth, and two route comments (`GET /tool-sources`, `GET /secrets`) still said `Dual-auth`. The first pass searched for the term where it expected the term to be; it did not re-run the search afterwards.

  The `describe('dual auth (bearer OR cookie)')` block in `auth.test.ts` was **deliberately not renamed**: it covers exactly those two planes and JWT has its own block, so renaming it would have made the test overclaim.

  **`activity-uploader.ts`** said the queue cap was 1 MiB where the constant is 64 MB — stale by 64× in the file that owns the number. It now names both constants and records that drops are counted and surface in `session_end.capture`.

  **`sdk/src/types.ts`** justified hook-sourced `user_prompt` capture by saying the OTEL request body "truncates large (~60KB+) prompts". The runner uses file mode, which writes complete bodies, so that truncation no longer applies; the rationale is restated accurately.

  **MCP tool descriptions now declare the limits their schemas enforce.** `objectives_complete`'s `result` is capped at 4096 characters and said nothing — you discovered it by having a completion rejected _after_ writing it. A tool description is the only specification an agent has for a tool whose implementation it cannot read.

  Declared across every tool backed by a schema with an enforced bound: `objectives_create` title (200), outcome (2048), body (4096), watchers (64), attachments (64); `objectives_discuss` body (16384), attachments (64); `objectives_update` blockReason (2048); `objectives_complete` result (4096); `objectives_watchers` add (64) and remove (64); and `broadcast`, `send`, and `channels_post` body (65536) and attachments (64).

  The first pass declared only the limits already known from the objective's scope, and so missed the attachment caps in the very schemas it was editing. The list above was rebuilt the other way round — enumerating every constrained field on each request schema in `sdk/src/schemas.ts`, then checking each against its tool description — which is what turned up the eight beyond the original set.

  **Not addressed, and named because the same enumeration found them:** `DiscussObjectiveRequestSchema` and `PushPayloadSchema` both accept an optional `title` that no MCP tool exposes, so an agent cannot set one and a human on the web UI can. That is a surface-parity gap rather than a stale comment, so it is filed rather than fixed here.

  **Comments naming symbols that do not exist — found by a second, artifact-bounded method.** The passes above were bounded by terms chosen in advance, which cannot find drift nobody suspected. So a second pass enumerated its candidate set from the comments themselves: every backticked identifier appearing in a comment across 240 source files (**1,075 distinct**), each checked against all non-comment source. **44 were absent; 8 were real.** The other 36 are external vocabulary — protocol field names (`grant_type`, `message_stop`), env vars, TS compiler options, browser and upstream-SDK symbols.

  | file                                   | cited                                   | actual                                                                                                         |
  | -------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
  | `sdk/src/types.ts`                     | `pollUrl` on the `/enroll` response     | **no such field** — the response carries relative `verificationUri`/`verificationUriComplete` and no poll hint |
  | `core/src/trace/sse.ts`                | `buildAnthropicEntry` in `anthropic.ts` | `anthropicToGenAi` in `genai.ts`                                                                               |
  | `core/src/trace/transcript.ts`         | `parseMessages` in the HTTP path        | `anthropicToGenAi`                                                                                             |
  | `server/src/members.ts` (×2)           | `TeamConfigSchema`                      | `ServerConfigSchema`                                                                                           |
  | `server/src/run.ts`                    | `loadTeamConfigFromFile`                | `loadServerConfigFromFile`                                                                                     |
  | `server/src/team-store.ts`             | `seedTeam`                              | `setTeam`                                                                                                      |
  | `server/src/files/filesystem-store.ts` | `srcPath`                               | `src`                                                                                                          |
  | `web-ui/src/lib/client.ts`             | the `__resetForTests` convention        | `__reset<Module>ForTests`                                                                                      |

  The `sdk/src/types.ts` one is the worst of these: it is a **published type** documenting a wire field that has never existed, so an SDK consumer reading the doc comment would look for a response field the broker does not send.

  `core/src/trace/sse.ts` also gained the same disclosure `redactHeaders` carries: `reassembleAnthropicSse`, `parseSseEvents` and `looksLikeSseStream` are published exports with **no in-tree caller** — nothing in csuite holds a raw SSE body since capture became transcript- and OTEL-sourced. That is now stated in the header so the module's presence is not read as a live streaming-capture path.

  **What remains unswept, stated rather than implied.** The backticked-identifier method sees only claims that name a symbol. It cannot see a comment that describes a mechanism in prose without naming anything — the `dual-auth` and 1 MiB defects were both of that kind and both needed the vocabulary pass to find. Neither method reaches a comment that is wrong about _behaviour_ while naming only symbols that still exist; that residue is unmeasured, and the four new `redactJson` contract tests are the pattern for closing it where it matters.

## 0.2.0

### Minor Changes

- [#27](https://github.com/the-efficacious/commandsuite/pull/27) [`9d22ed2`](https://github.com/the-efficacious/commandsuite/commit/9d22ed2179f5ab81852705485d2692107c7330bb) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Remove the `claude/channel` MCP-notification delivery path.

  Broker events used to reach Claude Code as `notifications/claude/channel` MCP notifications pushed through the bridge — a surface gated behind Claude Code's `--dangerously-load-development-channels` development flag. With the claude runner on Agent SDK streaming input and codex on turn dispatches, nothing consumed it.

  - The forwarder → sink seam is now a typed `ChannelEvent` (`{content, meta}`) delivered to a `ChannelEventSink`; the MCP method envelope, the `forwarderShim` bridge default, and the bridge's `claude/channel` experimental capability are gone.
  - `RunnerOptions.notificationSink` is renamed to `channelSink`. Every real adapter must supply one; without it the runner drops live events with a log line (history remains readable via `recent`).
  - The IPC `mcp_notification` frame survives for exactly one method: a genuine `tools/list_changed`.
  - `csuite-sdk` no longer exports `MCP_CHANNEL_CAPABILITY` / `MCP_CHANNEL_NOTIFICATION`.

## 0.1.2

## 0.1.1

## 0.1.0

### Minor Changes

- [#21](https://github.com/the-efficacious/commandsuite/pull/21) [`8c4a842`](https://github.com/the-efficacious/commandsuite/commit/8c4a842b9e5a4b9f777994cab253d41808d8891c) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Formal runner standard: the `AgentAdapter` contract, a shared session driver, run summaries, and a conformance suite for new agent runners.

  The two runners (`csuite claude`, `csuite codex`) are now thin wrappers over one shared lifecycle. A new `AgentAdapter` interface (`runtime/agents/adapter.ts`) captures everything framework-specific — binary location, config prepare/restore, spawn, notification sink, second-bridge policy — and the new `runAgentSession` driver (`runtime/agent-session.ts`) owns everything else: auth, runner startup, signal handling per declared mode (`forward` for terminal-owning TUIs, `teardown` for headless agents), and idempotent teardown on every exit path with a fixed ordering (agent capture flush → operator-file restore → uploader drain). Adding a third runner no longer re-implements exit-path correctness.

  Every session now ends with a machine-readable account of itself, identical across runners:

  - New `session_start` / `session_end` activity kinds bracket each run in the member's activity stream (mirroring `objective_open`/`objective_close`), with `session_end` carrying exit code, reason, duration, agent-native session id, and capture accounting (`enqueued`/`uploaded`/`dropped` — so an incomplete trace says so instead of being silently short on the broker).
  - A structured `run summary` log line and a human-readable closing line report the same facts locally.

  `csuite codex` gains `--doctor` / `--skip-doctor`, and the doctor is now adapter-generic (`runAgentDoctor`): shared checks (binary, $TMPDIR, loopback bind) plus an advisory agent-version probe against the adapter's declared tested range (WARN outside, never FAIL). Both runners also run the silent preflight before spawn.

  New runners are validated by a shared conformance suite (`packages/cli/test/runtime/conformance/`) that runs five lifecycle scenarios against a fake broker + fake agent binary; both shipped runners pass it. The written standard — adapter contract, capture capability tiers (0 operable … 3 full fidelity), run summary spec, fixture rule — lives at `docs/runners/conformance.mdx`.

  The Claude Code runner verb is renamed: **`csuite claude`** (was `csuite claude-code`; the old verb is kept as a silent alias so existing scripts keep working). The runner id in banners, session logs, and `session_start`/`session_end` events is now `claude`.

  Breaking-ish notes (pre-1.0): the runner startup banner is now uniform (`csuite <runner>: …` prefix, plus an agent/team line for the claude runner), and brokers older than this release will reject activity batches containing the new session events — upgrade the server and CLI together.

- [#19](https://github.com/the-efficacious/commandsuite/pull/19) [`9199dba`](https://github.com/the-efficacious/commandsuite/commit/9199dbafaa3337a9d62c7fd287ae666d90fb4f05) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Retire the team `directive` field and slim the first-run wizard to identity + auth.

  The wizard now collects only the team name, your name, a bearer token, and TOTP enrollment — no more forced directive/context/role prose before you've even seen the product. Standing context lives in exactly three editable places: `team.context` (team-level, now up to 8192 chars, editable from TeamHome in the web UI, `csuite team set`, or the `team_update` MCP tool), role title + description (public per-member), and member `instructions` (private per-member).

  Existing databases migrate automatically on boot: a non-empty legacy `directive` is folded into the head of `context` and the column is dropped. `PATCH /team`, `csuite team set`, and `team_update` no longer accept `directive`.

## 0.0.1
