---
'csuite-server': minor
'csuite-sdk': minor
'csuite-cli': minor
'csuite-web-ui': minor
---

An objective's contract can be amended, and the correction lives in the
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
