---
'csuite-cli': patch
---

`csuite --help` now lists `csuite team`. The verb has always dispatched and the
CLI reference has always documented it, but the top-level usage block — the
first place anyone looks for the vocabulary — skipped a whole verb family. A
test now compares the usage block against the dispatch table in both
directions, so an undocumented verb (or an advertised one that does not exist)
fails the build.
