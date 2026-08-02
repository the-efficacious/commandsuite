---
"csuite-sdk": minor
"csuite-server": minor
---

feat!: rename briefing to instruction blocks as a clean wire break (protocol v2) — GET /instructions replaces GET /briefing outright, `Client.instructions()` replaces `Client.briefing()`, responses carry named block descriptors plus a canonical composed-content hash, instruction edits fan out a `kind: 'instructions'` event to every member whose composed text changed, and the roster lists restart-pending members
