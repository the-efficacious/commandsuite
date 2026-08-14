---
'csuite-core': minor
'csuite-cli': minor
'csuite-server': minor
---

`csuite prune-traces` now deletes across the whole activity database — inferences, telemetry and raw bodies as well as the activity timeline — and reports each separately. Previously it pruned only the timeline while the heaviest tables in the same file grew without bound. Raw bodies are collected by reference rather than age, so a deduplicated body outlives the exchange that first stored it.
