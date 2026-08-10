---
'csuite-server': major
'csuite-sdk': major
'csuite-cli': major
'csuite-web-ui': major
'csuite-core': major
---

**Objectives are removed.** The spine replaces them: contracts, subjects,
revisions, criteria and verdicts, asks and rulings, and `orient` as the
recovery call. Pre-1.0, the director's ruling was to decimate rather than
gate — the old surface is deleted, not deprecated behind a flag. The
legacy record is imported first, as `legacy_projection`, by
`csuite-import-objectives`; **run it before upgrading a server, because
after the upgrade the old tables have no reader.**

**What goes.** The objectives store and its eleven REST endpoints; the
eleven `objectives_*` MCP tools and the `csuite objectives` verb; the
`ObjectivesPanel` / `ObjectiveDetail` / `ObjectiveCreate` panels, their
routes, the inbox items, the nav badge, the palette entries and the
timeline's objective filter; the `/objectives/<id>/` files namespace,
its `obj:` owner scope and the ACL provider behind it; the objectives
section of the composed instructions; the runner's `context_refresh`
re-brief and its open-plate tracker; the `objective_open` /
`objective_close` activity kinds; and four permission leaves —
`objectives.create`, `.cancel`, `.reassign`, `.watch`. Twelve leaves
become nine. The `operator` preset becomes `spine.author` +
`spine.focus`.

**DECISIONS.**

- **The objective-context watchdog is deleted rather than fixed, and its
  removal is a bug fix.** It built its haystack from
  `entry.request.system` and `entry.request.messages`, which both runners
  hard-code to `null` and `[]` — so it never detected anything, and it
  nagged every assignee every five minutes for as long as it shipped. The
  curator's lease and receipt counters are what it was reaching for. The
  comments in the curator that name it as a shape to avoid rebuilding now
  say what it was, since the code they point at is gone.
- **The generic `context-watchdog.ts` is untouched**, verified across the
  whole branch: all three of its compose call sites already passed
  `openObjectives: []`, so it was decoupled before this started. Its
  twelve tests still pass unchanged.
- **The session-online notice loses its plate count.** It counted a
  member's active and blocked objectives and pushed the number — a
  derived value, computed when the socket opened, stale the moment
  anything moved, and spent out of the member's context whether they
  needed it or not. §10: status is PULLED state. It names `orient`
  instead, which answers the same question at the moment it is asked and
  is the cheapest call in the surface by construction.
- **The re-brief is replaced, not merely deleted.** It and `orient`
  recovery fired side by side from phase 3 on. They were never
  equivalent: the re-brief composed runner-side and SKIPPED AN EMPTY
  PLATE, so a member with nothing assigned was told nothing; recovery
  composes nothing, injects the header and cursor an empty plate is
  owed, and records a lease and receipts server-side on every call.
- **`quickstart` gets a spine equivalent rather than losing its
  seeding.** It registers one subject — `doc:quickstart`, as a
  deliberate act of the operator who ran the command, never a repo name
  parsed out of the working directory — and authors the demo contract
  against it with an op_id derived from the title. It names no verifier:
  volunteering somebody to judge criteria is not a demo's business.
- **`AmendmentDisposition` survives its origin.** It arrived with
  objectives; the process document and the spine's `amendment` adopted
  the same field with the same meaning on purpose, so "does work started
  under the old text finish under it" has one answer across every
  amendable thing on the team. It is moved, not deleted.
- **`FsOwnerSchema` keeps its `obj:<id>` arm.** Nothing produces one any
  more, but rows written while the namespace existed are still in
  deployed databases and `fs_entries` has no migration that rewrites
  them. Narrowing back to `NameSchema` would recreate exactly the defect
  the widening fixed — the pattern excludes `:`, validation runs on the
  response, and the write has already committed when the caller is told
  it failed. Removing dead code and removing the schema that lets a
  client read what the removal left behind are different acts.
- **A repo-root scanner guards the removal**, reading the three shapes a
  consumer met the surface in: a tool name in a description, a route in
  a fetch, a permission leaf in a preset. All three typecheck, which is
  why the compiler cannot help. Comments are exempt so the files
  explaining what was removed can keep explaining it — and the exemption
  is bounded by fixtures rather than trusted: a planted occurrence of
  each form is found, one inside a comment is not, and a live call on
  the line below a comment about it still is.

**Corrections from independent verification.**

