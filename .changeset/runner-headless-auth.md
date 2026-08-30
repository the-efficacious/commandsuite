---
"csuite-cli": patch
---

`csuite claude` and `csuite codex` no longer fall into the interactive enrollment wizard when no credential resolves and stdin is not a TTY. They exit 1 naming the lookup key — broker URL and working directory — and the two fixes, so a service unit that omits `CSUITE_URL` fails once with a readable reason instead of restart-looping or hanging on a device code. `--doctor` gains a `saved auth` check that reports the same lookup (#199).
