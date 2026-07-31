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

### Run tests from the root if you're going to believe the result

`pnpm --filter <pkg> exec vitest run` is convenient and **bypasses turbo**,
which is what normally keeps a package's `dist/` in step with its source.
Tests that import a workspace package by name resolve through its
`exports` map into `dist/`, so a filtered run can pass against a build
that no longer matches the tree.

`scripts/assert-fresh-dist.mjs` closes part of that — a vitest
`globalSetup` that refuses when a dependency's `dist/` no longer matches
its own `src/`, whatever launched vitest. It does **not** close all of it:

| drift | root `pnpm test` | filtered run |
|---|---|---|
| a package's own `src/` | turbo | **the guard** |
| build config (`tsup.config.ts`, `vite.config.ts`) | turbo | **nothing** |
| a transitive workspace dependency | turbo | **nothing** |
| `dist/` edited after the build | nothing | nothing |

So a filtered run is fine for iterating and is **not** something to draw a
conclusion from. Run it from the root before you report a result, and
say which you ran — the two are different objects and only one of them
is checked end to end.

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

## Internal development — team members

**The same workflow as outside contributors.** Branch from `main`, open a pull
request against `main`, get it verified by someone who did not write it.

| branch | what it is |
|---|---|
| `main` | Protected. The trunk. Pull requests only. |
| `<type>/<short-description>` | Your working branch. Cut from `main`, merged back via PR, deleted after. |

> **This replaced a `develop` + `review/<date>` model on 2026-07-30.** That
> model existed as one isolation layer for as long as every team member held
> merge privileges under a **shared identity** — GitHub could not tell five
> members apart, so it could not enforce that a reviewer was someone other than
> the author. The old section said it was scaffolding and that the fix was to
> delete it once per-agent identities landed. They landed; this is that
> deletion.

turndb uses the same model, written down in its own `CONTRIBUTING.md`. It is
stated once per repository and pointed at from everywhere else — three copies of
a branch model is worse than one, because they drift and then nobody knows which
is true. **turndb's copy still describes the old model and needs the same
change.**

**Author proposes, partner verifies.** Every change is verified by someone who
did not write it, and whoever did not write it decides whether it is done. A
verifier is expected to disagree; agreement arrived at by deference is worth
nothing.

> **Name the commit you verified.** A branch moves. An approval recorded
> against a branch may not describe the state that ultimately merges, so a
> verification that names only the branch has not said what was checked. State
> the SHA. **A branch name is not an object; a branch name at a commit is.**

### Commit signing does not currently work

Observed independently on **two hosts**, in two repositories. Both hosts have
`gpg.format=ssh` configured against an SSH key.

**The failure differs between attempts, not between machines:** sometimes git's
signing path returns `communication with agent failed`; sometimes the commit
hangs past a bounded timeout. Both modes have been observed on the same host with
the same config, hours apart. In every observed case the commit does not
complete. We have not isolated the variable and are not guessing at it.

This is environmental rather than one person's misconfiguration, and it says
nothing about your machine.

Disable GPG signing for the commit, but **keep the DCO `Signed-off-by` trailer**
— that is a separate mechanism and it is required (see below).

This matters if branch protection ever requires signed commits: it has to be
solved before that requirement lands, not discovered at a rejected push.

## Writing tests

Assert **completeness and shape**, not presence or absence.

Presence assertions — *the field appeared*, *the row is gone*, *the call
returned* — are cheap and survive refactors, which is exactly why they are
everywhere and exactly why they are blind to a contract silently degrading.

This is not theoretical. Every defect found in a recent sweep across this
repository and turndb survived a green test that asserted the wrong thing:

- the roster tool rendered every role as `[object Object]` for the life of the
  repo; the test asserted that teammate *names* appeared;
- a paged read returned a short page while live rows existed; the test asserted
  that a deleted id was *absent*, never that the page was full;
- a trace view silently truncated its window; the test asserted that the call
  *returned*, never that the result was complete.

Before committing a test, ask **both** of these. They are not the same question,
and the second is the one people forget:

- **Would this pass against a version that returns *some* of the right answer?**
  This catches a fix that does too little — the short page, the half-rendered
  field, the truncated window.
- **Would this pass against a version that refuses *more* than it should?** This
  catches a fix that does too much. A suite full of "rejects bad input"
  assertions passes happily against an implementation that also rejects good
  input. If you add a validity check, test the *nearest valid thing* it must
  still accept.

If either answer is yes, it is not yet testing the contract.

Prefer cheap negative invariants — `expect(out).not.toContain('[object Object]')`
— over whole-string golden files, which fail on every cosmetic change and train
people to regenerate the golden without reading it. And where the type system can
make the wrong thing unrepresentable, that is better than either: tests are the
backstop, types are the fix.

### Name the string the deliverable must produce, then grep the tests for it

**A test that proves a helper does not prove its callers exist.**

A capture-health warning shipped with seven tests on the function that computes
it — absence rules, polarity, every state. All seven passed. Deleting the badge
markup from *both* screens that were supposed to render it left all seven still
passing. The helper was proven; the thing the work existed to deliver was not.

It was found in one command:

```
rg 'NO CAPTURE|CAPTURE UNCHECKED' packages/web-ui/test   →   zero
```

A grep for the exact string the surface must render, run against the tests that
claim to prove it renders. That is the whole technique. It took seconds and
found what a full mutation suite over the helper had missed, because those
mutations were all *inside* the layer that was already covered.

Do this whenever the deliverable is something a person or an agent has to
actually see: a badge, a log line, a tool description, a field on a response.
Then add the assertion that greps for — a component render, an end-to-end
response body — and **delete each producer independently** to watch its own test
fail.

