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

// The spine — author a contract (requires `spine.author`)
const { contract } = await client.appendSpineEvent({
  kind: 'specification',
  subject: 'repo:api',
  opId: crypto.randomUUID(),
  body: {
    title: 'Pull main and run smoke tests',
    criteria: [{ id: 'c1', text: 'Smoke tests green on latest main' }],
    assignee: 'engineer-1',
    verifier: 'reviewer-1',
  },
});

// Recovery — what binds the calling member right now
const pack = await client.spineOrient();

// Trace capture (self-upload; `activity.read` to read another member's)
const traces = await client.listActivity('engineer-1', { kind: 'llm_exchange' });
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
