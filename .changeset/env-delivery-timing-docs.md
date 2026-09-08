---
'csuite-core': patch
'csuite-sdk': patch
'csuite-web-ui': patch
---

Environment delivery is no longer described as spawn-time only. Setting a secret or variable value, and binding or unbinding a member, fan out an `environment` event that makes a running runner re-resolve and restart its agent cold at its next idle boundary; metadata edits and deletions emit no such event and reach the member on its next runner start. The REST, MCP and CLI references, the secrets and variables concept pages, the web UI value hints, and the `PATCH /secrets/:slug` notice — which promised a reload that never fired — now all draw that line.
