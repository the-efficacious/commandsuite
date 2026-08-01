# csuite-web-host

## 0.4.0

### Patch Changes

- [#129](https://github.com/the-efficacious/commandsuite/pull/129) [`a00f59e`](https://github.com/the-efficacious/commandsuite/commit/a00f59e71c68ef7a9fef5ff16ecda709e0217066) Thanks [@sureforge](https://github.com/sureforge)! - Remove length caps from team context, role descriptions, personal instructions,
  and composed briefings. Show character counts and explicitly approximate token
  estimates on the web, CLI, and agent administration surfaces, and warn when an
  oversized briefing is requested by a runner that may still enforce the former
  8192-character client-side limit.
- Updated dependencies [[`c0e1b89`](https://github.com/the-efficacious/commandsuite/commit/c0e1b8974c795b91001fa45a8b5c4b2174af0ed9), [`94bee08`](https://github.com/the-efficacious/commandsuite/commit/94bee08d593c4aac56aaf563d7d1b2865bce405e), [`e5a9210`](https://github.com/the-efficacious/commandsuite/commit/e5a9210991b00871656e2cda6a0dd28722a6facf), [`d384bff`](https://github.com/the-efficacious/commandsuite/commit/d384bff9d97ac222fb2fcf022d84e26c6da18a00), [`a00f59e`](https://github.com/the-efficacious/commandsuite/commit/a00f59e71c68ef7a9fef5ff16ecda709e0217066)]:
  - csuite-sdk@0.4.0
  - csuite-web-ui@0.4.0

## 0.3.5

### Patch Changes

- Updated dependencies []:
  - csuite-sdk@0.3.5
  - csuite-web-ui@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies []:
  - csuite-sdk@0.3.4
  - csuite-web-ui@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies [[`5f638aa`](https://github.com/the-efficacious/commandsuite/commit/5f638aa670267c4cdc8472cf86b61ba0d0d38e51), [`676f315`](https://github.com/the-efficacious/commandsuite/commit/676f31504a4afd7dae0483a55e1d14a1c3ef934b), [`1d618e4`](https://github.com/the-efficacious/commandsuite/commit/1d618e491a9630662b3cdef8afdf9b4f7322d2a5), [`40e5513`](https://github.com/the-efficacious/commandsuite/commit/40e55138e45c4a610f111896f95ad3bed8052a23)]:
  - csuite-sdk@0.3.3
  - csuite-web-ui@0.3.3

## 0.3.2

### Patch Changes

- [#58](https://github.com/the-efficacious/commandsuite/pull/58) [`6800958`](https://github.com/the-efficacious/commandsuite/commit/6800958da90dbe87e89a1a49f6976b18f6e4177f) Thanks [@sureforge](https://github.com/sureforge)! - Correct package authorship metadata to identify Efficacious, Inc.

- Updated dependencies [[`6800958`](https://github.com/the-efficacious/commandsuite/commit/6800958da90dbe87e89a1a49f6976b18f6e4177f)]:
  - csuite-sdk@0.3.2
  - csuite-web-ui@0.3.2

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
  - csuite-web-ui@0.3.1

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

- Updated dependencies [[`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ee34ac0`](https://github.com/the-efficacious/commandsuite/commit/ee34ac049fe54c734fac074c94aac13103cb2074), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c), [`ec161f2`](https://github.com/the-efficacious/commandsuite/commit/ec161f269b506e174d598957b61b61eaffadc79c)]:
  - csuite-sdk@0.3.0
  - csuite-web-ui@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [[`9d22ed2`](https://github.com/the-efficacious/commandsuite/commit/9d22ed2179f5ab81852705485d2692107c7330bb)]:
  - csuite-sdk@0.2.0
  - csuite-web-ui@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies []:
  - csuite-sdk@0.1.2
  - csuite-web-ui@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies []:
  - csuite-sdk@0.1.1
  - csuite-web-ui@0.1.1

## 0.1.0

### Minor Changes

- [#22](https://github.com/the-efficacious/commandsuite/pull/22) [`871122f`](https://github.com/the-efficacious/commandsuite/commit/871122fdab0bfbf5ed3507dc8392903b5ecb9be4) Thanks [@andrew-jon-p7a](https://github.com/andrew-jon-p7a)! - `csuite-web-ui` and `csuite-web-host` are now published packages (previously private workspace packages), and both join the fixed version group so the whole published surface releases in lockstep.

  - **`csuite-web-ui`** ships as it always existed internally: TypeScript source (`files: ["src"]`, exports pointing at `src/index.ts`). Build it with your host's bundler — Vite + `@preact/preset-vite` is the reference setup (`csuite-web-host` is the working example). Mount the team view via `<TeamShell>`.
  - **`csuite-web-host`** now builds into its own `dist/` and publishes it (`files: ["dist"]`), so an external host — a managed service, a CDN, any static server — can serve the same TOTP-gated PWA the self-hosted broker ships, straight from the tarball (`csuite-web-host/dist`).
  - **`csuite-server`** owns the copy step now: its build syncs `csuite-web-host/dist` into `public/` (`apps/server/scripts/sync-public.mjs`) instead of web-host writing into the server's tree. No behavior change for server users — the published tarball still ships the built PWA in `public/`.

### Patch Changes

- Updated dependencies [[`871122f`](https://github.com/the-efficacious/commandsuite/commit/871122fdab0bfbf5ed3507dc8392903b5ecb9be4), [`8c4a842`](https://github.com/the-efficacious/commandsuite/commit/8c4a842b9e5a4b9f777994cab253d41808d8891c), [`9199dba`](https://github.com/the-efficacious/commandsuite/commit/9199dbafaa3337a9d62c7fd287ae666d90fb4f05)]:
  - csuite-web-ui@0.1.0
  - csuite-sdk@0.1.0

## 0.0.1

### Patch Changes

- csuite-sdk@0.0.1
- csuite-web-ui@0.0.1
