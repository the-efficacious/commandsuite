---
'csuite-sdk': minor
'csuite-server': minor
'csuite-cli': minor
---

Fix `objectives_list` returning only assigned work to any caller holding `objectives.create`.

The tool describes itself as listing "objectives you have a relationship with — assigned to you, originated by you, or objectives you're watching," and the agent briefing tells agents to call it after a restart or context compaction *rather than trusting memory*. For a member who originates or watches without being assigned — the coordinating role — it returned an empty plate.

The defect was not where it looked. The route already implemented the relationship union, and a member **without** `objectives.create` got exactly what the description promised. `handleObjectivesList` unconditionally sent `assignee: <self>`, which the route honours for privileged callers, bypassing the union entirely. So the permission granting more authority was what removed the capability, and the role that most needs to see what it originated and watches was the only one that could not.

`ListObjectivesQuery` gains `related`, the explicit relationship scope — assigned OR originated OR watching — applied for every caller, with the same self-only restriction as `assignee` for members lacking `objectives.create`. The MCP tool now sends `related` instead of `assignee`.

The union is deliberately **not** the default for a privileged caller with no filter: the director dashboard (`web-ui/src/lib/objectives.ts`) calls `listObjectives()` bare and relies on team-wide, and the runner's plate snapshot (`objectives-tracker.ts`) relies on `assignee` staying narrow — folding watched objectives into it would change what every agent is re-briefed with after compaction.

The regression fixture is a **privileged** caller assigned nothing, against a team-wide total larger than their related set. Both properties matter: a plain-member fixture passes against the bug because the union already covers that path, and an equal-sized team total passes against a route that ignores `related` entirely.
