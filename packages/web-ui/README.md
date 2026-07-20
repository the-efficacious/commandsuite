# csuite-web-ui

The **team-view UI + runtime** for [CommandSuite](https://github.com/the-efficacious/commandsuite) — the bulk of the web front-end. A host-agnostic Preact library: a host injects an authenticated client + identity and mounts `<TeamShell>`, and this package owns the entire in-team experience.

> **Adding or changing team UI? It goes here**, not in `apps/web-host`. That app is just the OSS auth host; this package is the actual UI.

## What lives here

Everything a member sees *inside* a team:

- **Chat** — transcript, composer, channels, DMs, threads
- **Objectives** — list, detail, creation, and the `TracePanel` (LLM activity review)
- **Files · Members · Tools · Secrets** panels
- **Chrome** — command palette, activity inspector, toasts, theming
- **Runtime** — the live WebSocket subscription + reconnect, roster polling, unread tracking, signals/state

## Public API

The surface is intentionally narrow — `<TeamShell>` plus a few primitives and signal helpers (see `src/index.ts`). Do **not** deep-import `lib/` or `components/`; those paths are internal and move without notice.

```tsx
import { TeamShell } from 'csuite-web-ui';
import 'csuite-web-ui/styles.css';

<TeamShell client={authedClient} identity={identity} onSignOut={...} />
```

The host owns auth and any chrome *around* the shell; the shell owns everything *inside*. `<TeamShell>` also accepts `teamSlug` and `leftRail` for multi-team / embedded hosts.

## Consumers

Two hosts mount this today:

- **`apps/web-host`** (`csuite-web-host`) — the OSS self-hosted web app (TOTP auth, served by the broker).
- The **commercial hosted platform** (separate repo) — Clerk auth + billing wrapped around the same `<TeamShell>`.

That's the whole point of the split: one shared UI, thin hosts. Don't fold it into a host.

## Dev

It isn't run standalone — mount it from a host:

```bash
pnpm --filter csuite-web-host dev    # runs the OSS host, which renders this UI
pnpm --filter csuite-web-ui test
pnpm --filter csuite-web-ui typecheck
```

## License

Apache 2.0. See the [monorepo](https://github.com/the-efficacious/commandsuite) for full source.
