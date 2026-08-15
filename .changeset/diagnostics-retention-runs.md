---
'csuite-core': patch
---

The diagnostics retention ladder now actually runs. Its compaction was implemented and never called, leaving row caps as the only bound on the diagnostics tables.
