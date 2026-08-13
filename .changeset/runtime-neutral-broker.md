---
'csuite-core': minor
'csuite-server': minor
'csuite-cli': patch
---

Move the broker application into `csuite-core`: `createApp`, every
SQL-backed store (now generic over an injected synchronous
`SqlDriver`), the member domain, auth, instructions, push dispatch,
the team filesystem, and the notifications pipeline — with ports for
the capabilities a host supplies: blob storage (web streams), push
delivery, WebSocket upgrades, field encryption, and gen-ai capture.
Each seam keeps a reference implementation and its existing tests,
and `csuite-core/conformance` exports the behavioral contract suites
(SqlDriver, BlobStore, FieldCipher, and a wire-level broker check)
that the Node binding runs in its own CI.
`csuite-server` is unchanged in behavior: it is now the Node binding
of the shared application — `node:sqlite` driver, filesystem blob
store, `web-push` sender, `@hono/node-ws` upgrades, KEK-based field
cipher, and static SPA serving. Core's runtime neutrality (no
`node:*` imports) is enforced by a CI check rather than declared in
prose. Direct constructors renamed where an interface took the name:
`SessionStore`/`TokenStore`/`PushSubscriptionStore` are now the
injected contracts, with `Sqlite*` classes as the SQL
implementations; token hashing and instruction-version hashing are
async (Web Crypto).
