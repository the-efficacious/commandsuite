# csuite-core

## 0.10.0

### Minor Changes

- [#311](https://github.com/the-efficacious/commandsuite/pull/311) [`20cd8c1`](https://github.com/the-efficacious/commandsuite/commit/20cd8c1dc38abb65f37c02067ee5c9796bdd659f) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - **Breaking.** `process_document` is renamed `team_process` across the agent-facing surface, the wire, the SDK and storage. "Document" named the storage shape, not the concept: it framed the team's process as a static artifact to fetch rather than operational context to consult, and neither the permission leaf (`process.manage`) nor the store's own description had ever used the word. Bare `process` was not an option — it shadows Node's global and reads as the runtime process at every call site — and `team_process` rules that reading out on sight.

  What moves:

  - **MCP tools.** `process_document_get`, `process_document_history` and `process_document_write` become `team_process_get`, `team_process_history` and `team_process_write`. Only the new names are advertised in `tools/list`. The old names still dispatch for this one release, because tool names are quoted in prose that does not auto-update (team instructions, the team process text itself) and a hard rename would strand a caller reading them out of it; each such call logs a `warn` record naming the alias and its replacement so stale references can be found. The aliases are removed in the next minor.
  - **REST.** `GET`/`PUT /process-document` and `GET /process-document/history` become `/team-process` and `/team-process/history`. The `GET /instructions` field `processDocument` becomes `teamProcess`, and the instruction-block kind `process_document` — in `blocks`, in instruction events and in the context watchdog's `context.block.kind` attribute — becomes `team_process`.
  - **SDK.** The `ProcessDocument*` types and schemas become `TeamProcess*` (`TeamProcess`, `TeamProcessEdit`, `EditTeamProcessRequest`, `TEAM_PROCESS_MAX`, `TEAM_PROCESS_PATHS`, …), and `Client.getProcessDocument`, `processDocumentHistory` and `writeProcessDocument` become `getTeamProcess`, `teamProcessHistory` and `writeTeamProcess`. `csuite-core` now exports `createSqliteTeamProcessStore`, `TeamProcessStore` and `TeamProcessError`.
  - **Permission.** `process.manage` becomes `team_process.manage`. There is no permissions migration: `raw_permissions` is stored verbatim and resolved on every read, and the resolver maps the old name to the new one, so a member or template saved under `process.manage` keeps the capability with no row rewritten. Both names are accepted on write.
  - **Database.** The tables `process_document` and `process_document_edits` become `team_process` and `team_process_edits`. The store renames them in place on first open, deciding from `sqlite_master` rather than from a caught error: a fresh database gets the new names directly, a pre-rename database is renamed with every row — including the append-only edit history — preserved, and an already-migrated database is left untouched, so opening twice is the same as opening once.

  Upgrade brokers and runners together. A runner built before this change validates the `GET /instructions` packet against a block-kind enum that has no `team_process` in it and rejects the whole response, so a new broker leaves an older runner unable to fetch its instructions at all — the same lockstep 0.9.0 asked for.

  The instruction-version hash is computed from the same inputs as before, so upgrading does not mark any runner restart-pending.

### Patch Changes

- [#311](https://github.com/the-efficacious/commandsuite/pull/311) [`20cd8c1`](https://github.com/the-efficacious/commandsuite/commit/20cd8c1dc38abb65f37c02067ee5c9796bdd659f) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Instruction and environment restarts now start the agent cold instead of resuming the prior conversation. The successor gets the refreshed instructions and the runner's `context_refresh` re-brief on its open objectives, and its `session_start` says why (`resumed: false` with `resumeReason: 'instructions changed'`, `'environment changed'`, or `'environment reloaded'`); a fresh MCP session is always re-briefed, even inside the cooldown that folds an attach and a compaction. Resuming there was the source of a capture defect measured in production: a restarted runner re-read the whole resumed transcript as new activity — 1000+ rows spanning 15 hours in one second — saturating the uploader and dropping 40–88% of events. Two fixes close that regardless of how a session restarts: the transcript reader follows a changed `transcript_path` (a new file after any agent swap) while keeping its line-uuid dedup, and every transcript-derived `ActivityEvent` carries an optional `sourceId` that the broker dedups on (`member_activity.source_id`, a partial unique index added lazily; id-less events from older runners are stored as before). The runner no longer predicts resume from the filesystem: bare `--resume` on `csuite claude` hands the decision to Claude Code (`continue`, which starts fresh when nothing exists), and on `csuite codex` starts a new thread loudly, since codex resumes by id only; explicit `--resume <id>` stays strict on both.

- Updated dependencies [[`20cd8c1`](https://github.com/the-efficacious/commandsuite/commit/20cd8c1dc38abb65f37c02067ee5c9796bdd659f), [`20cd8c1`](https://github.com/the-efficacious/commandsuite/commit/20cd8c1dc38abb65f37c02067ee5c9796bdd659f)]:
  - csuite-sdk@0.10.0

## 0.9.0

### Minor Changes

- [#232](https://github.com/the-efficacious/commandsuite/pull/232) [`5e11966`](https://github.com/the-efficacious/commandsuite/commit/5e119668f7d1759bee6d5930edb99d585b1976a0) Thanks [@sureforge](https://github.com/sureforge)! - Refuse bearer-credential-shaped chat bodies before persistence and guard every
  runner tool result before it enters an IPC frame or agent context. The shared
  credential detector recognizes complete `csuite_` bearer tokens without
  echoing the refused value.

- [#222](https://github.com/the-efficacious/commandsuite/pull/222) [`b001e51`](https://github.com/the-efficacious/commandsuite/commit/b001e5193e890732f62da24a61bc79905df47506) Thanks [@sureforge](https://github.com/sureforge)! - Runners now receive a targeted `environment` stream event when a bound secret or variable changes, drain at idle, refresh their resolved environment through the broker, and resume the same conversation. `context_control reload` triggers the same refresh explicitly, while `--no-env-reload` disables only automatic environment restarts. New secret values are registered with the additive redactor before the successor agent starts; a failed refresh keeps the prior environment.

- [#225](https://github.com/the-efficacious/commandsuite/pull/225) [`7e24133`](https://github.com/the-efficacious/commandsuite/commit/7e24133b5619805385c2ad7e44e1225b0fc8de8a) Thanks [@sureforge](https://github.com/sureforge)! - Notify long-running clients when bearer authentication is rejected, expose
  token-aware blocked presence, and let runners retain capture while saved device
  auth is replaced after re-enrolment.

- [#231](https://github.com/the-efficacious/commandsuite/pull/231) [`bc0c171`](https://github.com/the-efficacious/commandsuite/commit/bc0c171707ee885c5db76f880b44749cf6ca9144) Thanks [@sureforge](https://github.com/sureforge)! - Add compatibility-preserving pending member creation. Callers can select
  `credentialMode: 'pending'` to create a member without minting a bearer token;
  the CLI, MCP tool, and web UI now use that mode and direct the new member through
  device-code enrolment. Omitting the mode retains the 0.8 bootstrap-token response
  until the legacy default is removed in a separately approved change.

- [#254](https://github.com/the-efficacious/commandsuite/pull/254) [`2e27743`](https://github.com/the-efficacious/commandsuite/commit/2e277435e0904b59df74ec04d800f98ebb8b7dc2) Thanks [@sureforge](https://github.com/sureforge)! - Add the dedicated `channels.manage` permission, channel descriptions, and an
  immutable administration audit. Channel creator and legacy channel-admin roles
  no longer authorize mutations; creation is provenance and creators join as
  ordinary members. Existing teams must grant `channels.manage` before channel
  administration resumes.

- [#288](https://github.com/the-efficacious/commandsuite/pull/288) [`bb79f4d`](https://github.com/the-efficacious/commandsuite/commit/bb79f4d8a16b2263b5bac2896ea6eac427c264e6) Thanks [@sureforge](https://github.com/sureforge)! - Make runner liveness evidence-based and message delivery recoverable. Runners
  report typed ready/degraded conditions, action-only turn outcomes, and an
  explicit supervision claim; peers that do not advertise the capability remain
  unreported. Messages become
  subscription-owned accepted leases at real turn start and return to pending on
  disconnect or any degraded projection, while stale completions are refused.

  0.9.0 is the protocol compatibility baseline. Upgrade brokers and runners
  together from 0.8.x; mixed 0.8.x/0.9.0 deployments are unsupported.

- [#274](https://github.com/the-efficacious/commandsuite/pull/274) [`19dac9e`](https://github.com/the-efficacious/commandsuite/commit/19dac9eca6bd9ac3c5b90580dea36bc24129e7a8) Thanks [@sureforge](https://github.com/sureforge)! - Add the runner-to-broker message disposition protocol and durable 24-hour
  pending ledger. Notification receipts now wait for a subscriber acknowledgement
  instead of claiming delivery when a live socket merely accepted bytes; old
  runners remain explicitly unreported.

- [#233](https://github.com/the-efficacious/commandsuite/pull/233) [`8811e48`](https://github.com/the-efficacious/commandsuite/commit/8811e487cd62fdc94aa7ca42f8783b9302237a71) Thanks [@sureforge](https://github.com/sureforge)! - Add explicit per-token and revoke-all bearer rotation scopes. The CLI requires
  one scope and writes the replacement credential to a new 0600 file without
  printing plaintext; the legacy empty REST body retains revoke-all behavior
  until its separately approved compatibility flip.

- [#260](https://github.com/the-efficacious/commandsuite/pull/260) [`7de73b4`](https://github.com/the-efficacious/commandsuite/commit/7de73b4e04d9f09edfb1389a7c81fb9df941e755) Thanks [@sureforge](https://github.com/sureforge)! - Add stable UUID member identities as the attribution key for typed offboarding.
  Existing databases are backfilled transactionally, names remain the public
  handle, and older brokers that do not report an identity remain readable.

### Patch Changes

- [#255](https://github.com/the-efficacious/commandsuite/pull/255) [`a45aff0`](https://github.com/the-efficacious/commandsuite/commit/a45aff09fca495707eff7243a8393b74402c52c7) Thanks [@sureforge](https://github.com/sureforge)! - Make `fs_ls` distinguish readable-empty, unreadable, and nonexistent member roots without exposing paths below an unreadable boundary, and correct the process-document tool text to describe idle restart, conversation resume, and retained history.

- [#272](https://github.com/the-efficacious/commandsuite/pull/272) [`aa3b5ed`](https://github.com/the-efficacious/commandsuite/commit/aa3b5ed49450549d2d484058ffe6d0d5c2e6d081) Thanks [@sureforge](https://github.com/sureforge)! - Make unknown, unverified, and disabled webhook endpoints indistinguishable to
  unauthenticated senders. Correctly signed requests to disabled endpoints now
  leave a causal rejected receipt for authorized operators.

- [#279](https://github.com/the-efficacious/commandsuite/pull/279) [`b6151be`](https://github.com/the-efficacious/commandsuite/commit/b6151becf1c60a3c6b861d96a35892cc5eddbd33) Thanks [@keencaliper](https://github.com/keencaliper)! - Declare `Vary: Accept` on both representations of the paths the web UI and
  REST API share, and mark API responses `no-store`.

  A browser navigation to `/objectives` is answered with the SPA shell while an
  API call to the same URL is answered with JSON, and neither response said it
  had varied on `Accept`. A cache is entitled to reuse the first for the second,
  which is what happened: refreshing an objective page cached the shell under
  that URL, the app's own fetch of the same URL was served that HTML, and the
  page rendered `invalid JSON from …`. Because the objectives fetch lives in the
  shell, one refresh degraded every route in the session until the entry expired.

  Operators behind a CDN: `Vary: Accept` fixes the cache key going forward but
  does not evict entries already stored under the unvaried response. Purge the
  cache for HTML-negotiated origin paths after upgrading, or the symptom will
  survive the fix and look like the fix failed.

  API responses now also carry `Cache-Control: no-store`. RFC 9111 §3.5 already
  stops a shared cache storing a response to an `Authorization`-bearing request,
  but browser sessions authenticate with a cookie and get no such protection.

- Updated dependencies [[`5e11966`](https://github.com/the-efficacious/commandsuite/commit/5e119668f7d1759bee6d5930edb99d585b1976a0), [`b001e51`](https://github.com/the-efficacious/commandsuite/commit/b001e5193e890732f62da24a61bc79905df47506), [`c6977d4`](https://github.com/the-efficacious/commandsuite/commit/c6977d416ff989db0ea1bc02aa8771e5dfde2ba8), [`7e24133`](https://github.com/the-efficacious/commandsuite/commit/7e24133b5619805385c2ad7e44e1225b0fc8de8a), [`bc0c171`](https://github.com/the-efficacious/commandsuite/commit/bc0c171707ee885c5db76f880b44749cf6ca9144), [`2e27743`](https://github.com/the-efficacious/commandsuite/commit/2e277435e0904b59df74ec04d800f98ebb8b7dc2), [`bb79f4d`](https://github.com/the-efficacious/commandsuite/commit/bb79f4d8a16b2263b5bac2896ea6eac427c264e6), [`19dac9e`](https://github.com/the-efficacious/commandsuite/commit/19dac9eca6bd9ac3c5b90580dea36bc24129e7a8), [`acf7f5a`](https://github.com/the-efficacious/commandsuite/commit/acf7f5adbd7e7cf9608641e12a1348a4671dabf8), [`8811e48`](https://github.com/the-efficacious/commandsuite/commit/8811e487cd62fdc94aa7ca42f8783b9302237a71), [`7de73b4`](https://github.com/the-efficacious/commandsuite/commit/7de73b4e04d9f09edfb1389a7c81fb9df941e755)]:
  - csuite-sdk@0.9.0

## 0.8.0

### Minor Changes

- [#192](https://github.com/the-efficacious/commandsuite/pull/192) [`7c03e4b`](https://github.com/the-efficacious/commandsuite/commit/7c03e4b4c10c4daa9bc419b9eae7adab9efaff7f) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Replace the Director, Admin, and Operator member categories with explicit permission leaves, restore independent objective capabilities, and make permission bundles one-shot member-creation templates.

- [#194](https://github.com/the-efficacious/commandsuite/pull/194) [`a2cc68a`](https://github.com/the-efficacious/commandsuite/commit/a2cc68af186c8bcb661088efc7b26f914c7abd80) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - **Breaking.** One structured logger across the broker, CLI and runner: every process now emits `{ts, level, component, msg, ...context}` as one JSON line, with a `CSUITE_LOG_LEVEL` threshold. Runner logs previously carried no severity at all, and the broker's `BrokerLogger` defaulted to a no-op that discarded subscriber warnings.

  `BrokerLogger` is no longer exported from `csuite-core`; `Broker`, the MCP client manager and the gen-ai correlator all take the standard `Logger`, and the correlator's `log` option is now `logger`.

- [#194](https://github.com/the-efficacious/commandsuite/pull/194) [`a2cc68a`](https://github.com/the-efficacious/commandsuite/commit/a2cc68af186c8bcb661088efc7b26f914c7abd80) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Read paths for captured data that was previously write-only: `GET /members/:name/telemetry` serves the cost and token records agents export, and `GET /members/:name/genai/:id/raw` serves the verbatim bytes behind an inference. The agent timeline now renders session start/end, so a run that dropped events says so instead of looking identical to a complete one, and unresolved capture diagnostics appear on the member profile.

- [#194](https://github.com/the-efficacious/commandsuite/pull/194) [`a2cc68a`](https://github.com/the-efficacious/commandsuite/commit/a2cc68af186c8bcb661088efc7b26f914c7abd80) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - `csuite prune-traces` now deletes across the whole activity database — inferences, telemetry and raw bodies as well as the activity timeline — and reports each separately. Previously it pruned only the timeline while the heaviest tables in the same file grew without bound. Raw bodies are collected by reference rather than age, so a deduplicated body outlives the exchange that first stored it.

- [#196](https://github.com/the-efficacious/commandsuite/pull/196) [`134f0f8`](https://github.com/the-efficacious/commandsuite/commit/134f0f8a17d990cc91b13ceb0d34616d86f96f81) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Fix `/history` returning private channel and objective-thread messages to every member. A scoped push was delivered to its audience live but persisted like a broadcast, so the durable read handed it to anyone. Messages now carry the audience they were delivered to, and the feed honours it; rows written before this cannot say who they were for, so a scoped one is now shown only to its sender.

- [#194](https://github.com/the-efficacious/commandsuite/pull/194) [`a2cc68a`](https://github.com/the-efficacious/commandsuite/commit/a2cc68af186c8bcb661088efc7b26f914c7abd80) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - **Breaking.** Rename the live idle/working/blocked signal to work state (`WorkStateTracker`, `WorkState`), so "activity" unambiguously means the durable per-member record. Wire paths and JSON field names are unchanged.

  `ActivityTracker`, `createActivityTracker`, `ACTIVITY_TTL_MS` and the `ActivityState` type become `WorkStateTracker`, `createWorkStateTracker`, `WORK_STATE_TTL_MS` and `WorkState`.

### Patch Changes

- [#194](https://github.com/the-efficacious/commandsuite/pull/194) [`a2cc68a`](https://github.com/the-efficacious/commandsuite/commit/a2cc68af186c8bcb661088efc7b26f914c7abd80) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - The diagnostics retention ladder now actually runs. Its compaction was implemented and never called, leaving row caps as the only bound on the diagnostics tables.

- [#196](https://github.com/the-efficacious/commandsuite/pull/196) [`134f0f8`](https://github.com/the-efficacious/commandsuite/commit/134f0f8a17d990cc91b13ceb0d34616d86f96f81) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Stop serving uploaded files as executable documents on the broker's own origin. `GET /fs/read` reflected the uploader's declared content type with `inline` disposition, so an HTML or SVG upload ran as script — with the opener's session — when the link was opened. Files now download unless they are a type that renders without scripting (raster images, media, PDF), and every response carries `nosniff` plus a restrictive Content-Security-Policy. Image, media and PDF previews in the web UI are unchanged.

- [#194](https://github.com/the-efficacious/commandsuite/pull/194) [`a2cc68a`](https://github.com/the-efficacious/commandsuite/commit/a2cc68af186c8bcb661088efc7b26f914c7abd80) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Unmatched `/members/...` requests now answer a JSON 404 instead of falling through to the single-page app, which returned `index.html` with a 200 to clients asking for JSON.

- [#196](https://github.com/the-efficacious/commandsuite/pull/196) [`134f0f8`](https://github.com/the-efficacious/commandsuite/commit/134f0f8a17d990cc91b13ceb0d34616d86f96f81) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Stop a handful of wrong sign-in codes locking every member out of the web UI. Codeless login counted failures in one global bucket, so ten bad guesses from anywhere blocked the whole team for fifteen minutes. Failures are now counted per source first — the guesser locks themselves out — and reaching the global ceiling asks for a member name instead of refusing everyone.

- [#196](https://github.com/the-efficacious/commandsuite/pull/196) [`134f0f8`](https://github.com/the-efficacious/commandsuite/commit/134f0f8a17d990cc91b13ceb0d34616d86f96f81) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Stop storing the body of webhook deliveries that fail signature verification, and bound the deliveries table. `/hooks/:slug` is unauthenticated by design, so retaining rejected payloads let anyone who knew a slug write unbounded data into the broker database. Rejections now record size, digest and reason instead of the payload, cannot be replayed, and each endpoint keeps its most recent 1000 receipts.

- [#194](https://github.com/the-efficacious/commandsuite/pull/194) [`a2cc68a`](https://github.com/the-efficacious/commandsuite/commit/a2cc68af186c8bcb661088efc7b26f914c7abd80) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Fix traces silently truncating at a corrupt row. The activity, inference and telemetry list paths skipped rows they could not decode and returned a short page, which every caller reads as "no more rows" — so one bad row ended a trace early and reported it as complete. They now refill, and a short page means exhausted.

- [#196](https://github.com/the-efficacious/commandsuite/pull/196) [`134f0f8`](https://github.com/the-efficacious/commandsuite/commit/134f0f8a17d990cc91b13ceb0d34616d86f96f81) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Keep custom tool-source credentials on the origin they were configured for. The executor followed redirects, and while the runtime strips `Authorization` across origins it forwards a `kind: header` credential (`X-API-Key` and the like) intact — reachable by an agent steering a cooperative upstream's open redirect. Redirects are now followed only within the binding's pinned origin, and a hop that leaves it fails the tool call without sending anything.

- Updated dependencies [[`7c03e4b`](https://github.com/the-efficacious/commandsuite/commit/7c03e4b4c10c4daa9bc419b9eae7adab9efaff7f), [`a2cc68a`](https://github.com/the-efficacious/commandsuite/commit/a2cc68af186c8bcb661088efc7b26f914c7abd80), [`a2cc68a`](https://github.com/the-efficacious/commandsuite/commit/a2cc68af186c8bcb661088efc7b26f914c7abd80)]:
  - csuite-sdk@0.8.0

## 0.7.1

### Patch Changes

- [#190](https://github.com/the-efficacious/commandsuite/pull/190) [`a39a46f`](https://github.com/the-efficacious/commandsuite/commit/a39a46f751b68556633440b1bbcadd254dd3e1a0) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Transactional execution goes through the driver seam: `SqlDriver`
  gains an optional `transaction(fn)` capability and core exports
  `runInTransaction`, which every store now uses instead of issuing
  SQL-level BEGIN/COMMIT/ROLLBACK through `exec`. Engines that forbid
  transaction statements in SQL text (managing atomicity above it)
  implement the capability; `node:sqlite` needs no change — the helper
  falls back to the standard statements. The conformance kit asserts
  commit and rollback behavior. One site previously used
  `BEGIN IMMEDIATE`; under the single-connection model the eager write
  lock was indistinguishable from `BEGIN`, and the helper's fallback
  uses the latter.
- Updated dependencies []:
  - csuite-sdk@0.7.1

## 0.7.0

### Minor Changes

- [#188](https://github.com/the-efficacious/commandsuite/pull/188) [`4f09779`](https://github.com/the-efficacious/commandsuite/commit/4f0977937266b445265ded29af8deb3a0c16896f) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Move the broker application into `csuite-core`: `createApp`, every
  SQL-backed store (now generic over an injected synchronous
  `SqlDriver`), the member domain, auth, instructions, push dispatch,
  the team filesystem, and the notifications pipeline — with ports for
  the capabilities a host supplies: blob storage (web streams), push
  delivery, WebSocket upgrades, field encryption, and gen-ai capture.
  Each seam keeps a reference implementation and its existing tests,
  and `csuite-core/conformance` exports the behavioral contract suites
  (SqlDriver, BlobStore, FieldCipher, and a wire-level broker check)
  that the Node binding runs in its own CI.
  `csuite-server` is unchanged in behavior: it is now the Node binding
  of the shared application — `node:sqlite` driver, filesystem blob
  store, `web-push` sender, `@hono/node-ws` upgrades, KEK-based field
  cipher, and static SPA serving. Core's runtime neutrality (no
  `node:*` imports) is enforced by a CI check rather than declared in
  prose. Direct constructors renamed where an interface took the name:
  `SessionStore`/`TokenStore`/`PushSubscriptionStore` are now the
  injected contracts, with `Sqlite*` classes as the SQL
  implementations; token hashing and instruction-version hashing are
  async (Web Crypto).

### Patch Changes

- Updated dependencies []:
  - csuite-sdk@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [[`c9e4a85`](https://github.com/the-efficacious/commandsuite/commit/c9e4a85707581d4325a24a17d4fbd880ea88136d), [`1dd4d23`](https://github.com/the-efficacious/commandsuite/commit/1dd4d23eb112f703d04ffcd985246145ded50f6b), [`c9e4a85`](https://github.com/the-efficacious/commandsuite/commit/c9e4a85707581d4325a24a17d4fbd880ea88136d)]:
  - csuite-sdk@0.6.0

## 0.5.1

### Patch Changes

- [#154](https://github.com/the-efficacious/commandsuite/pull/154) [`b086b93`](https://github.com/the-efficacious/commandsuite/commit/b086b9390aa0991c082c7e1876eba01e103fc770) Thanks [@keencaliper](https://github.com/keencaliper)! - Correct what the raw-body store claims to preserve. `redact.ts` stated the
  store "keeps bytes VERBATIM … captured before anything parses or redacts
  them — that is what makes byte-exact reconstruction possible", and cited
  `raw-body-store.ts`, which says the opposite. The code matches
  `raw-body-store.ts`: for claude, attribute redaction runs in `parseOtlpLogs`
  before the correlator captures anything.

  Every fidelity claim on this path now names the object it is verbatim _with
  respect to_, and states that the answer depends on the ingest route — codex
  bundle uploads are content-addressed before any parse or redaction, claude
  OTLP bodies are captured after attribute redaction. Four further statements
  were corrected alongside the one first reported, including a field comment
  inside `raw-body-store.ts` itself (`AppendBodyInput.bytes`, "The ORIGINAL
  wire bytes") and two "before redaction" claims in `genai-correlator.ts` and
  `run.ts`.

  No behaviour change. The remaining gap — nothing in `raw_exchange` or
  `raw_blob` records which route a body took, so a reader cannot tell a
  scrubbed body from an unscrubbed one — is now stated in the prose rather
  than left for a reader to discover, and is tracked separately.

- Updated dependencies []:
  - csuite-sdk@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [[`6c35f83`](https://github.com/the-efficacious/commandsuite/commit/6c35f8346605bd9d0c939b5e93606dc3c1147ffa), [`294d857`](https://github.com/the-efficacious/commandsuite/commit/294d857242d3e3cd47d4cef594c5193c30d1c773), [`294d857`](https://github.com/the-efficacious/commandsuite/commit/294d857242d3e3cd47d4cef594c5193c30d1c773), [`9593188`](https://github.com/the-efficacious/commandsuite/commit/959318883f411d42ef98bd5adcc9249807ded94e)]:
  - csuite-sdk@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies []:
  - csuite-sdk@0.4.1

## 0.4.0

### Patch Changes

- [#106](https://github.com/the-efficacious/commandsuite/pull/106) [`c8f0d18`](https://github.com/the-efficacious/commandsuite/commit/c8f0d1866ad415d068c24e06eac4097fabd4914f) Thanks [@sureforge](https://github.com/sureforge)! - Preserve broker-composed instruction blocks verbatim in captured inference traces while continuing to redact secrets everywhere else.

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

### Patch Changes

- Updated dependencies [[`8c4a842`](https://github.com/the-efficacious/commandsuite/commit/8c4a842b9e5a4b9f777994cab253d41808d8891c), [`9199dba`](https://github.com/the-efficacious/commandsuite/commit/9199dbafaa3337a9d62c7fd287ae666d90fb4f05)]:
  - csuite-sdk@0.1.0

## 0.0.1

### Patch Changes

- csuite-sdk@0.0.1
