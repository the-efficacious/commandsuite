---
'csuite-cli': patch
'csuite-sdk': patch
---

Report peak activity-uploader queue occupancy in events and serialized UTF-8 bytes in
`session_end.capture`, while continuing to accept older run summaries that omit the new fields.
