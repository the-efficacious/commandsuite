---
'csuite-core': patch
'csuite-server': patch
'csuite-cli': patch
'csuite-sdk': patch
---

Correct source comments and MCP tool descriptions that assert mechanisms, guarantees, or constants the code contradicts.

**Security-relevant.** `core/src/trace/redact.ts` opened by describing "**decrypted** Anthropic API traffic" — MITM-proxy-era language in the redaction module, when there is no interception, no TLS decryption, and no CA on disk. Reading the code underneath the stale comment turned up a second thing: `redactHeaders` is a published export of `csuite-core` with **no in-tree caller**, and nothing in the repo captures raw HTTP headers any more. The header now states the real threat model — secrets surfacing inside *content* rather than in intercepted headers — records that `redactHeaders` is retained as public API rather than because csuite inspects headers, and states what redaction does **not** cover: the raw-body store keeps bytes verbatim by design, which is what makes byte-exact reconstruction possible.

**`dual-auth` → `tri-auth` on 18 lines across 5 source files**, not the 5 sites originally reported: eleven in `server/src/app.ts`, four in `sdk/src/protocol.ts`, one each in `core/src/session-store.ts`, `server/src/sessions.ts`, and a test header. Auth has three planes — opaque bearer, session cookie, optional RS256 JWT — and `server/src/auth.ts` already called itself "Tri-auth middleware", which is what made the rest identifiable as stale rather than as a naming choice.

Three of those eleven `app.ts` lines were missed by the first pass and found in verification: the **defining paragraph** at the top of the file still read `Dual-auth = either bearer or cookie` directly above routes the same pass had relabelled tri-auth, and two route comments (`GET /tool-sources`, `GET /secrets`) still said `Dual-auth`. The first pass searched for the term where it expected the term to be; it did not re-run the search afterwards.

The `describe('dual auth (bearer OR cookie)')` block in `auth.test.ts` was **deliberately not renamed**: it covers exactly those two planes and JWT has its own block, so renaming it would have made the test overclaim.

**`activity-uploader.ts`** said the queue cap was 1 MiB where the constant is 64 MB — stale by 64× in the file that owns the number. It now names both constants and records that drops are counted and surface in `session_end.capture`.

**`sdk/src/types.ts`** justified hook-sourced `user_prompt` capture by saying the OTEL request body "truncates large (~60KB+) prompts". The runner uses file mode, which writes complete bodies, so that truncation no longer applies; the rationale is restated accurately.

**MCP tool descriptions now declare the limits their schemas enforce.** `objectives_complete`'s `result` is capped at 4096 characters and said nothing — you discovered it by having a completion rejected *after* writing it. A tool description is the only specification an agent has for a tool whose implementation it cannot read.

Declared across every tool backed by a schema with an enforced bound: `objectives_create` title (200), outcome (2048), body (4096), watchers (64), attachments (64); `objectives_discuss` body (16384), attachments (64); `objectives_update` blockReason (2048); `objectives_complete` result (4096); `objectives_watchers` add (64) and remove (64); and `broadcast`, `send`, and `channels_post` body (65536) and attachments (64).

The first pass declared only the limits already known from the objective's scope, and so missed the attachment caps in the very schemas it was editing. The list above was rebuilt the other way round — enumerating every constrained field on each request schema in `sdk/src/schemas.ts`, then checking each against its tool description — which is what turned up the eight beyond the original set.

**Not addressed, and named because the same enumeration found them:** `DiscussObjectiveRequestSchema` and `PushPayloadSchema` both accept an optional `title` that no MCP tool exposes, so an agent cannot set one and a human on the web UI can. That is a surface-parity gap rather than a stale comment, so it is filed rather than fixed here.

**Comments naming symbols that do not exist — found by a second, artifact-bounded method.** The passes above were bounded by terms chosen in advance, which cannot find drift nobody suspected. So a second pass enumerated its candidate set from the comments themselves: every backticked identifier appearing in a comment across 240 source files (**1,075 distinct**), each checked against all non-comment source. **44 were absent; 8 were real.** The other 36 are external vocabulary — protocol field names (`grant_type`, `message_stop`), env vars, TS compiler options, browser and upstream-SDK symbols.

| file | cited | actual |
|---|---|---|
| `sdk/src/types.ts` | `pollUrl` on the `/enroll` response | **no such field** — the response carries relative `verificationUri`/`verificationUriComplete` and no poll hint |
| `core/src/trace/sse.ts` | `buildAnthropicEntry` in `anthropic.ts` | `anthropicToGenAi` in `genai.ts` |
| `core/src/trace/transcript.ts` | `parseMessages` in the HTTP path | `anthropicToGenAi` |
| `server/src/members.ts` (×2) | `TeamConfigSchema` | `ServerConfigSchema` |
| `server/src/run.ts` | `loadTeamConfigFromFile` | `loadServerConfigFromFile` |
| `server/src/team-store.ts` | `seedTeam` | `setTeam` |
| `server/src/files/filesystem-store.ts` | `srcPath` | `src` |
| `web-ui/src/lib/client.ts` | the `__resetForTests` convention | `__reset<Module>ForTests` |

The `sdk/src/types.ts` one is the worst of these: it is a **published type** documenting a wire field that has never existed, so an SDK consumer reading the doc comment would look for a response field the broker does not send.

`core/src/trace/sse.ts` also gained the same disclosure `redactHeaders` carries: `reassembleAnthropicSse`, `parseSseEvents` and `looksLikeSseStream` are published exports with **no in-tree caller** — nothing in csuite holds a raw SSE body since capture became transcript- and OTEL-sourced. That is now stated in the header so the module's presence is not read as a live streaming-capture path.

**What remains unswept, stated rather than implied.** The backticked-identifier method sees only claims that name a symbol. It cannot see a comment that describes a mechanism in prose without naming anything — the `dual-auth` and 1 MiB defects were both of that kind and both needed the vocabulary pass to find. Neither method reaches a comment that is wrong about *behaviour* while naming only symbols that still exist; that residue is unmeasured, and the four new `redactJson` contract tests are the pattern for closing it where it matters.
