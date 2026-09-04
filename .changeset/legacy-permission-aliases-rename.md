---
'csuite-sdk': patch
'csuite-core': patch
---

`LEGACY_PERMISSION_EXPANSIONS` is now `LEGACY_PERMISSION_ALIASES`. The table
holds two unlike things — `objectives.manage`, an aggregate that expanded to
several leaves and no longer exists, and `process.manage`, a one-to-one rename
— and only the first is an expansion, so the old name described half its
contents. The old export remains as a deprecated alias of the new one, so
nothing outside this repository has to move yet; a test pins the two to the
same table, because a shim that drifted to a subset would expand fewer aliases
and quietly narrow a member's authority.
