---
'csuite-cli': patch
---

Fix a transcript-reader race where a drain already in flight when `close()`
landed could still emit activity events for lines appended after close.
