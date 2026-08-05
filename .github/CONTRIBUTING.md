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
   check verifies every commit is signed off (see the DCO section below);
   a commit-convention check verifies the PR title and every commit
   subject (see "Commit message conventions"). All of these checks must
   pass.
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

### Check whether the property is already covered before building an instrument

**Before designing a measurement, establish whether the property is already
asserted.** If it is, say what the new measurement adds that the existing one
cannot. *"We measured it in the field"* is weaker than *"a fixture proves it on
every run"* whenever the property is deterministic and local.

The cost of skipping this, measured: establishing in the field that a
spool-directory sweep gates on a captured marker rather than a liveness probe
consumed **four daemon versions, four reviewers and about fifty minutes**, and
produced seven instrument defects — including a design with a false-VALID
ordering hole and a timestamp bracket that truncated to whole seconds,
recreating the defect it was written to catch.

`packages/cli/test/runtime/trace-host.test.ts` had covered it the entire time —
five constructed states driven through the real `startCaptureHost`,
mutation-proven on both load-bearing guards, and covering a branch the one-shot
field observation could not reliably produce. **The fixture was stronger on
every axis that mattered**, and one `grep` over the test directory was cheaper
than any single review round it went through.

Two causes worth naming separately, because each recurs on its own:

- **A locally testable property written into a field-validation contract.**
  Separate criteria by the kind of evidence they require, not by what prompted
  them.
- **Nobody asked, because the instrument work was immediately productive.**
  Each round found a real defect, so the loop felt like it was converging rather
  than like it should not have started. **Local yield is not evidence that the
  work is necessary.**

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

This completes a defence against a check whose answer was fixed before it ran:

| | | |
|---|---|---|
| **mutate** | delete or invert the thing and watch a *specific named* test fail | author-side |
| **confirm it applied** | a mutation that silently didn't apply is indistinguishable from one that survived | author-side |
| **positive control** | prove the check can pass when it should | author-side |
| **a second measurer** | someone else measuring the same system disagrees with your result | structural |

The first catches a test that cannot fail; the second catches a mutation that
never ran; the third catches a test that cannot pass.

**The fourth exists because the first three share a blind spot.** They are all
things the author does, so they all fail together when the author's *frame* is
wrong rather than their code. A probe once passed OTEL's `key=value` header
format to curl, which needs `key: value` — no credential was ever sent, and the
401 it measured was its own malformed input. Mutating that probe finds nothing:
it was internally consistent, and every author-side check would have agreed with
it. What caught it was a colleague's unrelated row count contradicting the
result, before it had reached anyone's decision.

So when a check's *frame* is the thing in question, no amount of author-side
discipline reaches it. That is what *author proposes, partner verifies* is for,
and it is the only one of these that fires **before** publication rather than
after.

### Mutate the surface your fix added, for the defect you were fixing

The table above is the general discipline. This is it pointed at one moment:
**the code you write to fix a defect is the least-audited place that defect can
hide.** The old surface gets scrutinised; the new surface gets written by
someone who "obviously" would not make that mistake — and holding a defect in
mind is not the same as checking for it. Thinking about the disease produces
confidence rather than scrutiny.

**Probes and renderers are the sites.** Both take structured data and produce
something a person or an agent reads, and both make a default-value decision at
every field — exactly where one fact becomes indistinguishable from another.

After the fix compiles:

1. **Name the defect class in one sentence** — "two different facts print
   identically", "a returned field is dropped", "an error renders as empty".
2. **List the surfaces the fix added or touched.**
3. **Mutate each against that sentence and confirm a named test fails.**

Step 3 is the whole thing. Three instances found in a single day all passed
review; two were caught by mutation and one by a verifier driving the
combination by hand. A fourth shipped: a guard test added alongside a cap
removal, whose own comment called it *"the guard against either quietly
returning"*, **passed with the cap restored** — it built its fixture directly
and never validated against the schema it claimed to guard.

**A check that cannot pass is as broken as one that cannot fail.** It can look
correct when exercised only on inputs expected to fail — the tell is that the
pass case and the fail case fail *identically*, which points at the harness
rather than the logic. A CI gate written and tested only against the failing
payload survives that way until the day it should have been the one green
thing. Run the positive control before trusting the negative one.

