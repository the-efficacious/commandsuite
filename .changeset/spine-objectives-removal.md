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

**What is documented as GONE rather than replaced,** because it is:
watchers (subscription is reader-side now — `all` / `lifecycle` /
`none`), reassignment (the spine has no act that moves an assignee), the
`obj:<id>` chat thread, per-objective traces, and the objectives file
namespace. Where there is no successor the docs say so instead of
inventing one. The spine also has no CLI surface, so no walkthrough
pretends otherwise.
