/**
 * `csuite mcp-bridge` — the stdio MCP server agents spawn via `.mcp.json`.
 *
 * This is a **thin relay** that owns nothing except its two endpoints:
 *
 *   stdio <──── MCP JSON-RPC ────>  agent (Claude Code, etc.)
 *   IPC   <──── csuite IPC frames ──>  runner (the member's `csuite claude-code` process)
 *
 * It doesn't talk to the csuite broker, doesn't hold a briefing, doesn't
 * own a tools set, doesn't maintain state beyond "I have one socket
 * open to the runner, I speak MCP stdio." All of that lives in the
 * runner process.
 *
 * The bridge's job:
 *
 *   1. Read `CSUITE_RUNNER_SOCKET` from env; refuse to start without it
 *   2. Connect to the runner's Unix domain socket
 *   3. Wire an MCP `Server` to stdio
 *   4. For every `tools/list` and `tools/call` MCP request, wrap it
 *      in an `mcp_request` frame, send to the runner, await the
 *      matching `mcp_response`, and resolve the MCP request with it
 *   5. For every `mcp_notification` frame the runner pushes, emit
 *      the corresponding MCP notification on stdio
 *   6. When the runner's socket closes (runner shutdown, crash, etc.),
 *      close the MCP server cleanly so the agent knows its MCP child
 *      has gone away
 *
 * Because the bridge holds no business state, it's trivial to restart:
 * if it crashes mid-session the agent re-spawns it per `.mcp.json`
 * rules, and the new bridge connects to the same running runner and
 * picks up where the old one left off (modulo the agent needing to
 * re-list tools, which it does automatically on reconnect).
 */

import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { MCP_CHANNEL_CAPABILITY } from 'csuite-sdk/protocol';
import { CLI_VERSION } from '../version.js';
import {
  encodeFrame,
  type IpcFrame,
  type IpcMcpResponse,
  parseFrame,
  RUNNER_SOCKET_ENV,
} from './ipc.js';

export class BridgeStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeStartupError';
  }
}

