---
'csuite-core': patch
'csuite-server': patch
'csuite-cli': patch
'csuite-sdk': patch
---

Correct source comments and MCP tool descriptions that assert mechanisms, guarantees, or constants the code contradicts.

**Security-relevant.** `core/src/trace/redact.ts` opened by describing "**decrypted** Anthropic API traffic" — MITM-proxy-era language in the redaction module, when there is no interception, no TLS decryption, and no CA on disk. Reading the code underneath the stale comment turned up a second thing: `redactHeaders` is a published export of `csuite-core` with **no in-tree caller**, and nothing in the repo captures raw HTTP headers any more. The header now states the real threat model — secrets surfacing inside *content* rather than in intercepted headers — records that `redactHeaders` is retained as public API rather than because csuite inspects headers, and states what redaction does **not** cover: the raw-body store keeps bytes verbatim by design, which is what makes byte-exact reconstruction possible.

**`dual-auth` → `tri-auth` in 16 sites**, not the 5 originally reported: `core/src/session-store.ts`, `server/src/sessions.ts`, eight in `server/src/app.ts`, four in `sdk/src/protocol.ts`, plus a test header. Auth has three planes — opaque bearer, session cookie, optional RS256 JWT — and `server/src/auth.ts` already called itself "Tri-auth middleware".

The `describe('dual auth (bearer OR cookie)')` block in `auth.test.ts` was **deliberately not renamed**: it covers exactly those two planes and JWT has its own block, so renaming it would have made the test overclaim.

**`activity-uploader.ts`** said the queue cap was 1 MiB where the constant is 64 MB — stale by 64× in the file that owns the number. It now names both constants and records that drops are counted and surface in `session_end.capture`.

**`sdk/src/types.ts`** justified hook-sourced `user_prompt` capture by saying the OTEL request body "truncates large (~60KB+) prompts". The runner uses file mode, which writes complete bodies, so that truncation no longer applies; the rationale is restated accurately.

**MCP tool descriptions now declare the limits their schemas enforce.** `objectives_complete`'s `result` is capped at 4096 characters and said nothing — you discovered it by having a completion rejected *after* writing it. Also declared: `objectives_discuss` body (16384), `objectives_update` blockReason (2048), and `objectives_create`'s title (200), outcome (2048), body (4096), and watcher count (64). A tool description is the only specification an agent has for a tool whose implementation it cannot read.
