---
'csuite-web-ui': patch
---

`ActivityToolAction.source` is rendered rather than dropped. The tag was carried
through `buildThread` into the tool-action view model and then left out of the
row, so a reader could not tell which recorder produced an action — and that tag
is what separates the agent's own durable record (`transcript`,
`codex_rollout`) from the broker's metadata-only invoke audit (`tool_source`),
which is the difference between what the agent did and what the broker logged
about it. It renders beside the agent name, titled as the capture source.