### Make “this must not compile” executable

**A comment saying an API must reject a call does not establish that it does.**
Put the hostile call in a typechecked fixture and invert the assertion with
`@ts-expect-error`:

```ts
// @ts-expect-error — arbitrary recovery must not exist on the public surface
publicStore.resolve('malformed_row_skipped', 'member')
```

When the boundary is closed, the compiler error is expected and the fixture
passes. If a refactor accidentally makes the call legal, TypeScript reports
`TS2578: Unused '@ts-expect-error' directive` and fails the build. The negative
claim therefore cannot silently rot into a comment that nobody recompiles.

This is especially useful for checking an architectural boundary with several
routes. Enumerate them separately — a generic write method, a generic recovery
method, a point-cause recovery — because closing one route does not establish
that the boundary is closed. Add a nearby valid call as a positive control so
the fixture also proves the public API remains usable.

### Two questions for any fixture written under pressure

**Does it reach the thing it names, and what does its opposite failure look
like?** The next two sections are those questions. Between them they account
for the two ways a fixture can be complete and meaningless — and fixtures
written in a hurry, answering a finding, are when both go unasked.

### A suite answering a finding inherits the finding's polarity

**When tests are written in response to a defect, they get built in the
direction the defect names — and completeness in one direction reads as
completeness.**

A false recovery was found: a health incident cleared by an operation that had
not actually run. The response was four tests, all asserting *does not clear* —
zero-input paths, failure paths, each a faithful answer to the finding. All
four passed. So would an implementation in which no recovery ever fired at all,
leaving every incident latched forever. The suite proved false healing was
impossible and said nothing about whether true healing was possible, because
the finding it answered only named the first.

Nobody involved was careless: the negatives were a *complete* answer to the
direction that was named. That is the mechanism — a finding names one sign, and
a suite that fully covers that sign looks finished.

The two directions are not symmetric conveniences; they guard against different
defects. **Negative placement tests prevent false healing; positive placement
tests prevent permanent sickness.** A suite covering one direction silently
accepts the other failure.

So at the moment you finish a suite written in response to a finding — that
moment specifically — ask what the opposite failure looks like, and add the
fixture that would catch it. This is the positive-control rule's sibling: that
one catches a check that cannot pass; this one catches a whole suite aimed the
wrong way while every individual test is right.

### Confirm the fixture reached the code under test

The mutation table above already requires one thing that sounds bureaucratic
and isn't: *confirm the mutation applied before reading the count, because a
mutation that silently didn't apply is indistinguishable from a survivor.* The
same discipline, reflected onto fixtures:

**Confirm the fixture reached the code under test before reading the verdict —
a fixture that never arrives is indistinguishable from one that passed.**

Five fixtures in one session did not exercise the thing they named. In every
case the fixture died *before the branch it named*, and only noise disclosed
it — each happened to fail loudly, which is luck, not method:

| what broke | what the fixture believed | the missing assertion |
|---|---|---|
| the request 404'd on an unwired store | the POST succeeded | assert 2xx before checking the effect |
| an array was passed where one record was expected | the induced error was raised | assert the error you induced, by identity |
| an empty batch took the success path | the failure branch ran | assert the operation actually failed |
| an invented record shape was ignored | the parser consumed the record | assert the consumer saw it |

Two executable forms, one per direction:

- **On the failure side, assert the specific failure, not any failure.**
  `rejects.toThrow(/the reason you induced/)` where a bare `rejects.toThrow()`
  is satisfied by an upstream type error, a 404, or a missing import just as
  happily as by the defect under test.
- **On the success side, assert a value the target branch uniquely produces**,
  not a value that "no complaints" also produces. An assertion that an incident
  cleared is satisfied by a recovery that fired spuriously; an assertion on the
  row the success path alone writes is not.

Where the path is deep, assert one intermediate observable that only the
intended route sets — a 2xx before the effect, the consumer having seen the
record, the branch having run. It costs a line per fixture.

This is the helper-versus-caller problem moved inside a single test: you assert
the outcome and *infer* the path, and the path is what broke. The other
practices here do not reach it — mutation, positive controls and
compile-negatives all assume the fixture exercises the mechanism it names. A
fixture that fails for the wrong reason is one edit away from passing for the
wrong reason.

