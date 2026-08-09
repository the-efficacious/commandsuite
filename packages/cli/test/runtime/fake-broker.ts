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
// Name the fake broker returns from /instructions. The link calls
// /instructions at startup to self-derive its name; this is what it
// gets back, and what it will then subscribe under.
export const FAKE_BROKER_NAME = 'link-test-agent';
export const FAKE_BROKER_TEAM_NAME = 'fake-team';
export const FAKE_BROKER_MISSION = 'Exercise the link in isolation.';

/**
 * Objectives the fake broker will return from /instructions + /objectives.
 * Tests can push onto or read from this to verify the runner's
 * open-plate handling (e.g. the `context_refresh` re-brief).
 */
export const fakeBrokerObjectives: Array<Record<string, unknown>> = [];

/**
 * Raw query strings the fake broker saw on `GET /objectives`, in order.
 * The MCP tool's choice of filter IS the agent-facing contract — asking
 * for `assignee` instead of `related` reinstates the empty-plate defect
 * while every server-side test stays green — so tests assert on what
 * went out, not only on what came back.
 */
export const fakeBrokerObjectiveQueries: string[] = [];

/** Runner-version headers observed on instructions fetches, including refreshes. */
export const fakeBrokerInstructionsRunnerVersions: Array<string | undefined> = [];

/** Personal instructions returned by /instructions; mutable for compatibility tests. */
export const fakeBrokerInstructions: { value: string } = { value: '' };

/**
 * Resolved tool sources the fake broker returns on /instructions
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
export const fakeBrokerSecrets: {
  env: Record<string, string> | null;
  /**
   * Which keys of `env` came from the SECRETS store. `undefined` models
   * a broker that predates the secrets/variables split and sends no
   * classification at all — the runner must then register everything,
   * which is the fail-closed direction.
   */
  secretEnvNames?: string[];
} = { env: {} };

/** Whether `/healthz` advertises the remote-Claude raw-body acknowledgement. */
export const fakeBrokerCapabilities: { rawBodyAck: boolean } = { rawBodyAck: true };

/**
 * The spine surface the fake broker serves.
 *
 * Canned rather than a real annex on purpose: the link tests exercise
 * the CLI's side of the wire — what it sends, and what it renders back
 * — and the annex's own rules are held by the server's suites against
 * the real store. What matters here is that a spine tool call reaches
 * `/spine/*` with the payload the tool composed, which is the half no
 * server-side test can see.
 *
 * `refuseNext` makes the next append answer with a canned refusal, so
 * the refusal RENDERING is drivable end to end: a stale delta must
 * arrive whole, and only a real 409 through the client proves it does.
 *
 * `replayNext` and the contract echo exist for the same reason in the
 * success direction. An append response that always carried
 * `contract: null, replayed: false` left three rendered lines — the
 * contract's new `state_rev`, its staleness warning, and the REPLAY
 * notice — unreachable in every test, and mutations deleting two of
 * them survived a full green suite. The `state_rev` line in particular
 * is the number every tool description tells an agent to read back.
 */
