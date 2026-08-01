---
'csuite-server': minor
'csuite-sdk': minor
'csuite-cli': minor
---

Team process rules are held as current state and injected into every
member's fixed context, amendable with history retrievable.

Four process rules were adopted on 2026-07-31/08-01 and all four lived
only in a director-to-lead DM and in broadcasts. No member other than
the lead knew any of them, and a member whose context had cleared knew
none. The same evening a ruling silently re-scoped an acceptance
criterion and produced a circular dependency a director had to break.
Both are one shape: the durable surface holds the stale version and the
correction is a message.

- New `process_rules` store with an **immutable anchor** as the identity
  a reader tracks across amendments — text moves, the anchor does not,
  which is what makes a reversal distinguishable from a rewording.
- **`provenance` is required.** "The director said this" and "the lead
  proposed it and nobody objected" bind differently; rendering them
  identically launders the second into the first.
- **`status` includes `disputed`,** with a required reason. One real
  rule is recorded in a form its author cannot stand behind and
  observed practice contradicts — a store with only "in force" or
  absence would have to drop it or assert it, and both are false.
- Amendment carries **`disposition`, the same field and semantics as an
  objective contract amendment**, so "does work started under the old
  rule finish under it" has one answer across contracts and process.
  `changeKind` is orthogonal: it says whether the rule reversed,
  narrowed or was reworded.
- History is **retrieved, never resident**: `GET
  /process-rules/:anchor/history`. The injected block is bounded by the
  number of rules, not by how often they changed.
- Rules ride in their **own briefing field, never inside
  `instructions`** — that field inherits an 8192 cap sized for authored
  text which also bounds composed output, and rules inside it would
  stop a runner starting. In their own field an older runner ignores
  them and starts normally.

Known gap, stated because a reader would otherwise assume otherwise:
the `#103` context watchdog does not watch this block, so rules reach a
member at their next runner start with no in-flight recovery. Extending
the projection requires the redaction exemption to land with it or the
two gaps stop cancelling.

Also adds `scripts/mutate.sh`, which asserts a mutation actually applied
before interpreting the suite — an unapplied patch and a killed mutant
are otherwise the same green.
