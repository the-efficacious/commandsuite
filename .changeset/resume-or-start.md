---
"csuite-cli": minor
"csuite-sdk": minor
---

Bare `--resume` on `csuite claude` and `csuite codex` is now resume-or-start: it resumes the most recent session/thread when one exists and otherwise starts fresh — loudly, with a greppable runner log line and typed `resumed: false` + `resumeReason` on the `session_start` activity event — instead of erroring. Under a supervisor (`install-service`'s `Restart=always`) the old deterministic error was an infinite restart loop on any fresh member. Explicit `--resume <id>` stays strict. The `session_start` schema gains optional `resumed`/`resumeReason` fields (additive; absent on events from older runners).
