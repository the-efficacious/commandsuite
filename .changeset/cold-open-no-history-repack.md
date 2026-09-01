---
'csuite-cli': patch
'csuite-core': patch
'csuite-sdk': patch
'csuite-server': patch
---

Instruction and environment restarts now start the agent cold instead of resuming the prior conversation. The successor gets the refreshed instructions and the runner's `context_refresh` re-brief on its open objectives, and its `session_start` says why (`resumed: false` with `resumeReason: 'instructions changed'`, `'environment changed'`, or `'environment reloaded'`); a fresh MCP session is always re-briefed, even inside the cooldown that folds an attach and a compaction. Resuming there was the source of a capture defect measured in production: a restarted runner re-read the whole resumed transcript as new activity — 1000+ rows spanning 15 hours in one second — saturating the uploader and dropping 40–88% of events. Two fixes close that regardless of how a session restarts: the transcript reader follows a changed `transcript_path` (a new file after any agent swap) while keeping its line-uuid dedup, and every transcript-derived `ActivityEvent` carries an optional `sourceId` that the broker dedups on (`member_activity.source_id`, a partial unique index added lazily; id-less events from older runners are stored as before). The runner no longer predicts resume from the filesystem: bare `--resume` on `csuite claude` hands the decision to Claude Code (`continue`, which starts fresh when nothing exists), and on `csuite codex` starts a new thread loudly, since codex resumes by id only; explicit `--resume <id>` stays strict on both.
