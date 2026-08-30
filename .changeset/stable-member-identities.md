---
'csuite-sdk': minor
'csuite-core': minor
---

Add stable UUID member identities as the attribution key for typed offboarding.
Existing databases are backfilled transactionally, names remain the public
handle, and older brokers that do not report an identity remain readable.
