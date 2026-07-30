# csuite

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

- Updated dependencies [[`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c)]:
  - csuite-cli@0.3.0
  - csuite-sdk@0.3.0
  - csuite-server@0.3.0
  - csuite-core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [[`585b331`](https://github.com/the-efficacious/commandsuite/commit/585b331df11f9a927adcddadd16d1055cb89b924), [`9d22ed2`](https://github.com/the-efficacious/commandsuite/commit/9d22ed2179f5ab81852705485d2692107c7330bb)]:
  - csuite-cli@0.2.0
  - csuite-sdk@0.2.0
  - csuite-server@0.2.0
  - csuite-core@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies [[`5954ce2`](https://github.com/the-efficacious/commandsuite/commit/5954ce240f6e94bf3b6f76e463487acd072b6fa7)]:
  - csuite-cli@0.1.2
  - csuite-core@0.1.2
  - csuite-sdk@0.1.2
  - csuite-server@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [[`bbed9d8`](https://github.com/the-efficacious/commandsuite/commit/bbed9d880aabd3e49b1657bca198f560f16768b5)]:
  - csuite-cli@0.1.1
  - csuite-core@0.1.1
  - csuite-sdk@0.1.1
  - csuite-server@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [[`385ffef`](https://github.com/the-efficacious/commandsuite/commit/385ffef84df773e09c8c6a736bfceccb1fa3fbf2), [`871122f`](https://github.com/the-efficacious/commandsuite/commit/871122fdab0bfbf5ed3507dc8392903b5ecb9be4), [`8c4a842`](https://github.com/the-efficacious/commandsuite/commit/8c4a842b9e5a4b9f777994cab253d41808d8891c), [`9199dba`](https://github.com/the-efficacious/commandsuite/commit/9199dbafaa3337a9d62c7fd287ae666d90fb4f05)]:
  - csuite-server@0.1.0
  - csuite-cli@0.1.0
  - csuite-sdk@0.1.0
  - csuite-core@0.1.0

## 0.0.1

### Patch Changes

- Updated dependencies [f760db7]
  - csuite-cli@0.0.1
  - csuite-core@0.0.1
  - csuite-sdk@0.0.1
  - csuite-server@0.0.1