### Assert the output the consumer actually reads

The previous section asks whether the fixture reached the code. This one is its
mirror at the other end: **did what the code produced reach the consumer, and
did anything assert the form the consumer reads it in?**

**The consumer is usually not the caller.** Tests call a function and read its
return value, so the return value is what gets asserted — and the return value
is frequently not the product. A commit-subject validator was mutated twice
during one pull request, one layer apart:

| mutation | suite result | what it actually did |
|---|---|---|
| the `missing-prefix` message replaced with the literal `ok` | all green | every failure became unactionable |
| `main()` changed to always return `0` | all green | the check could never fail CI |

Every test asserted an exported function and every one of them still passed.
The first destroyed the sentence a contributor reads; the second destroyed the
exit status the workflow reads, which is the *only* thing CI observes. **A
validator that diagnoses every input perfectly and exits `0` is not a weaker
version of working — it is a green check, and the suite could not see it.**

So name the consumer before you decide what to assert:

| the deliverable | the consumer | what it reads |
|---|---|---|
| a CLI, a script, a git hook | a shell, a CI runner | the exit status, and which stream the text went to |
| an HTTP route | a client | the status code and the body, not the handler's return |
| a badge, a warning, a tool description | a person or an agent | the rendered string |
| a log line | whatever retains it | that something retained it |

**"Name the string the deliverable must produce" above is this rule for the
case where the output is text on a screen, and its grep is the right tool
there. The grep does not generalise** — no search for a string finds an exit
status, a stream, or a status code. What generalises is the question.

Two executable forms:

- **When the product is a process, drive it as a process.** `spawnSync` the
  script, assert the exit status *and* the stream — text on stdout that the
  consumer reads from stderr is as invisible as text never produced. Testing
  only the exported functions leaves the entire command line — argument
  parsing, stream choice, exit code — unasserted.
- **When the product is read at a boundary you do not own** — a workflow file,
  a manifest, a generated config — assert the artefact. A validator can be
  correct while the workflow invokes it with the wrong arguments, and the suite
  will not know. Read the file in a test and assert the decisions in it.

Why a rule: both mutations were found by mutating and neither would have been
found by re-reading the tests, which looked thorough — **68 cases**, positive
controls in both directions, every rule diagnosed by name, a real git
repository for the revision range. Run against that suite, the exit-code
mutation produces **68 passed, 0 failed** — byte-identical to the unmutated
run. **The completeness was real and all of it was on one side of the
boundary.** The question never asked was not *is the rule right* but *does
anything downstream ever see it*.

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

## Use a command that cannot see your working tree

**Intending to cite a commit is not the same as running a command that reaches
one**, and the gap is invisible in the output. A `file:line` is a coordinate in
a specific tree; it looks identical whether or not it resolves for the reader.

```bash
git show <sha>:path/to/file | grep -n thing     # cannot see your checkout
git rev-parse <sha>:path/to/file                # cannot see your checkout

sed -n '3241p' path/to/file                     # always can, and reads the same
grep -n thing path/to/file                      # always can, and reads the same
```

Two instances in one evening, both from people being careful, and **they fail
differently — which is why the rule has to be about the command rather than the
intent:**

- **Wrong tree, no commit named.** A contributor documented *"`rust-toolchain.toml`
  pins the compiler to 1.95.0"* as a present fact. True in their working tree —
  they had branched from a verification checkout carrying someone else's
  unmerged commits — and **false on `main`**, where there is no pin at all. The
  corrected statement turned out to be more useful than the original: the gate
  job and the jobs building the shipped artifact install *different compilers*.
- **Right commit named, command never reached it.** A reviewer fetched the
  exact commit, then ran `sed` against the working-tree copy and reported those
  lines as commit-scoped. They were off by about seven hundred lines, resolved
  cleanly against a tree four days old, and so looked entirely plausible.

**A rule phrased as "cite against a named commit" would not have caught the
second — that reviewer did name the commit.**

### When two readings disagree, compare objects rather than coordinates

```bash
git rev-parse <sha>:path/to/file
```

