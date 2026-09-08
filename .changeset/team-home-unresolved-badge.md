---
'csuite-web-ui': patch
---

Unresolved capture incidents and a degraded diagnostics store now show on the
team home roster row, not only on the member profile. `presenceDiagnostics` had
one reader, so the page everyone starts on — the one where you decide whose
profile is worth opening — drew a member sitting on unresolved incidents exactly
as it drew a clean one. The badges render alongside the capture warning rather
than instead of it, and a degraded store speaks at zero unresolved, because a
store that cannot record is the state in which a zero means nothing.
