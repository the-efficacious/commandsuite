---
'csuite-sdk': patch
'csuite-core': patch
'csuite-cli': patch
---

One slug grammar, defined once. `SLUG_PATTERN`, `SLUG_MAX_LENGTH` and `SLUG_RULE`
are now exported from `csuite-sdk/protocol`, and every slug schema
(`ChannelSlugSchema`, `ToolSourceSlugSchema`, and the `SecretSlugSchema` /
`NotificationSlugSchema` aliases) and every server validator (`validateSlug`,
`validateSourceSlug`, `validateVariableSlug`) is built from them. The regex was
written out four times and a fifth copy disagreed.

**The variables store now enforces what the wire always enforced.**
`validateVariableSlug` allowed 64 characters and `^[a-z0-9][a-z0-9-]*$`, so it
accepted `git--token` and `git-token-`; `CreateVariableRequestSchema` has
refused both since variables shipped, and every existing row came through it, so
nothing on disk is affected. The function is kept (not deleted) and delegates,
so `csuite-core`'s export surface is unchanged.

**Agents were told the wrong rule.** The `variables_create` tool description said
"Lowercase letters/digits/dashes, max 64" while the SDK refused over 32
client-side, so a 40-character slug failed with a raw zod dump the model could
not learn from. Every `slug` argument on `tool_sources_create`, `secrets_create`,
`variables_create`, `notifications_create` and `notifications_profile_create` now
carries one description, interpolated from `SLUG_MAX_LENGTH`, that states the
dash rules too.

`validateVariableSlug`'s doc comment also claimed a variable slug "may not
collide with a secret's". Nothing enforced that, at any layer, and the stated
reason was void — change events thread as `secret:<slug>` and `variable:<slug>`.
The rule is: **a slug is unique within its store, never across stores.** What is
shared across the secret/variable pair is the env-name namespace, which has its
own check.
