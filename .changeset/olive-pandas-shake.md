---
'csuite-web-ui': minor
---

Give the web UI a runner-environment surface, so the identity rows that
moved out of the secrets store stop being invisible to humans.

Splitting variables from secrets fixed the trace-redaction defect and
left the web UI showing only half the runner environment: `SecretsPanel`
listed secrets, the migrated `GIT_AUTHOR_*` / `GIT_COMMITTER_*` rows
were reachable on the API, CLI and MCP surfaces, and an operator opening
the panel saw a shorter list with nothing to say where the rest went.

- **Secrets nav → Environment**, one panel over both stores. They share
  one env-var namespace and the broker enforces it across both, so a
  collision raised while editing a secret names a *variable* — an error
  a secrets-only panel could not display.
- Separate labelled sections rather than one merged list, because which
  store a value lives in decides whether it is scrubbed from captured
  traces. Creating an entry requires picking a kind, with no default,
  and each choice states its trace consequence.
- A variable's value is shown; a secret's is still write-only. "Set but
  not shown" renders differently from "not set", so a configured
  variable can never read as missing.
- `/secrets` still resolves, now to the merged panel. Detail routes stay
  per-kind (`/secrets/:slug`, `/variables/:slug`) because a slug is
  unique per store, not across the pair.

There is no convert action between the stores, and the secret detail
view says so: a secret's value is write-only, so a delete-and-recreate
needs the original value to hand.
