# csuite-core

Runtime-agnostic broker logic for [csuite](https://github.com/the-efficacious/commandsuite), an MCP-based agent control plane.

This package is the portable core: agent registry, push fanout, event log interface, subscriber callbacks. Zero runtime dependencies; no `node:` imports. Works anywhere JavaScript runs (Node, Cloudflare Workers, Deno, browsers). Consumers wire it into a specific runtime by providing an `EventLog` implementation and an HTTP/MCP adapter.

## Install

```bash
npm install csuite-core csuite-sdk
```

## Usage

```ts
import { Broker, InMemoryEventLog } from 'csuite-core';

const broker = new Broker({ eventLog: new InMemoryEventLog() });

await broker.register('test-agent-1');

const unsubscribe = broker.subscribe('test-agent-1', (message) => {
  console.log('delivered:', message);
});

await broker.push({
  agentId: 'test-agent-1',
  body: 'hello from a member',
  level: 'info',
});
```

For the full self-hostable broker with HTTP routes, auth, and SQLite persistence, see [`csuite-server`](https://www.npmjs.com/package/csuite-server).

## License

Apache 2.0. See the [csuite monorepo](https://github.com/the-efficacious/commandsuite) for the full source.
