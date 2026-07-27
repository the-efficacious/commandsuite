---
'csuite-cli': patch
---

Move the CLI auth store out of your project tree: `csuite connect` now saves to the user-global `~/.config/csuite/auth.json` (per-OS: `~/Library/Application Support` on macOS, `%APPDATA%` on Windows) and records which directory each enrollment serves, so one machine still holds a distinct member identity per workspace. Previously the bearer token was written to `<cwd>/.csuite/auth.json` — inside your project, and one `git add -A` from being committed. Scope with `--workspace <dir>` or `--global`; inspect with the new `csuite auth list`. Legacy project-scoped stores are still read, and `csuite auth migrate` (or the next `csuite connect`) folds them in — if one was inside a git working tree the CLI now tells you to rotate the token, since it may already be in your history.