**Same blob, someone miscounted. Different blob, someone is not where they
think they are.**

An exchange of line numbers settled nothing: two people each read carefully,
got different answers, and there was no way to adjudicate without believing
one of them. One command settled it in a direction neither could argue with.
**That is the property a check should have — it resolves a dispute without
either party having to be trusted.**

It is the same rule this repository already applies to review — **name the
commit you verified; a branch name is not an object** — pointed at citations
instead of approvals.

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

To make the sign-off automatic, install a `commit-msg` hook (from the
repo root):

```bash
printf '%s\n' '#!/bin/sh' \
  'grep -q "^Signed-off-by:" "$1" || printf "\nSigned-off-by: %s <%s>\n" "$(git config user.name)" "$(git config user.email)" >> "$1"' \
  > .git/hooks/commit-msg && chmod +x .git/hooks/commit-msg
```

> An earlier version of this section said `git config --global
> format.signOff true` does this. It does not — that setting affects
> only `git format-patch`, and a trailer-less commit in this repo's own
> history is the measurement. No stock git config adds the trailer to
> ordinary commits; the hook (or typing `-s`) is what works.

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

Commits follow Conventional Commits. This is **required**, and CI enforces
the parts of it a machine can decide.

```
type(scope): subject
```

- **type** — one of `feat` `fix` `docs` `chore` `refactor` `test` `ci`
  `perf` `build`. Lowercase, and the list is closed. Append `!` for a
  breaking change (`feat!:`, `fix(web-ui)!:`).
- **scope** — optional; if the parentheses are there they must have
  something in them.
- **subject** — **72 characters or fewer including the prefix**, imperative
  mood, no trailing period.
- **body** — explains **why**, not what. The diff shows what.

### The PR title is a commit subject

This repo squash-merges, and GitHub uses the **pull request title** as the
squash subject for any PR with more than one commit. That title is what
lands in `main`'s history, so it is held to the convention exactly like a
commit subject is, and it is re-checked when you edit it.

The `(#123)` GitHub appends to the squash subject does not count against
the 72 characters — the limit is measured on the subject as you wrote it.
The line in `git log` will therefore run up to about seven characters
longer than the limit.

### What CI decides and what review carries

The `.github/workflows/commit-convention.yml` workflow checks the PR title
and every commit the PR adds, and names the offending subject and the rule
it broke. It decides the shape, the type, the length, and the trailing
period — the rules with one unarguable answer.

**Imperative mood and "the body explains why" are conventions, not gates.**
Nothing checks them. They are not softer requirements; they are the ones
where a mechanical verdict would be arguable, and a check people can
reasonably dispute is a check the whole convention gets routed around.
Review carries them.

The check runs only on commits your PR adds. Existing history is not
rewritten and is not checked — several subjects already in `main` predate
this rule and would fail it.

### Authors whose subjects we do not write

**Dependabot is exempt, by author, and nothing else is.** It generates both
the PR title and the commit subject from the update it found, and the summary
text — *"bump the minor-and-patch group across 1 directory with 8 updates"* —
grows with the number of packages, so its length is not something this repo
can bound. Retitling does not help: the generated commit subject fails the
same rules, and editing the title does not change what the bot committed.

The exemption is **scoped to the author, not to the rules**. A subject that
Dependabot may ship is still refused from you — that pair is asserted in
`scripts/test/check-commit-convention.test.mjs`, so widening the vocabulary
for everyone fails its own suite. Passing no author at all enforces
everything, so a misconfigured workflow fails closed rather than silently
exempting the repo.

**An exempt run still prints every subject it did not check.** A green check
that quietly enforced nothing is the same defect as a doc describing
behaviour the code does not have.

Setting `commit-message.prefix` in `dependabot.yml` was considered and does
not work: it changes only future PRs — subjects already generated are not
rewritten — and `chore(deps): ` is one character *longer* than
`deps(deps): `, so a 76-character subject becomes 77.

### Bodies, and who they are for

Write commit and PR bodies for someone reading the history months from now
who was not present for the work: what changed, why, the risk, and what is
not covered. The discovery narrative — what you tried, what you got wrong
first — belongs in review, where the people who need it are.

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
