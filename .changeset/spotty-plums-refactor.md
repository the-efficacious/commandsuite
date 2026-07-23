---
'csuite-sdk': minor
'csuite-server': minor
'csuite-cli': minor
---

Retire the team `directive` field and slim the first-run wizard to identity + auth.

The wizard now collects only the team name, your name, a bearer token, and TOTP enrollment — no more forced directive/context/role prose before you've even seen the product. Standing context lives in exactly three editable places: `team.context` (team-level, now up to 8192 chars, editable from TeamHome in the web UI, `csuite team set`, or the `team_update` MCP tool), role title + description (public per-member), and member `instructions` (private per-member).

Existing databases migrate automatically on boot: a non-empty legacy `directive` is folded into the head of `context` and the column is dropped. `PATCH /team`, `csuite team set`, and `team_update` no longer accept `directive`.
