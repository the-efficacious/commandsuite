---
'csuite-server': minor
'csuite-web-ui': patch
'csuite-sdk': patch
---

feat: grant `process.manage` to the seeded admin and surface it in the permissions editor. The leaf shipped held by nobody — a deliberate control — which left the team-process section invisible on every fresh install; compounding it, the web UI's permission grid had no `PERMISSION_META` entry for the leaf, so it could not be granted from the UI at all. The wizard's withheld list is now empty (new teams seed the bootstrap admin with every leaf; existing teams are untouched — presets seed once, at genesis) and the permissions editor lists `process.manage`, with a parity test so a future leaf cannot ship checkbox-less again.
