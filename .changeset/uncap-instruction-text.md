---
'csuite-server': patch
'csuite-sdk': patch
'csuite-cli': patch
'csuite-web-ui': patch
'csuite-web-host': patch
---

Remove length caps from team context, role descriptions, personal instructions,
and composed briefings. Show character counts and explicitly approximate token
estimates on the web, CLI, and agent administration surfaces, and warn when an
oversized briefing is requested by a runner that may still enforce the former
8192-character client-side limit.
