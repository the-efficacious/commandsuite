/**
 * Minimal HTTP + WebSocket broker used by the link integration tests.
 *
 * Speaks just enough of the csuite wire protocol to exercise the link's
 * HTTP + WebSocket paths without pulling in csuite-core or the real
 * server. Pushes are captured in an array; incoming WebSocket
 * subscribers are exposed so tests can inject messages on demand.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';

export interface FakeBrokerPush {
  to?: string | null;
  title?: string | null;
  body: string;
  level?: string;
  data?: Record<string, unknown>;
}

export interface LiveSubscriber {
  name: string;
  write: (json: Record<string, unknown>) => void;
  close: () => void;
}

export interface FakeBroker {
  port: number;
  url: string;
  pushes: FakeBrokerPush[];
  subscribers: LiveSubscriber[];
  waitForSubscriber: (name: string, timeoutMs?: number) => Promise<LiveSubscriber>;
  close: () => Promise<void>;
}

const TOKEN = 'fake-broker-token';
// Name the fake broker returns from /briefing. The link calls
// /briefing at startup to self-derive its name; this is what it
// gets back, and what it will then subscribe under.
export const FAKE_BROKER_NAME = 'link-test-agent';
export const FAKE_BROKER_TEAM_NAME = 'fake-team';
export const FAKE_BROKER_MISSION = 'Exercise the link in isolation.';

/**
 * Objectives the fake broker will return from /briefing + /objectives.
 * Tests can push onto or read from this to verify the runner's
 * open-plate handling (e.g. the `context_refresh` re-brief).
 */
export const fakeBrokerObjectives: Array<Record<string, unknown>> = [];

/**
 * Resolved tool sources the fake broker returns on /briefing
 * (`toolSources` field). Tests mutate this then push a
 * `data.kind='tool_source'` message to exercise the runner's
 * external-tools refresh → tools/list_changed path.
 */
export const fakeBrokerToolSources: Array<Record<string, unknown>> = [];

/**
 * Invocations received on POST /tool-sources/:slug/tools/:name/invoke.
 * The fake responds with a canned CallToolResult echoing the args.
 */
export const fakeBrokerToolInvocations: Array<{
  slug: string;
  tool: string;
  args: Record<string, unknown>;
}> = [];

/**
 * The env map GET /secrets/resolve returns. Tests mutate `env` to
 * exercise the runner's secret injection; setting it to `null` makes
 * the endpoint 404 (a broker that predates the secrets feature).
 * Default: empty map — no secrets, endpoint present.
 */
export const fakeBrokerSecrets: { env: Record<string, string> | null } = { env: {} };

