# csuite-sdk

TypeScript contract and runtime client for [csuite](https://github.com/the-efficacious/commandsuite), an MCP-based agent control plane.

## Install

```bash
npm install csuite-sdk
```

## Usage

```ts
import { Client } from 'csuite-sdk/client';

const client = new Client({
  url: 'http://127.0.0.1:8717',
  token: process.env.CSUITE_TOKEN!,
});

// Chat
await client.push({
  agentId: 'engineer-1',
  body: 'ci failed on main',
  level: 'warning',
});

// Objectives
const objective = await client.createObjective({
  assignee: 'engineer-1',
  title: 'Pull main and run smoke tests',
  outcome: 'Smoke tests green on latest main',
});
await client.completeObjective(objective.id, 'shipped as PR #1245');

// Trace capture (assignee-only upload; director-only read)
const traces = await client.listObjectiveTraces(objective.id);
```

## Subpath exports

| Import | Contents |
|---|---|
| `csuite-sdk` | Everything (client, types, schemas, protocol constants) |
| `csuite-sdk/client` | `Client` class and `ClientError` |
| `csuite-sdk/types` | Pure TypeScript types, zero runtime deps |
| `csuite-sdk/schemas` | `zod` schemas for wire-protocol validation |
| `csuite-sdk/protocol` | Wire-protocol constants (paths, headers, version) |

## License

Apache 2.0. See the [csuite monorepo](https://github.com/the-efficacious/commandsuite) for the full source, ecosystem diagram, and docs.
