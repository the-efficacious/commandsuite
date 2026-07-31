---
"csuite-sdk": patch
"csuite-server": patch
---

Retain the completeness failures the broker already detects, instead of
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
