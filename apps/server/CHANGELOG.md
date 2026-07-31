# csuite-server

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

- Updated dependencies [[`5f638aa`](https://github.com/the-efficacious/commandsuite/commit/5f638aa670267c4cdc8472cf86b61ba0d0d38e51), [`676f315`](https://github.com/the-efficacious/commandsuite/commit/676f31504a4afd7dae0483a55e1d14a1c3ef934b), [`40e5513`](https://github.com/the-efficacious/commandsuite/commit/40e55138e45c4a610f111896f95ad3bed8052a23)]:
  - csuite-sdk@0.3.3
  - csuite-core@0.3.3

## 0.3.2

### Patch Changes

- [#58](https://github.com/the-efficacious/commandsuite/pull/58) [`6800958`](https://github.com/the-efficacious/commandsuite/commit/6800958da90dbe87e89a1a49f6976b18f6e4177f) Thanks [@sureforge](https://github.com/sureforge)! - Correct package authorship metadata to identify Efficacious, Inc.

- [#57](https://github.com/the-efficacious/commandsuite/pull/57) [`3542523`](https://github.com/the-efficacious/commandsuite/commit/35425234db188071c3758716fb67b438da55af83) Thanks [@keencaliper](https://github.com/keencaliper)! - The server no longer writes `mime`, `sourceUa`, or `sourceIp` values that its own published schemas refuse to read back.

  Two endpoints produced values their consumer schema rejected, so a successful request could store a row the SDK then threw on. `POST /fs/write` checked that `mime` was present but never bounded it, while `FsEntrySchema.mimeType` caps it at 255; `POST /enroll` recorded the raw `User-Agent` header and the raw `ipKey()` result, while `PendingEnrollmentSchema` caps them at 512 and 64. Both were live in 0.3.1: a 300-character `mime` returned `200`, persisted, and came back out of `/fs/stat` as an entry `FsEntrySchema.safeParse` rejected; a 600-character `User-Agent` produced an `/enroll/pending` row failing with `too_big maximum:512`.

  **The two are fixed in opposite directions, deliberately.** Reject when the value is a **claim about content**; truncate when it is a **label the user did not choose**.

  `mime` is now **refused** with `400` before anything is persisted, and is never trimmed to fit. A truncated MIME type is not a shorter version of the caller's claim — it is a different, still well-formed claim they never made, silently attached to their bytes. A refused upload is recoverable; mislabeled stored content is not.

  `sourceUa` and `sourceIp` are now **truncated** to their schema bounds and the enrollment proceeds. These are audit context the enrolling user never authored — one derived from proxy headers, the other from whatever their client sends. Refusing would deny a legitimate device a login over a field its operator cannot see, cannot edit, and did not write.

  Truncation is **recorded**, because a silently-cut value is indistinguishable from a genuine one sitting at the limit: the stored value ends in `…` so the record itself says it was cut, and a warning names the field and the original length. The `…` lives inside the bound, so the marker cannot produce the oversize value it exists to prevent.

  Both limits are read off the published schemas rather than restated as literals — a second copy of the number is how the producer and consumer drifted apart originally.

  The bound applies only to the **stored** `sourceIp`, never to the rate-limit key, which keeps the full `ipKey()` string. Truncating the bucket key would merge every client sharing a long forwarded prefix into one bucket, letting a single client exhaust the enrollment mint limit for everyone behind the same proxy chain.

  Verified by mutation rather than by review: collapsing either policy into the other fails both cross-referencing tests, a `400` that still persists the row fails the absence check, dropping the `…` or the warning each fails its own test, and bounding the rate-limit key fails the bucket-separation test.

- Updated dependencies [[`6800958`](https://github.com/the-efficacious/commandsuite/commit/6800958da90dbe87e89a1a49f6976b18f6e4177f)]:
  - csuite-core@0.3.2
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
  - csuite-core@0.3.1
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

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - Fix `objectives_list` returning only assigned work to any caller holding `objectives.create`.

  The tool describes itself as listing "objectives you have a relationship with — assigned to you, originated by you, or objectives you're watching," and the agent briefing tells agents to call it after a restart or context compaction _rather than trusting memory_. For a member who originates or watches without being assigned — the coordinating role — it returned an empty plate.

  The defect was not where it looked. The route already implemented the relationship union, and a member **without** `objectives.create` got exactly what the description promised. `handleObjectivesList` unconditionally sent `assignee: <self>`, which the route honours for privileged callers, bypassing the union entirely. So the permission granting more authority was what removed the capability, and the role that most needs to see what it originated and watches was the only one that could not.

  `ListObjectivesQuery` gains `related`, the explicit relationship scope — assigned OR originated OR watching — applied for every caller, with the same self-only restriction as `assignee` for members lacking `objectives.create`. The MCP tool now sends `related` instead of `assignee`.

  The union is deliberately **not** the default for a privileged caller with no filter: the director dashboard (`web-ui/src/lib/objectives.ts`) calls `listObjectives()` bare and relies on team-wide, and the runner's plate snapshot (`objectives-tracker.ts`) relies on `assignee` staying narrow — folding watched objectives into it would change what every agent is re-briefed with after compaction.

  The regression fixture is a **privileged** caller assigned nothing, against a team-wide total larger than their related set. Both properties matter: a plain-member fixture passes against the bug because the union already covers that path, and an equal-sized team total passes against a route that ignores `related` entirely.

- [#51](https://github.com/the-efficacious/commandsuite/pull/51) [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c) Thanks [@keencaliper](https://github.com/keencaliper)! - Reassigning an objective no longer strips the previous assignee from its discussion thread.

  Thread membership is **computed**, not stored — `objectiveThreadMembers` derives it from the current assignee, the originator, the explicit watchers, and every admin. So reassignment never revoked anything: the assignee term simply stopped matching, and the outgoing assignee fell out of their own objective's thread at exactly the moment they needed to hand over. Posting a handover returned `403: user '<name>' is not a member of objective <id>'s thread`, which pushes the most valuable context of the whole transition into a private DM instead of the objective's append-only record.

  `reassign` now promotes the outgoing assignee to **watcher** in the same transaction, emitting a `watcher_added` event carrying `reason: 'reassigned-from'` so the audit log explains why they are on the list.

  **Why a watcher rather than "retaining them as a thread member":** there is no membership record to retain. Membership is a union of derived grants, and `watchers` is the only durable one the model can already express — it persists, it grants posting rights, and it receives future pushes. The alternative would have required a new concept.

  The grant is deliberately **visible**: a former assignee appears in the watcher list, which is true — they worked on it — and an accountable watcher beats an invisible one. The accepted cost is that repeated reassignment grows the list.

  No-ops are skipped: the outgoing assignee is not promoted when they are the originator (membership already derives from that) or already a watcher, so no duplicate entries.

  Confirmed by test rather than assumed: a former assignee who was _independently_ a watcher retained access **before** this change, which is what establishes that nothing was being revoked. Reassignment also strips neither the incoming assignee, the originator, nor pre-existing watchers.

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
  - csuite-core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [[`9d22ed2`](https://github.com/the-efficacious/commandsuite/commit/9d22ed2179f5ab81852705485d2692107c7330bb)]:
  - csuite-sdk@0.2.0
  - csuite-core@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies []:
  - csuite-core@0.1.2
  - csuite-sdk@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies []:
  - csuite-core@0.1.1
  - csuite-sdk@0.1.1

## 0.1.0

### Minor Changes

- [#19](https://github.com/the-efficacious/commandsuite/pull/19) [`385ffef`](https://github.com/the-efficacious/commandsuite/commit/385ffef84df773e09c8c6a736bfceccb1fa3fbf2) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Fresh bootstraps now seed into a dedicated `./csuite/` server directory instead of scattering files across the cwd.

  `csuite setup` and the `csuite serve` first-run wizard create `./csuite/` (mode `0o700` — the containing-directory permission the KEK docs always recommended) and place `csuite.json`, `csuite.db`, and `csuite-kek.bin` inside it. Resolution never nests and stays backward compatible: an explicit `--config-path`/`$CSUITE_CONFIG_PATH` wins, a flat `./csuite.json` in the cwd marks it as the server directory (existing deployments and running from inside `./csuite/` both keep working unchanged), and `csuite serve` from the parent auto-discovers `./csuite/csuite.json`.

  Also fixed: a boot that bails before the wizard can run (non-TTY stdin, already-populated team) no longer leaves a freshly-minted `csuite-kek.bin` — or anything else — behind in the directory.

- [#19](https://github.com/the-efficacious/commandsuite/pull/19) [`9199dba`](https://github.com/the-efficacious/commandsuite/commit/9199dbafaa3337a9d62c7fd287ae666d90fb4f05) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - Retire the team `directive` field and slim the first-run wizard to identity + auth.

  The wizard now collects only the team name, your name, a bearer token, and TOTP enrollment — no more forced directive/context/role prose before you've even seen the product. Standing context lives in exactly three editable places: `team.context` (team-level, now up to 8192 chars, editable from TeamHome in the web UI, `csuite team set`, or the `team_update` MCP tool), role title + description (public per-member), and member `instructions` (private per-member).

  Existing databases migrate automatically on boot: a non-empty legacy `directive` is folded into the head of `context` and the column is dropped. `PATCH /team`, `csuite team set`, and `team_update` no longer accept `directive`.

### Patch Changes

- [#22](https://github.com/the-efficacious/commandsuite/pull/22) [`871122f`](https://github.com/the-efficacious/commandsuite/commit/871122fdab0bfbf5ed3507dc8392903b5ecb9be4) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - `csuite-web-ui` and `csuite-web-host` are now published packages (previously private workspace packages), and both join the fixed version group so the whole published surface releases in lockstep.

  - **`csuite-web-ui`** ships as it always existed internally: TypeScript source (`files: ["src"]`, exports pointing at `src/index.ts`). Build it with your host's bundler — Vite + `@preact/preset-vite` is the reference setup (`csuite-web-host` is the working example). Mount the team view via `<TeamShell>`.
  - **`csuite-web-host`** now builds into its own `dist/` and publishes it (`files: ["dist"]`), so an external host — a managed service, a CDN, any static server — can serve the same TOTP-gated PWA the self-hosted broker ships, straight from the tarball (`csuite-web-host/dist`).
  - **`csuite-server`** owns the copy step now: its build syncs `csuite-web-host/dist` into `public/` (`apps/server/scripts/sync-public.mjs`) instead of web-host writing into the server's tree. No behavior change for server users — the published tarball still ships the built PWA in `public/`.

- Updated dependencies [[`8c4a842`](https://github.com/the-efficacious/commandsuite/commit/8c4a842b9e5a4b9f777994cab253d41808d8891c), [`9199dba`](https://github.com/the-efficacious/commandsuite/commit/9199dbafaa3337a9d62c7fd287ae666d90fb4f05)]:
  - csuite-sdk@0.1.0
  - csuite-core@0.1.0

## 0.0.1

### Patch Changes

- csuite-core@0.0.1
- csuite-sdk@0.0.1