function log(msg: string, ctx: Record<string, unknown> = {}): void {
  const record = { ts: new Date().toISOString(), component: 'bridge', msg, ...ctx };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

/**
 * Bridge main entry. Blocks (by holding the stdio transport open)
 * until either stdin closes (agent disconnected) or the runner
 * socket drops. Called from the `csuite mcp-bridge` CLI verb.
 */
export async function runBridge(): Promise<void> {
  const socketPath = process.env[RUNNER_SOCKET_ENV];
  if (!socketPath || socketPath.length === 0) {
    throw new BridgeStartupError(
      `${RUNNER_SOCKET_ENV} is required — the bridge must be spawned by a csuite runner ` +
        `(try: csuite claude-code -- <agent-command>)`,
    );
  }

  // Connect to the runner's IPC socket. Short timeout — if the
  // runner isn't listening we fail loudly rather than hang stdio.
  const ipcSocket = await connectWithTimeout(socketPath, 5_000).catch((err) => {
    throw new BridgeStartupError(
      `failed to connect to runner at ${socketPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });

  // Correlation state: every outbound `mcp_request` gets a monotonically
  // increasing id. When the matching `mcp_response` frame arrives,
  // we look up the pending promise in `pendingRequests` and resolve it.
  // Unmatched responses are logged + dropped.
  let nextRequestId = 1;
  const pendingRequests = new Map<number, (response: IpcMcpResponse) => void>();

  const mcpServer = new Server(
    { name: 'csuite', version: CLI_VERSION },
    {
      capabilities: {
        experimental: { [MCP_CHANNEL_CAPABILITY]: {} },
        tools: { listChanged: true },
      },
    },
  );

  // ── Inbound IPC frames from the runner ────────────────────────────
  //
  // The runner sends us two kinds of traffic: responses to our
  // requests (matched by id) and unsolicited notifications to emit
  // on the MCP stdio transport (channel events, context re-briefs,
  // and tools/list_changed on tool-source registry changes).
  const rl = createInterface({ input: ipcSocket, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const frame = parseFrame(line);
    if (frame === null) {
      log('bridge: dropped malformed IPC frame', { lineLength: line.length });
      return;
    }
    if (frame.kind === 'mcp_response') {
      const pending = pendingRequests.get(frame.id);
      if (!pending) {
        log('bridge: unmatched mcp_response', { id: frame.id });
        return;
      }
      pendingRequests.delete(frame.id);
      pending(frame);
      return;
    }
    if (frame.kind === 'mcp_notification') {
      // Push out as a real MCP notification on stdio. This is how
      // channel events and context re-briefs reach the agent.
      mcpServer
        .notification({
          method: frame.method,
          params: frame.params ?? {},
        })
        .catch((err: unknown) =>
          log('bridge: failed to emit MCP notification', {
            method: frame.method,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return;
    }
    if (frame.kind === 'shutdown') {
      log('bridge: runner sent shutdown', { reason: frame.reason });
      teardown('runner-shutdown');
      return;
    }
    if (frame.kind === 'error') {
      log('bridge: runner reported error', { message: frame.message });
      if (typeof frame.id === 'number') {
        const pending = pendingRequests.get(frame.id);
        if (pending) {
          pendingRequests.delete(frame.id);
          pending({
            kind: 'mcp_response',
            id: frame.id,
            error: { code: -32000, message: frame.message },
          });
        }
      }
      return;
    }
    // `mcp_request` frames don't flow from runner to bridge.
    log('bridge: unexpected frame kind from runner', { kind: (frame as IpcFrame).kind });
  });

  // ── MCP request handlers — forward via IPC ────────────────────────
  //
  // Every request the agent sends (`tools/list`, `tools/call`) gets
  // wrapped in an `mcp_request` frame with a correlation id, sent to
  // the runner, and resolved when the matching `mcp_response` comes
  // back. We trust the runner's result shape because it's the same
  // code base — no extra validation here.

  const forwardRequest = <T>(
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextRequestId++;
      pendingRequests.set(id, (response) => {
        if (response.error) {
          reject(new Error(response.error.message));
          return;
        }
        resolve(response.result as T);
      });
      try {
        ipcSocket.write(encodeFrame({ kind: 'mcp_request', id, method, params }));
      } catch (err) {
        pendingRequests.delete(id);
        reject(err);
      }
    });

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return forwardRequest<{ tools: Tool[] }>('tools/list', undefined);
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
    return forwardRequest<CallToolResult>(
      'tools/call',
      req.params as unknown as Record<string, unknown>,
    );
  });

  // ── Stdio transport ───────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log('bridge: stdio + IPC connected', { socketPath });

  // Hold the process alive until one of the two endpoints goes away.
  let teardownReason: string | null = null;
  const teardown = (reason: string): void => {
    if (teardownReason !== null) return;
    teardownReason = reason;
    log('bridge: tearing down', { reason });
    try {
      rl.close();
    } catch {
      /* ignore */
    }
    try {
      ipcSocket.destroy();
    } catch {
      /* ignore */
    }
    // Let the stdio transport flush the last frame before exit.
    setTimeout(() => process.exit(0), 50).unref();
  };

  ipcSocket.on('close', () => teardown('runner-socket-closed'));
  ipcSocket.on('error', (err) => {
    log('bridge: IPC socket error', {
      error: err instanceof Error ? err.message : String(err),
    });
    teardown('runner-socket-error');
  });
  process.once('SIGINT', () => teardown('SIGINT'));
  process.once('SIGTERM', () => teardown('SIGTERM'));

  // The MCP transport keeps the process alive via stdin.
  // When stdin closes, the transport's onclose fires — we teardown
  // from there.
  transport.onclose = () => {
    teardown('stdio-closed');
  };
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Connect to a Unix domain socket with a timeout. */
function connectWithTimeout(path: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout after ${timeoutMs}ms connecting to ${path}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
