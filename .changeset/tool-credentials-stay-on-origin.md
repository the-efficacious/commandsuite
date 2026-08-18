---
'csuite-core': patch
---

Keep custom tool-source credentials on the origin they were configured for. The executor followed redirects, and while the runtime strips `Authorization` across origins it forwards a `kind: header` credential (`X-API-Key` and the like) intact — reachable by an agent steering a cooperative upstream's open redirect. Redirects are now followed only within the binding's pinned origin, and a hop that leaves it fails the tool call without sending anything.
