# Security

## Reporting a vulnerability

Please do **not** file public GitHub issues for security vulnerabilities.
Email **security@efficacious.io** with a description, affected version, and
reproduction steps. We aim to acknowledge within 72 hours and patch
in-band-severity issues within 14 days.

If the vulnerability is in a dependency rather than csuite itself, please
still let us know so we can pin or fork as needed.

## Supported versions

CommandSuite is pre-1.0 and published from a single release line. Only the
latest published release receives security fixes — there are no maintained
release branches yet.

| Version | Supported |
|---|---|
| Latest `0.x` release | :white_check_mark: |
| Any older release | :x: |

When the project reaches 1.0, this section will be replaced with a concrete
supported-version window.

## What we protect

1. **Bearer tokens** — per-member shared secrets used by agents and
   member terminals to authenticate to the broker.
2. **TOTP secrets** — per-member secrets backing the web UI's 2FA login.
3. **Captured LLM traces** — prompts, tool calls, tool results, and
   response bodies normalized from each agent's native instrumentation
   (Claude Code's OpenTelemetry export, the codex app-server stream) and
   streamed to the broker as agent activity rows.
4. **Session cookies** — `csuite_session` cookies minted after TOTP login.
5. **VAPID private key** — used to sign Web Push notifications.

## Architecture that serves those protections

| Asset | Control |
|---|---|
| Bearer tokens | Stored SHA-256 hashed in the database `tokens` table — plaintext is shown once at issuance and never persisted. Resolution is constant-time (`timingSafeEqual`). A member may hold multiple tokens; rotation issues a fresh one and revokes the rest. A bootstrap token hand-written into `csuite.json` is migrated into the token store on first boot. |
| TOTP secrets | Encrypted at rest with AES-256-GCM (random IV per field, authenticated). Replay-guarded per member (monotonic counter). Per-member + global codeless-login rate limits (5 / 15 min per member, 10 / 15 min global). Legacy plaintext values are auto-migrated on first boot under an active KEK. |
| Trace payloads | Normalized inside the runner process from the agent's native instrumentation; no TLS interception. Redaction runs before upload and strips `Authorization`, `Cookie`, `x-api-key`, `x-anthropic-api-key`, `proxy-authorization`, and scrubs common API-key patterns (`sk-ant-…`, `sk-…`, `AKIA…`, `ghp_…`, `xox[baprs]-…`). Claude Code's OTEL export lands on the authenticated, bearer-attributed `/otlp` endpoint; the manual activity path (`POST /members/:name/activity`) is authenticated and self-only. Read is gated to self or a member with `activity.read` (`GET /members/:name/activity`). |
| Session cookies | `HttpOnly` + `SameSite=Strict`. `Secure` set when the broker is listening over HTTPS. 7-day sliding TTL. |
| Permission enforcement | Each member's flat, unranked permission set (e.g. `team.manage`, `members.manage`, `objectives.create`) is checked **server-side on every mutating endpoint**. No client-side gating relied upon. |
| Identity binding | `agentId === member.name` is enforced in the broker core (`packages/core/src/broker.ts`) and pre-stream in the HTTP handler. A member cannot subscribe to another member's activity. |

## Known limitations

These are documented rather than hidden. Each is tracked as a roadmap item; the delta from "documented" to "closed" is visible in this file's history.

- **KEK handling today is limited to an env var or a local key file.** The KEK used to encrypt TOTP + VAPID at rest is resolved from `CSUITE_KEK` (base64-encoded 32 bytes) or an auto-generated `<configDir>/csuite-kek.bin` on first boot. This is strictly better than plaintext-at-rest (where the config file alone leaked every credential), but still: if both the config file AND the key file leak together, encryption buys you nothing. Deployments that want separation should set `CSUITE_KEK` to a value managed by their secret manager / OS keychain / HSM and ensure the key file never exists. OS-keychain native integration is a follow-up.
- **Redaction is pattern-based and incomplete.** Custom schemes, JWTs, shorter API keys, base64-encoded secrets, and **any secret inside message content or tool I/O** pass through unmodified. `redactJson` in `packages/core/src/trace/redact.ts` is the full pattern set. Treat traces as sensitive; only grant `activity.read` to members that need trace access.
- **`/history` is viewer-scoped but not rate-limited.** A compromised bearer token can fan-scan team history it is entitled to see. Scope is bounded by identity, but request rate is not.
- **Session cookie lacks `__Host-` prefix** and there is no CSRF token on cookie-authed state-changing POSTs. `SameSite=Strict` is the only CSRF defense today — strong in current browsers but not universal.
- **The `/otlp` ingest trusts the exporting member's own bearer.** Claude Code's OpenTelemetry export authenticates with the member's token and is attributed to that member; a compromised token could POST fabricated activity for its own member (the same trust already held by the manual activity-upload path). The ingest is fully defensive against malformed payloads (a bad batch yields no rows rather than an error).

## Changes in this release

### Trace capture no longer intercepts TLS — the MITM proxy is removed

Earlier versions captured agent traffic with a loopback MITM TLS proxy: a
per-session CA whose cert was injected into the agent child via
`NODE_EXTRA_CA_CERTS` (or `CODEX_CA_CERTIFICATE` for codex), an
`HTTPS_PROXY`/`ALL_PROXY` redirect, and an SSL keylog path. The whole
mechanism decrypted the agent's HTTPS to reconstruct LLM exchanges, which
carried real security cost: a private CA the agent trusted, a keylog file on
disk, and an `--unsafe-tls` escape hatch that disabled TLS validation
entirely for packaged binaries.

Starting with this release:

- The MITM proxy, per-session CA, HTTP/1.1 reassembler, host allowlist, and
  the `--unsafe-tls` / `NODE_TLS_REJECT_UNAUTHORIZED=0` escape hatch are all
  **deleted**. The runner never injects proxy or CA environment variables and
  never touches the agent's TLS trust store.
- Capture is now sourced from each agent's own native instrumentation: Claude
  Code exports its work over OpenTelemetry to the broker's authenticated
  `/otlp` endpoint (bearer-token attributed to the exporting member), and the
  codex adapter reads the app-server item stream the runner already consumes.
  The agent's outbound TLS is never decrypted.
- Redaction still runs runner-side before any captured content leaves the
  member's machine.

This removes both the private-CA trust boundary and the `--unsafe-tls`
footgun that were flagged in the 2026-04-16 internal audit.

### `csuite rotate --member <name>` — atomic bearer-token rotation

Bearer tokens used to be rotatable only by hand-editing the team config — risky (easy to typo or clobber an unrelated member) and skipped in practice, so rotation events never happened. `csuite rotate --member <name>` calls `POST /members/:name/rotate-token`: the broker generates a cryptorandom `csuite_<base64url>` bearer (~256 bits of entropy), inserts it into the `tokens` table, and revokes every other active token for that member — the break-glass "assume a token leaked, restart from a clean slate" posture. The new plaintext is printed once with explicit save-now framing. Every member's permissions, role, and TOTP state stay untouched. The plaintext is never persisted; only the SHA-256 hash lands in the database.

### TOTP secrets + VAPID private key encrypted at rest (AES-256-GCM)

TOTP secrets were stored base32, and the VAPID private key was stored as a PEM. A read-only exfiltration of `csuite.json` would have leaked every member's web-login credential permanently (rotating would have meant re-enrolling every member from scratch). That was the second HIGH-severity finding in the 2026-04-16 audit.

Starting with this release:

- Both fields are now encrypted at rest with AES-256-GCM (12-byte random IV per field, 16-byte authentication tag). Wire format is `enc-v1:<base64url(iv)>:<base64url(tag)>:<base64url(ct)>`.
- The KEK is resolved at server boot, in order: (1) `CSUITE_KEK` env var (base64-encoded 32 bytes) — for deployments that manage keys via their own secret manager / OS keychain / HSM; (2) `<configDir>/csuite-kek.bin` — auto-generated on first boot at `0o600` when `CSUITE_KEK` isn't set, which keeps zero-config self-host working.
- Authenticated-encryption means a tampered ciphertext or a wrong KEK surfaces as a clear error, not a silent bit flip.
- Configs written by older versions (plaintext TOTP / VAPID) migrate transparently on first load under an active KEK: the loader detects plaintext, counts it against the `migrated` field, and the subsequent config rewrite emits `enc-v1:...` values. Single-release upgrade path, no manual migration required.

This closes the second of two HIGH-severity findings from the 2026-04-16 internal audit. The remaining open items are MED/LOW severity; see **Known limitations** above for the current slate.

## Disclosure history

*(Will be maintained as issues are reported and patched. Empty at first release.)*
