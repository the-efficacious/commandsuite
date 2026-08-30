---
'csuite-sdk': minor
'csuite-core': minor
'csuite-server': minor
---

Add the dedicated `channels.manage` permission, channel descriptions, and an
immutable administration audit. Channel creator and legacy channel-admin roles
no longer authorize mutations; creation is provenance and creators join as
ordinary members. Existing teams must grant `channels.manage` before channel
administration resumes.
