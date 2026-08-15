---
'csuite-core': patch
---

Fix traces silently truncating at a corrupt row. The activity, inference and telemetry list paths skipped rows they could not decode and returned a short page, which every caller reads as "no more rows" — so one bad row ended a trace early and reported it as complete. They now refill, and a short page means exhausted.
