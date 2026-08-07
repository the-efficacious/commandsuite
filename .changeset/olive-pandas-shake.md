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
- Every view lives under `/environment`, including the per-kind detail
  routes (`/environment/secrets/:slug`, `/environment/variables/:slug`).
  They stay per-kind because a slug is unique per store, not across the
  pair. The prefix is not cosmetic: the broker registers its REST routes
  before the SPA fallback, so the obvious `/secrets/:slug` is answered by
  the API and returns 401 JSON on a reload or a shared link. That was
  already true of the old secret detail route; it is fixed here.

Classification is carried by the design system's lamp signals rather
than by a badge — a secret reads `nominal` (contained), a variable reads
`caution` (recorded verbatim) — on the section heading, the create form's
kind choice, and the detail banner. Content is held to a readable
measure, and controls are sized to the data they hold rather than to the
window.

There is no convert action between the stores, and the secret detail
view says so: a secret's value is write-only, so a delete-and-recreate
needs the original value to hand.
