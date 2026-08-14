---
'csuite-core': patch
---

Unmatched `/members/...` requests now answer a JSON 404 instead of falling through to the single-page app, which returned `index.html` with a 200 to clients asking for JSON.
