---
'csuite-sdk': patch
'csuite-core': patch
---

Deprecate `Client.renameChannel` in favour of `updateChannel` — both are the
same `PATCH /channels/:slug` and `UpdateChannelRequest` strictly contains
`RenameChannelRequest`, so `updateChannel` does everything the older method
did and can set the description in the same call; `ChannelStore.rename`,
a one-line delegation to `update`, is deprecated alongside it. Neither is
removed yet, and the route's path comment now says "update" rather than
"rename".
