# csuite-server

Self-hostable Node broker for [csuite](https://github.com/the-efficacious/commandsuite), an MCP-based agent team control plane.

Wraps [`csuite-core`](https://www.npmjs.com/package/csuite-core) in a Hono HTTP/2 app with two auth planes that both resolve to the same slot identity:

- **Machine plane** — `Authorization: Bearer <token>` for the member's `csuite claude-code` runner subprocess. Tokens are backed by SHA-256 hashes in the team config file.
- **Human plane** — `csuite_session` cookie minted after a TOTP login, used by the built-in Preact web UI (`csuite-web-host`) that this package serves out of its `public/` dir.

Both planes resolve to the same slot. Permissions — a flat, unranked set of leaves such as `objectives.create` and `members.manage` — are checked server-side on every mutating endpoint.

One server = one team. Exposes:

### Chat + identity
- `GET /healthz` — liveness probe (no auth)
- `GET /briefing` — name, role, permissions, team, teammates, open objectives, and composed instructions for the authenticated slot
- `GET /roster` — full slot list plus runtime connection state
- `POST /push` — deliver a message to one teammate (DM) or broadcast
- `GET /subscribe?name=…` — long-lived WebSocket stream; `name` must equal the caller's name
- `GET /history?with=…&limit=…&before=…` — query message log scoped to the authenticated caller

### Objectives
- `GET /objectives` — list with optional `assignee` + `status` filters; members without `objectives.create` can only see their own
- `POST /objectives` — create and atomically assign (requires `objectives.create`)
- `GET /objectives/:id` — fetch one + full event history; gated by thread membership
- `PATCH /objectives/:id` — update status (`active ↔ blocked`) and/or block reason (assignee, or a member with `objectives.cancel`)
- `POST /objectives/:id/complete` — mark done with required result (assignee only)
- `POST /objectives/:id/cancel` — terminally cancel (originator, or a member with `objectives.cancel`)
- `POST /objectives/:id/reassign` — reassign to a different slot (requires `objectives.reassign`)
- `POST /objectives/:id/watchers` — add/remove watchers (originator, or a member with `objectives.watch`)
- `POST /objectives/:id/discuss` — post to the `obj:<id>` thread (thread members only)

### Captured LLM traces (agent activity)
- `POST /members/:name/activity` — append decoded trace / lifecycle events (self only)
- `GET /members/:name/activity?from=&to=&limit=&kind=` — time-range query for review (self, or a member with `activity.read`)
- `GET /members/:name/activity/stream` — WebSocket live tail (self, or a member with `activity.read`)

### Session (human plane)
- `POST /session/totp` — exchange `{slot, code}` for a session cookie
- `POST /session/logout` — clear the server-side session row
- `GET /session` — return the current session's slot/role/expiry

### Web Push
- `GET /push/vapid-public-key` — anonymous; returns the server's VAPID public key
- `POST /push/subscriptions` — register a browser push subscription against the authenticated slot
- `DELETE /push/subscriptions/:id` — remove a subscription (scoped to the caller's slot)

### Static SPA
- `GET /` + catch-all — serves the built `csuite-web-host` bundle with SPA fallback to `index.html`

## Install

```bash
npm install -g csuite-server
```

## Run

```bash
# First run with no config — drops into an interactive wizard
csuite-server

# Subsequent runs — reads ./csuite.json (or $CSUITE_CONFIG_PATH)
export CSUITE_PORT=8717
export CSUITE_DB_PATH=/var/lib/csuite/events.db
csuite-server
```

The team config file defines the team's name, directive, context, permission presets, roles, slots, HTTPS settings, and VAPID keys. Each slot has a name, a role (a free-text title), a `permissions` list (preset names and/or individual leaf permissions), a secret token, and optional TOTP enrollment. See [`config.example.json`](./config.example.json) for the full schema.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `CSUITE_CONFIG_PATH` | `./csuite.json` | Path to the team config file |
| `CSUITE_PORT` | `8717` | HTTP listen port (plain-HTTP mode only) |
| `CSUITE_HOST` | `127.0.0.1` | HTTP listen address — binding to non-loopback auto-enables self-signed HTTPS |
| `CSUITE_DB_PATH` | `./csuite.db` | SQLite path for event log, sessions, and push subscriptions. Use `:memory:` for ephemeral runs. |

The `--config-path` flag overrides `CSUITE_CONFIG_PATH`.

## HTTPS modes

Configured via an `https` block in the team config file:

```jsonc
{
  "https": {
    "mode": "off",            // off | self-signed | custom
    "bindHttp": 8717,
    "bindHttps": 7443,
    "redirectHttpToHttps": true,
    "hsts": "auto",           // auto = off unless running a real cert
    "selfSigned": {
      "lanIp": null,          // auto-detected when binding 0.0.0.0
      "validityDays": 365,
      "regenerateIfExpiringWithin": 30
    },
    "custom": { "certPath": null, "keyPath": null }
  }
}
```

- `off` (default) — plain HTTP on `bindHttp`. Safe for localhost only.
- `self-signed` — HTTP/2 + TLS with a persisted self-signed cert. Auto-enabled when `CSUITE_HOST` is non-loopback.
- `custom` — HTTP/2 + TLS with user-supplied `certPath` + `keyPath` (for reverse-proxy uploads or your own ACME flow).

The HTTPS listener uses HTTP/2 with HTTP/1.1 ALPN fallback. WebSocket upgrades ride the HTTP/1.1 path.

## TOTP login (web UI)

The admin member created during the first-run wizard gets a TOTP enrollment prompt. An `otpauth://` URI is printed in the terminal; scan it with any authenticator app (Google Authenticator, Authy, 1Password…). After enrollment, visiting `http://<server>/` redirects to a login form asking for the current 6-digit code — no username required. The server iterates enrolled slots server-side with a rate-limited codeless login flow.

Re-enrolling: `csuite enroll --slot <name>` regenerates the secret and prints a fresh URI. The bearer token in the config file is the recovery path — SSH to the box, run `csuite enroll`, scan the new code.

## Web Push

On first boot, the server auto-generates a VAPID keypair and persists it to the config file as a `webPush` block. The web UI fetches the public half via `GET /push/vapid-public-key` and subscribes the browser via `pushManager.subscribe()`. When a message is pushed:

- **DMs** always notify the recipient (unless they have a live WebSocket connection open).
- **Broadcasts** notify only when `level >= warning` or the body contains `@<name>`.

Dead subscriptions (410 Gone from the push service) are automatically removed. VAPID keys are never rotated casually — doing so invalidates every existing push subscription.

## Embedding

You can also embed the broker in your own Node process:

```ts
import { loadTeamConfigFromFile, runServer } from 'csuite-server';

const { team, roles, store, https, webPush } = loadTeamConfigFromFile('./csuite.json');

const running = await runServer({
  slots: store,
  team,
  roles,
  https,
  webPush,
  configDir: './data',     // where self-signed cert is stored
  configPath: './csuite.json',  // for VAPID auto-gen persistence
  dbPath: '/var/lib/csuite/events.db',
  host: '127.0.0.1',
  port: 8717,
});

// later…
await running.stop();
```

Pass `publicRoot: null` to disable the web UI entirely for machine-only deployments.

## License

Apache 2.0. See the [csuite monorepo](https://github.com/the-efficacious/commandsuite) for the full source.