- **The provenance guard now covers deletion, not just update.** A
  `BEFORE UPDATE OF provenance` trigger left two ways through that both
  preserve a row's id AND its seq, so nothing downstream could tell
  afterwards: `INSERT OR REPLACE`, and `DELETE` followed by a fresh
  insert. A delete-and-reinsert migration is not exotic — it is how
  people routinely change a column they cannot `ALTER`, and it is
  exactly the caller the rule exists for. `spine_events` now also
  refuses deletion, which the table's own header already asserted
  ("nothing ever deletes, so the stream is gapless") and nothing
  enforced. **`PRAGMA recursive_triggers = ON` is part of the fix**:
  SQLite fires delete triggers for rows removed by REPLACE conflict
  resolution if and only if it is set, so without it `INSERT OR
  REPLACE` walks straight past the trigger. Measured both ways, and the
  fixture drives that exact statement rather than trusting the reading.
- **A correction of a legacy `assigned` event no longer vanishes.**
  `assigned` is the one legacy kind that produces no event of its own —
  its content *is* the specification — and it was recorded in the
  ledger only. Legacy `correctEvent` explicitly permits correcting it,
  so such a correction resolved to nothing, was reported unimported
  under a reason that was FALSE about the target ("which was not
  imported" — it was, as the spec), and the member's correction text
  left the annex entirely. Corrections now resolve through the ledger,
  which also fixes the same class ACROSS runs: a correction arriving on
  a later run than its target found an empty in-memory map and could
  never staple. Member-authored text disappearing is the one thing this
  design says must never happen.
- **Amendments are keyed by legacy event id, not by ordinal.** The
  amendment list is built by filtering event rows and a filter
  compacts, so one unreadable payload shifted every later amendment by
  one — pairing an event dated and attributed to one member with
  another member's reason and another member's recorded prior text. A
  claim nobody made, wearing a member's name, generated by the branch
  that handles the error.
- **The ambient crash window is closed.** The annex write and the
  ledger write are separate autocommit statements and cannot be made
  one: the store opens its own transaction and SQLite refuses nesting.
  A kill between them duplicated a discussion post on re-run (measured
  1 → 2; lifecycle stayed at 1, because `op_id` dedupes it). An ambient
  step's identity — contract, author, instant, text — is now recoverable
  from the ANNEX, which is strictly stronger than a transaction: it
  also survives the ledger being lost or rebuilt.
- **A mistyped `--db` is refused.** `openDatabase` creates the file, so
  a typo imported the zero objectives in a brand-new database and
  exited 0 printing "objectives read: 0". For a migration an operator
  is told to run *before* upgrading, that reads as clean success while
  the real database goes unimported.
- **`/objectives` is a reserved path segment.** Deleting the namespace
  special case made `ownerOf('/objectives/o-1/f.txt')` return
  `objectives` — a legal member name — so a member called that acquired
  read and write over the whole frozen legacy tree, while the assignee
  it was created for correctly could not. A structural boundary had
  become a name-dependent one. Nobody owns that segment by name now;
  directors and grant-holders reach those rows, nobody else does, and
  the stated cost is that a member named `objectives` has no home
  directory.
- **The `obj:` schema branch has a guard again.** `FsOwnerSchema` keeps
  that arm for rows in deployed databases, but the only test exercising
  it was deleted with the objectives endpoints, leaving a live branch
  unguarded — and narrowing it is a defect that already shipped once
  (server 200, SDK throws parsing its own server's correct response,
  invisible to any test reading JSON directly). A legacy row is now
  seeded straight into `fs_entries` and asserted to parse.
- **The scanner strips comments instead of skipping comment-shaped
  lines.** A tool name planted inside a template literal, on a
  continuation line starting with `*` — a markdown bullet, which is how
  tool descriptions are actually written — scored zero hits: exactly
  the case the scanner exists for, exempted for looking like prose. It
  also flagged trailing comments after real code. Both directions now
  have fixtures. The importer's file-level exemption is gone: it bought
  nothing (the scan is clean without it) and permanently blinded the
  one module most likely to regrow the surface.

**What is documented as GONE rather than replaced,** because it is:
watchers (subscription is reader-side now — `all` / `lifecycle` /
`none`), reassignment (the spine has no act that moves an assignee), the
`obj:<id>` chat thread, per-objective traces, and the objectives file
namespace. Where there is no successor the docs say so instead of
inventing one. The spine also has no CLI surface, so no walkthrough
pretends otherwise.
