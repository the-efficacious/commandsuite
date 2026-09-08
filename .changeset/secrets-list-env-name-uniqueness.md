---
'csuite-cli': patch
---

Stop telling agents that secret env names are globally unique.
`secrets_list` still advertised the uniqueness rule the store dropped on
2026-07-30, and an agent that believes it will not create the per-member
token rows the product is built around. The description now states the
rule that actually holds: slugs are unique, env names are deliberately
not, and the invariant is per member — no member may resolve one env
name twice, counting variables as well as secrets.
