---
'csuite-core': minor
---

Fix `/history` returning private channel and objective-thread messages to every member. A scoped push was delivered to its audience live but persisted like a broadcast, so the durable read handed it to anyone. Messages now carry the audience they were delivered to, and the feed honours it; rows written before this cannot say who they were for, so a scoped one is now shown only to its sender.
