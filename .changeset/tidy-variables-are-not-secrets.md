---
'csuite-server': minor
'csuite-sdk': minor
'csuite-cli': minor
---

Separate runner environment **variables** from secrets, so a value the
team publishes stops being scrubbed from the team's own traces.

The secrets registry was the only path into a runner's environment and
registered every value in it for redaction unconditionally. Git
identity had to be stored as a secret and was then removed from every
captured body — and which members it happened to was decided by a
length threshold, so a six-character name vanished while a
four-character one survived.

- New `variables` store, `/variables/*` API, `csuite variables`
  command and `variables_*` MCP tools. Values are readable by a
  `secrets.manage` holder and are **never** passed to
  `registerSecretValues`.
- `GET /secrets/resolve` returns secrets and variables merged, plus
  `secretEnvNames` marking which keys the runner may register. A
  runner talking to an older broker registers everything, as before.
- `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and
  `GIT_COMMITTER_EMAIL` migrate from secrets to variables
  automatically at broker start, in one transaction, carrying values
  and bindings. No operator step.
- The per-member `envName` uniqueness invariant now spans both stores.
  A secret and a variable targeting one name for one member is an
  error, never a precedence rule.

`MIN_REGISTERED_VALUE_LENGTH` is unchanged: the repair is
classification, and the threshold goes back to guarding short *secret*
values.

The web UI has no variables panel yet, so migrated rows leave
`SecretsPanel` and are visible on the API, CLI and MCP surfaces only.
Filed rather than left implicit.
