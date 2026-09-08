---
'csuite-server': patch
---

`csuite-server` no longer declares its own `EncryptedFieldError` and
`ENCRYPTED_FIELD_PREFIX`. Both now come from csuite-core and are re-exported, so
the package's public surface is unchanged. The two classes carried the same
`.name` and the two prefixes the same string, which is why every assertion
anyone would write passed: an `instanceof EncryptedFieldError` check inside core
— in `secrets.ts` and `tool-sources/store.ts`, whose comments named the class
they were catching — saw a foreign constructor and let a decrypt failure escape
as an unhandled 500.
