---
'csuite-sdk': minor
'csuite-core': minor
'csuite-cli': minor
---

Add explicit per-token and revoke-all bearer rotation scopes. The CLI requires
one scope and writes the replacement credential to a new 0600 file without
printing plaintext; the legacy empty REST body retains revoke-all behavior
until its separately approved compatibility flip.
