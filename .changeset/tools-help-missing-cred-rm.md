---
'csuite-cli': patch
---

`csuite --help` now lists `cred-rm` on the `csuite tools` line. The subcommand
has always dispatched, the module header named it and the CLI reference
documented it, so the only way to remove a stored tool-source credential was
invisible to anyone reading `--help`. A test now holds the usage line, the
`tools subcommand required` error and the dispatcher's own switch to one list,
so the next subcommand cannot land advertised in one place and absent from
another.

The same line now calls a tool source "admin-defined" rather than "platform".
"Platform" names the hosted product elsewhere in the docs, and a registry an
operator configures on their own broker is not that.
