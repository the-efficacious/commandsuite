---
'csuite-core': patch
---

`DiagnosticEmitter.enrollmentSourceLabelTruncated` no longer takes a field name — the cause records a count and nothing else, and which source label was truncated is already in the log line.
