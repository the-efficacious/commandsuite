---
'csuite-cli': patch
---

Fix the activity uploader abandoning its last upload at shutdown. `close()` (and `flush()`) returned as soon as the queue looked empty, even with a POST still on the wire — so a run's final `session_end` could reach the broker after the run that produced it had already exited, and any event queued behind that in-flight POST was dropped instead of drained. Both now wait for the upload in flight and then drain what is left, so a closed uploader means every event it will ever send has landed and the `uploaded`/`dropped` counts in the run summary are accurate.
