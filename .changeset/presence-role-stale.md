---
'csuite-core': patch
---

A role edit now reaches every projection that carries a role. `Presence.role` is
stamped at first register and never refreshed, so after a `PATCH /members/:name`
under a live connection the roster's `connected[]` still named the old role
beside the authoritative one in `teammates[]` — one response carrying two
answers. `GET /roster` and the team-status composition both re-read the role
from the member store, and the registry's copy is now documented as a seed
rather than an answer.
