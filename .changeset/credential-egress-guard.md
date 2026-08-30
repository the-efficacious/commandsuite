---
'csuite-sdk': minor
'csuite-core': minor
'csuite-cli': patch
---

Refuse bearer-credential-shaped chat bodies before persistence and guard every
runner tool result before it enters an IPC frame or agent context. The shared
credential detector recognizes complete `csuite_` bearer tokens without
echoing the refused value.
