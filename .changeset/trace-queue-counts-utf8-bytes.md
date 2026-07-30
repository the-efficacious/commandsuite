---
'csuite-cli': patch
---

Count serialized activity-event sizes in UTF-8 bytes rather than UTF-16 code units. The corrected
counter drives the queued-payload budget, size-triggered flushing, and approximate POST batch
selection; request-envelope overhead remains outside the POST estimate.

ASCII behavior is unchanged. The effective limits are tighter for non-ASCII content, especially
CJK- and emoji-heavy traces. Oldest-event drops at the corrected queued-payload budget remain
counted and reported in `session_end.capture`.