Why a rule and not just care: this failure appeared **repeatedly in a single
working session, across most of the people in it** — including twice by authors
who had written down this exact failure mode and had their own note open at the
time. Knowing the shape does not fire mid-task. A grep does not require you to
have the right instinct at the right moment, which is precisely what fails.

(An earlier draft of this paragraph gave a precise count. It was wrong, in the
direction that made the rule sound better, and it was corrected by someone
checking it against the list. A house standard should not open with an inflated
tally of the thing it is arguing about — and a number that needs maintaining
will rot, while the mechanism will not.)

### Sample on the operation, not after it

**A probe that samples after the next operation cannot observe a transient
violation.** Any invariant that is restored quickly is invisible to a check that
looks late — and **a bound that holds only between operations is not a bound.**

A store with a hard row cap deleted exactly to the cap and then inserted one
more row recording that the cap had been hit, leaving it one over. The author's
probe recorded many rows in a loop, then counted: the overshoot had already been
corrected by the next enforcement, so the probe returned a clean result and the
defect was invisible. A second probe that stopped *on* the enforcement measured
two rows under a cap of one.

The clean result was an artefact of where sampling stopped. This is the same
failure as a check that cannot fail, wearing the opposite sign: instead of a
green that proves nothing, a **negative result that proves nothing**.

So when you are checking an invariant that some later step repairs — a cap, a
lock, a queue depth, a temporary file — take the measurement at the moment the
invariant is under stress, not after the system has had a chance to tidy up. If
you get a negative result from a loop, ask what ran between the violation and
your assertion.

### Every suite of negatives needs one positive control

**A check that always says no satisfies every negative fixture you can write.**

A validator was added to reject forged values: a path digest that wasn't a
digest, a hash that wasn't a hash, an error code outside the finite set. Four
tests asserted each forgery was refused, and all four passed. They would also
have passed against a validator that discarded its input and returned nothing —
which is a real possibility, because "drop anything that fails the shape check"
is one typo away from "drop everything".

So the fifth test asserts a *legitimate* value survives: a digest produced by
the real constructor is still persisted. That one costs a line and is the only
thing standing between the suite and a validator that has quietly stopped
validating.

The general form: whenever your tests are mostly *this must be rejected*, *this
must be absent*, *this must not appear*, add at least one asserting the
mechanism still admits what it should. Absence assertions are cheap to satisfy
by breaking the thing that produces presence.

This completes a three-part defence against a check whose answer was fixed
before it ran:

| | |
|---|---|
| **mutate** | delete or invert the thing and watch a *specific named* test fail |
| **confirm it applied** | a mutation that silently didn't apply is indistinguishable from one that survived |
| **positive control** | prove the check can pass when it should |

The first two catch a test that cannot fail. The third catches a test that
cannot pass.

## When something inexplicable happens, measure it

**The reflex to attribute an anomaly to your own carelessness is the most
efficient way to lose information.** It is fast, humble, feels responsible — and
it deletes the datapoint. You are usually the only person who will ever see it.

Three times in a single working session on this project, someone buried real
evidence that way:

- a file that "should" have been readable wasn't, filed as carelessness about
  paths. It was the first evidence that the team was not all on one machine —
  found again two hours later, the hard way;
- a `git push` hung for five minutes, worked around and recorded as a local
  hiccup. It was the credential-helper state that two people then spent an hour
  disagreeing about;
- a signed commit hung, worked around with `-c commit.gpgsign=false`. It was the
  measurement that eventually settled which signing mechanism was failing, and
  it corrected a claim already merged into this file.

Each was in someone's own scrollback the whole time. So when something
unexpected happens and the easy explanation is that you were sloppy, that is
exactly when to spend sixty seconds measuring it instead.

The related discipline: **when two careful measurements of the same thing
disagree, stop arguing about the thing and check whether you measured the same
thing.** Same path, different machines, different contents.

## Changesets & releases

Any change that affects a published package's behavior needs a
**changeset** — a small file describing the change and its semver impact:

```bash
pnpm changeset
```

Pick the bump (patch / minor / major), write a one-line summary, and commit
the generated `.changeset/*.md` alongside your PR. Docs-only, test-only, or
internal refactors that don't change published behavior don't need one.

**Write the summary as a user-facing changelog line** — it is published
verbatim (with a PR link and your handle) in the root `CHANGELOG.md` and the
GitHub release notes. "Fix transcript-reader race that emitted events after
close" ages better than "fix bug".

All packages version in **lockstep** — one shared version across the whole
suite (see the `fixed` group in `.changeset/config.json`). Releases are
automated: merging changesets to `main` opens a **"Version Packages"** PR that
applies the bumps, updates per-package changelogs, and aggregates them into
the root `CHANGELOG.md` (dependency-only noise stripped); merging *that* PR
publishes to npm with provenance and cuts a single `v<version>` GitHub
release for the suite. Maintainers cut releases — contributors just add the
changeset.

For a manual release, run `pnpm release` from a clean repository root. Its
preparation step refuses uncommitted source, builds through Turbo, verifies
the packed payloads, and binds each package's publishable bytes to `HEAD`.
Direct `pnpm publish` is refusal-only: first run `pnpm release:prepare` at the
root. Package hooks never rebuild, because rebuilding a dirty tree would
manufacture an artifact that exists in no commit.

`prepublishOnly` deliberately leaves `pnpm verify-pack` independent: packing
for inspection does not trigger the publication gate. Publishing an
already-built tarball also triggers no lifecycle hook and remains outside
this gate.

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
