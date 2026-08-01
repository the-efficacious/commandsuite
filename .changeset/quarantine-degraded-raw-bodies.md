---
'csuite-cli': patch
---

Atomically quarantine oversized, unreadable, or invalid-UTF-8 Claude body files after the broker acknowledges their batch, preserving the only copy and its degradation reason without pinning the active spool. Quarantine is limited to private, runner-owned regular files directly inside the runner's raw-body directory; outside paths, symlinks, directories, devices, missing files, and changed identities are reported but never moved.

Quarantine retention remains unbounded and is not solved by this change.