export async function startFakeBroker(): Promise<FakeBroker> {
  const pushes: FakeBrokerPush[] = [];
  const subscribers: LiveSubscriber[] = [];

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });

  // WebSocket server attached to the same HTTP server, handling
  // `/subscribe` upgrades. `noServer: true` means we own the upgrade
  // dispatch; that lets us auth-check before handing the socket off.
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/subscribe') {
      socket.destroy();
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const name = url.searchParams.get('name') ?? '';
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachSubscriber(ws, name);
    });
  });

  function attachSubscriber(ws: WebSocket, name: string): void {
    const sub: LiveSubscriber = {
      name,
      write: (json) => {
        ws.send(JSON.stringify(json));
      },
      close: () => {
        ws.close();
      },
    };
    subscribers.push(sub);
    ws.on('close', () => {
      const idx = subscribers.indexOf(sub);
      if (idx >= 0) subscribers.splice(idx, 1);
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const jsonHeaders = { 'Content-Type': 'application/json' };

    if (url.pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
      return;
    }

    const auth = req.headers.authorization;
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401, jsonHeaders);
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (url.pathname === '/briefing' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders);
      res.end(
        JSON.stringify({
          name: FAKE_BROKER_NAME,
          role: { title: 'engineer', description: '' },
          // Admin-level permissions so the link test exercises the
          // full gated tool surface.
          permissions: [
            'team.manage',
            'members.manage',
            'objectives.create',
            'objectives.cancel',
            'objectives.reassign',
            'objectives.watch',
            'activity.read',
          ],
          instructions: '',
          team: {
            name: FAKE_BROKER_TEAM_NAME,
            context: FAKE_BROKER_MISSION,
            permissionPresets: {},
          },
          teammates: [
            {
              name: FAKE_BROKER_NAME,
              role: { title: 'engineer', description: '' },
              permissions: [],
            },
            {
              name: 'peer-1',
              role: { title: 'reviewer', description: '' },
              permissions: [],
            },
          ],
          openObjectives: fakeBrokerObjectives,
          toolSources: fakeBrokerToolSources,
        }),
      );
      return;
    }

    // POST /tool-sources/:slug/tools/:name/invoke — records the call
    // and returns a canned CallToolResult echoing the args.
    const invokeMatch = /^\/tool-sources\/([^/]+)\/tools\/([^/]+)\/invoke$/.exec(url.pathname);
    if (invokeMatch && req.method === 'POST') {
      const body = await readBody(req);
      const parsed = JSON.parse(body || '{}') as { args?: Record<string, unknown> };
      const slug = decodeURIComponent(invokeMatch[1] as string);
      const tool = decodeURIComponent(invokeMatch[2] as string);
      fakeBrokerToolInvocations.push({ slug, tool, args: parsed.args ?? {} });
      res.writeHead(200, jsonHeaders);
      res.end(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: `fake-invoke ${slug}__${tool}: ${JSON.stringify(parsed.args ?? {})}`,
            },
          ],
        }),
      );
      return;
    }

    if (url.pathname === '/secrets/resolve' && req.method === 'GET') {
      if (fakeBrokerSecrets.env === null) {
        res.writeHead(404, jsonHeaders);
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ env: fakeBrokerSecrets.env }));
      return;
    }

    if (url.pathname === '/roster' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders);
      res.end(
        JSON.stringify({
          teammates: [
            {
              name: FAKE_BROKER_NAME,
              role: { title: 'engineer', description: '' },
              permissions: [],
            },
            {
              name: 'peer-1',
              role: { title: 'reviewer', description: '' },
              permissions: [],
            },
          ],
          connected: [
            {
              name: 'peer-1',
              connected: 1,
              createdAt: 1_700_000_000_000,
              lastSeen: 1_700_000_000_000,
              role: { title: 'reviewer', description: '' },
            },
          ],
        }),
      );
      return;
    }

    if (url.pathname === '/objectives' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ objectives: fakeBrokerObjectives }));
      return;
    }

    if (url.pathname.startsWith('/objectives/') && req.method === 'GET') {
      const id = url.pathname.slice('/objectives/'.length);
      const objective = fakeBrokerObjectives.find((o) => o.id === id);
      if (!objective) {
        res.writeHead(404, jsonHeaders);
        res.end(JSON.stringify({ error: `no such objective: ${id}` }));
        return;
      }
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ objective, events: [] }));
      return;
    }

    if (url.pathname === '/push' && req.method === 'POST') {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as FakeBrokerPush;
      pushes.push(parsed);
      res.writeHead(200, jsonHeaders);
      res.end(
        JSON.stringify({
          delivery: { live: 1, targets: 1 },
          message: {
            id: `fake-${pushes.length}`,
            ts: Date.now(),
            to: parsed.to ?? null,
            from: FAKE_BROKER_NAME,
            title: parsed.title ?? null,
            body: parsed.body,
            level: parsed.level ?? 'info',
            data: parsed.data ?? {},
          },
        }),
      );
      return;
    }

    if (url.pathname === '/history' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ messages: [] }));
      return;
    }

    // /subscribe is served as a WebSocket upgrade (see `wss` above).
    // Any stray GET here — unauthenticated probe, misbehaving client —
    // falls through to 404.
    res.writeHead(404, jsonHeaders);
    res.end(JSON.stringify({ error: 'not found' }));
  }

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address() as AddressInfo;

  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    pushes,
    subscribers,
    waitForSubscriber: async (to, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const sub = subscribers.find((s) => s.name === to);
        if (sub) return sub;
        await sleep(20);
      }
      throw new Error(`timeout waiting for subscriber ${to}`);
    },
    close: () =>
      new Promise((resolve) => {
        for (const sub of subscribers) sub.close();
        wss.close();
        httpServer.close(() => resolve());
      }),
  };
}

export const FAKE_BROKER_TOKEN = TOKEN;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