export const fakeBrokerSpine: {
  appends: Array<Record<string, unknown>>;
  orient: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  eventsById: Record<string, Record<string, unknown>>;
  contracts: Record<string, Record<string, unknown>>;
  subjects: Array<Record<string, unknown>>;
  refuseNext: { status: number; body: Record<string, unknown> } | null;
  /** Answer the next append as an idempotent replay of an existing event. */
  replayNext: boolean;
  /**
   * Every floor signal the runner reported, in order, with the member
   * it was reported for.
   *
   * Recorded rather than counted because the SHAPE is the contract: a
   * `session_start` carrying no capabilities and one carrying
   * `{dumpSignal: true}` are different declarations, and a test that
   * only counted signals would pass against a runner that forwarded
   * the adapter's ceiling as `undefined` forever.
   */
  signals: Array<{ member: string; body: Record<string, unknown> }>;
  /** Curator config writes the `subscribe` tool made. */
  curatorWrites: Array<Record<string, unknown>>;
  curatorConfig: Record<string, unknown>;
  /**
   * 404 the ANNEX (`/spine/orient`), as a broker predating the spine
   * would.
   *
   * Split from `absentSignals` deliberately. A single flag could only
   * ever construct "both present" or "both absent", and the
   * configuration that broke the runner is neither: an annex with no
   * curator answers orient 200 and signals 404, and one shared
   * availability flag turned that 404 into a permanent loss of
   * recovery. A fixture that cannot express the broken deployment
   * cannot catch the bug in it.
   */
  absent: boolean;
  /** 404 only `POST /members/:name/spine-signals` — an annex with no curator. */
  absentSignals: boolean;
} = {
  appends: [],
  orient: {},
  events: [],
  eventsById: {},
  contracts: {},
  subjects: [],
  refuseNext: null,
  replayNext: false,
  signals: [],
  curatorWrites: [],
  curatorConfig: {},
  absent: false,
  absentSignals: false,
};

/**
 * Activity events received on POST /members/:name/activity, in arrival
 * order. The conformance suite reads this to assert the run bracket
 * (`session_start` / `session_end`) and capture uploads reach the
 * broker. Tests should clear it between runs.
 */
