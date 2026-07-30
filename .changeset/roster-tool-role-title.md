---
'csuite-cli': patch
---

Fix the `roster` MCP tool rendering every teammate's role as `[object Object]`.

A role has been an object (`{title, description}`) since the initial public release, but the agent-facing `roster` tool interpolated it straight into its output line, so every agent that ever called `roster` got `- Lea [[object Object]] [admin] connected=1` — the one field that says what a teammate *does* was unreadable, on the one surface an agent has for deciding who to route work to. Every human-facing surface (`csuite roster`, `csuite member list`, and the web UI) already read `role.title`; only the agent's view was broken.

The tool now renders `role.title`, matching `csuite roster`. The existing bridge test asserted only that teammate *names* appeared in the output, which is why this shipped and survived — it now asserts the role titles render and that `[object Object]` never appears.
