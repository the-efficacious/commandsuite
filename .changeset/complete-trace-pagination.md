---
'csuite-core': patch
'csuite-sdk': patch
'csuite-server': patch
'csuite-web-ui': patch
---

Make activity and GenAI range reads losslessly pageable with composite timestamp/id cursors.

TracePanel now traverses every page before joining activity with GenAI records, member activity pagination preserves rows sharing a timestamp, and GenAI enrichment failures are surfaced while retaining the marker-only fallback. Consumer-side history caps that silently discarded rows have been removed.
