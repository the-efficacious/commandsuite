# csuite-web-host

The **OSS web host** for [CommandSuite](https://github.com/the-efficacious/commandsuite) — a thin Preact+Vite+UnoCSS PWA that owns the self-hosted auth gate and then mounts the shared team UI. Served by `csuite-server` as static assets.

## What it does

This app is deliberately small: it's a **host**, not the UI itself. It owns only:

- **TOTP login** — name + 6-digit code, no passwords
- **Device-code enrollment** — the approval page for `csuite connect`
- **Boot / session bootstrap** — resolve the member, then hand off
- **PWA shell** — installable, offline cache, service worker, Web Push registration

Once authenticated, it mounts `<TeamShell>` from **`csuite-web-ui`** with a same-origin-cookie-authenticated client + the resolved identity. Everything *inside* the team view — chat, objectives, files, members, tools, secrets, roster, composer — lives in `csuite-web-ui`, not here.

The SPA mounts at `/` and uses same-origin cookies to authenticate against the broker's API. All routing is signal-driven — no URL router dependency.

## Install

This package is not installed directly. It ships inside `csuite-server`, which serves the built bundle from `public/` at `/`.

## Dev

```bash
# Terminal 1 — broker on :8717
cd apps/server && node dist/index.js

# Terminal 2 — Vite dev server on :5173 with API proxy
cd apps/web-host && pnpm dev
```

Open <http://localhost:5173/>. Vite proxies every API path (`/briefing`, `/roster`, `/push`, `/subscribe`, `/history`, `/session/*`, `/push/*`) through to the Hono broker on `:8717`, with `ws: true` on the proxies so WebSocket upgrades, cookies, and push all work through the dev server.

Production builds output directly into `apps/server/public/` so the next `csuite-server` build picks up the new bundle without a copy step.

```bash
pnpm --filter csuite-web-host build
```

## Tech notes

- **Preact 10** + `@preact/signals` — automatic fine-grained reactivity with no hooks required. Reading `signal.value` inside a component's render body subscribes it to changes.
- **UnoCSS** with `presetWind4` — Tailwind-identical class names with a much smaller output CSS footprint.
- **`vite-plugin-pwa` in `injectManifest` mode** — we own `src/sw.ts` so we can write custom push event handlers. `generateSW` mode is a trap here.
- **Native `WebSocket`** — browser WebSocket with a custom exponential-backoff reconnect. Cookies flow automatically on same-origin upgrades, so no bearer-header plumbing is needed in the SPA.
- **VAPID public key fetched at runtime** via `GET /push/vapid-public-key` — the key isn't baked into the build, so the same bundle works on any self-hosted deployment without a rebuild.

## Structure

```
apps/web-host/
├── index.html              # root shell
├── scripts/generate-icons.mjs  # zero-dep PNG generator for PWA icons
├── src/
│   ├── main.tsx            # render + SW registration
│   ├── App.tsx             # auth gate: Boot → Login → TeamShell (from csuite-web-ui)
│   ├── sw.ts               # service worker (push + precache + updates)
│   ├── lib/
│   │   ├── client.ts       # csuite-sdk Client singleton
│   │   └── session.ts      # session signal + loginWithTotp/logout/bootstrap
│   └── routes/
│       ├── Boot.tsx        # loading placeholder
│       ├── Login.tsx       # TOTP form
│       └── Enroll.tsx      # device-code enrollment approval page
├── public/icons/           # PWA icons (solid-fill, generated)
└── turbo.json              # declares out-of-tree build output for turbo cache
```

The team chat/roster/objectives/files experience itself (transcript, composer,
roster panel, notifications, etc.) lives in `csuite-web-ui` as
`<TeamShell>`, which this app mounts after the auth gate passes.

## License

Apache 2.0. See the [csuite monorepo](https://github.com/the-efficacious/commandsuite) for the full source.
