---
'csuite-cli': patch
---

**Exit codes changed for startup failures. A supervisor may be branching on
this.** `docs/reference/cli.mdx` has always published 1 = failure (network,
broker error, IO, preflight FAIL) and 2 = usage error (bad flags or arguments),
and `UsageError`'s own comment stated the same intent, but three runtime
conditions were converted to `UsageError` and exited **2**: an unreachable
broker, a missing or broken agent binary, and a missing token. A unit with
`RestartPreventExitStatus=2` therefore stayed down after a broker bounce — the
single most common transient failure in the system, and the one `Restart=always`
exists for.

Those three now exit **1** through a new `StartupError` carrier, and `2` means a
wrong argv and nothing else. The same change settles a disagreement inside the
CLI: "nothing enrolled for this (broker URL, directory)" exited 1 from
`csuite claude` and 2 from `csuite claude install-service` and `csuite <verb>
cycle`, on the identical formatter and the identical lookup key. All of them now
exit 1. `csuite <verb> install-service` also exits 1 rather than 2 when no saved
auth entry is scoped to the workspace.

**If you branch on 2 to stop retrying, that is now the correct signal and it
will fire less often** — a broker outage, a half-installed agent and an unenrolled
directory all report themselves as retriable. If you branch on 2 to catch
*startup* problems, switch to 1.

`csuite <verb> install-service` and `csuite <verb> cycle` now split all of their
refusals the same way. Exit 2 is kept for a value that cannot be rendered into a
unit file and for "two brokers are scoped here, pass `--url`". Exit 1 covers the
rest: nothing enrolled, no root and no passwordless sudo, a privileged command
that failed, a snapshot that could not be taken before replacement, and a unit
that installed but whose member never came live — every one of which is a
machine that is not ready rather than an invocation that is wrong.

`64` — a configuration the container entrypoint refused — is now published in the
CLI reference's exit-code table alongside 0, 1 and 2, instead of appearing only
in `docs/deployment.mdx` and `docs/runners/stub.mdx`.
