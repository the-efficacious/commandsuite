---
'csuite-server': patch
'csuite-sdk': patch
'csuite-cli': patch
---

Name CommandSuite and csuite in the briefing opening, with the broker and
long-lived runner versions shown separately so a stale runner is visible from
its own context. Older callers report `runner=unknown`; malformed version
reports retain a warning without preventing briefing delivery. Long version
tokens are visibly abbreviated so operational metadata cannot consume the
headroom reserved for authored instructions.
