# Contributing to CommandSuite

Thanks for your interest in CommandSuite. This doc covers how to contribute
in a way that keeps the project legally clean and easy to work with.

## Before you start

- Read the [Code of Conduct](CODE_OF_CONDUCT.md). By participating you
  agree to uphold it.
- For **security issues**, please don't open a public issue — see
  [SECURITY.md](SECURITY.md).
- For questions or ideas, open a
  [discussion](https://github.com/the-efficacious/commandsuite/discussions) before
  investing in code. A quick back-and-forth saves a lot of wasted work.

## Development setup

```bash
git clone git@github.com:the-efficacious/commandsuite.git
cd commandsuite
pnpm install
pnpm build
pnpm test
```

Node 22+ and pnpm 10+ are required (see `.nvmrc`).

Useful per-package scripts:

```bash
pnpm --filter csuite-server dev      # run the broker with hot reload
pnpm --filter csuite-web-host dev         # run the PWA dev server
pnpm lint                              # biome check across the monorepo
pnpm typecheck                         # tsc --noEmit everywhere
pnpm test                              # all package test suites
```

## Project layout — where does code go?

The monorepo splits into `packages/` (importable libraries) and `apps/`
(deployable things). The two spots people most often get wrong are the UI:

- **Team-view UI** — chat, objectives, files, members, tools, secrets: any
  component a member sees *inside* a team → **`packages/web-ui`**
  (`csuite-web-ui`). This is the bulk of the front-end; it's host-agnostic and
  exposes a single `<TeamShell>`.
- **Auth gate / host chrome** — login, enrollment, boot, PWA shell →
  **`apps/web-host`** (`csuite-web-host`). A thin host that mounts
  `<TeamShell>` after authenticating; served by the broker.

Rule of thumb: if it's UI a member interacts with inside the app, it's almost
certainly `web-ui`; only auth/boot/host chrome belongs in `web-host`. The rest:
`csuite-core` (broker logic), `csuite-server` (Node broker), `csuite-sdk` (wire
client), `csuite-cli` (terminal).

## Contribution workflow

1. **Fork** the repo and create a topic branch from `main`:
   `git checkout -b feat/your-thing`
2. **Commit** your changes with a clear message. All commits must be
   signed off — see the DCO section below.
3. **Push** to your fork and open a PR against `the-efficacious/commandsuite:main`.
4. CI runs `lint`, `build`, `typecheck`, and `test` on every PR; a DCO
   check verifies every commit is signed off (see the DCO section below).
   All of these checks must pass.
5. A maintainer will review. Expect some back-and-forth — that's
   normal.
6. Once approved, a maintainer squashes and merges. The `Signed-off-by`
   trailers are preserved.

## Changesets & releases

Any change that affects a published package's behavior needs a
**changeset** — a small file describing the change and its semver impact:

```bash
pnpm changeset
```

Pick the bump (patch / minor / major), write a one-line summary, and commit
the generated `.changeset/*.md` alongside your PR. Docs-only, test-only, or
internal refactors that don't change published behavior don't need one.

All packages version in **lockstep** — one shared version across the whole
suite (see the `fixed` group in `.changeset/config.json`). Releases are
automated: merging changesets to `main` opens a **"Version Packages"** PR that
applies the bumps and updates changelogs; merging *that* PR publishes to npm
with provenance. Maintainers cut releases — contributors just add the changeset.

## DCO — Developer Certificate of Origin

CommandSuite uses the [DCO](https://developercertificate.org) to track the
provenance of every contribution. The DCO is a lightweight,
once-and-done attestation that you have the right to submit the code
you're sending us. There is **no CLA, no paperwork, no login flow.**

### What you're asserting

By signing off on a commit, you're agreeing to the text at
<https://developercertificate.org>. In plain language:

- The code is yours (or you have the right to submit it under this
  project's license).
- You're OK with it being public, under Apache 2.0, forever.
- You keep your copyright — you're granting a license, not assigning
  ownership.

### How to sign off

Add a `Signed-off-by:` trailer to every commit. Git makes this a
one-flag operation:

```bash
git commit -s -m "fix: tighten objective state transitions"
```

That adds a line like:

```
Signed-off-by: Your Name <you@example.com>
```

to the end of the commit message. The name and email must match your
`git config user.name` and `user.email`.

To make `-s` automatic on every commit:

```bash
git config --global format.signOff true
```

### Forgot to sign off?

Amend the last commit:

```bash
git commit --amend --signoff --no-edit
git push --force-with-lease
```

For multiple commits in a branch, rebase with `--signoff`:

```bash
git rebase --signoff main
git push --force-with-lease
```

A DCO check (the `.github/workflows/dco.yml` GitHub Actions workflow) runs on
every PR; it'll tell you which commits are missing sign-off and how to fix them.

## Commit message conventions

Use clear, imperative-mood subject lines. Conventional Commits-style
prefixes are appreciated but not required:

- `feat: ...` for new functionality
- `fix: ...` for bug fixes
- `docs: ...` for doc-only changes
- `chore: ...` for tooling / infra
- `refactor: ...` for non-behavioral code changes
- `test: ...` for test-only changes

Keep the subject under 72 chars. If the change needs context, put it
in the body (explain **why**, not what — the diff shows what).

## Code style

- **TypeScript**: strict mode, no `any` escapes, no
  `noUnusedLocals`/`noUnusedParameters` exceptions.
- **Formatter / linter**: Biome. `pnpm lint:fix` cleans most issues.
- **Imports**: sorted automatically by Biome's `organizeImports`.
- **Tests**: colocate in `src/**/*.test.ts` or `test/`. Prefer Vitest.
  The server keeps its integration suites under `apps/server/test/`
  (shared setup in `test/helpers/`); follow the patterns there.

## What to contribute

- **Bug fixes** with a clear reproduction are always welcome.
- **Docs improvements** — clarifications, typos, examples — merge fast.
- **Features** — please open a discussion or issue first. We care a lot
  about keeping the OSS focused on its core primitives; not every
  good idea belongs in the core. "It would be easy to add X" is usually
  not a sufficient reason by itself.
- **Performance work** — include before/after benchmarks.

## License

By contributing, you agree that your contribution is licensed under
Apache License 2.0 (see [LICENSE](../LICENSE)). You retain copyright in
your contribution; the DCO sign-off is your grant of the Apache 2.0
license to the project and its downstream users.

Contributors are credited via GitHub's
[contributors graph](https://github.com/the-efficacious/commandsuite/graphs/contributors)
and in the git history — no separate authors file to update.
