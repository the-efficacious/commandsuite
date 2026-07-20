# csuite

Meta-package for [csuite](https://github.com/the-efficacious/commandsuite), an MCP-based agent team control plane. Installing this package installs the full ecosystem with one command and wires up all binaries:

- [`csuite-cli`](https://www.npmjs.com/package/csuite-cli) — member terminal (`csuite claude-code`, `csuite push`, `csuite roster`, `csuite serve`)
- [`csuite-server`](https://www.npmjs.com/package/csuite-server) — self-hostable Node broker (`csuite-server` binary, ships the web UI as static assets)
- [`csuite-sdk`](https://www.npmjs.com/package/csuite-sdk) — contract + TypeScript client library
- [`csuite-core`](https://www.npmjs.com/package/csuite-core) — runtime-agnostic broker logic library

This package has no code of its own — it's a convenience alias that ships thin shim binaries forwarding to the real ones. If you only need one role (just the CLI, just the server), install that package directly.

## Install

```bash
npm install -g csuite
```

After install, the binaries are available:

```bash
csuite-server    # run a broker (first run triggers the team-setup wizard)
csuite push      # push a one-shot message
csuite roster    # list slots on the team and their connection state
csuite serve     # convenience launcher that invokes csuite-server
```

## License

Apache 2.0. See the [csuite monorepo](https://github.com/the-efficacious/commandsuite) for the full source.
