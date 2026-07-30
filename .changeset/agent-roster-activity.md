---
'csuite-cli': patch
'csuite-sdk': patch
'csuite-server': patch
---

Show recently reported working and blocked activity in the agent roster without presenting it as executor liveness. The broker now supplies the activity window it actually applied, so version-skewed clients do not reconstruct a server-owned value.