export const fakeBrokerActivity: Array<{ member: string; event: Record<string, unknown> }> = [];

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
      res.end(
        JSON.stringify({
          status: 'ok',
          version: 'fake',
          ...(fakeBrokerCapabilities.rawBodyAck ? { capabilities: { rawBodyAck: true } } : {}),
        }),
      );
      return;
    }

    const auth = req.headers.authorization;
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401, jsonHeaders);
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (url.pathname === '/instructions' && req.method === 'GET') {
      const reported = req.headers['x-csuite-runner-version'];
      fakeBrokerInstructionsRunnerVersions.push(
        typeof reported === 'string' ? reported : undefined,
      );
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
          instructions: fakeBrokerInstructions.value,
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

    // POST /members/:name/activity — the runner's streaming uploader.
    // Records every event and acks the batch, mirroring the real broker.
    const activityMatch = /^\/members\/([^/]+)\/activity$/.exec(url.pathname);
    if (activityMatch && req.method === 'POST') {
      const body = await readBody(req);
      const parsed = JSON.parse(body || '{}') as { events?: Array<Record<string, unknown>> };
      const member = decodeURIComponent(activityMatch[1] as string);
      const events = Array.isArray(parsed.events) ? parsed.events : [];
      for (const event of events) {
        fakeBrokerActivity.push({ member, event });
      }
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ accepted: events.length }));
      return;
    }

    if (url.pathname === '/secrets/resolve' && req.method === 'GET') {
      if (fakeBrokerSecrets.env === null) {
        res.writeHead(404, jsonHeaders);
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, jsonHeaders);
      res.end(
        JSON.stringify({
          env: fakeBrokerSecrets.env,
          ...(fakeBrokerSecrets.secretEnvNames !== undefined
            ? { secretEnvNames: fakeBrokerSecrets.secretEnvNames }
            : {}),
        }),
      );
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
      fakeBrokerObjectiveQueries.push(url.searchParams.toString());
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

    // ─── Spine ────────────────────────────────────────────────────
    // Records what the tool composed, then answers with whatever the
    // test staged. The assertions live on `fakeBrokerSpine.appends`:
    // the payload a tool sends IS the agent-facing contract, and a
    // suite that only reads what came back cannot see it.
    if (url.pathname === '/spine/events' && req.method === 'POST') {
      const parsed = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
      fakeBrokerSpine.appends.push(parsed);
      const refusal = fakeBrokerSpine.refuseNext;
      if (refusal !== null) {
        fakeBrokerSpine.refuseNext = null;
        res.writeHead(refusal.status, jsonHeaders);
        res.end(JSON.stringify(refusal.body));
        return;
      }
      // The contract the payload names, as the real broker returns it:
      // its state AFTER the append. Tests stage it in
      // `fakeBrokerSpine.contracts`, so the rendered `state_rev` line
      // and the staleness warning are reachable.
      const named =
        typeof (parsed.body as { contract?: unknown } | undefined)?.contract === 'string'
          ? ((parsed.body as { contract: string }).contract as string)
          : null;
      const contract = named === null ? null : (fakeBrokerSpine.contracts[named] ?? null);
      const replayed = fakeBrokerSpine.replayNext;
      fakeBrokerSpine.replayNext = false;
      res.writeHead(replayed ? 200 : 201, jsonHeaders);
      res.end(
        JSON.stringify({
          event: {
            seq: fakeBrokerSpine.appends.length,
            id: `evt_fake_${fakeBrokerSpine.appends.length}`,
            kind: parsed.kind,
            class: 'authoritative',
            subject: (parsed.subject as string | undefined) ?? null,
            revision: null,
            actor: FAKE_BROKER_NAME,
            authoredBy: null,
            at: '2026-08-09T09:00:00.000Z',
            provenance: 'native',
            opId: (parsed.opId as string | undefined) ?? null,
            cites: (parsed.cites as string[] | undefined) ?? [],
            staplesTo: null,
            contract: named,
            stateRev: null,
            body: parsed.body,
          },
          contract,
          replayed,
        }),
      );
      return;
    }

    if (url.pathname === '/spine/orient' && req.method === 'GET') {
      if (fakeBrokerSpine.absent) {
        res.writeHead(404, jsonHeaders);
        res.end(JSON.stringify({ error: 'no spine here' }));
        return;
      }
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(fakeBrokerSpine.orient));
      return;
    }

    if (url.pathname.endsWith('/spine-signals') && req.method === 'POST') {
      if (fakeBrokerSpine.absent || fakeBrokerSpine.absentSignals) {
        res.writeHead(404, jsonHeaders);
        res.end(JSON.stringify({ error: 'no spine here' }));
        return;
      }
      const member = decodeURIComponent(
        url.pathname.slice('/members/'.length, -'/spine-signals'.length),
      );
      const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
      fakeBrokerSpine.signals.push({ member, body });
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ accepted: true, leasesInvalidated: 0 }));
      return;
    }

    if (url.pathname === '/spine/curator' && req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
      fakeBrokerSpine.curatorWrites.push(body);
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(fakeBrokerSpine.curatorConfig));
      return;
    }

    if (url.pathname === '/spine/curator' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(fakeBrokerSpine.curatorConfig));
      return;
    }

    if (url.pathname === '/spine/events' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders);
      res.end(
        JSON.stringify({
          events: fakeBrokerSpine.events,
          nextCursor: null,
          headSeq: fakeBrokerSpine.events.length,
        }),
      );
      return;
    }

    if (url.pathname.startsWith('/spine/events/') && req.method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/spine/events/'.length));
      const event = fakeBrokerSpine.eventsById[id];
      if (!event) {
        res.writeHead(404, jsonHeaders);
        res.end(JSON.stringify({ error: 'no such event' }));
        return;
      }
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ event }));
      return;
    }

    if (url.pathname.startsWith('/spine/contracts/') && req.method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/spine/contracts/'.length));
      const contract = fakeBrokerSpine.contracts[id];
      if (!contract) {
        res.writeHead(404, jsonHeaders);
        res.end(JSON.stringify({ error: 'no such contract' }));
        return;
      }
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ contract }));
      return;
    }

    if (url.pathname === '/spine/subjects' && req.method === 'POST') {
      const parsed = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
      fakeBrokerSpine.subjects.push(parsed);
      res.writeHead(201, jsonHeaders);
      res.end(
        JSON.stringify({
          subject: {
            id: parsed.id,
            type: parsed.type,
            parent: (parsed.parent as string | undefined) ?? null,
            registeredBy: FAKE_BROKER_NAME,
            at: '2026-08-09T09:00:00.000Z',
          },
        }),
      );
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
