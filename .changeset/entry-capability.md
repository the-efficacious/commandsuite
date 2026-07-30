---
'csuite-sdk': patch
'csuite-server': patch
'csuite-web-ui': patch
---

`FsEntry` now carries `canWrite` — the server's own `canWrite()` answer for the requesting viewer. Clients no longer have to rebuild that rule, and for objective-namespace entries they could not: the owner is `obj:<id>` and the rule includes objective membership, which a client cannot determine for an arbitrary path. The field is optional, so an older server that omits it still parses. The web UI's Delete control now asks rather than inferring, which restores it for objective members who were entitled to it all along.
